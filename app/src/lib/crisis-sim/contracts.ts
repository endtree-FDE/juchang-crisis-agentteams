import { createHash } from "node:crypto";

import { CLOUD_AGENTTEAMS_ROLES } from "@/lib/admin/cloud-agentteams-contract.ts";

import preset2014Json from "@/data/crisis-sim/2014-east-art-center.preset.json";
import presetStageJson from "@/data/crisis-sim/stage-malfunction.preset.json";
import libraryJson from "@/data/crisis-sim/virtual-private-library.json";

/**
 * 三种运行模式严禁混称（用户门禁裁决）：
 * - Protocol Simulation：零模型调用，本文件族只产出这一种。
 * - Live Agent Run：真实 AgentTeams/DSH 运行，由用户接管，本代码族只提供派单预览（输入不是证据）。
 * - Verified Replay：只能由 P2 导出脚本从真实运行冻结，页面只读。
 * 红线：本目录不得构造 Cloud Runtime Evidence（真实运行证据只来自 CloudStudio/DSH 导出），不得伪造 check→accept→terminal 事件。
 */

export const CRISIS_SCENARIO_PRESET_SCHEMA = "juchang-crisis-scenario-preset@1" as const;
export const CRISIS_PROTOCOL_SIMULATION_SCHEMA = "juchang-crisis-protocol-simulation@1" as const;
export const CRISIS_HUMAN_DECISION_RECEIPT_SCHEMA = "juchang-human-decision-receipt@1" as const;
export const CRISIS_SKILL_CANDIDATE_SCHEMA = "juchang-crisis-skill-candidate@1" as const;
export const CRISIS_EVAL_REPORT_SCHEMA = "juchang-crisis-eval-report@1" as const;
export const CRISIS_VERIFIED_REPLAY_SCHEMA = "juchang-crisis-verified-replay@1" as const;
export const CRISIS_LIBRARY_SCHEMA = "juchang-synthetic-private-library@0.1" as const;
export const CRISIS_BOOTSTRAP_SCHEMA = "juchang-crisis-sim-bootstrap@1" as const;

export const CRISIS_RUN_MODES = {
  protocol_simulation: {
    key: "protocol_simulation",
    badge: "Protocol Simulation",
    badgeTone: "neutral" as const,
    schema: CRISIS_PROTOCOL_SIMULATION_SCHEMA,
    usesModel: false,
    claim: "零模型调用 · 模拟协议、界面、权限与 Eval，不声称真实运行",
  },
  live_agent_run: {
    key: "live_agent_run",
    badge: "Live Agent Run",
    badgeTone: "strong" as const,
    schema: "juchang-cloud-dispatch@1 / juchang-cloud-receipt@1",
    usesModel: true,
    claim: "证据只能来自 AgentTeams/DSH 真实运行",
  },
  verified_replay: {
    key: "verified_replay",
    badge: "Verified Replay",
    badgeTone: "readonly" as const,
    schema: CRISIS_VERIFIED_REPLAY_SCHEMA,
    usesModel: false,
    claim: "回放自真实运行导出物 · 冻结只读",
  },
} as const;

const PRESET_2014_SOURCE_FILE_SHA256 = "6b1bf92525dc88517219865b8e2c481307fc4f40c593a7862b1de29f1b3c56f3";
const LIBRARY_SOURCE_FILE_SHA256 = "53512474fb3675152ad408fe8d96cd63e0353d701ace80f918acf9e75bd01452";

export type CrisisDataClass = "historical_fact" | "oral_testimony" | "simulated";

export type CrisisFactClaim = {
  factId: string;
  field: string;
  value?: string | number;
  values?: Array<string | number>;
  dataClass?: CrisisDataClass;
  status: string;
  evidenceRefs?: string[];
  safeOperationalConclusion?: string;
};

export type CrisisLateArrivalFact = {
  factId: string;
  arrivesAfterCheckpoint: string;
  claim?: string;
  summary?: string;
  dataClass: CrisisDataClass;
  source: string;
  synthetic?: boolean;
};

export type CrisisDeadline = {
  id: string;
  label: string;
  at: string;
  source: string;
  confidence: string;
};

export type CrisisMilestone = {
  at: string;
  relativeLabel?: string;
  kind: string;
  label: string;
  description: string;
};

export type CrisisRoleSpec = {
  roleId: string;
  displayName: string;
  dependsOn: string[];
  questions: string[];
  deliverables: string[];
};

/**
 * 结构化人工审批要求：权限必须是数据而不是文案关键词。
 * approver 必须具名（人类角色或机构名），Agent 对自身永远没有审批权。
 */
