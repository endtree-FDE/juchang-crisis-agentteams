import type {
  CrisisDeadline,
  CrisisOptionMatrixRow,
  CrisisProtocolRoleStep,
  CrisisProtocolSimulationReport,
  CrisisScenarioPreset,
  LibraryRecord,
  VirtualPrivateLibrary,
} from "./contracts.ts";
import { buildCrisisSkillCandidate, CRISIS_PROTOCOL_SIMULATION_SCHEMA } from "./contracts.ts";
import { resolveLibraryAccess } from "./context-broker.ts";

/**
 * 确定性协议模拟器：输出 juchang-crisis-protocol-simulation@1。
 * 零模型调用、零运行时证据构造：全部内容由 preset + library + generatedAt 纯函数推导。
 * T-xx 标签一律由绝对时间相对 decisionDeadlineAt 动态计算，绝不写死。
 */

export type ProtocolSimulationInput = {
  preset: CrisisScenarioPreset;
  library: VirtualPrivateLibrary;
  presetDigest: string;
  libraryDigest: string;
  generatedAt: string;
};

const MINUTE_MS = 60_000;

export function tLabelFor(atIso: string, deadlineIso: string): string {
  const minutes = Math.round((new Date(atIso).getTime() - new Date(deadlineIso).getTime()) / MINUTE_MS);
  if (minutes === 0) return "T-0";
  return minutes < 0 ? `T-${Math.abs(minutes)}` : `T+${minutes}`;
}

export function minutesFromNow(atIso: string, nowIso: string): number {
  return Math.round((new Date(atIso).getTime() - new Date(nowIso).getTime()) / MINUTE_MS);
}

function withTimeView<T extends { at: string }>(items: T[], preset: CrisisScenarioPreset): Array<T & { tLabel: string; minutesFromSimulatedNow: number }> {
  return items.map((item) => ({
    ...item,
    tLabel: tLabelFor(item.at, preset.dynamicTime.decisionDeadlineAt),
    minutesFromSimulatedNow: minutesFromNow(item.at, preset.dynamicTime.simulatedNowAt),
  }));
}

function roleDepth(roles: CrisisScenarioPreset["roles"], roleId: string, seen: Set<string> = new Set()): number {
  const role = roles.find((item) => item.roleId === roleId);
  if (!role || role.dependsOn.length === 0) return 0;
  if (seen.has(roleId)) throw new Error(`protocol_simulator: 角色 DAG 存在环（${roleId}）`);
  seen.add(roleId);
  return 1 + Math.max(...role.dependsOn.map((dep) => roleDepth(roles, dep, seen)));
}

function factValueText(claim: CrisisScenarioPreset["factClaims"][number]): string {
  if (claim.values && claim.values.length > 0) return claim.values.join(" vs ");
  return claim.value !== undefined ? String(claim.value) : "（无值）";
}

