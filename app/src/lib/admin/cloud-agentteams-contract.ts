export const CLOUD_AGENTTEAMS_DISPATCH_SCHEMA = "juchang-cloud-dispatch@1" as const;
export const CLOUD_AGENTTEAMS_RECEIPT_SCHEMA = "juchang-cloud-receipt@1" as const;
export const CLOUD_AGENTTEAMS_DISPATCH_PREFIX = "JUCHANG_CLOUD_DISPATCH: " as const;
export const CLOUD_AGENTTEAMS_RUNTIME_ENVIRONMENT = "cloudstudio" as const;
export const CLOUD_AGENTTEAMS_TARGET_TEAM = "juchang-change-control-v14" as const;
export const CLOUD_AGENTTEAMS_TARGET_LEADER_DM_ROOM_ID = "!GKL4XFzVKBFE6bqGad:matrix-local.agentteams.io:18080" as const;

export const CLOUD_AGENTTEAMS_ROLES = [
  "material_intake",
  "evidence_guard",
  "entity_matcher",
  "approval_guard",
] as const;

export type CloudAgentTeamsRole = (typeof CLOUD_AGENTTEAMS_ROLES)[number];

export type CloudAgentTeamsDispatch = {
  schema: typeof CLOUD_AGENTTEAMS_DISPATCH_SCHEMA;
  dispatchId: string;
  projectId: string;
  idempotencyKey: string;
  changeRef: string;
  projectRef: string;
  adapterRef: string;
  decisionRunId: string;
  dispatchAttemptId?: string;
  riskRoute: "TEAM";
  runtimeEnvironment: typeof CLOUD_AGENTTEAMS_RUNTIME_ENVIRONMENT;
  targetTeam: typeof CLOUD_AGENTTEAMS_TARGET_TEAM;
  targetLeaderDMRoomId: typeof CLOUD_AGENTTEAMS_TARGET_LEADER_DM_ROOM_ID;
  external_write_allowed: false;
  sourceLocators: string[];
  affectedObjects: string[];
  unresolvedQuestions: string[];
  tasks: Array<{
    taskId: string;
    role: CloudAgentTeamsRole;
    dependsOn: CloudAgentTeamsRole[];
    output: "status + summary + deliverables";
  }>;
  authority: {
    mayApprove: false;
    mayExecute: false;
    publicWriteAllowed: false;
  };
};

export type CloudAgentTeamsReceipt = {
  schema: typeof CLOUD_AGENTTEAMS_RECEIPT_SCHEMA;
  dispatchId: string;
  changeRef: string;
  projectRef: string;
  status: "running" | "completed" | "failed";
  workers: Array<{
    taskId: string;
    role: CloudAgentTeamsRole;
    status: "completed" | "blocked" | "failed";
    summary: string;
    deliverables: string[];
    effective: boolean;
    conclusion?: "HUMAN_REVIEW" | "SUCCESS_WITH_NOTES" | "BLOCKED";
    factCount?: number;
    conflictCount?: number;
    unknownFields?: string[];
    sourceReceiptSha256?: string;
  }>;
  completeProject: {
    attempted: boolean;
    success: boolean;
    status: "completed";
  };
  leader: {
    status: "READY_FOR_HUMAN_REVIEW";
    summary: string;
  };
  counters: {
    productionWrites: number;
    publicPublishes: number;
    realRefunds: number;
    externalMessages: number;
  };
  receivedAt: string;
};

