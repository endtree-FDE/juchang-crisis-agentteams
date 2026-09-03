#!/usr/bin/env node
/**
 * P2 Verified Replay 导出脚本：只校验并冻结"真实 Live Agent Run"的导出物。
 * 红线：本脚本绝不生成 juchang-cloud-runtime-evidence@1，只消费真实运行导出物；
 *      协议模拟产物不允许、也不可能通过本脚本被包装成回放。
 *
 * 用法：
 *   node scripts/crisis-sim/export-verified-replay.mjs <runtime-evidence.json> [--dispatch <dispatch.json>] [--out <path>] [--write] [--force]
 *
 * 默认 DRY-RUN：只打印校验报告，不写任何文件。加 --write 才写入冻结 fixture。
 * 依赖 Node ≥ 22.18 的原生 TS type-stripping 直接 import app/src/lib/admin/cloud-agentteams-contract.ts。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLOUD_AGENTTEAMS_DISPATCH_PREFIX,
  CLOUD_AGENTTEAMS_DISPATCH_SCHEMA,
  CLOUD_AGENTTEAMS_RECEIPT_SCHEMA,
  CLOUD_AGENTTEAMS_ROLES,
  evaluateCloudAgentTeamsReceipt,
} from "../../app/src/lib/admin/cloud-agentteams-contract.ts";

const EVIDENCE_SCHEMA = "juchang-cloud-runtime-evidence@1";
const FIXTURE_SCHEMA = "juchang-crisis-verified-replay@1";

/**
 * 输入门禁（导出为纯函数，供测试在沙箱 EPERM 无法 spawn 时直接调用）。
 * 返回 { ok, message }；message 与 CLI 打印的门禁文案一致（不含 [FAIL] 前缀）。
 */
export function gateRuntimeEvidenceInput(raw) {
  if (raw?.schema !== EVIDENCE_SCHEMA) {
    return {
      ok: false,
      message:
        `schema 门禁：期望 ${EVIDENCE_SCHEMA}，实际 ${String(raw?.schema)}\n` +
        "       本脚本只接受真实运行导出物。协议模拟/人工产物不是合法输入。",
    };
  }
  if (raw?.receipt?.schema !== CLOUD_AGENTTEAMS_RECEIPT_SCHEMA) {
    return { ok: false, message: `导出物缺少合法 receipt（期望 ${CLOUD_AGENTTEAMS_RECEIPT_SCHEMA}）` };
  }
  return { ok: true, message: "" };
}
const DEFAULT_OUT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../app/src/data/crisis-sim",
);

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const body = keys
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",");
  return `{${body}}`;
}

function parseArgs(argv) {
  const args = { positional: [], dispatch: null, out: null, write: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dispatch") {
      args.dispatch = argv[(i += 1)];
    } else if (arg === "--out") {
      args.out = argv[(i += 1)];
    } else if (arg === "--write") {
      args.write = true;
    } else if (arg === "--force") {
      args.force = true;
    } else {
      args.positional.push(arg);
    }
  }
  return args;
}

function loadJsonFile(filePath) {
  const raw = readFileSync(filePath, "utf8");
  try {
    return { parsed: JSON.parse(raw), rawText: raw };
  } catch {
    // 导出物可能是序列化后的 dispatch 文本（带前缀），剥离前缀后重试
    const stripped = raw.trim().startsWith(CLOUD_AGENTTEAMS_DISPATCH_PREFIX)
      ? raw.trim().slice(CLOUD_AGENTTEAMS_DISPATCH_PREFIX.length)
      : null;
    if (!stripped) {
      throw new Error(`文件不是合法 JSON，也不是带 "${CLOUD_AGENTTEAMS_DISPATCH_PREFIX}" 前缀的序列化导出物: ${filePath}`);
    }
    return { parsed: JSON.parse(stripped), rawText: raw };
  }
}