function buildDeliverableSummary(
  name: string,
  preset: CrisisScenarioPreset,
): { summary: string; factRefs?: string[] } {
  const conflicts = preset.factClaims.filter((claim) => claim.status === "conflict");
  const confirmed = preset.factClaims.filter(
    (claim) => claim.status !== "conflict" && claim.value !== undefined,
  );
  switch (name) {
    case "minimum-viable-truth":
      return {
        summary: confirmed.map((claim) => `${claim.field} = ${factValueText(claim)}`).join("；") || "无已确认事实",
        factRefs: confirmed.map((claim) => claim.factId),
      };
    case "fact-conflict-register":
      return {
        summary:
          conflicts
            .map((claim) => `${claim.factId}: ${factValueText(claim)} — ${claim.safeOperationalConclusion ?? "待人工裁决"}`)
            .join("；") || "无数值冲突",
        factRefs: conflicts.map((claim) => claim.factId),
      };
    case "incident-timeline":
      return {
        summary: preset.simulatedMilestones
          .map((milestone) => `${tLabelFor(milestone.at, preset.dynamicTime.decisionDeadlineAt)} ${milestone.label}：${milestone.description}`)
          .join("；"),
      };
    case "option-feasibility-matrix":
      return {
        summary: preset.options
          .map((option) => `${option.label} → ${option.agentDecision}（阻断 ${option.knownBlockers.length} 项）`)
          .join("；"),
      };
    case "hard-blocker-register": {
      const blockers = [...new Set(preset.options.flatMap((option) => option.knownBlockers))];
      return { summary: blockers.join("；") || "无已知阻断" };
    }
    case "confirmation-deadlines":
      return {
        summary: preset.dynamicTime.deadlines
          .map((deadline: CrisisDeadline) => `${deadline.label} @ ${deadline.at}（${deadline.source}/${deadline.confidence}）`)
          .join("；"),
      };
    case "stakeholder-graph":
      return {
        summary: `共 ${preset.stakeholders.length} 个利益相关方；其中 ${
          preset.stakeholders.filter((item) => item.authorityStatus).length
        } 个带授权状态，需具名人类决断。`,
      };
    case "authority-graph":
      return {
        summary: preset.humanDecisionBoundary.prohibitedAgentActions
          .map((action) => `Agent 禁止：${action}`)
          .join("；"),
      };
    case "contract-and-permission-register":
      return {
        summary: `虚拟闭源库冻结 ${preset.dynamicTime.deadlines.length} 条截止窗口与受限记录；confidential/restricted 记录的全文仅 human_incident_commander 可读，合作关系不构成许可。`,
      };
    case "audience-impact-brief": {
      const audienceFacts = preset.factClaims.filter((claim) => claim.field.startsWith("audience."));
      return {
        summary:
          [preset.intentAndPromises?.audienceValue, ...audienceFacts.map((claim) => `${claim.field}：${factValueText(claim)}`)]
            .filter(Boolean)
            .join("；") || "观众影响待人工评估",
        factRefs: audienceFacts.map((claim) => claim.factId),
      };
    }
    case "communication-risk-review": {
      const promises = preset.intentAndPromises?.publicPromises?.map((item) => item.claim) ?? [];
      return {
        summary:
          [...promises, "对外说明必须共同面对，不制造观众与乐团的对立；健康信息只披露最小必要范围。"]
            .filter(Boolean)
            .join("；"),
      };
    }
    case "execution-checklist-candidate": {
      const prepared = preset.options.filter((option) => option.agentDecision === "prepare_only");
      return {
        summary: prepared
          .flatMap((option) => option.conditions.map((condition) => `${option.label} → ${condition}`))
          .join("；"),
      };
    }
    case "human-approval-boundary":
      return {
        summary: `人工能力：${preset.humanDecisionBoundary.humanCapabilities.join("、")}；Agent 无审批与执行权，所有外部动作保持未授权。`,
      };
    default:
      throw new Error(`protocol_simulator: 未知交付物 ${name}（场景 ${preset.presetId}）`);
  }
}

function buildRoleBrokerCalls(
  role: CrisisScenarioPreset["roles"][number],
  preset: CrisisScenarioPreset,
  library: VirtualPrivateLibrary,
): CrisisProtocolRoleStep["brokerCalls"] {
  const behaviorFor = (recordId: string, action: string) =>
    library.requiredDemoBehaviors.find((behavior) => {
      if (behavior.role !== role.roleId || behavior.recordId !== recordId) return false;
      const expectedAction =
        behavior.expected === "approval_denied_named_human_required" ? "approve" : "read_excerpt";
      return expectedAction === action;
    })?.behaviorId;

  const calls: CrisisProtocolRoleStep["brokerCalls"] = [];
  for (const collection of library.collections) {
    for (const record of collection.records as LibraryRecord[]) {
      const lookup = resolveLibraryAccess(library, role.roleId, record.recordId, "read_excerpt");
      // 元数据对本角色不可见的记录，角色根本不知道它存在，不应出现在其调用轨迹里。
      if (!lookup.allowed && !lookup.metadataVisible) continue;
      calls.push({
        behaviorId: behaviorFor(record.recordId, "read_excerpt"),
        recordId: record.recordId,
        action: "read_excerpt",
        outcome: lookup.allowed ? "allowed" : "denied_handoff_required",
      });
    }
  }
  for (const behavior of library.requiredDemoBehaviors) {
    if (behavior.role !== role.roleId) continue;
    if (behavior.expected !== "approval_denied_named_human_required") continue;
    if (calls.some((call) => call.behaviorId === behavior.behaviorId)) continue;
    calls.push({
      behaviorId: behavior.behaviorId,
      recordId: behavior.recordId,
      action: "approve",
      outcome: "approval_denied_named_human_required",
    });
  }
  return calls;
}

