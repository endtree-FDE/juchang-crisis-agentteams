import type { LibraryRecord, VirtualPrivateLibrary } from "./contracts.ts";

/**
 * 虚拟闭源库 RBAC Broker（纯函数，无 node 依赖，可在客户端实时运行）。
 * 分层语义：元数据（recordId/密级）→ 摘要（summary）→ 全文/用途/引用/审批。
 * 拒绝不是错误：拒绝记录会生成人工交接项（handoff）。
 */

export type BrokerAccessAction = string;

export type BrokerReason =
  | "role_permitted"
  | "metadata_visible_content_denied_handoff_required"
  | "metadata_hidden_handoff_required"
  | "record_not_found"
  | "action_unknown";

export type BrokerLookup = {
  roleId: string;
  recordId: string;
  action: BrokerAccessAction;
  collectionId: string | null;
  classification: string | null;
  metadataVisible: boolean;
  contentVisible: boolean;
  allowed: boolean;
  handoffRequired: boolean;
  reason: BrokerReason;
  note: string;
};

const READ_ACTIONS = new Set(["read_excerpt", "read_full"]);

export function findLibraryRecord(
  library: Pick<VirtualPrivateLibrary, "collections">,
  recordId: string,
): { record: LibraryRecord; collectionId: string } | null {
  for (const collection of library.collections) {
    const record = collection.records.find((item) => item.recordId === recordId);
    if (record) return { record, collectionId: collection.collectionId };
  }
  return null;
}

export function resolveLibraryAccess(
  library: Pick<VirtualPrivateLibrary, "collections" | "accessActions">,
  roleId: string,
  recordId: string,
  action: BrokerAccessAction,
): BrokerLookup {
  const found = findLibraryRecord(library, recordId);
  if (!found) {
    return {
      roleId,
      recordId,
      action,
      collectionId: null,
      classification: null,
      metadataVisible: false,
      contentVisible: false,
      allowed: false,
      handoffRequired: true,
      reason: "record_not_found",
      note: "记录不存在：按安全默认拒绝并生成人工核对项。",
    };
  }
  if (!library.accessActions.includes(action)) {
    return {
      roleId,
      recordId,
      action,
      collectionId: found.collectionId,
      classification: found.record.classification,
      metadataVisible: false,
      contentVisible: false,
      allowed: false,
      handoffRequired: true,
      reason: "action_unknown",
      note: "未知访问动作：按安全默认拒绝。",
    };
  }

  const { record, collectionId } = found;
  const metaPermitted = record.permittedRoles.discover_metadata ?? [];
  const metadataVisible = metaPermitted.includes(roleId);

  if (action === "discover_metadata") {
    return {
      roleId,
      recordId,
      action,
      collectionId,
      classification: record.classification,
      metadataVisible,
      contentVisible: false,
      allowed: metadataVisible,
      handoffRequired: !metadataVisible,
      reason: metadataVisible ? "role_permitted" : "metadata_hidden_handoff_required",
      note: metadataVisible
        ? "允许发现元数据（recordId 与密级）。"
        : "该角色无权发现此记录的元数据：记录对本角色不可见，需人工交接。",
    };
  }

  const permitted = record.permittedRoles[action] ?? [];
  const allowed = permitted.includes(roleId);

  if (READ_ACTIONS.has(action)) {
    return {
      roleId,
      recordId,
      action,
      collectionId,
      classification: record.classification,
      metadataVisible,
      contentVisible: allowed,
      allowed,
      handoffRequired: !allowed,
      reason: allowed
        ? "role_permitted"
        : metadataVisible
          ? "metadata_visible_content_denied_handoff_required"
          : "metadata_hidden_handoff_required",
      note: allowed
        ? "允许读取摘要内容。"
        : metadataVisible
          ? "元数据可见但内容拒绝：需要有人工交接（有权限角色或事件负责人）完成读取。"
          : "该角色对此记录完全不可见：需人工交接确认是否存在与如何流转。",
    };
  }

  const namedHumanOnly = action === "approve" || action === "execute";
  return {
    roleId,
    recordId,
    action,
    collectionId,
    classification: record.classification,
    metadataVisible,
    contentVisible: false,
    allowed,
    handoffRequired: !allowed,
    reason: allowed ? "role_permitted" : "metadata_visible_content_denied_handoff_required",
    note: allowed
      ? "允许该动作。"
      : namedHumanOnly
        ? "approval_denied_named_human_required：Agent 无审批/执行权，必须由具名人类决定。"
        : "该角色未获此动作授权：拒绝并生成人工交接项。",
  };
}

export type BrokerTraceItem = {
  behaviorId: string;
  role: string;
  recordId: string;
  action: BrokerAccessAction;
  expected: string;
  actual: string;
  ok: boolean;
  lookup: BrokerLookup;
};

function actionFromExpected(expected: string): BrokerAccessAction {
  if (expected === "approval_denied_named_human_required") return "approve";
  return "read_excerpt";
}

export function runRequiredDemoBehaviors(
  library: VirtualPrivateLibrary,
): BrokerTraceItem[] {
  return library.requiredDemoBehaviors.map((behavior) => {
    const action = actionFromExpected(behavior.expected);
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
    } else if (behavior.expected === "approval_denied_named_human_required") {
      actual = !lookup.allowed ? "approval_denied_named_human_required" : "allowed";
    } else {
      actual = lookup.allowed ? "allowed" : "denied";
    }
    return {
      behaviorId: behavior.behaviorId,
      role: behavior.role,
      recordId: behavior.recordId,
      action,
      expected: behavior.expected,
      actual,
      ok: actual === behavior.expected,
      lookup,
    };
  });
}