function extractDispatch(raw, dispatchPath) {
  let parsed = null;
  let rawText = null;
  if (dispatchPath) {
    ({ parsed, rawText } = loadJsonFile(dispatchPath));
  } else if (raw && typeof raw === "object" && raw.dispatch) {
    parsed = raw.dispatch;
    rawText = JSON.stringify(raw.dispatch);
  }
  if (!parsed) {
    return { dispatch: null, dispatchSha256: null, dispatchProvided: false };
  }
  if (typeof parsed === "string") {
    const stripped = parsed.startsWith(CLOUD_AGENTTEAMS_DISPATCH_PREFIX)
      ? parsed.slice(CLOUD_AGENTTEAMS_DISPATCH_PREFIX.length)
      : parsed;
    parsed = JSON.parse(stripped);
  } else if (typeof parsed === "object" && typeof parsed.dispatch === "string") {
    const stripped = parsed.dispatch.startsWith(CLOUD_AGENTTEAMS_DISPATCH_PREFIX)
      ? parsed.dispatch.slice(CLOUD_AGENTTEAMS_DISPATCH_PREFIX.length)
      : parsed.dispatch;
    parsed = JSON.parse(stripped);
  }
  if (parsed?.schema !== CLOUD_AGENTTEAMS_DISPATCH_SCHEMA) {
    throw new Error(`dispatch schema 不符：期望 ${CLOUD_AGENTTEAMS_DISPATCH_SCHEMA}，实际 ${String(parsed?.schema)}`);
  }
  return {
    dispatch: parsed,
    dispatchSha256: sha256(stableStringify(parsed)),
    dispatchProvided: Boolean(dispatchPath),
  };
}

const REDACTIONS = [
  { rule: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replacement: "[redacted:email]" },
  { rule: /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: "[redacted:bearer]" },
  { rule: /sk-[A-Za-z0-9_-]{8,}/g, replacement: "[redacted:key]" },
];

function desensitize(value) {
  let redactionCount = 0;
  const walk = (node) => {
    if (typeof node === "string") {
      let out = node;
      for (const { rule, replacement } of REDACTIONS) {
        out = out.replace(rule, () => {
          redactionCount += 1;
          return replacement;
        });
      }
      return out;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]));
    }
    return node;
  };
  return { value: walk(value), redactionCount };
}

