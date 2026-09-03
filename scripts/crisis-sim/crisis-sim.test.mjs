/**
 * crisis-sim 验证与安全测试（node:test，零模型调用）。
 *
 * 运行：npm run test:crisis-sim
 * 依赖：--import ./scripts/crisis-sim/register-ts-paths.mjs 提供 @/ 别名与 JSON import 支持。
 *
 * 覆盖主Agent规定的 13 项：六项 Eval、角色 DAG、动态截止、结构化人工审批、
 * Context Broker 四行为、安全计数、反冒充门禁、Verified Replay 拒绝、人工收据边界、
 * Skill Candidate 未晋升、route.ts 静态安全审查、Fixture 来源与披露不漂移。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { CLOUD_AGENTTEAMS_ROLES } from "../../app/src/lib/admin/cloud-agentteams-contract.ts";
import {
  buildHumanDecisionReceipt,
  canonicalDigest,
  CRISIS_HUMAN_DECISION_RECEIPT_SCHEMA,
  CRISIS_PROTOCOL_SIMULATION_SCHEMA,
  CRISIS_SKILL_CANDIDATE_SCHEMA,
  loadCrisisSimFixtures,
} from "../../app/src/lib/crisis-sim/contracts.ts";
import { runRequiredDemoBehaviors } from "../../app/src/lib/crisis-sim/context-broker.ts";
import { runCrisisEvals } from "../../app/src/lib/crisis-sim/evals.ts";
import { runCrisisProtocolSimulation, tLabelFor } from "../../app/src/lib/crisis-sim/protocol-simulator.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SIMULATOR_SOURCE_PATH = path.join(REPO_ROOT, "app/src/lib/crisis-sim/protocol-simulator.ts");
const ROUTE_SOURCE_PATH = path.join(REPO_ROOT, "app/src/app/admin/api/crisis-sim/route.ts");
const AUTH_HELPER_PATH = path.join(REPO_ROOT, "app/src/app/admin/api/agent-studio/auth.ts");
const EXPORTER_PATH = path.join(REPO_ROOT, "scripts/crisis-sim/export-verified-replay.mjs");
const SMOKE_SCRIPT_PATH = path.join(REPO_ROOT, "scripts/crisis-sim/run-protocol-smoke.ps1");

const fixtures = loadCrisisSimFixtures();

function runReport(presetId, presetOverride) {
  const preset = presetOverride ?? fixtures.presets[presetId];
  return runCrisisProtocolSimulation({
    preset,
    library: fixtures.library,
    // digests 以文件名（非 presetId）为键；直接按 canonicalDigest 重算，语义一致
    presetDigest: canonicalDigest(preset),
    libraryDigest: fixtures.digests["virtual-private-library.json"],
    generatedAt: new Date().toISOString(),
  });
}

/** 深克隆 fixture 并覆盖 dynamicTime 字段（篡改测试用，不改原 fixture）。 */
function clonePresetWith(presetId, dynamicTimePatch) {
  const preset = JSON.parse(JSON.stringify(fixtures.presets[presetId]));
  Object.assign(preset.dynamicTime, dynamicTimePatch);
  return preset;
}