export type CrisisHumanApproval = {
  approvalId: string;
  label: string;
  approver: string;
  stakeholderId?: string;
  scope: string;
};

export type CrisisOption = {
  optionId: string;
  label: string;
  historicalStatus: string;
  conditions: string[];
  knownBlockers: string[];
  agentDecision: "not_authorized" | "prepare_only";
  requiredHumanApprovals: CrisisHumanApproval[];
  permissionRefs?: string[];
};

export type CrisisStakeholder = {
  stakeholderId: string;
  label: string;
  roles: string[];
  authorityStatus?: string;
};

export type CrisisScenarioPreset = {
  schema: typeof CRISIS_SCENARIO_PRESET_SCHEMA;
  presetId: string;
  title: string;
  scenarioKind: string;
  scenarioMode: string;
  sourceProvenance: {
    sourceFile: string | null;
    sourceSchema: string | null;
    sourceFileSha256: string | null;
    frozenAt: string;
    desensitized: boolean;
    note?: string;
  };
  disclosure: {
    isLiveRun: boolean;
    runKind: string;
    statement: string;
    historicalUseOfAgentTeams?: boolean;
    externalWriteAllowed?: boolean;
    isRealHistoricalEvent?: boolean;
  };
  dynamicTime: {
    warning?: string;
    detectedAt: string;
    performanceStartAt: string;
    simulatedNowAt: string;
    currentCheckpoint: string;
    decisionDeadlineAt: string;
    deadlineSource: string;
    deadlineConfidence: string;
    deadlines: CrisisDeadline[];
  };
  simulatedMilestones: CrisisMilestone[];
  sourceCatalog?: Array<{
    sourceId: string;
    sourceKind: string;
    title: string;
    authority?: string;
    url?: string;
    limitations?: string[];
  }>;
  intentAndPromises?: {
    programmingIntent?: Array<{ claim: string; status: string; evidenceRefs: string[] }>;
    publicPromises?: Array<{ claim: string; status: string; evidenceRefs: string[] }>;
    audienceValue?: string;
  };
  factClaims: CrisisFactClaim[];
  lateArrivalFacts?: CrisisLateArrivalFact[];
  roles: CrisisRoleSpec[];
  leader: {
    displayName: string;
    mayApprove: boolean;
    output: string;
    requiredSections: string[];
  };
  options: CrisisOption[];
  stakeholders: CrisisStakeholder[];
  humanDecisionBoundary: {
    required: boolean;
    humanCapabilities: string[];
    prohibitedAgentActions: string[];
  };
  safetyCounters: {
    productionWrites: number;
    publicPublishes: number;
    realRefunds: number;
    externalMessages: number;
  };
  skillTransfer?: {
    candidateSkillId: string;
    applicability: "direct" | "partial" | "none";
    note?: string;
    mappings: Array<{
      skillItem: string;
      secondCaseEquivalent: string | null;
      transfer: "direct" | "rewrite" | "not_applicable";
    }>;
  };
};

export type LibraryRecord = {
  recordId: string;
  classification: "internal" | "confidential" | "restricted";
  synthetic: boolean;
  status?: string;
  validFrom?: string;
  validUntil?: string;
  summary: string;
  permittedRoles: Record<string, string[]>;
  sourceBasis: string;
};

export type LibraryCollection = {
  collectionId: string;
  label: string;
  records: LibraryRecord[];
};

export type RequiredDemoBehavior = {
  behaviorId: string;
  role: string;
  recordId: string;
  expected: string;
};

export type VirtualPrivateLibrary = {
  schema: typeof CRISIS_LIBRARY_SCHEMA;
  libraryId: string;
  libraryMode: string;
  title: string;
  sourceProvenance?: {
    sourceFile: string;
    sourceSchema: string;
    sourceFileSha256: string;
    frozenAt: string;
    desensitized: boolean;
  };
  disclosure: {
    synthetic: boolean;
    containsRealSecrets: boolean;
    containsRealPersonalData: boolean;
    containsRealContracts: boolean;
    notAuthoritativeForHistoricalFact: boolean;
    statement: string;
  };
  roles: string[];
  accessActions: string[];
  sourcePriority: string[];
  collections: LibraryCollection[];
  requiredDemoBehaviors: RequiredDemoBehavior[];
};