function buildRoleSteps(preset: CrisisScenarioPreset, library: VirtualPrivateLibrary): CrisisProtocolRoleStep[] {
  return preset.roles.map((role) => {
    const depth = roleDepth(preset.roles, role.roleId);
    const deliverables = role.deliverables.map((name) => ({ name, ...buildDeliverableSummary(name, preset) }));
    const brokerCalls = buildRoleBrokerCalls(role, preset, library);
    return {
      roleId: role.roleId,
      displayName: role.displayName,
      dependsOn: role.dependsOn,
      depth,
      questions: role.questions,
      deliverables,
      brokerCalls,
      status: "completed",
      conclusion: "SUCCESS_WITH_NOTES",
    };
  });
}

function buildOptionMatrix(preset: CrisisScenarioPreset): CrisisOptionMatrixRow[] {
  return preset.options.map((option) => {
    const blocked = option.agentDecision === "not_authorized" || option.knownBlockers.length > 0;
    const blockingRoleIds = [
      ...new Set(
        preset.roles
          .filter((role) =>
            role.deliverables.some((name) => name === "option-feasibility-matrix" || name === "hard-blocker-register"),
          )
          .map((role) => role.roleId),
      ),
    ];
    return {
      optionId: option.optionId,
      label: option.label,
      historicalStatus: option.historicalStatus,
      conditions: option.conditions,
      knownBlockers: option.knownBlockers,
      agentDecision: option.agentDecision,
      feasibility: blocked ? "blocked" : "feasible_with_authorization",
      blockingRoleIds,
      requiredHumanApprovals: option.requiredHumanApprovals,
    };
  });
}

function buildStakeholderEdges(preset: CrisisScenarioPreset): Array<{ from: string; to: string; relation: string; note?: string }> {
  const venueish = preset.stakeholders
    .filter((item) => item.roles.includes("venue") || item.roles.includes("presenter"))
    .map((item) => item.stakeholderId);
  const edges: Array<{ from: string; to: string; relation: string; note?: string }> = [];
  const push = (from: string, to: string, relation: string, note?: string) => {
    if (from === to) return;
    if (edges.some((edge) => edge.from === from && edge.to === to && edge.relation === relation)) return;
    edges.push(note ? { from, to, relation, note } : { from, to, relation });
  };
  const pairRules: Array<{ match: (a: string[], b: string[]) => boolean; build: (a: string, b: string) => void }> = [
    {
      match: (a) => a.includes("service_recipient") || a.includes("impact_holder"),
      build: (venue, other) => venueish.forEach((v) => v === venue && push(venue, other, "duty_of_care")),
    },
    {
      match: (a) => a.includes("permission_required"),
      build: (venue, other) => venueish.forEach((v) => v === venue && push(venue, other, "requires_permission_from")),
    },
    {
      match: (a, b) => a.includes("contract_party") && b.includes("contract_party"),
      build: (a, b) => push(a < b ? a : b, a < b ? b : a, "contract_binding"),
    },
    {
      match: (a) => a.includes("economic_authority_context"),
      build: (venue, other) => venueish.forEach((v) => v === venue && push(other, venue, "authority_context_over")),
    },
    {
      match: (a) => a.includes("health_privacy_subject"),
      build: (venue, other) => venueish.forEach((v) => v === venue && push(venue, other, "privacy_duty")),
    },
    {
      match: (a) => a.includes("artistic_decision_participant"),
      build: (performer, other) => push(other, performer, "artistic_coordination"),
    },
    {
      match: (a) => a.includes("coordination_party"),
      build: (venue, other) => venueish.forEach((v) => v === venue && push(other, venue, "coordination_with")),
    },
    {
      match: (a) => a.includes("repair_authority"),
      build: (venue, other) => venueish.forEach((v) => v === venue && push(other, venue, "repair_authority_for")),
    },
    {
      match: (a) => a.includes("soloist"),
      build: (performer, other) => push(other, performer, "performs_with"),
    },
  ];
  for (const a of preset.stakeholders) {
    for (const b of preset.stakeholders) {
      if (a.stakeholderId === b.stakeholderId) continue;
      for (const rule of pairRules) {
        if (rule.match(a.roles, b.roles)) rule.build(b.stakeholderId, a.stakeholderId);
      }
    }
  }
  return edges;
}