function collectKeys(value, keys = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

// ① 两个 preset 六项 Eval 全部通过
for (const presetId of fixtures.presetOrder) {
  test(`① 六项 Eval 全部通过：${presetId}`, () => {
    const preset = fixtures.presets[presetId];
    const report = runReport(presetId);
    const evalReport = runCrisisEvals({ preset, library: fixtures.library, report }, new Date().toISOString());
    assert.equal(evalReport.outcomes.length, 6, "必须是六项 Eval");
    assert.equal(evalReport.allPassed, true,
      `未通过的 Eval：${evalReport.outcomes.filter((o) => !o.passed).map((o) => `${o.evalId}(${o.detail})`).join("；") || "无"}`);
    for (const outcome of evalReport.outcomes) {
      assert.equal(outcome.passed, true, `${outcome.evalId}: ${outcome.detail}`);
    }
  });
}

// ② 四角色齐全且与 CLOUD_AGENTTEAMS_ROLES 一致、dependsOn 依赖存在且无环
for (const presetId of fixtures.presetOrder) {
  test(`② 四角色 DAG 与 AgentTeams 合同一致：${presetId}`, () => {
    const preset = fixtures.presets[presetId];
    const roleIds = preset.roles.map((role) => role.roleId);
    assert.deepEqual([...roleIds].sort(), [...CLOUD_AGENTTEAMS_ROLES].sort());
    for (const role of preset.roles) {
      for (const dep of role.dependsOn) {
        assert.ok(roleIds.includes(dep), `${role.roleId} 依赖不存在的角色 ${dep}`);
      }
    }
    // 显式无环检查（三色标记）
    const state = new Map();
    const visit = (roleId, stack) => {
      const current = state.get(roleId) ?? 0;
      assert.notEqual(current, 1, `dependsOn 存在环：${[...stack, roleId].join(" → ")}`);
      if (current === 2) return;
      state.set(roleId, 1);
      const role = preset.roles.find((item) => item.roleId === roleId);
      for (const dep of role.dependsOn) visit(dep, [...stack, roleId]);
      state.set(roleId, 2);
    };
    for (const role of preset.roles) visit(role.roleId, []);
    // 模拟器拓扑深度必须与 DAG 一致
    const report = runReport(presetId);
    assert.equal(report.roleSteps.length, CLOUD_AGENTTEAMS_ROLES.length);
    for (const step of report.roleSteps) {
      assert.ok(step.depth >= 0 && Number.isInteger(step.depth));
      assert.deepEqual([...step.dependsOn].sort(), [...(preset.roles.find((r) => r.roleId === step.roleId)?.dependsOn ?? [])].sort());
    }
  });
}

// ③ 动态截止：T 标签由绝对时间计算，篡改 simulatedNowAt 后派生值随之变化
test("③ T 标签由绝对时间动态计算，篡改 simulatedNowAt 生效", () => {
  const presetId = "2014-east-art-center";
  const preset = fixtures.presets[presetId];
  const deadlineAt = preset.dynamicTime.decisionDeadlineAt;
  const report = runReport(presetId);

  // 每个 T 标签都必须等于「绝对时间 − decisionDeadlineAt」的重算值（不是写死的字符串）
  for (const deadline of report.dynamicTimeView.deadlines) {
    assert.equal(deadline.tLabel, tLabelFor(deadline.at, deadlineAt), `deadline ${deadline.id}`);
    assert.equal(deadline.minutesFromSimulatedNow,
      Math.round((new Date(deadline.at) - new Date(preset.dynamicTime.simulatedNowAt)) / 60000));
  }
  for (const milestone of report.dynamicTimeView.milestones) {
    assert.equal(milestone.tLabel, tLabelFor(milestone.at, deadlineAt), `milestone ${milestone.label}`);
  }
  assert.equal(report.dynamicTimeView.tLabelAtSimulatedNow, tLabelFor(preset.dynamicTime.simulatedNowAt, deadlineAt));
  assert.match(report.reportId, new RegExp(`^cps_${presetId}_[0-9a-f]{8}_[0-9a-f]{8}$`));

  // 引擎源码不得写死任何非零 T-xx 字面量（"T-0" 是计算分支，允许；T-80 等只许由绝对时间推导复现）
  const simulatorSource = readFileSync(SIMULATOR_SOURCE_PATH, "utf8");
  assert.ok(!/["'`]T-[1-9]\d*/.test(simulatorSource), "protocol-simulator.ts 中不得硬编码 T-xx 标签");

  // 篡改 simulatedNowAt（+35 分钟）：minutesFromSimulatedNow 与 tLabelAtSimulatedNow 必须跟随变化
  const shiftedNow = new Date(new Date(preset.dynamicTime.simulatedNowAt).getTime() + 35 * 60000).toISOString();
  const tampered = clonePresetWith(presetId, { simulatedNowAt: shiftedNow });
  const tamperedReport = runReport(presetId, tampered);
  assert.notEqual(tamperedReport.dynamicTimeView.simulatedNowAt, report.dynamicTimeView.simulatedNowAt);
  assert.equal(tamperedReport.dynamicTimeView.tLabelAtSimulatedNow, tLabelFor(shiftedNow, deadlineAt));
  assert.notEqual(tamperedReport.dynamicTimeView.tLabelAtSimulatedNow, report.dynamicTimeView.tLabelAtSimulatedNow,
    "simulatedNowAt 篡改后 T 标签必须变化（不得是静态字符串）");
  for (let i = 0; i < report.dynamicTimeView.deadlines.length; i += 1) {
    const before = report.dynamicTimeView.deadlines[i];
    const after = tamperedReport.dynamicTimeView.deadlines[i];
    assert.equal(after.minutesFromSimulatedNow, before.minutesFromSimulatedNow - 35, `deadline ${before.id} 相对分钟数必须随 now 平移`);
    // 相对截止时间的 tLabel 不随 now 篡改变化：它锚定 decisionDeadlineAt 这个绝对时刻
    assert.equal(after.tLabel, before.tLabel);
  }
});

// ④ 结构化 requiredHumanApprovals
for (const presetId of fixtures.presetOrder) {
  test(`④ requiredHumanApprovals 结构化且 Agent 不越权：${presetId}`, () => {
    const preset = fixtures.presets[presetId];
    assert.ok(preset.options.length > 0);
    const withApprovals = preset.options.filter((option) => option.requiredHumanApprovals.length > 0);
    assert.ok(withApprovals.length > 0, "每个 preset 至少一个方案声明结构化人工审批");
    for (const option of preset.options) {
      assert.ok(Array.isArray(option.requiredHumanApprovals), `${option.optionId} requiredHumanApprovals 必须是数组（必填，可空）`);
      if (option.permissionRefs !== undefined) {
        assert.ok(Array.isArray(option.permissionRefs) && option.permissionRefs.every((ref) => typeof ref === "string"),
          `${option.optionId} permissionRefs 必须是字符串数组`);
      }
      for (const approval of option.requiredHumanApprovals) {
        for (const field of ["approvalId", "label", "approver", "scope"]) {
          assert.ok(typeof approval[field] === "string" && approval[field].trim().length > 0,
            `${option.optionId}.${approval.approvalId ?? "?"} 缺少 ${field}`);
        }
      }
    }
    for (const option of withApprovals) {
      assert.ok(["not_authorized", "prepare_only"].includes(option.agentDecision),
        `${option.optionId} 声明了人工审批却获 Agent 授权：${option.agentDecision}`);
    }
    // optionMatrix 透传
    const report = runReport(presetId);
    for (const row of report.optionMatrix) {
      const option = preset.options.find((item) => item.optionId === row.optionId);
      assert.ok(option, `optionMatrix 出现未知 option ${row.optionId}`);
      assert.deepEqual(row.requiredHumanApprovals, option.requiredHumanApprovals, `${row.optionId} 审批要求必须透传`);
    }
  });
}

// ⑤ Context Broker 四条演示行为
test("⑤ Context Broker：允许读 / 元数据可见内容拒 / 完全不可见 / 审批拒", () => {
  const trace = runRequiredDemoBehaviors(fixtures.library);
  assert.equal(trace.length, 4, "requiredDemoBehaviors 必须正好四条");
  const byId = new Map(trace.map((item) => [item.behaviorId, item]));

  const allowed = byId.get("allowed-private-hit");
  assert.ok(allowed && allowed.expected === "read_excerpt_allowed");
  assert.equal(allowed.ok, true);
  assert.equal(allowed.lookup.allowed, true);
  assert.equal(allowed.lookup.reason, "role_permitted");

  const denied = byId.get("denied-private-read");
  assert.ok(denied && denied.expected === "metadata_visible_content_denied_handoff_required");
  assert.equal(denied.ok, true);
  assert.equal(denied.lookup.allowed, false);
  assert.equal(denied.lookup.metadataVisible, true);
  assert.equal(denied.lookup.handoffRequired, true);

  const hidden = byId.get("hidden-record-invisible");
  assert.ok(hidden && hidden.expected === "metadata_hidden_handoff_required");
  assert.equal(hidden.ok, true);
  assert.equal(hidden.lookup.allowed, false);
  assert.equal(hidden.lookup.metadataVisible, false);

  const approval = byId.get("no-agent-approval");
  assert.ok(approval && approval.expected === "approval_denied_named_human_required");
  assert.equal(approval.action, "approve");
  assert.equal(approval.ok, true);
  assert.equal(approval.lookup.allowed, false);
  assert.match(approval.lookup.note, /具名人类/, "approve 拒绝必须提示具名人类");

  // 报告里的 brokerTrace 同样全部符合预期
  for (const presetId of fixtures.presetOrder) {
    const report = runReport(presetId);
    assert.ok(report.brokerTrace.length >= 4);
    assert.ok(report.brokerTrace.every((item) => item.ok), `${presetId} brokerTrace 存在未达预期项`);
  }
});

// ⑥ 安全计数全零（preset 与 report 两层）
test("⑥ 安全计数全零（fixture 与报告两层）", () => {
  const keys = ["productionWrites", "publicPublishes", "realRefunds", "externalMessages"];
  for (const presetId of fixtures.presetOrder) {
    for (const key of keys) {
      assert.equal(fixtures.presets[presetId].safetyCounters[key], 0, `preset ${presetId}.${key}`);
      assert.equal(runReport(presetId).safetyCounters[key], 0, `report ${presetId}.${key}`);
    }
  }
});

// ⑦ 协议模拟产物不能冒充 Cloud Runtime Evidence
test("⑦ 报告 schema 与字段不含任何运行时证据伪装", () => {
  for (const presetId of fixtures.presetOrder) {
    const report = runReport(presetId);
    assert.equal(report.schema, CRISIS_PROTOCOL_SIMULATION_SCHEMA);
    assert.equal(report.schema, "juchang-crisis-protocol-simulation@1");
    assert.equal(report.runKind, "protocol_simulation");
    assert.equal(report.zeroModelCalls, true);
    const keys = collectKeys(report);
    const masquerade = keys.filter((key) => /runtime.?evidence|cloud.?runtime/i.test(key));
    assert.deepEqual(masquerade, [], `报告对象不得出现运行时证据类字段：${masquerade.join(", ")}`);
  }
});

// ⑧ Verified Replay 导出器拒绝协议模拟与伪造 receipt
test("⑧ export-verified-replay 拒绝协议模拟与伪造 receipt", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "crisis-sim-replay-gate-"));

  const simReportPath = path.join(tmp, "protocol-simulation-report.json");
  writeFileSync(simReportPath, JSON.stringify(runReport("2014-east-art-center")), "utf8");
  const fakePath = path.join(tmp, "fake-runtime-evidence.json");
  writeFileSync(fakePath, JSON.stringify({
    schema: "juchang-cloud-runtime-evidence@1",
    receipt: { schema: "juchang-crisis-protocol-simulation@1", note: "伪装 receipt" },
  }), "utf8");

  // stderr 走临时文件而非 pipe：受限沙箱禁用命名管道时也能跑
  const runExporter = (inputPath, tag) => {
    const errPath = path.join(tmp, `${tag}.stderr.txt`);
    const errFd = openSync(errPath, "w");
    try {
      const result = spawnSync(process.execPath, [EXPORTER_PATH, inputPath], {
        cwd: REPO_ROOT,
        stdio: ["ignore", "ignore", errFd],
      });
      return {
        status: result.status,
        error: result.error ?? null,
        stderr: result.error ? String(result.error) : readFileSync(errPath, "utf8"),
      };
    } finally {
      closeSync(errFd);
    }
  };

  const simResult = runExporter(simReportPath, "sim-report");
  const fakeResult = runExporter(fakePath, "fake-evidence");
  const spawnEperm = [simResult, fakeResult].some((r) => r.error && r.error.code === "EPERM");

  if (spawnEperm) {
    // sandbox-skip：Windows 沙箱禁止子进程管道/创建，exit-code 断言由主Agent提权集成运行覆盖。
    // 降级路径：直接 import exporter 的纯门禁函数，断言同一门禁分支对两个输入的判定。
    console.log(
      "[sandbox-skip] spawn EPERM：跳过 exit code/stderr 子进程断言，" +
      "改为直接调用 gateRuntimeEvidenceInput 验证门禁分支（完整子进程断言由集成阶段提权运行）。",
    );
    const { gateRuntimeEvidenceInput } = await import("./export-verified-replay.mjs");
    const simGate = gateRuntimeEvidenceInput(JSON.parse(readFileSync(simReportPath, "utf8")));
    assert.equal(simGate.ok, false, "协议模拟必须被门禁拒绝");
    assert.match(simGate.message, /schema 门禁/);
    assert.match(simGate.message, /juchang-cloud-runtime-evidence@1/);
    const fakeGate = gateRuntimeEvidenceInput(JSON.parse(readFileSync(fakePath, "utf8")));
    assert.equal(fakeGate.ok, false, "伪造 receipt 必须被门禁拒绝");
    assert.match(fakeGate.message, /receipt/);
    // CLI 外壳静态断言：门禁失败必须以 exit(1) 收尾（exit code 语义不漂移）
    const exporterSource = readFileSync(EXPORTER_PATH, "utf8");
    const gateCallIdx = exporterSource.indexOf("gateRuntimeEvidenceInput(raw)");
    assert.ok(gateCallIdx !== -1, "CLI main() 必须调用 gateRuntimeEvidenceInput");
    assert.ok(exporterSource.indexOf("process.exit(1)", gateCallIdx) !== -1, "门禁失败后必须 process.exit(1)");
    return;
  }

  assert.equal(simResult.error, null, `exporter 子进程异常：${simResult.error}`);
  assert.equal(simResult.status, 1, `协议模拟必须被拒（stderr: ${simResult.stderr}）`);
  assert.match(simResult.stderr, /schema 门禁/);
  assert.match(simResult.stderr, /juchang-cloud-runtime-evidence@1/);

  // schema 伪装成运行时证据，但 receipt 不合法 → 同样拒
  assert.equal(fakeResult.error, null, `exporter 子进程异常：${fakeResult.error}`);
  assert.equal(fakeResult.status, 1, `伪造 receipt 必须被拒（stderr: ${fakeResult.stderr}）`);
  assert.match(fakeResult.stderr, /receipt/);
});

