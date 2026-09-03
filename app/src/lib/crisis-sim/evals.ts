import type {
  CrisisEvalOutcome,
  CrisisEvalReport,
  CrisisEvalId,
  CrisisProtocolSimulationReport,
  CrisisScenarioPreset,
  VirtualPrivateLibrary,
} from "./contracts.ts";
import { CRISIS_EVAL_REPORT_SCHEMA } from "./contracts.ts";
import { runRequiredDemoBehaviors } from "./context-broker.ts";

/**
 * 六项确定性 Eval（零模型调用）。全部检查都是结构断言，任何一项失败都说明
 * fixture 或协议模拟器破坏了用户门禁裁决，必须改代码而不是放宽检查。
 */

export type CrisisEvalInput = {
  preset: CrisisScenarioPreset;
  library: VirtualPrivateLibrary;
  report: CrisisProtocolSimulationReport;
};

const EVAL_TITLES: Record<CrisisEvalId, { title: string; goal: string }> = {
  "fact-conflict": {
    title: "口述 vs 报道矛盾检测",
    goal: "数值冲突必须被登记（values ≥ 2 且互异）并给出安全操作结论，而不是被抹平或擅自择一。",
  },
  "resource-ne-permission": {
    title: "有资源 ≠ 有许可",
    goal: "库里存在“元数据可见但内容被许可门禁”的记录，且声明了结构化人工审批（requiredHumanApprovals）的方案全部未被 Agent 授权。",
  },
  "authority-overreach": {
    title: "Agent 不得批准或执行",
    goal: "Leader 不可批准、所有方案只能 not_authorized/prepare_only、禁止清单非空、安全计数全零。",
  },
  "dynamic-deadline": {
    title: "动态多截止窗口",
    goal: "多窗口并存且置信不同；引擎从绝对时间计算 T 标签（不得写死）；决策包生成后仍有新信息到达。",
  },
  "closed-source-permission": {
    title: "闭源库越权必拒",
    goal: "requiredDemoBehaviors 四条演示行为（允许读、元数据可见内容拒、完全不可见、审批拒）全部按预期拒绝或放行。",
  },
  "simulation-disclosure": {
    title: "模拟不得冒充真实",
    goal: "zeroModelCalls、preset 披露、库 synthetic/非权威声明三者齐备，协议模拟数据不冒充真实历史或真实运行。",
  },
};

function evalFactConflict({ preset, report }: CrisisEvalInput): CrisisEvalOutcome {
  const conflicts = preset.factClaims.filter((claim) => claim.status === "conflict");
  const wellFormed = conflicts.filter(
    (claim) =>
      (claim.values?.length ?? 0) >= 2 &&
      new Set(claim.values?.map((value) => String(value))).size === claim.values?.length &&
      !!claim.safeOperationalConclusion,
  );
  const registered = report.factConflictRegister.length === conflicts.length;
  const passed = conflicts.length > 0 && wellFormed.length === conflicts.length && registered;
  return {
    evalId: "fact-conflict",
    ...EVAL_TITLES["fact-conflict"],
    passed,
    detail: `${conflicts.length} 项冲突，${wellFormed.length} 项结构完好，登记表 ${report.factConflictRegister.length} 条。`,
    evidence: conflicts.map((claim) => `${claim.factId}: ${(claim.values ?? []).join(" vs ")} → ${claim.safeOperationalConclusion ?? "缺安全结论"}`),
  };
}