export type CrisisProtocolRoleStep = {
  roleId: string;
  displayName: string;
  dependsOn: string[];
  depth: number;
  questions: string[];
  deliverables: Array<{ name: string; summary: string; factRefs?: string[] }>;
  brokerCalls: Array<{ behaviorId?: string; recordId: string; action: string; outcome: string }>;
  status: "completed" | "blocked";
  conclusion: "SUCCESS_WITH_NOTES" | "BLOCKED";
};

export type CrisisOptionMatrixRow = {
  optionId: string;
  label: string;
  historicalStatus: string;
  conditions: string[];
  knownBlockers: string[];
  agentDecision: CrisisOption["agentDecision"];
  feasibility: "blocked" | "feasible_with_authorization";
  blockingRoleIds: string[];
  requiredHumanApprovals: CrisisHumanApproval[];
};

export type CrisisProtocolSimulationReport = {
  schema: typeof CRISIS_PROTOCOL_SIMULATION_SCHEMA;
  reportId: string;
  presetId: string;
  runKind: "protocol_simulation";
  zeroModelCalls: true;
  generatedAt: string;
  presetDigest: string;
  libraryDigest: string;
  simulationDisclosure: string;
  dynamicTimeView: {
    detectedAt: string;
    performanceStartAt: string;
    simulatedNowAt: string;
    currentCheckpoint: string;
    decisionDeadlineAt: string;
    deadlineSource: string;
    deadlineConfidence: string;
    tLabelAtSimulatedNow: string;
    deadlines: Array<CrisisDeadline & { tLabel: string; minutesFromSimulatedNow: number }>;
    milestones: Array<CrisisMilestone & { tLabel: string; minutesFromSimulatedNow: number }>;
  };
  roleSteps: CrisisProtocolRoleStep[];
  factConflictRegister: Array<{
    factId: string;
    field: string;
    dataClass: CrisisDataClass;
    status: string;
    values?: Array<string | number>;
    safeOperationalConclusion?: string;
  }>;
  optionMatrix: CrisisOptionMatrixRow[];
  stakeholderGraph: {
    nodes: CrisisStakeholder[];
    edges: Array<{ from: string; to: string; relation: string; note?: string }>;
  };
  brokerTrace: Array<{ behaviorId: string; role: string; recordId: string; expected: string; actual: string; ok: boolean }>;
  decisionBrief: {
    leaderDisplayName: string;
    mayApprove: false;
    sections: Record<string, string[]>;
    humanDecisionRequired: true;
  };
  lateArrivals: Array<{ factId: string; arrivesAfterCheckpoint: string; text: string; dataClass: CrisisDataClass }>;
  skillCandidate: CrisisSkillCandidate;
  safetyCounters: {
    productionWrites: 0;
    publicPublishes: 0;
    realRefunds: 0;
    externalMessages: 0;
  };
};

export type HumanDecisionChoice = "approve_simulated_plan" | "reject" | "request_more_evidence";

export type HumanDecisionReceipt = {
  schema: typeof CRISIS_HUMAN_DECISION_RECEIPT_SCHEMA;
  receiptId: string;
  presetId: string;
  scenarioDigest: string;
  agentRunDigest: string;
  runKind: "protocol_simulation" | "live_agent_run";
  decisionMakerRole: "human_incident_commander";
  decision: HumanDecisionChoice;
  reason: string;
  decidedAt: string;
  authorityBasis: string;
  simulationOnly: true;
  executionAuthorized: false;
};

export type CrisisSkillCandidate = {
  schema: typeof CRISIS_SKILL_CANDIDATE_SCHEMA;
  skillId: string;
  status: "candidate";
  title: string;
  sourcePresetId: string;
  checklist: string[];
  promotionGate: {
    requiresSecondCase: true;
    promoted: false;
    verifiedOnPresets: string[];
  };
};

export type CrisisEvalId =
  | "fact-conflict"
  | "resource-ne-permission"
  | "authority-overreach"
  | "dynamic-deadline"
  | "closed-source-permission"
  | "simulation-disclosure";

export type CrisisEvalOutcome = {
  evalId: CrisisEvalId;
  title: string;
  goal: string;
  passed: boolean;
  detail: string;
  evidence: string[];
};

export type CrisisEvalReport = {
  schema: typeof CRISIS_EVAL_REPORT_SCHEMA;
  presetId: string;
  ranAt: string;
  allPassed: boolean;
  outcomes: CrisisEvalOutcome[];
};

export type FixtureProvenanceCheck = {
  fixture: string;
  sourceFile: string | null;
  recordedSourceFileSha256: string | null;
  expectedSourceFileSha256: string | null;
  verified: boolean;
  canonicalDigest: string;
};