// ⑨ 人工决定永远不授予执行权
test("⑨ buildHumanDecisionReceipt：executionAuthorized 恒 false，reason 太短抛错", () => {
  const preset = fixtures.presets["2014-east-art-center"];
  const base = {
    preset,
    presetDigest: fixtures.digests["2014-east-art-center.preset.json"],
    agentRunDigest: "a".repeat(64),
    decidedAt: "2026-09-02T10:00:00.000Z",
  };
  for (const decision of ["approve_simulated_plan", "reject", "request_more_evidence"]) {
    for (const runKind of ["protocol_simulation", "live_agent_run"]) {
      const receipt = buildHumanDecisionReceipt({ ...base, decision, runKind, reason: "人工指挥官基于决策包的具名判断" });
      assert.equal(receipt.schema, CRISIS_HUMAN_DECISION_RECEIPT_SCHEMA);
      assert.equal(receipt.executionAuthorized, false, `${decision}/${runKind} 不得授予执行权`);
      assert.equal(receipt.simulationOnly, true);
      assert.equal(receipt.decisionMakerRole, "human_incident_commander");
      assert.equal(receipt.decision, decision);
    }
  }
  for (const badReason of ["", "   ", "短", "abc"]) {
    assert.throws(() => buildHumanDecisionReceipt({ ...base, decision: "reject", runKind: "protocol_simulation", reason: badReason }),
      /reason 必须至少 4 个字符/);
  }
});

