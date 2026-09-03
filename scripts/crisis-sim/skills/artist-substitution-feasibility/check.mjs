#!/usr/bin/env node
/**
 * artist-substitution-feasibility 核对器（确定性脚本，零模型调用）。
 *
 * 用法：
 *   node check.mjs --preset <preset.json> --library <library.json> [--out <verdict.json>]
 *
 * 契约：juchang-skill-checklist-verdict@1。规则全文即本文件 RULES 数组（与 SKILL.md 对应）。
 * 红线：规则未命中时 verdict 只能是 unknown 或 fails，绝不把缺失证据报告为成立；
 *       --out 仅允许落在 output/crisis-sim/**；不访问网络、不读环境变量。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_ID = "artist-substitution-feasibility";
const SKILL_VERSION = "0.1.0";
const VERDICT_CONTRACT = "juchang-skill-checklist-verdict@1";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT_ALLOW_ROOT = path.join(REPO_ROOT, "output", "crisis-sim");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function fail(message) {
  console.error(`[FAIL] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { preset: null, library: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--preset") args.preset = argv[(i += 1)];
    else if (arg === "--library") args.library = argv[(i += 1)];
    else if (arg === "--out") args.out = argv[(i += 1)];
    else fail(`未知参数: ${arg}`);
  }
  if (!args.preset || !args.library) fail("必须提供 --preset 与 --library");
  return args;
}

function loadJson(filePath, expectedSchema, label) {
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) fail(`${label} 不存在: ${resolved}`);
  const bytes = readFileSync(resolved);
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`${label} 不是合法 JSON: ${resolved}`);
  }
  if (parsed?.schema !== expectedSchema) {
    fail(`${label} schema 不符：期望 ${expectedSchema}，实际 ${String(parsed?.schema)}`);
  }
  return { data: parsed, sha256: sha256(bytes), path: path.relative(REPO_ROOT, resolved).replace(/\\/g, "/") };
}

/** 在闭源库中按 recordId 找记录。 */
function findRecord(library, recordId) {
  for (const collection of library.collections ?? []) {
    for (const record of collection.records ?? []) {
      if (record.recordId === recordId) return { record, collectionId: collection.collectionId };
    }
  }
  return null;
}

/** 截取真实原文短句作为 matched 证据（取自数据本身，不是脚本自造）。 */
function quote(text, pattern) {
  const match = String(text ?? "").match(pattern);
  if (!match) return null;
  const start = Math.max(0, match.index - 6);
  return String(text).slice(start, match.index + match[0].length + 12);
}

function unknownMissing(itemId, what) {
  return { itemId, verdict: "unknown", basis: ["structure-missing"], matched: `structure-missing: ${what}`, note: "预期数据结构缺失，按未知处理（不静默跳过）" };
}

/**
 * 九项 checklist 规则。每项返回 { itemId, question, verdict, basis, matched, note }。
 * verdict ∈ holds | fails | unknown。
 */