function buildDecisionBrief(preset: CrisisScenarioPreset): CrisisProtocolSimulationReport["decisionBrief"] {
  const conflicts = preset.factClaims.filter((claim) => claim.status === "conflict");
  const confirmed = preset.factClaims.filter((claim) => claim.status !== "conflict");
  const prepared = preset.options.filter((option) => option.agentDecision === "prepare_only");
  const sections: Record<string, string[]> = {
    confirmedFacts: confirmed.map((claim) => `${claim.factId}（${claim.status}）：${factValueText(claim)}`),
    conflictsAndUnknowns: [
      ...conflicts.map((claim) => `${claim.factId} 冲突 ${factValueText(claim)}：${claim.safeOperationalConclusion ?? "待人工裁决"}`),
      ...preset.factClaims
        .filter((claim) => claim.status === "oral_testimony" && !claim.values)
        .map((claim) => `${claim.factId} 仅为口述（${claim.status}），未经独立来源确认`),
    ],
    currentOptions: preset.options.map((option) => `${option.label}（agentDecision=${option.agentDecision}）`),
    hardBlockers: [...new Set(preset.options.flatMap((option) => option.knownBlockers))],
    authorityRequired: [
      ...preset.humanDecisionBoundary.prohibitedAgentActions.map((action) => `须具名人类决定：${action}`),
      ...preset.stakeholders
        .filter((item) => item.authorityStatus)
        .map((item) => `${item.label}：${item.authorityStatus}`),
      ...preset.options
        .filter((option) => option.requiredHumanApprovals.length > 0)
        .flatMap((option) =>
          option.requiredHumanApprovals.map(
            (approval) => `${option.label} → 需 ${approval.approver} 审批：${approval.label}（范围：${approval.scope}）`,
          ),
        ),
    ],
    audienceAndCommunication: [
      ...(preset.intentAndPromises?.audienceValue ? [preset.intentAndPromises.audienceValue] : []),
      ...(preset.intentAndPromises?.publicPromises?.map((item) => `公开承诺：${item.claim}`) ?? []),
      "对外说明共同面对，不制造观众与乐团的对立。",
    ],
    executionConditions: prepared.flatMap((option) =>
      option.conditions.map((condition) => `${option.label} → ${condition}`),
    ),
    nextDeadline: [
      `${preset.dynamicTime.deadlines.find((d) => d.at === preset.dynamicTime.decisionDeadlineAt)?.label ?? "决定截止"} @ ${
        preset.dynamicTime.decisionDeadlineAt
      }（来源 ${preset.dynamicTime.deadlineSource} / 置信 ${preset.dynamicTime.deadlineConfidence}）`,
      ...preset.dynamicTime.deadlines.map(
        (deadline) => `${tLabelFor(deadline.at, preset.dynamicTime.decisionDeadlineAt)} ${deadline.label}（${deadline.confidence}）`,
      ),
    ],
    safetyCounters: [
      `productionWrites=${preset.safetyCounters.productionWrites}`,
      `publicPublishes=${preset.safetyCounters.publicPublishes}`,
      `realRefunds=${preset.safetyCounters.realRefunds}`,
      `externalMessages=${preset.safetyCounters.externalMessages}`,
    ],
  };
  const missing = preset.leader.requiredSections.filter((section) => !sections[section]);
  if (missing.length > 0) {
    throw new Error(`protocol_simulator: 决策包缺少必需小节 ${missing.join(", ")}`);
  }
  return {
    leaderDisplayName: preset.leader.displayName,
    mayApprove: false,
    sections,
    humanDecisionRequired: true,
  };
}