// ⑩ Skill Candidate 未晋升
test("⑩ skillCandidate 保持候选状态，promotionGate.promoted === false", () => {
  for (const presetId of fixtures.presetOrder) {
    const candidate = runReport(presetId).skillCandidate;
    assert.equal(candidate.schema, CRISIS_SKILL_CANDIDATE_SCHEMA);
    assert.equal(candidate.status, "candidate");
    assert.equal(candidate.promotionGate.promoted, false);
    assert.equal(candidate.promotionGate.requiresSecondCase, true);
    assert.equal(candidate.sourcePresetId, presetId);
  }
});

// ⑪⑫ route.ts 静态安全审查：Origin / Cookie / 授权门禁次序
test("⑪⑫ route.ts：Origin 拒绝、GET 浏览器信任检查、双层 authorizeAgentStudio、415", () => {
  const source = readFileSync(ROUTE_SOURCE_PATH, "utf8");

  // ⑫ 无效 Cookie/未授权被拒：GET 用 isTrustedBrowserReadRequest，两个方法都用 authorizeAgentStudio
  assert.ok(source.includes("isTrustedBrowserReadRequest"), "GET 必须使用 isTrustedBrowserReadRequest");
  const getBody = source.slice(source.indexOf("export async function GET"));
  const getTrustedIdx = getBody.indexOf("isTrustedBrowserReadRequest(request)");
  const getAuthIdx = getBody.indexOf("authorizeAgentStudio()");
  assert.ok(getTrustedIdx !== -1 && getAuthIdx !== -1 && getTrustedIdx < getAuthIdx,
    "GET 必须先做浏览器信任检查再做授权");

  // ⑪ 错误 Origin 被拒：POST 先调用 rejectInvalidPostOrigin
  const postBody = source.slice(source.indexOf("export async function POST"));
  const originIdx = postBody.indexOf("rejectInvalidPostOrigin(request)");
  const postAuthIdx = postBody.indexOf("authorizeAgentStudio()");
  assert.ok(originIdx !== -1, "POST 必须调用 rejectInvalidPostOrigin");
  assert.ok(originIdx < postAuthIdx, "POST 必须先拒绝错误 Origin 再做授权");

  // 415 内容类型检查在授权之后、解析 body 之前
  assert.ok(/status:\s*415/.test(postBody), "POST 必须有 415 内容类型门禁");
  assert.ok(postBody.indexOf("415") < postBody.indexOf("request.json()"), "415 必须先于 body 解析");

  // authorizeAgentStudio 出现两次（GET + POST）
  assert.equal(source.split("authorizeAgentStudio()").length - 1 >= 2, true);

  // 不写 PocketBase、不读环境密钥、错误不回传堆栈
  assert.ok(!/pocketbase|pb\.collection/i.test(source), "route.ts 不得写 PocketBase");
  assert.ok(!/process\.env/.test(source), "route.ts 不得直接读取环境变量/密钥");
  assert.ok(!source.includes("error.stack"), "错误响应不得泄露堆栈");

  // 授权 helper 真实存在且导出两个门禁函数
  const authSource = readFileSync(AUTH_HELPER_PATH, "utf8");
  assert.ok(/export\s+(async\s+)?function\s+authorizeAgentStudio|export\s+const\s+authorizeAgentStudio/.test(authSource));
  assert.ok(/export\s+(async\s+)?function\s+rejectInvalidPostOrigin|export\s+const\s+rejectInvalidPostOrigin/.test(authSource));
});