export type CrisisSimFixtures = {
  presets: Record<string, CrisisScenarioPreset>;
  presetOrder: string[];
  library: VirtualPrivateLibrary;
  digests: Record<string, string>;
  /** 以 presetId 为键的规范哈希。注意 stage preset 的 presetId（stage-malfunction-demo）与文件名（stage-malfunction）不一致，禁止用 `${presetId}.preset.json` 反推 digests。 */
  presetDigests: Record<string, string>;
  provenance: FixtureProvenanceCheck[];
};

export type CrisisSimBootstrap = {
  schema: typeof CRISIS_BOOTSTRAP_SCHEMA;
  generatedAt: string;
  presets: CrisisScenarioPreset[];
  presetDigests: Record<string, string>;
  library: VirtualPrivateLibrary;
  libraryDigest: string;
  provenance: FixtureProvenanceCheck[];
  runModes: typeof CRISIS_RUN_MODES;
};

/** 冻结回放（juchang-crisis-verified-replay@1）的业务可读摘要：技术哈希只在运行证据抽屉展示。 */
export type VerifiedReplaySummary = {
  replayId: string;
  presetId?: string;
  schema: string;
  frozenAt: string;
  readonly: boolean;
  disclosure: string;
  source: {
    kind: string;
    evaluatorState: string;
    dispatchProvided: boolean;
  };
  runtimeProvenance: { runtime?: string; cloudstudio?: boolean; statement?: string } | null;
  validation: { state?: string; issueCount?: number; counters?: Record<string, number> } | null;
  qualityReview?: { status: string; summary: string } | null;
  digests: Record<string, string | null>;
  workerSummaries: Array<{ taskId: string; role: string; status: string; summary: string; detailText?: string }>;
  leaderSummary: { status?: string; summary?: string; detailText?: string } | null;
  /** 真实 Skill 调用轨迹（业务可读字段；哈希等技术字段只进运行证据抽屉）。 */
  skillInvocations: Array<{
    skillId: string;
    role?: string;
    status: string;
    contract?: string;
    version?: string;
    invokedAt?: string;
  }>;
  /** 权威审计事件序列（check_task / accept_task_result / task_terminal_observed / complete_project 等）。 */
  auditEvents: Array<{ operation: string; at?: string }>;
};

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function canonicalDigest(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

const preset2014 = preset2014Json as unknown as CrisisScenarioPreset;
const presetStage = presetStageJson as unknown as CrisisScenarioPreset;
const library = libraryJson as unknown as VirtualPrivateLibrary;

function assertPresetShape(preset: CrisisScenarioPreset, fixtureName: string): void {
  if (preset.schema !== CRISIS_SCENARIO_PRESET_SCHEMA) {
    throw new Error(`fixture ${fixtureName}: schema 必须是 ${CRISIS_SCENARIO_PRESET_SCHEMA}`);
  }
  if (!preset.presetId || !preset.dynamicTime?.decisionDeadlineAt || !Array.isArray(preset.dynamicTime.deadlines)) {
    throw new Error(`fixture ${fixtureName}: 缺少 presetId 或 dynamicTime.deadlines`);
  }
  const roleIds = preset.roles.map((role) => role.roleId).sort();
  const expected = [...CLOUD_AGENTTEAMS_ROLES].sort();
  if (roleIds.length !== expected.length || roleIds.some((id, index) => id !== expected[index])) {
    throw new Error(`fixture ${fixtureName}: 四角色必须与 AgentTeams 合同一致（${expected.join(", ")}）`);
  }
  if (preset.leader.mayApprove !== false) {
    throw new Error(`fixture ${fixtureName}: leader.mayApprove 必须为 false`);
  }
}

export function loadCrisisSimFixtures(): CrisisSimFixtures {
  assertPresetShape(preset2014, "2014-east-art-center.preset.json");
  assertPresetShape(presetStage, "stage-malfunction.preset.json");

  if (library.schema !== CRISIS_LIBRARY_SCHEMA) {
    throw new Error(`fixture virtual-private-library.json: schema 必须是 ${CRISIS_LIBRARY_SCHEMA}`);
  }
  if (!library.disclosure.synthetic || !library.disclosure.notAuthoritativeForHistoricalFact) {
    throw new Error("fixture virtual-private-library.json: 必须保持 synthetic_private_demo 声明");
  }

  const preset2014ProvenanceOk = preset2014.sourceProvenance.sourceFileSha256 === PRESET_2014_SOURCE_FILE_SHA256;
  const presetStageProvenanceOk = presetStage.sourceProvenance.sourceFileSha256 === null;
  const libraryProvenanceOk = library.sourceProvenance?.sourceFileSha256 === LIBRARY_SOURCE_FILE_SHA256;

  if (!preset2014ProvenanceOk) {
    throw new Error("fixture 2014-east-art-center.preset.json: sourceFileSha256 与冻结源不一致");
  }
  if (!presetStageProvenanceOk) {
    throw new Error("fixture stage-malfunction.preset.json: 纯合成场景不得声明外部源哈希");
  }
  if (!libraryProvenanceOk) {
    throw new Error("fixture virtual-private-library.json: sourceFileSha256 与冻结源不一致");
  }

  const digests: Record<string, string> = {
    "2014-east-art-center.preset.json": canonicalDigest(preset2014),
    "stage-malfunction.preset.json": canonicalDigest(presetStage),
    "virtual-private-library.json": canonicalDigest(library),
  };

  return {
    presets: {
      [preset2014.presetId]: preset2014,
      [presetStage.presetId]: presetStage,
    },
    presetOrder: [preset2014.presetId, presetStage.presetId],
    library,
    digests,
    presetDigests: {
      [preset2014.presetId]: digests["2014-east-art-center.preset.json"],
      [presetStage.presetId]: digests["stage-malfunction.preset.json"],
    },
    provenance: [
      {
        fixture: "2014-east-art-center.preset.json",
        sourceFile: preset2014.sourceProvenance.sourceFile,
        recordedSourceFileSha256: preset2014.sourceProvenance.sourceFileSha256,
        expectedSourceFileSha256: PRESET_2014_SOURCE_FILE_SHA256,
        verified: preset2014ProvenanceOk,
        canonicalDigest: digests["2014-east-art-center.preset.json"],
      },
      {
        fixture: "stage-malfunction.preset.json",
        sourceFile: null,
        recordedSourceFileSha256: null,
        expectedSourceFileSha256: null,
        verified: presetStageProvenanceOk,
        canonicalDigest: digests["stage-malfunction.preset.json"],
      },
      {
        fixture: "virtual-private-library.json",
        sourceFile: library.sourceProvenance?.sourceFile ?? null,
        recordedSourceFileSha256: library.sourceProvenance?.sourceFileSha256 ?? null,
        expectedSourceFileSha256: LIBRARY_SOURCE_FILE_SHA256,
        verified: libraryProvenanceOk,
        canonicalDigest: digests["virtual-private-library.json"],
      },
    ],
  };
}

export function buildCrisisSkillCandidate(preset: CrisisScenarioPreset): CrisisSkillCandidate {
  return {
    schema: CRISIS_SKILL_CANDIDATE_SCHEMA,
    skillId: "artist-substitution-feasibility",
    status: "candidate",
    title: "演出要素替补可行性核对（候选）",
    sourcePresetId: preset.presetId,
    checklist: [
      "艺术能力或技术恢复能力核对",
      "本人及经纪（或维保商与技术负责人）确认",
      "能在截止时间前到场（或完成修复/搬移）",
      "与指挥和乐团可合作",
      "直播声誉风险可接受",
      "批准权核对：具名人类授权，Agent 无审批权",
    ],
    promotionGate: {
      requiresSecondCase: true,
      promoted: false,
      verifiedOnPresets: [],
    },
  };
}

export function buildHumanDecisionReceipt(input: {
  preset: CrisisScenarioPreset;
  presetDigest: string;
  agentRunDigest: string;
  runKind: "protocol_simulation" | "live_agent_run";
  decision: HumanDecisionChoice;
  reason: string;
  decidedAt: string;
  authorityBasis?: string;
}): HumanDecisionReceipt {
  const reason = input.reason.trim();
  if (reason.length < 4) {
    throw new Error("human_decision_receipt: reason 必须至少 4 个字符，说明人的判断依据");
  }
  const decidedAt = input.decidedAt.trim() || new Date().toISOString();
  const receiptId = `hdr_${input.preset.presetId}_${sha256Hex(`${input.decision}|${reason}|${decidedAt}`).slice(0, 12)}`;
  return {
    schema: CRISIS_HUMAN_DECISION_RECEIPT_SCHEMA,
    receiptId,
    presetId: input.preset.presetId,
    scenarioDigest: input.presetDigest,
    agentRunDigest: input.agentRunDigest,
    runKind: input.runKind,
    decisionMakerRole: "human_incident_commander",
    decision: input.decision,
    reason,
    decidedAt,
    authorityBasis: input.authorityBasis?.trim() || "口头授权声明（演示）",
    simulationOnly: true,
    executionAuthorized: false,
  };
}