export type CloudAgentTeamsRuntimeEvidence = {
  schema: "juchang-cloud-runtime-evidence@1";
  project: { project_id: string; status: "completed"; tasks: string[] };
  tasks: Array<{
    task_id: string;
    status: "completed";
    result_status: "SUCCESS" | "SUCCESS_WITH_NOTES";
  }>;
  audit: {
    schema: "juchang-cloud-audit@1";
    dispatchId: string;
    projectId: string;
    events: Array<{
      sequence: number;
      at: string;
      operation: string;
      taskId?: string;
      success: boolean;
      effective?: boolean;
      validationErrors?: unknown[];
      status?: string;
    }>;
  };
  skillInvocations?: Array<{
    taskId: string;
    role: CloudAgentTeamsRole;
    skillId: string;
    status: "discovered" | "loaded" | "called" | "succeeded" | "blocked" | "failed" | "not_called";
    contract?: string;
    version?: string;
    digest?: string;
    claimableAsFreshEvidence: boolean;
    bundleRef: string;
    authorityRef: string;
    bundleSha256: string;
    authoritySha256: string;
  }>;
  receipt: CloudAgentTeamsReceipt;
};

export type CloudCollaborationState =
  | "not_received"
  | "running"
  | "needs_attention"
  | "ready_for_human_review";

export type CloudReceiptIssue = {
  code: string;
  label: string;
  taskId?: string;
};

export type CloudReceiptEvaluation = {
  state: CloudCollaborationState;
  label: string;
  summary: string;
  canEnterHumanReview: boolean;
  workerProgress: { effective: number; received: number; expected: number };
  issues: CloudReceiptIssue[];
  receipt: CloudAgentTeamsReceipt | null;
  runtimeEvidence?: CloudAgentTeamsRuntimeEvidence | null;
  sourceSchema: string;
};

type ExpectedReceiptTrace = {
  dispatchId?: string;
  changeRef?: string;
  projectRef?: string;
  tasks?: Array<{ taskId: string; role: CloudAgentTeamsRole }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isValidRfc3339DateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = Number(offsetHourText || 0);
  const offsetMinute = Number(offsetMinuteText || 0);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return month >= 1 && month <= 12
    && day >= 1 && day <= daysInMonth
    && hour <= 23
    && minute <= 59
    && second <= 59
    && offsetHour <= 23
    && offsetMinute <= 59
    && Number.isFinite(Date.parse(value));
}

function cleanIdPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "unknown";
}

export function buildCloudAgentTeamsDispatch(input: {
  changeRef: string;
  projectRef: string;
  adapterRef: string;
  decisionRunId: string;
  dispatchAttemptId?: string;
  sourceLocators: string[];
  affectedObjects: string[];
  unresolvedQuestions: string[];
}): CloudAgentTeamsDispatch {
  const dispatchAttemptId = input.dispatchAttemptId?.trim() || input.decisionRunId;
  const dispatchId = `cloud_${cleanIdPart(input.changeRef)}_${cleanIdPart(dispatchAttemptId)}`;
  const dependencyMap: Record<CloudAgentTeamsRole, CloudAgentTeamsRole[]> = {
    material_intake: [],
    evidence_guard: ["material_intake"],
    entity_matcher: ["material_intake"],
    approval_guard: ["evidence_guard", "entity_matcher"],
  };
  return {
    schema: CLOUD_AGENTTEAMS_DISPATCH_SCHEMA,
    dispatchId,
    projectId: dispatchId,
    idempotencyKey: dispatchId,
    changeRef: input.changeRef,
    projectRef: input.projectRef,
    adapterRef: input.adapterRef,
    decisionRunId: input.decisionRunId,
    ...(input.dispatchAttemptId ? { dispatchAttemptId: input.dispatchAttemptId } : {}),
    riskRoute: "TEAM",
    runtimeEnvironment: CLOUD_AGENTTEAMS_RUNTIME_ENVIRONMENT,
    targetTeam: CLOUD_AGENTTEAMS_TARGET_TEAM,
    targetLeaderDMRoomId: CLOUD_AGENTTEAMS_TARGET_LEADER_DM_ROOM_ID,
    external_write_allowed: false,
    sourceLocators: [...new Set(input.sourceLocators)],
    affectedObjects: [...new Set(input.affectedObjects)],
    unresolvedQuestions: [...new Set(input.unresolvedQuestions)],
    tasks: CLOUD_AGENTTEAMS_ROLES.map((role, index) => ({
      taskId: `${dispatchId}-${String(index + 1).padStart(2, "0")}`,
      role,
      dependsOn: dependencyMap[role],
      output: "status + summary + deliverables",
    })),
    authority: { mayApprove: false, mayExecute: false, publicWriteAllowed: false },
  };
}