// ⑭ 审计回归：smoke 读 evalReport.outcomes（假绿修复）；route 收据绑定收紧
test("⑭ 审计回归：smoke outcomes 字段 + route 收据绑定门禁", () => {
  // smoke 脚本必须读 evalReport.outcomes（曾误读 .evals 导致计数恒 0 的假绿）
  const smokeSource = readFileSync(SMOKE_SCRIPT_PATH, "utf8");
  // 含中文的 .ps1 必须带 UTF-8 BOM，否则 Windows PowerShell 5.1 按 ANSI(GBK) 误读直接解析崩溃
  // （2026-09-02 实测：无 BOM 时用户侧报「字符串缺少终止符」级解析错误，窗口秒退且无状态文件）
  const smokeBytes = readFileSync(SMOKE_SCRIPT_PATH);
  assert.ok(
    smokeBytes[0] === 0xef && smokeBytes[1] === 0xbb && smokeBytes[2] === 0xbf,
    "run-protocol-smoke.ps1 必须以 UTF-8 BOM 开头（PS 5.1 中文脚本硬性要求）",
  );
  assert.ok(smokeSource.includes("$parsed.outcomes"), "smoke 必须读取 evalReport.outcomes");
  assert.ok(!/\$parsed\.evals\b/.test(smokeSource), "smoke 不得再读取不存在的 .evals 字段（假绿回归）");
  // smoke 必须回传 run_eval 拿到的 reportId 以触发收据-报告一致性校验
  assert.ok(smokeSource.includes("report.reportId"), "smoke 必须从 run_eval 响应捕获 reportId");
  assert.ok(/\$decisionBodyHash\["reportId"\]/.test(smokeSource), "smoke 的 record_human_decision 必须回传 reportId");

  // route.ts 收据绑定收紧（静态断言）
  const source = readFileSync(ROUTE_SOURCE_PATH, "utf8");
  // protocol_simulation：客户端回传 reportId 时必须与确定性重跑一致
  assert.ok(source.includes("body.reportId"), "route 必须接受并校验客户端回传的 reportId");
  assert.ok(/reportId\s*!==\s*report\.reportId/.test(source), "reportId 必须与确定性重跑的 report.reportId 比对");
  // live_agent_run：agentRunDigest 必须是 64 位十六进制（不再是长度≥8）
  assert.ok(/\[0-9a-f\]\{64\}/.test(source), "live_agent_run 的 agentRunDigest 必须校验 64 位十六进制");
  assert.ok(!/length\s*<\s*8/.test(source), "长度≥8 的弱校验必须移除");
});