const RULES = [
  {
    itemId: "named-substitute-candidate-exists",
    question: "存在具名替补钢琴家候选？",
    evaluate({ preset, library }) {
      const option = (preset.options ?? []).find((o) => o.optionId === "option-find-pianist-substitute");
      if (!option) return unknownMissing(this.itemId, "preset option-find-pianist-substitute");
      const blocker = (option.knownBlockers ?? []).find((b) => /人选|候选/.test(b));
      const libraryHasPianistSubstitute = (library.collections ?? [])
        .flatMap((c) => c.records ?? [])
        .some((r) => /钢琴/.test(r.summary ?? "") && /替补|候选/.test(r.summary ?? ""));
      if (blocker && !libraryHasPianistSubstitute) {
        return {
          itemId: this.itemId, question: this.question, verdict: "fails",
          basis: ["preset:option:option-find-pianist-substitute"],
          matched: blocker,
          note: "preset 阻断登记声明无确认人选，闭源库亦无钢琴替补记录",
        };
      }
      if (!blocker && libraryHasPianistSubstitute) {
        return { itemId: this.itemId, question: this.question, verdict: "holds", basis: ["library:artists-collaboration"], matched: "闭源库存在钢琴替补候选记录", note: "" };
      }
      return {
        itemId: this.itemId, question: this.question, verdict: "unknown",
        basis: ["preset:option:option-find-pianist-substitute"],
        matched: blocker ?? "(knownBlockers 无人选类条目)",
        note: "阻断登记与闭源库信号不一致，按未知处理",
      };
    },
  },
  {
    itemId: "artist-consent-confirmed",
    question: "候选艺术家本人同意已确认？",
    evaluate({ library }) {
      const hit = findRecord(library, "candidate-kavakos-shanghai");
      if (!hit) return unknownMissing(this.itemId, "library candidate-kavakos-shanghai");
      const matched = quote(hit.record.summary, /本人意愿[^；。]*?(需|待)[^；。]*?确认/);
      if (matched) {
        return {
          itemId: this.itemId, question: this.question, verdict: "unknown",
          basis: ["library:candidate-kavakos-shanghai"], matched,
          note: "闭源库明示本人意愿需现场确认，且该记录自述不是实时档期证明",
        };
      }
      return { itemId: this.itemId, question: this.question, verdict: "unknown", basis: ["library:candidate-kavakos-shanghai"], matched: hit.record.summary ?? "", note: "规则未命中，按未知处理" };
    },
  },
  {
    itemId: "inviting-party-permission-obtained",
    question: "原邀请方许可已取得？",
    evaluate({ preset, library }) {
      const rule = findRecord(library, "permission-visiting-artist-third-party");
      const hall = (preset.stakeholders ?? []).find((s) => s.stakeholderId === "shanghai-concert-hall");
      if (!rule || !hall) return unknownMissing(this.itemId, "permission record / shanghai-concert-hall");
      const requiresGrant = /必须获得原邀请方与艺术家授权/.test(rule.record.summary ?? "");
      const permissionPending = (hall.roles ?? []).includes("permission_required");
      const grantEvidence = (library.collections ?? [])
        .flatMap((c) => c.records ?? [])
        .some((r) => /许可|授权/.test(r.summary ?? "") && /已(取得|获得|授予)/.test(r.summary ?? ""));
      if (requiresGrant && permissionPending && !grantEvidence) {
        return {
          itemId: this.itemId, question: this.question, verdict: "fails",
          basis: ["library:permission-visiting-artist-third-party", "preset:stakeholder:shanghai-concert-hall"],
          matched: quote(rule.record.summary, /必须获得原邀请方与艺术家授权/) ?? rule.record.summary,
          note: "规则要求授权、干系人标注 permission_required、全库无任何授予证据——许可当前未取得",
        };
      }
      return { itemId: this.itemId, question: this.question, verdict: "unknown", basis: ["library:permission-visiting-artist-third-party"], matched: rule.record.summary ?? "", note: "信号不一致，按未知处理" };
    },
  },
  {
    itemId: "rehearsal-completed",
    question: "与指挥/乐团已完成合排？",
    evaluate({ library }) {
      const hit = findRecord(library, "collaboration-kavakos-chailly-orchestra");
      if (!hit) return unknownMissing(this.itemId, "library collaboration-kavakos-chailly-orchestra");
      const matched = quote(hit.record.summary, /未合排/);
      if (matched) {
        return {
          itemId: this.itemId, question: this.question, verdict: "fails",
          basis: ["library:collaboration-kavakos-chailly-orchestra"], matched,
          note: "闭源库明示本场未合排；合作史不能证明当晚质量",
        };
      }
      return { itemId: this.itemId, question: this.question, verdict: "unknown", basis: ["library:collaboration-kavakos-chailly-orchestra"], matched: hit.record.summary ?? "", note: "规则未命中，按未知处理" };
    },
  },
  {
    itemId: "mahler-roster-recallable",
    question: "马勒七缺员可在剩余时间召回？",
    evaluate({ library }) {
      const hit = findRecord(library, "roster-current-night");
      if (!hit) return unknownMissing(this.itemId, "library roster-current-night");
      const matched = quote(hit.record.summary, /缺少[^；。]*?无法[^；。]*?召回/);
      if (matched) {
        return {
          itemId: this.itemId, question: this.question, verdict: "fails",
          basis: ["library:roster-current-night"], matched,
          note: "闭源库明示缺员且无法召回（人数为口述约数）",
        };
      }
      return { itemId: this.itemId, question: this.question, verdict: "unknown", basis: ["library:roster-current-night"], matched: hit.record.summary ?? "", note: "规则未命中，按未知处理" };
    },
  },
  {
    itemId: "decision-deadline-confidence-high",
    question: "决定截止时间为高置信？",
    evaluate({ preset }) {
      const deadline = (preset.dynamicTime?.deadlines ?? []).find((d) => d.id === "dl-substitute-decision");
      if (!deadline) return unknownMissing(this.itemId, "preset dynamicTime.deadlines dl-substitute-decision");
      if (deadline.confidence === "high") {
        return { itemId: this.itemId, question: this.question, verdict: "holds", basis: ["preset:dynamicTime.deadlines"], matched: `"confidence": "high" @ ${deadline.at}`, note: "" };
      }
      return {
        itemId: this.itemId, question: this.question, verdict: "unknown",
        basis: ["preset:dynamicTime.deadlines"],
        matched: `"source": "${deadline.source}", "confidence": "${deadline.confidence}" @ ${deadline.at}`,
        note: `截止时间为 ${deadline.source}（${deadline.confidence}），非高置信，须人核实真实窗口`,
      };
    },
  },
  {
    itemId: "broadcast-risk-eliminated",
    question: "直播永久记录风险已消除？",
    evaluate({ library }) {
      const hit = findRecord(library, "broadcast-lock-state");
      if (!hit) return unknownMissing(this.itemId, "library broadcast-lock-state");
      const matched = quote(hit.record.summary, /永久记录/);
      if (matched) {
        return {
          itemId: this.itemId, question: this.question, verdict: "fails",
          basis: ["library:broadcast-lock-state"], matched,
          note: "传播临近锁定且失误会被永久记录——风险未消除",
        };
      }
      return { itemId: this.itemId, question: this.question, verdict: "unknown", basis: ["library:broadcast-lock-state"], matched: hit.record.summary ?? "", note: "规则未命中，按未知处理" };
    },
  },
  {
    itemId: "economic-authority-named",
    question: "具名经济授权人已确认？",
    evaluate({ preset, library }) {
      const auth = findRecord(library, "authority-live-program-change");
      const board = (preset.stakeholders ?? []).find((s) => s.stakeholderId === "board");
      if (!auth || !board) return unknownMissing(this.itemId, "authority record / board stakeholder");
      const matched = quote(auth.record.summary, /具名事件负责人/);
      if (matched && board.authorityStatus === "oral_testimony_requires_further_verification") {
        return {
          itemId: this.itemId, question: this.question, verdict: "unknown",
          basis: ["library:authority-live-program-change", "preset:stakeholder:board"],
          matched,
          note: "授权链要求具名人类，board 语境为口述待核实——具名授权人未确认",
        };
      }
      return { itemId: this.itemId, question: this.question, verdict: "unknown", basis: ["library:authority-live-program-change"], matched: auth.record.summary ?? "", note: "信号不一致，按未知处理" };
    },
  },
  {
    itemId: "fallback-route-viable",
    question: "兜底路线（缩短节目+退款）艺术/技术上可行？",
    evaluate({ preset }) {
      const option = (preset.options ?? []).find((o) => o.optionId === "option-shortened-program-half-refund");
      if (!option) return unknownMissing(this.itemId, "preset option-shortened-program-half-refund");
      const artisticOrTechnicalBlocker = (option.knownBlockers ?? []).some((b) => /乐手|编制|合排|乐谱|到场/.test(b));
      if (option.agentDecision === "prepare_only" && !artisticOrTechnicalBlocker) {
        return {
          itemId: this.itemId, question: this.question, verdict: "holds",
          basis: ["preset:option:option-shortened-program-half-refund", "preset:fact-refund"],
          matched: `"agentDecision": "${option.agentDecision}"；knownBlockers 无艺术/技术类条目`,
          note: "兜底路线艺术/技术可行；经济授权与协商仍为人工前置（不在本项范围）",
        };
      }
      return { itemId: this.itemId, question: this.question, verdict: "unknown", basis: ["preset:option:option-shortened-program-half-refund"], matched: `"agentDecision": "${option.agentDecision}"`, note: "信号不一致，按未知处理" };
    },
  },
];