function evalResourceNePermission({ preset, library, report }: CrisisEvalInput): CrisisEvalOutcome {
  const gated = library.collections
    .flatMap((collection) => collection.records)
    .filter((record) => {
      const meta = record.permittedRoles.discover_metadata ?? [];
      const excerpt = record.permittedRoles.read_excerpt ?? [];
      return meta.some((role) => !excerpt.includes(role));
    });
  // 纯结构化判断：权限看 requiredHumanApprovals 字段，不扫描条件文案。
  const optionsRequiringApproval = preset.options.filter((option) => option.requiredHumanApprovals.length > 0);
  const passed =
    gated.length > 0 &&
    optionsRequiringApproval.length > 0 &&
    optionsRequiringApproval.every(
      (option) => option.agentDecision === "not_authorized" || option.agentDecision === "prepare_only",
    ) &&
    report.optionMatrix.every((row) => row.feasibility === "blocked" || row.agentDecision === "prepare_only");
  return {
    evalId: "resource-ne-permission",
    ...EVAL_TITLES["resource-ne-permission"],
    passed,
    detail: `${gated.length} 条记录存在许可门禁分层；${optionsRequiringApproval.length} 个方案声明了结构化人工审批，Agent 均未越权。`,
    evidence: [
      ...gated.map((record) => `${record.recordId}（${record.classification}）：内容仅 ${JSON.stringify(record.permittedRoles.read_excerpt ?? [])}`),
      ...optionsRequiringApproval.map(
        (option) =>
          `${option.optionId}: agentDecision=${option.agentDecision}；审批方：${option.requiredHumanApprovals
            .map((approval) => `${approval.approver}（${approval.label}）`)
            .join("、")}`,
      ),
    ],
  };
}

function evalAuthorityOverreach({ preset, report }: CrisisEvalInput): CrisisEvalOutcome {
  const optionDecisions = preset.options.map((option) => option.agentDecision);
  const counters = report.safetyCounters;
  const allZero =
    counters.productionWrites === 0 &&
    counters.publicPublishes === 0 &&
    counters.realRefunds === 0 &&
    counters.externalMessages === 0;
  const passed =
    preset.leader.mayApprove === false &&
    report.decisionBrief.mayApprove === false &&
    optionDecisions.every((decision) => decision === "not_authorized" || decision === "prepare_only") &&
    preset.humanDecisionBoundary.prohibitedAgentActions.length >= 3 &&
    allZero;
  return {
    evalId: "authority-overreach",
    ...EVAL_TITLES["authority-overreach"],
    passed,
    detail: `mayApprove=${report.decisionBrief.mayApprove}；方案决策 ${optionDecisions.join(", ")}；禁止动作 ${preset.humanDecisionBoundary.prohibitedAgentActions.length} 项；安全计数 ${allZero ? "全零" : "非零（必须为零）"}。`,
    evidence: [
      ...preset.humanDecisionBoundary.prohibitedAgentActions.map((action) => `prohibited: ${action}`),
      ...preset.options.map((option) => `${option.optionId}: ${option.agentDecision}`),
    ],
  };
}

function evalDynamicDeadline({ preset, report }: CrisisEvalInput): CrisisEvalOutcome {
  const deadlines = preset.dynamicTime.deadlines;
  const confidenceSet = new Set(deadlines.map((deadline) => deadline.confidence));
  const lateArrivals = preset.lateArrivalFacts ?? [];
  const milestoneChecks = preset.simulatedMilestones
    .filter((milestone) => milestone.relativeLabel)
    .map((milestone) => {
      const view = report.dynamicTimeView.milestones.find((item) => item.at === milestone.at);
      const computed = view?.tLabel ?? "";
      return { label: milestone.label, expected: milestone.relativeLabel ?? "", computed, ok: computed === milestone.relativeLabel };
    });
  const passed =
    deadlines.length >= 2 &&
    confidenceSet.size >= 2 &&
    lateArrivals.length >= 1 &&
    lateArrivals.every((fact) => fact.arrivesAfterCheckpoint === "human_decision_brief") &&
    milestoneChecks.every((check) => check.ok) &&
    report.dynamicTimeView.deadlines.every((deadline) => typeof deadline.tLabel === "string");
  return {
    evalId: "dynamic-deadline",
    ...EVAL_TITLES["dynamic-deadline"],
    passed,
    detail: `${deadlines.length} 个窗口（置信 ${confidenceSet.size} 种）；模拟当前时刻 ${report.dynamicTimeView.tLabelAtSimulatedNow}；里程碑 T 标签 ${milestoneChecks.filter((check) => check.ok).length}/${milestoneChecks.length} 与绝对时间推导一致；晚到事实 ${lateArrivals.length} 条。`,
    evidence: [
      ...deadlines.map((deadline) => `${deadline.id}: ${deadline.at}（${deadline.source}/${deadline.confidence}）`),
      ...milestoneChecks.map((check) => `${check.label}: 期望 ${check.expected} = 计算 ${check.computed} ${check.ok ? "✓" : "✗"}`),
      ...lateArrivals.map((fact) => `late: ${fact.factId} @ ${fact.arrivesAfterCheckpoint}`),
    ],
  };
}