// ⑬ Fixture 来源哈希与模拟声明不漂移
test("⑬ provenance 全 verified，披露声明不漂移", () => {
  assert.equal(fixtures.provenance.length, 3);
  for (const item of fixtures.provenance) {
    assert.equal(item.verified, true, `${item.fixture} 来源哈希漂移`);
    assert.equal(item.recordedSourceFileSha256, item.expectedSourceFileSha256, `${item.fixture} 记录哈希与期望不一致`);
    assert.match(item.canonicalDigest, /^[0-9a-f]{64}$/);
  }
  // 回归：presetDigests 以 presetId（而非文件名）为键——stage preset 的 presetId 是
  // "stage-malfunction-demo"，与文件名 "stage-malfunction.preset.json" 不同，曾致 route 503
  for (const presetId of fixtures.presetOrder) {
    const digest = fixtures.presetDigests[presetId];
    assert.ok(typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest),
      `presetDigests[${presetId}] 必须是 64 位十六进制非空字符串，实际：${String(digest)}`);
    // 与 canonicalDigest 重算一致，杜绝键名/内容错位
    assert.equal(digest, canonicalDigest(fixtures.presets[presetId]), `presetDigests[${presetId}] 与 fixture 内容不一致`);
  }
  // route.ts 不得再用「presetId 拼文件名」的旧索引方式
  const routeSource = readFileSync(ROUTE_SOURCE_PATH, "utf8");
  assert.ok(!routeSource.includes("`${preset.presetId}.preset.json`") && !routeSource.includes("`${presetId}.preset.json`"),
    "route.ts 不得再用 `${presetId}.preset.json` 索引 digests（键是文件名而非 presetId 的回归）");
  assert.ok(routeSource.includes("fixtures.presetDigests[preset.presetId]"), "route.ts 必须使用 presetDigests[presetId] 新字段");
  assert.equal(fixtures.presets["2014-east-art-center"].disclosure.isLiveRun, false);
  assert.equal(fixtures.presets["2014-east-art-center"].disclosure.runKind, "protocol_simulation");
  assert.equal(fixtures.library.disclosure.synthetic, true);
  assert.equal(fixtures.library.disclosure.containsRealSecrets, false);
  assert.equal(fixtures.library.disclosure.containsRealPersonalData, false);
  assert.equal(fixtures.library.disclosure.notAuthoritativeForHistoricalFact, true);
});