export function serializeCloudAgentTeamsDispatch(dispatch: CloudAgentTeamsDispatch): string {
  return `${CLOUD_AGENTTEAMS_DISPATCH_PREFIX}${JSON.stringify({
    ...dispatch,
    projectId: dispatch.dispatchId,
    runtimeEnvironment: CLOUD_AGENTTEAMS_RUNTIME_ENVIRONMENT,
    targetTeam: CLOUD_AGENTTEAMS_TARGET_TEAM,
    targetLeaderDMRoomId: CLOUD_AGENTTEAMS_TARGET_LEADER_DM_ROOM_ID,
    external_write_allowed: false,
  })}`;
}

function parseCurrentReceipt(value: unknown): CloudAgentTeamsReceipt | null {
  if (!isRecord(value) || value.schema !== CLOUD_AGENTTEAMS_RECEIPT_SCHEMA) return null;
  return value as CloudAgentTeamsReceipt;
}

function stateCopy(state: CloudCollaborationState, issueCount: number) {
  if (state === "ready_for_human_review") return { label: "可交人工", summary: "四项结果与项目汇总均已核对。" };
  if (state === "needs_attention") return { label: "需要处理", summary: `${issueCount} 项回执问题阻止进入人工复核。` };
  if (state === "running") return { label: "准备中", summary: "云端任务尚未形成完整回执。" };
  return { label: "未收到回执", summary: "尚无可核对的云端协作结果。" };
}

function evaluateHistoricalReceipt(value: Record<string, unknown>): CloudReceiptEvaluation {
  const sourceSchema = typeof value.schema === "string" ? value.schema : "unknown";
  const nodes = Array.isArray(value.nodes) ? value.nodes.filter(isRecord) : [];
  const received = nodes.filter((node) => String(node.worker || "") !== "leader").length;
  const completed = value.completed === true || String(value.status || "").startsWith("COMPLETED");
  const issues: CloudReceiptIssue[] = [{
    code: "legacy_receipt_unstructured",
    label: "旧回执缺少逐项 summary、deliverables 与 effective，不能按新门禁放行。",
  }];
  if (!completed) issues.unshift({ code: "run_incomplete", label: "历史运行没有完成。" });
  const copy = stateCopy("needs_attention", issues.length);
  return {
    state: "needs_attention",
    ...copy,
    canEnterHumanReview: false,
    workerProgress: { effective: 0, received, expected: CLOUD_AGENTTEAMS_ROLES.length },
    issues,
    receipt: null,
    sourceSchema,
  };
}