function main() {
  const args = parseArgs(process.argv.slice(2));
  const preset = loadJson(args.preset, "juchang-crisis-scenario-preset@1", "preset");
  const library = loadJson(args.library, "juchang-synthetic-private-library@0.1", "library");

  const items = RULES.map((rule) => rule.evaluate({ preset: preset.data, library: library.data }));
  const counts = {
    holds: items.filter((i) => i.verdict === "holds").length,
    fails: items.filter((i) => i.verdict === "fails").length,
    unknown: items.filter((i) => i.verdict === "unknown").length,
  };
  const hardItems = new Set([
    "named-substitute-candidate-exists",
    "inviting-party-permission-obtained",
    "rehearsal-completed",
    "mahler-roster-recallable",
    "broadcast-risk-eliminated",
  ]);
  const overallVerdict = items.some((i) => hardItems.has(i.itemId) && i.verdict === "fails")
    ? "substitution_not_feasible_now"
    : counts.unknown > 0
      ? "substitution_conditionally_possible"
      : "substitution_feasible_per_current_materials";

  const verdict = {
    schema: VERDICT_CONTRACT,
    skill: { skillId: SKILL_ID, version: SKILL_VERSION, contract: VERDICT_CONTRACT },
    runtime: "deterministic-script",
    modelCalls: 0,
    inputs: [
      { kind: "preset", path: preset.path, sha256: preset.sha256 },
      { kind: "library", path: library.path, sha256: library.sha256 },
    ],
    generatedAt: new Date().toISOString(),
    items,
    counts,
    overallVerdict,
    disclosure: "本 verdict 由确定性脚本真实计算生成；规则未命中项一律 unknown/fails；不构成执行授权。",
  };
  const text = `${JSON.stringify(verdict, null, 2)}\n`;

  if (args.out) {
    const outResolved = path.resolve(args.out);
    if (!outResolved.toLowerCase().startsWith(OUT_ALLOW_ROOT.toLowerCase() + path.sep)) {
      fail(`--out 越出允许范围（仅允许 ${OUT_ALLOW_ROOT} 之下）: ${outResolved}`);
    }
    writeFileSync(outResolved, text, "utf8");
  }
  process.stdout.write(text);
}

main();