function printReport(lines) {
  for (const line of lines) console.log(line);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const evidencePath = args.positional[0];
  if (!evidencePath) {
    printReport([
      "用法: node scripts/crisis-sim/export-verified-replay.mjs <runtime-evidence.json> [--dispatch <dispatch.json>] [--out <path>] [--write] [--force]",
      "",
      "  <runtime-evidence.json>  P1 真实 AgentTeams 运行的完整导出物（schema: juchang-cloud-runtime-evidence@1）",
      "  --dispatch <path>        对应派单（juchang-cloud-dispatch@1 或序列化文本）；缺省时尝试导出物内嵌 dispatch 字段",
      "  --out <path>             覆盖默认输出路径（默认写入 app/src/data/crisis-sim/verified-replay-<runId>.json）",
      "  --write                  实际写入冻结 fixture（缺省 DRY-RUN）",
      "  --force                  目标文件已存在时允许覆盖",
    ]);
    process.exit(2);
  }
  if (!existsSync(evidencePath)) {
    console.error(`[FAIL] 导出物文件不存在: ${evidencePath}`);
    process.exit(2);
  }

  const rawBytes = readFileSync(evidencePath);
  const rawExportSha256 = sha256(rawBytes);
  const raw = JSON.parse(rawBytes.toString("utf8"));

  const inputGate = gateRuntimeEvidenceInput(raw);
  if (!inputGate.ok) {
    console.error(`[FAIL] ${inputGate.message}`);
    process.exit(1);
  }

  const { dispatch, dispatchSha256, dispatchProvided } = extractDispatch(raw, args.dispatch);

  const expected = dispatch
    ? {
        dispatchId: dispatch.dispatchId,
        tasks: dispatch.tasks.map((task) => ({ taskId: task.taskId, role: task.role })),
      }
    : {
        dispatchId: raw.receipt.dispatchId,
        tasks: raw.receipt.workers.map((worker) => ({ taskId: worker.taskId, role: worker.role })),
      };

  if (dispatch) {
    const dispatchRoles = new Set(dispatch.tasks.map((task) => task.role));
    const missingRoles = CLOUD_AGENTTEAMS_ROLES.filter((role) => !dispatchRoles.has(role));
    if (missingRoles.length) {
      console.error(`[FAIL] dispatch 缺少角色: ${missingRoles.join(", ")}`);
      process.exit(1);
    }
  } else {
    console.warn(
      "[WARN] 未提供 dispatch：expected trace 退化为从 receipt.workers 推导（自洽校验，非绑定校验）。建议用 --dispatch 提供真实派单以绑定 dispatchId/taskId。",
    );
  }

  const evaluation = evaluateCloudAgentTeamsReceipt(raw, expected);
  const counters = raw.receipt.counters ?? {};
  const counterKeys = ["productionWrites", "publicPublishes", "realRefunds", "externalMessages"];
  const nonZeroCounters = counterKeys.filter((key) => (counters[key] ?? 0) !== 0);

  const gateChecks = [
    { label: "evaluator issues = 0", ok: evaluation.issues.length === 0 },
    { label: `state === ready_for_human_review（实际 ${evaluation.state}）`, ok: evaluation.state === "ready_for_human_review" },
    { label: "canEnterHumanReview = true", ok: evaluation.canEnterHumanReview === true },
    { label: "四项外部影响计数全部为 0", ok: nonZeroCounters.length === 0 },
  ];
  const gatePassed = gateChecks.every((check) => check.ok);

  printReport([
    "=== Verified Replay 导出校验（DRY-RUN 只报告，不写入）===",
    `输入: ${evidencePath}`,
    `rawExportSha256: ${rawExportSha256}`,
    `schema: ${raw.schema}`,
    `dispatch: ${dispatch ? `已提供（dispatchId=${dispatch.dispatchId}）` : "未提供（expected 自 receipt 推导）"}`,
    `evaluator: state=${evaluation.state} canEnterHumanReview=${evaluation.canEnterHumanReview} workerProgress=${JSON.stringify(evaluation.workerProgress)}`,
    `counters: ${JSON.stringify(counters)}`,
  ]);
  if (evaluation.issues.length) {
    console.log("issues:");
    for (const issue of evaluation.issues) {
      console.log(`  - ${issue.code} · ${issue.label}${issue.taskId ? ` · ${issue.taskId}` : ""}`);
    }
  }
  for (const check of gateChecks) {
    console.log(`  ${check.ok ? "[PASS]" : "[FAIL]"} ${check.label}`);
  }

  if (!gatePassed) {
    console.error("[FAIL] 校验门禁未通过：拒绝冻结。真实运行必须零 issue、可进入人工复核、零外部写入。");
    process.exit(1);
  }

  const { value: desensitized, redactionCount } = desensitize(raw);
  const slug = String(expected.dispatchId ?? "unknown-run").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const replayId = `verified-replay-${slug}`;
  const outPath = args.out
    ? path.resolve(args.out)
    : path.join(DEFAULT_OUT_DIR, `verified-replay-${slug}.json`);

  const fixtureWithoutSelfDigest = {
    schema: FIXTURE_SCHEMA,
    replayId,
    frozenAt: new Date().toISOString(),
    readonly: true,
    source: {
      kind: "live_agent_run",
      dispatchId: expected.dispatchId,
      projectId: raw.project?.project_id ?? null,
      changeRef: raw.receipt.changeRef ?? null,
      decisionRunId: dispatch?.decisionRunId ?? null,
      adapterRef: dispatch?.adapterRef ?? null,
      exportedFrom: path.basename(evidencePath),
      dispatchProvided,
      evaluatorState: evaluation.state,
    },
    disclosure:
      "本文件回放自一次真实 Live Agent Run 的导出物，已通过 evaluateCloudAgentTeamsReceipt 校验（0 issue、可进入人工复核、四项外部影响计数为 0）并脱敏冻结。它不是协议模拟，也不是实时运行；文件只读，禁止修改。",
    validation: {
      evaluator: "evaluateCloudAgentTeamsReceipt（app/src/lib/admin/cloud-agentteams-contract.ts）",
      state: evaluation.state,
      issueCount: evaluation.issues.length,
      workerProgress: evaluation.workerProgress,
      counters,
    },
    desensitization: {
      rules: ["email → [redacted:email]", "Bearer token → [redacted:bearer]", "sk- key → [redacted:key]"],
      redactionCount,
    },
    replay: desensitized,
    digests: {
      rawExportSha256,
      dispatchSha256,
      receiptSha256: sha256(stableStringify(raw.receipt)),
    },
  };
  fixtureWithoutSelfDigest.digests.fixtureSha256 = sha256(stableStringify(fixtureWithoutSelfDigest));

  if (args.write) {
    if (existsSync(outPath) && !args.force) {
      console.error(`[FAIL] 目标已存在: ${outPath}（用 --force 覆盖，或换 --out）`);
      process.exit(1);
    }
    writeFileSync(outPath, `${JSON.stringify(fixtureWithoutSelfDigest, null, 2)}\n`, "utf8");
    printReport([
      `fixtureSha256: ${fixtureWithoutSelfDigest.digests.fixtureSha256}`,
      `redactions: ${redactionCount}`,
      `[WROTE] ${outPath}`,
    ]);
  } else {
    printReport([
      `fixtureSha256: ${fixtureWithoutSelfDigest.digests.fixtureSha256}`,
      `redactions: ${redactionCount}`,
      `[DRY-RUN] 计划写入: ${outPath}（加 --write 实际写入）`,
    ]);
  }
  process.exit(0);
}

// 仅作为 CLI 直接执行时才跑 main；被 import（如沙箱内测试降级路径）时不执行
const invokedAsCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  try {
    main();
  } catch (error) {
    console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