export function runCrisisProtocolSimulation(input: ProtocolSimulationInput): CrisisProtocolSimulationReport {
  const { preset, library, presetDigest, libraryDigest, generatedAt } = input;
  const deadlines = withTimeView(preset.dynamicTime.deadlines, preset);
  const milestones = withTimeView(preset.simulatedMilestones, preset);
  const trace = library.requiredDemoBehaviors;
  return {
    schema: CRISIS_PROTOCOL_SIMULATION_SCHEMA,
    reportId: `cps_${preset.presetId}_${presetDigest.slice(0, 8)}_${libraryDigest.slice(0, 8)}`,
    presetId: preset.presetId,
    runKind: "protocol_simulation",
    zeroModelCalls: true,
    generatedAt,
    presetDigest,
    libraryDigest,
    simulationDisclosure: `${preset.disclosure.statement} 本报告为 ${CRISIS_PROTOCOL_SIMULATION_SCHEMA} 协议模拟：零模型调用，全部内容为确定性推导，不构成真实运行证据。`,
    dynamicTimeView: {
      detectedAt: preset.dynamicTime.detectedAt,
      performanceStartAt: preset.dynamicTime.performanceStartAt,
      simulatedNowAt: preset.dynamicTime.simulatedNowAt,
      currentCheckpoint: preset.dynamicTime.currentCheckpoint,
      decisionDeadlineAt: preset.dynamicTime.decisionDeadlineAt,
      deadlineSource: preset.dynamicTime.deadlineSource,
      deadlineConfidence: preset.dynamicTime.deadlineConfidence,
      tLabelAtSimulatedNow: tLabelFor(preset.dynamicTime.simulatedNowAt, preset.dynamicTime.decisionDeadlineAt),
      deadlines,
      milestones,
    },
    roleSteps: buildRoleSteps(preset, library),
    factConflictRegister: preset.factClaims
      .filter((claim) => claim.status === "conflict")
      .map((claim) => ({
        factId: claim.factId,
        field: claim.field,
        dataClass: claim.dataClass ?? "simulated",
        status: claim.status,
        values: claim.values,
        safeOperationalConclusion: claim.safeOperationalConclusion,
      })),
    optionMatrix: buildOptionMatrix(preset),
    stakeholderGraph: {
      nodes: preset.stakeholders,
      edges: buildStakeholderEdges(preset),
    },
    brokerTrace: trace.map((behavior) => {
      const action = behavior.expected === "approval_denied_named_human_required" ? "approve" : "read_excerpt";
      const lookup = resolveLibraryAccess(library, behavior.role, behavior.recordId, action);
      let actual: string;
      if (behavior.expected === "read_excerpt_allowed") {
        actual = lookup.allowed ? "read_excerpt_allowed" : "denied";
      } else if (behavior.expected === "metadata_visible_content_denied_handoff_required") {
        actual = !lookup.allowed && lookup.metadataVisible && lookup.handoffRequired
          ? "metadata_visible_content_denied_handoff_required"
          : lookup.allowed
            ? "allowed"
            : "metadata_hidden";
      } else if (behavior.expected === "metadata_hidden_handoff_required") {
        actual = !lookup.allowed && !lookup.metadataVisible
          ? "metadata_hidden_handoff_required"
          : lookup.allowed
            ? "allowed"
            : "metadata_visible_content_denied_handoff_required";
      } else {
        actual = !lookup.allowed ? "approval_denied_named_human_required" : "allowed";
      }
      return {
        behaviorId: behavior.behaviorId,
        role: behavior.role,
        recordId: behavior.recordId,
        expected: behavior.expected,
        actual,
        ok: actual === behavior.expected,
      };
    }),
    decisionBrief: buildDecisionBrief(preset),
    lateArrivals: (preset.lateArrivalFacts ?? []).map((fact) => ({
      factId: fact.factId,
      arrivesAfterCheckpoint: fact.arrivesAfterCheckpoint,
      text: fact.claim ?? fact.summary ?? "",
      dataClass: fact.dataClass,
    })),
    skillCandidate: buildCrisisSkillCandidate(preset),
    safetyCounters: {
      productionWrites: 0,
      publicPublishes: 0,
      realRefunds: 0,
      externalMessages: 0,
    },
  };
}