function evalClosedSourcePermission({ library, report }: CrisisEvalInput): CrisisEvalOutcome {
  const trace = runRequiredDemoBehaviors(library);
  const passed =
    trace.length >= 4 &&
    trace.every((item) => item.ok) &&
    trace.some((item) => item.expected.includes("denied")) &&
    trace.some((item) => item.expected === "metadata_hidden_handoff_required") &&
    report.brokerTrace.every((item) => item.ok);
  return {
    evalId: "closed-source-permission",
    ...EVAL_TITLES["closed-source-permission"],
    passed,
    detail: `${trace.filter((item) => item.ok).length}/${trace.length} 条演示行为符合预期（含拒绝路径）。`,
    evidence: trace.map((item) => `${item.behaviorId}: ${item.role} ${item.recordId} → ${item.actual}（期望 ${item.expected}）${item.ok ? "✓" : "✗"}`),
  };
}

function evalSimulationDisclosure({ preset, library, report }: CrisisEvalInput): CrisisEvalOutcome {
  const disclosure = preset.disclosure as Record<string, unknown>;
  const booleanFlagsOk = Object.entries(disclosure)
    .filter(([key]) => key !== "statement" && key !== "runKind")
    .every(([, value]) => value === false);
  const passed =
    report.zeroModelCalls === true &&
    report.runKind === "protocol_simulation" &&
    preset.disclosure.isLiveRun === false &&
    preset.disclosure.statement.length > 10 &&
    library.disclosure.synthetic === true &&
    library.disclosure.containsRealSecrets === false &&
    library.disclosure.notAuthoritativeForHistoricalFact === true &&
    booleanFlagsOk;
  return {
    evalId: "simulation-disclosure",
    ...EVAL_TITLES["simulation-disclosure"],
    passed,
    detail: `zeroModelCalls=${report.zeroModelCalls}；isLiveRun=${preset.disclosure.isLiveRun}；库 synthetic=${library.disclosure.synthetic}，非权威=${library.disclosure.notAuthoritativeForHistoricalFact}，无真实密钥=${!library.disclosure.containsRealSecrets}。`,
    evidence: [
      `preset.statement: ${preset.disclosure.statement}`,
      `library.statement: ${library.disclosure.statement}`,
      `report.simulationDisclosure: ${report.simulationDisclosure}`,
    ],
  };
}

const EVAL_RUNNERS: Array<[CrisisEvalId, (input: CrisisEvalInput) => CrisisEvalOutcome]> = [
  ["fact-conflict", evalFactConflict],
  ["resource-ne-permission", evalResourceNePermission],
  ["authority-overreach", evalAuthorityOverreach],
  ["dynamic-deadline", evalDynamicDeadline],
  ["closed-source-permission", evalClosedSourcePermission],
  ["simulation-disclosure", evalSimulationDisclosure],
];

export function runCrisisEvals(input: CrisisEvalInput, ranAt: string): CrisisEvalReport {
  const outcomes = EVAL_RUNNERS.map(([, run]) => run(input));
  return {
    schema: CRISIS_EVAL_REPORT_SCHEMA,
    presetId: input.preset.presetId,
    ranAt,
    allPassed: outcomes.every((outcome) => outcome.passed),
    outcomes,
  };
}