function evaluateCloudAgentTeamsReceiptOnly(
  value: unknown,
  expected: ExpectedReceiptTrace = {},
): CloudReceiptEvaluation {
  if (value == null) {
    const copy = stateCopy("not_received", 0);
    return {
      state: "not_received",
      ...copy,
      canEnterHumanReview: false,
      workerProgress: { effective: 0, received: 0, expected: CLOUD_AGENTTEAMS_ROLES.length },
      issues: [],
      receipt: null,
      sourceSchema: "none",
    };
  }
  const raw = isRecord(value) ? value : null;
  if (raw && typeof raw.schema === "string" && raw.schema.startsWith("juchang-agentteams-v12-run@")) {
    return evaluateHistoricalReceipt(raw);
  }
  const receipt = parseCurrentReceipt(value);
  if (!receipt) {
    const issues = [{ code: "receipt_schema_invalid", label: "回执格式无法识别。" }];
    const copy = stateCopy("needs_attention", issues.length);
    return {
      state: "needs_attention",
      ...copy,
      canEnterHumanReview: false,
      workerProgress: { effective: 0, received: 0, expected: CLOUD_AGENTTEAMS_ROLES.length },
      issues,
      receipt: null,
      sourceSchema: typeof raw?.schema === "string" ? raw.schema : "unknown",
    };
  }

  const issues: CloudReceiptIssue[] = [];
  if (expected.dispatchId && receipt.dispatchId !== expected.dispatchId) issues.push({ code: "dispatch_mismatch", label: "回执不属于本次派单。" });
  if (expected.changeRef && receipt.changeRef !== expected.changeRef) issues.push({ code: "change_mismatch", label: "回执关联了其他案件。" });
  if (expected.projectRef && receipt.projectRef !== expected.projectRef) issues.push({ code: "project_mismatch", label: "回执关联了其他项目。" });

  const workers = (Array.isArray(receipt.workers) ? receipt.workers : []).filter(isRecord);
  const roleCounts = new Map<CloudAgentTeamsRole, number>();
  const expectedTaskByRole = new Map(expected.tasks?.map((task) => [task.role, task.taskId]) || []);
  for (const worker of workers) {
    const role = typeof worker.role === "string" && CLOUD_AGENTTEAMS_ROLES.includes(worker.role as CloudAgentTeamsRole)
      ? worker.role as CloudAgentTeamsRole
      : null;
    if (!role) {
      issues.push({ code: "worker_role_invalid", label: "发现无法识别的协作角色。" });
      continue;
    }
    const taskId = typeof worker.taskId === "string" ? worker.taskId : undefined;
    roleCounts.set(role, (roleCounts.get(role) || 0) + 1);
    const expectedTaskId = expectedTaskByRole.get(role);
    if (expectedTaskId && taskId !== expectedTaskId) issues.push({ code: "worker_task_mismatch", label: `${role} 回执不属于本次任务。`, taskId });
    if (receipt.status !== "running" && worker.status !== "completed") issues.push({ code: "worker_not_completed", label: `${role} 尚未完成。`, taskId });
    if (worker.status === "completed" && (typeof worker.summary !== "string" || worker.summary.trim().length < 8)) issues.push({ code: "worker_summary_missing", label: `${role} 缺少有效摘要。`, taskId });
    if (worker.status === "completed" && (!Array.isArray(worker.deliverables) || !worker.deliverables.some((item) => typeof item === "string" && item.trim()))) issues.push({ code: "worker_deliverables_missing", label: `${role} 缺少交付物。`, taskId });
    if (worker.status === "completed" && worker.effective !== true) issues.push({ code: "worker_ineffective", label: `${role} 的结果未通过有效性检查。`, taskId });
    if (worker.conclusion !== undefined && !["HUMAN_REVIEW", "SUCCESS_WITH_NOTES", "BLOCKED"].includes(String(worker.conclusion))) issues.push({ code: "worker_conclusion_invalid", label: `${role} 的结论格式无效。`, taskId });
    if (worker.factCount !== undefined && (!Number.isSafeInteger(worker.factCount) || Number(worker.factCount) < 0)) issues.push({ code: "worker_fact_count_invalid", label: `${role} 的事实计数无效。`, taskId });
    if (worker.conflictCount !== undefined && (!Number.isSafeInteger(worker.conflictCount) || Number(worker.conflictCount) < 0)) issues.push({ code: "worker_conflict_count_invalid", label: `${role} 的冲突计数无效。`, taskId });
    if (worker.unknownFields !== undefined && (!Array.isArray(worker.unknownFields) || worker.unknownFields.some((item) => typeof item !== "string"))) issues.push({ code: "worker_unknown_fields_invalid", label: `${role} 的未知字段清单无效。`, taskId });
    if (worker.sourceReceiptSha256 !== undefined && !/^[a-f0-9]{64}$/.test(String(worker.sourceReceiptSha256))) issues.push({ code: "worker_receipt_digest_invalid", label: `${role} 的原始收据摘要无效。`, taskId });
  }
  if (receipt.status !== "running") {
    for (const role of CLOUD_AGENTTEAMS_ROLES) {
      const count = roleCounts.get(role) || 0;
      if (count === 0) issues.push({ code: "worker_missing", label: `缺少 ${role} 回执。` });
      if (count > 1) issues.push({ code: "worker_duplicate", label: `${role} 回执重复。` });
    }
  }
  if (receipt.status === "completed" && workers.length !== CLOUD_AGENTTEAMS_ROLES.length) {
    issues.push({ code: "worker_count_invalid", label: "完整回执必须准确包含四个 Worker。" });
  }
  if (receipt.status === "completed" && (!isRecord(receipt.completeProject) || receipt.completeProject.attempted !== true || receipt.completeProject.success !== true)) {
    issues.push({ code: "complete_project_failed", label: "项目汇总没有成功完成。" });
  }
  if (receipt.status === "completed" && (!isRecord(receipt.completeProject) || receipt.completeProject.status !== "completed")) {
    issues.push({ code: "complete_project_status_invalid", label: "项目服务端状态尚未收口为 completed。" });
  }
  if (receipt.status === "failed") issues.push({ code: "run_failed", label: "云端运行已失败。" });
  if (!["running", "completed", "failed"].includes(String(receipt.status))) issues.push({ code: "receipt_status_invalid", label: "回执状态无法识别。" });
  if (receipt.status === "completed" && receipt.leader?.status !== "READY_FOR_HUMAN_REVIEW") {
    issues.push({ code: "leader_status_invalid", label: "Leader 尚未进入 READY_FOR_HUMAN_REVIEW。" });
  }
  if (receipt.status === "completed" && (typeof receipt.leader?.summary !== "string" || receipt.leader.summary.trim().length < 8)) {
    issues.push({ code: "leader_summary_missing", label: "项目汇总缺少有效摘要。" });
  }
  if (!isValidRfc3339DateTime(receipt.receivedAt)) {
    issues.push({ code: "received_at_invalid", label: "回执时间必须是带时区的有效 RFC 3339 时间。" });
  }
  const counters = receipt.counters;
  if (!isRecord(counters) || [counters.productionWrites, counters.publicPublishes, counters.realRefunds, counters.externalMessages]
    .some((count) => typeof count !== "number" || count !== 0)) {
    issues.push({ code: "external_write_detected", label: "检测到未授权外部动作或计数缺失。" });
  }
  if (issues.length && /ready|approved|success/i.test(String(receipt.leader?.status || ""))) {
    issues.push({ code: "leader_claim_ignored", label: "主理人的完成声明不能覆盖结构化检查结果。" });
  }

  const effective = workers.filter((worker) => worker.effective === true).length;
  const state: CloudCollaborationState = issues.length
    ? "needs_attention"
    : receipt.status === "running"
      ? "running"
      : "ready_for_human_review";
  const copy = stateCopy(state, issues.length);
  return {
    state,
    ...copy,
    canEnterHumanReview: state === "ready_for_human_review",
    workerProgress: { effective, received: workers.length, expected: CLOUD_AGENTTEAMS_ROLES.length },
    issues,
    receipt,
    sourceSchema: receipt.schema,
  };
}