// ⑮ Skill 调用 trace 诚实性：技能包真实存在，回放 skillInvocations 的哈希可从真实文件重导
test("⑮ skillInvocations 诚实且含真实哈希（技能包 + 回放 fixture 可重导）", () => {
  const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
  const SKILL_DIR = path.join(REPO_ROOT, "scripts/crisis-sim/skills/artist-substitution-feasibility");

  // 技能包三文件真实存在且自洽
  const skillMd = readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
  assert.match(skillMd, /artist-substitution-feasibility/);
  assert.match(skillMd, /0\.1\.0/, "SKILL.md 必须声明版本 0.1.0");
  const authority = JSON.parse(readFileSync(path.join(SKILL_DIR, "authority.json"), "utf8"));
  assert.equal(authority.schema, "juchang-skill-authority@1");
  assert.equal(authority.skillId, "artist-substitution-feasibility");
  assert.equal(authority.deterministic, true);
  assert.equal(authority.modelCalls, 0, "核对器为零模型确定性脚本");
  const checkSource = readFileSync(path.join(SKILL_DIR, "check.mjs"), "utf8");
  assert.ok(!/fetch\(|https?\.request|process\.env/.test(checkSource), "核对器不得访问网络或环境变量");

  // 真实技能包哈希（与组装器同一算法：{文件名: 文件sha256} 按文件名排序的稳定序列化）
  const bundleMap = {};
  for (const name of ["SKILL.md", "check.mjs", "authority.json"]) {
    bundleMap[name] = sha256(readFileSync(path.join(SKILL_DIR, name)));
  }
  const expectedBundleSha256 = sha256(Buffer.from(JSON.stringify(bundleMap, Object.keys(bundleMap).sort()), "utf8"));
  const expectedAuthoritySha256 = sha256(readFileSync(path.join(SKILL_DIR, "authority.json")));

  // 回放 fixture 中的 skillInvocations：身份、哈希、来源标注逐项核对
  const dataDir = path.join(REPO_ROOT, "app/src/data/crisis-sim");
  const replayFiles = readdirSync(dataDir).filter((f) => f.startsWith("verified-replay-") && f.endsWith(".json"));
  assert.ok(replayFiles.length > 0, "至少存在一个 verified replay fixture");
  const withSkills = replayFiles
    .map((f) => ({ file: f, fixture: JSON.parse(readFileSync(path.join(dataDir, f), "utf8")) }))
    .filter(({ fixture }) => Array.isArray(fixture.replay?.skillInvocations) && fixture.replay.skillInvocations.length > 0);
  assert.ok(withSkills.length > 0, "至少一个回放含 skillInvocations（真实 Skill trace，禁止空壳）");

  for (const { file, fixture } of withSkills) {
    for (const invocation of fixture.replay.skillInvocations) {
      assert.equal(invocation.skillId, "artist-substitution-feasibility", `${file}: skillId`);
      assert.equal(invocation.version, "0.1.0", `${file}: version`);
      assert.equal(invocation.status, "succeeded", `${file}: status`);
      assert.equal(invocation.claimableAsFreshEvidence, true, `${file}: claimableAsFreshEvidence`);
      assert.match(String(invocation.digest), /^[0-9a-f]{64}$/, `${file}: digest 必须是 64 位十六进制`);
      assert.equal(invocation.bundleSha256, expectedBundleSha256,
        `${file}: bundleSha256 必须等于当前真实技能包哈希（可从文件重导，非手写值）`);
      assert.equal(invocation.authoritySha256, expectedAuthoritySha256,
        `${file}: authoritySha256 必须等于真实 authority.json 哈希`);
      assert.equal(invocation.runtime, "dsh-local-session", `${file}: 必须如实标注本地会话来源`);
      assert.ok(Number.isFinite(Date.parse(invocation.invokedAt)), `${file}: invokedAt 必须是真实可解析时间`);
      // 输出哈希可重导：verdict 文件仍在运行证据目录时，digest 必须等于其 sha256
      const verdictPath = path.join(REPO_ROOT, String(invocation.outputPath ?? ""));
      if (invocation.outputPath && existsSync(verdictPath)) {
        assert.equal(invocation.digest, sha256(readFileSync(verdictPath)),
          `${file}: digest 必须等于真实 verdict 输出文件的 sha256`);
      }
    }
  }
});