export function evaluateCloudAgentTeamsReceipt(
  value: unknown,
  expected: ExpectedReceiptTrace = {},
): CloudReceiptEvaluation {
  const raw = isRecord(value) ? value : null;
  if (raw?.schema !== "juchang-cloud-runtime-evidence@1") {
    const receiptEvaluation = evaluateCloudAgentTeamsReceiptOnly(value, expected);
    if (receiptEvaluation.receipt?.status !== "completed") return receiptEvaluation;
    const issues = [
      ...receiptEvaluation.issues,
      {
        code: "runtime_evidence_missing",
        label: "缺少任务检查、正式接收与项目终态的权威运行证据。",
      },
    ];
    const copy = stateCopy("needs_attention", issues.length);
    return {
      ...receiptEvaluation,
      ...copy,
      state: "needs_attention",
      canEnterHumanReview: false,
      issues,
      runtimeEvidence: null,
    };
  }

  const evidence = raw as unknown as CloudAgentTeamsRuntimeEvidence;
  const receiptEvaluation = evaluateCloudAgentTeamsReceiptOnly(evidence.receipt, expected);
  const issues = [...receiptEvaluation.issues];
  const expectedTasks = expected.tasks || [];
  const expectedTaskIds = expectedTasks.map((task) => task.taskId);
  const expectedTaskIdSet = new Set(expectedTaskIds);
  const projectTasks = Array.isArray(evidence.project?.tasks) ? evidence.project.tasks : [];
  const taskRecords = Array.isArray(evidence.tasks) ? evidence.tasks : [];
  const events = Array.isArray(evidence.audit?.events) ? evidence.audit.events : [];
  const skillInvocations = Array.isArray(evidence.skillInvocations) ? evidence.skillInvocations : [];

  function addIssue(code: string, label: string, taskId?: string) {
    issues.push({ code, label, ...(taskId ? { taskId } : {}) });
  }

  if (!expected.dispatchId || expectedTasks.length !== CLOUD_AGENTTEAMS_ROLES.length) {
    addIssue("runtime_expected_trace_missing", "案件缺少本次派单的任务清单，不能核对云端验收记录。");
  }
  if (evidence.project?.project_id !== expected.dispatchId) {
    addIssue("runtime_project_mismatch", "云端项目不属于本次派单。");
  }
  if (evidence.project?.status !== "completed") {
    addIssue("runtime_project_not_completed", "云端项目尚未完成。");
  }
  if (projectTasks.length !== expectedTaskIds.length
    || new Set(projectTasks).size !== projectTasks.length
    || projectTasks.some((taskId) => !expectedTaskIdSet.has(taskId))) {
    addIssue("runtime_project_tasks_mismatch", "云端项目的任务清单与本次派单不一致。");
  }
  if (taskRecords.length !== expectedTaskIds.length
    || new Set(taskRecords.map((task) => task?.task_id)).size !== taskRecords.length) {
    addIssue("runtime_task_count_invalid", "云端验收记录必须准确包含四个任务。");
  }
  for (const taskId of expectedTaskIds) {
    const task = taskRecords.find((item) => item?.task_id === taskId);
    if (!task) {
      addIssue("runtime_task_missing", "缺少任务的权威状态。", taskId);
      continue;
    }
    if (task.status !== "completed") addIssue("runtime_task_not_completed", "任务尚未完成。", taskId);
    if (!["SUCCESS", "SUCCESS_WITH_NOTES"].includes(task.result_status)) {
      addIssue("runtime_task_result_invalid", "任务结果未通过服务端检查。", taskId);
    }
  }
  for (const invocation of skillInvocations) {
    const expectedTask = expectedTasks.find(({ taskId }) => taskId === invocation?.taskId);
    if (!expectedTask || invocation?.role !== expectedTask.role) {
      addIssue("runtime_skill_task_mismatch", "Skill 记录不属于本次责任位。", invocation?.taskId);
      continue;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(invocation.skillId || ""))) addIssue("runtime_skill_id_invalid", "Skill 标识无法识别。", invocation.taskId);
    if (!["discovered", "loaded", "called", "succeeded", "blocked", "failed", "not_called"].includes(String(invocation.status))) addIssue("runtime_skill_status_invalid", "Skill 状态无法识别。", invocation.taskId);
    if (invocation.claimableAsFreshEvidence && invocation.status !== "succeeded") addIssue("runtime_skill_claim_invalid", "未成功的 Skill 不能标记为本轮成功证据。", invocation.taskId);
    if (invocation.status === "succeeded" && (!invocation.contract || !invocation.version || !/^[a-f0-9]{64}$/.test(String(invocation.digest || "")))) addIssue("runtime_skill_identity_incomplete", "成功的 Skill 缺少完整身份。", invocation.taskId);
    if (!/^[a-f0-9]{64}$/.test(String(invocation.bundleSha256 || "")) || !/^[a-f0-9]{64}$/.test(String(invocation.authoritySha256 || ""))) addIssue("runtime_skill_trace_digest_invalid", "Skill 证据摘要无效。", invocation.taskId);
  }
  if (evidence.audit?.schema !== "juchang-cloud-audit@1"
    || evidence.audit?.dispatchId !== expected.dispatchId
    || evidence.audit?.projectId !== evidence.project?.project_id) {
    addIssue("runtime_audit_identity_invalid", "审计记录与本次云端项目不一致。");
  }

  let previousTime = -Infinity;
  for (const [index, event] of events.entries()) {
    if (!Number.isInteger(event?.sequence) || event.sequence !== index + 1) {
      addIssue("runtime_audit_sequence_invalid", "审计记录顺序不连续。");
      break;
    }
    if (!isValidRfc3339DateTime(event?.at)) {
      addIssue("runtime_audit_time_invalid", "审计记录包含无效时间。");
      break;
    }
    const currentTime = Date.parse(event.at);
    if (currentTime < previousTime) {
      addIssue("runtime_audit_time_reversed", "审计记录时间发生倒序。");
      break;
    }
    previousTime = currentTime;
  }

  const terminalIndexes: number[] = [];
  for (const taskId of expectedTaskIds) {
    const checkIndex = events.findIndex((event) => event.operation === "check_task" && event.taskId === taskId);
    const acceptIndex = events.findIndex((event) => event.operation === "accept_task_result" && event.taskId === taskId);
    const terminalIndex = events.findIndex((event) => event.operation === "task_terminal_observed" && event.taskId === taskId);
    const check = events[checkIndex];
    const accept = events[acceptIndex];
    const terminal = events[terminalIndex];
    if (checkIndex < 0 || acceptIndex <= checkIndex || terminalIndex <= acceptIndex) {
      addIssue("runtime_task_audit_incomplete", "任务未按检查、接收、终态观察的顺序完成。", taskId);
      continue;
    }
    if (check?.success !== true || check.effective !== true || !Array.isArray(check.validationErrors) || check.validationErrors.length > 0) {
      addIssue("runtime_task_check_failed", "任务有效性检查未通过。", taskId);
    }
    if (accept?.success !== true) addIssue("runtime_task_accept_failed", "任务结果未被正式接收。", taskId);
    if (terminal?.success !== true || terminal.status !== "completed") {
      addIssue("runtime_task_terminal_invalid", "任务终态不是 completed。", taskId);
    }
    terminalIndexes.push(terminalIndex);
  }

  const completeIndex = events.findIndex((event) => event.operation === "complete_project");
  const projectTerminalIndex = events.findIndex((event) => event.operation === "project_terminal_observed");
  const completeEvent = events[completeIndex];
  const projectTerminalEvent = events[projectTerminalIndex];
  if (completeIndex < 0
    || terminalIndexes.length !== expectedTaskIds.length
    || terminalIndexes.some((index) => index >= completeIndex)
    || completeEvent?.success !== true
    || completeEvent.status !== "completed") {
    addIssue("runtime_complete_project_invalid", "四个任务完成前后，项目没有被正确收口。");
  }
  if (projectTerminalIndex <= completeIndex
    || projectTerminalEvent?.success !== true
    || projectTerminalEvent.status !== "completed") {
    addIssue("runtime_project_terminal_invalid", "缺少项目完成后的权威读回。");
  }
  if (isValidRfc3339DateTime(evidence.receipt?.receivedAt)
    && Number.isFinite(previousTime)
    && Date.parse(evidence.receipt.receivedAt) <= previousTime) {
    addIssue("runtime_receipt_too_early", "回执生成时间早于审计流程结束时间。");
  }

  const state: CloudCollaborationState = issues.length ? "needs_attention" : "ready_for_human_review";
  const copy = stateCopy(state, issues.length);
  return {
    ...receiptEvaluation,
    ...copy,
    state,
    canEnterHumanReview: state === "ready_for_human_review",
    issues,
    runtimeEvidence: evidence,
    sourceSchema: evidence.schema,
  };
}
