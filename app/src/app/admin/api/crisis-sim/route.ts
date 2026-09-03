import { NextResponse } from "next/server";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { buildCloudAgentTeamsDispatch, serializeCloudAgentTeamsDispatch } from "@/lib/admin/cloud-agentteams-contract";
import { isTrustedBrowserReadRequest } from "@/lib/admin/project-select-boundary";
import {
  buildHumanDecisionReceipt,
  canonicalDigest,
  loadCrisisSimFixtures,
  type CrisisSimFixtures,
  type HumanDecisionChoice,
  type CrisisScenarioPreset,
  type VerifiedReplaySummary,
} from "@/lib/crisis-sim/contracts";
import { runCrisisEvals } from "@/lib/crisis-sim/evals";
import { runCrisisProtocolSimulation } from "@/lib/crisis-sim/protocol-simulator";

import { authorizeAgentStudio, rejectInvalidPostOrigin } from "../agent-studio/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DISPATCH_PREVIEW_NOTE =
  "派单预览是 P1 真实 Agent 运行的输入，不是运行证据；真实运行证据只能来自用户接管的 AgentTeams 运行。";
const HUMAN_RECEIPT_NOTE =
  "人工决定收据只校验并返回，不落库；由浏览器本地保存。Agent 无审批与执行权，executionAuthorized 恒为 false。";

const DECISION_CHOICES: readonly HumanDecisionChoice[] = [
  "approve_simulated_plan",
  "reject",
  "request_more_evidence",
];

let fixturesCache: CrisisSimFixtures | null = null;
let replaysCache: VerifiedReplaySummary[] | null = null;

function getFixtures(): CrisisSimFixtures {
  fixturesCache ??= loadCrisisSimFixtures();
  return fixturesCache;
}

/** 只读加载已冻结的 Verified Replay fixture（juchang-crisis-verified-replay@1）。缺失/损坏时返回空数组，不阻塞 bootstrap。 */
function getVerifiedReplays(): VerifiedReplaySummary[] {
  if (replaysCache) return replaysCache;
  try {
    const dir = path.join(process.cwd(), "src/data/crisis-sim");
    replaysCache = readdirSync(dir)
      .filter((name) => name.startsWith("verified-replay-") && name.endsWith(".json"))
      .sort()
      .map((name) => {
        const parsed = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as Record<string, unknown>;
        const replay = (parsed.replay ?? {}) as Record<string, unknown>;
        const receipt = (replay.receipt ?? {}) as Record<string, unknown>;
        const workers = Array.isArray(receipt.workers) ? (receipt.workers as Array<Record<string, unknown>>) : [];
        const rawSkillInvocations = Array.isArray(replay.skillInvocations)
          ? (replay.skillInvocations as Array<Record<string, unknown>>)
          : [];
        const audit = (replay.audit ?? {}) as Record<string, unknown>;
        const rawAuditEvents = Array.isArray(audit.events) ? (audit.events as Array<Record<string, unknown>>) : [];
        return {
          replayId: String(parsed.replayId ?? name),
          schema: String(parsed.schema ?? ""),
          frozenAt: String(parsed.frozenAt ?? ""),
          readonly: parsed.readonly === true,
          disclosure: String(parsed.disclosure ?? ""),
          source: (parsed.source ?? {}) as VerifiedReplaySummary["source"],
          runtimeProvenance: (replay.provenance ?? null) as VerifiedReplaySummary["runtimeProvenance"],
          validation: (parsed.validation ?? null) as VerifiedReplaySummary["validation"],
          digests: (parsed.digests ?? {}) as Record<string, string | null>,
          workerSummaries: workers.map((worker) => ({
            taskId: String(worker.taskId ?? ""),
            role: String(worker.role ?? ""),
            status: String(worker.status ?? ""),
            summary: String(worker.summary ?? ""),
          })),
          leaderSummary: (receipt.leader ?? null) as VerifiedReplaySummary["leaderSummary"],
          skillInvocations: rawSkillInvocations.map((invocation) => ({
            skillId: String(invocation.skillId ?? ""),
            role: invocation.role === undefined ? undefined : String(invocation.role),
            status: String(invocation.status ?? ""),
            contract: invocation.contract === undefined ? undefined : String(invocation.contract),
            version: invocation.version === undefined ? undefined : String(invocation.version),
            invokedAt: invocation.invokedAt === undefined ? undefined : String(invocation.invokedAt),
          })),
          auditEvents: rawAuditEvents.map((event) => ({
            operation: String(event.operation ?? event.event ?? event.type ?? ""),
            at: event.at === undefined ? undefined : String(event.at),
          })),
        };
      });
    // 最新的回放排最前（verifiedReplays[0] 恒为信息最全的一次运行）。
    replaysCache.sort((a, b) => b.frozenAt.localeCompare(a.frozenAt));
  } catch {
    replaysCache = [];
  }
  return replaysCache;
}

function buildDispatchPreview(preset: CrisisScenarioPreset) {
  const dispatch = buildCloudAgentTeamsDispatch({
    changeRef: `chg-crisis-sim-${preset.presetId}`,
    projectRef: "zhuantang-yixun",
    adapterRef: "yixun-local",
    decisionRunId: `crisis-${preset.presetId}-p0`,
    sourceLocators: [
      ...(preset.sourceCatalog?.map((source) => source.url ?? source.sourceId) ?? []),
      ...(preset.sourceProvenance.sourceFile ? [preset.sourceProvenance.sourceFile] : []),
    ],
    affectedObjects: [preset.title],
    unresolvedQuestions: preset.options.map((option) => `是否采纳方案：${option.label}`),
  });
  return {
    presetId: preset.presetId,
    note: DISPATCH_PREVIEW_NOTE,
    dispatch,
    serialized: serializeCloudAgentTeamsDispatch(dispatch),
  };
}

export async function GET(request: Request) {
  if (!isTrustedBrowserReadRequest(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const authorization = await authorizeAgentStudio();
  if (!authorization.ok) return authorization.response;
  try {
    const fixtures = getFixtures();
    const generatedAt = new Date().toISOString();
    const dispatchPreviews = fixtures.presetOrder
      .map((presetId) => fixtures.presets[presetId])
      .map(buildDispatchPreview);
    return NextResponse.json(
      {
        schema: "juchang-crisis-sim-bootstrap@1",
        generatedAt,
        presets: fixtures.presetOrder.map((presetId) => fixtures.presets[presetId]),
        presetDigests: Object.fromEntries(
          fixtures.presetOrder.map((presetId) => [presetId, fixtures.presetDigests[presetId]]),
        ),
        library: fixtures.library,
        libraryDigest: fixtures.digests["virtual-private-library.json"],
        provenance: fixtures.provenance,
        verifiedReplays: getVerifiedReplays(),
        dispatchPreviews,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[crisis-sim/bootstrap]", error instanceof Error ? error.message : "bootstrap_failed");
    return NextResponse.json({ error: "crisis_sim_bootstrap_failed" }, { status: 500 });
  }
}

function resolvePreset(presetId: unknown) {
  if (typeof presetId !== "string") return null;
  const fixtures = getFixtures();
  return fixtures.presets[presetId] ?? null;
}

function runSimulation(preset: CrisisScenarioPreset) {
  const fixtures = getFixtures();
  const generatedAt = new Date().toISOString();
  const report = runCrisisProtocolSimulation({
    preset,
    library: fixtures.library,
    presetDigest: fixtures.presetDigests[preset.presetId],
    libraryDigest: fixtures.digests["virtual-private-library.json"],
    generatedAt,
  });
  return report;
}

export async function POST(request: Request) {
  const originRejected = rejectInvalidPostOrigin(request);
  if (originRejected) return originRejected;
  const authorization = await authorizeAgentStudio();
  if (!authorization.ok) return authorization.response;
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return NextResponse.json({ error: "JSON required" }, { status: 415 });
  }
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const action = typeof body.action === "string" ? body.action : "";
    const preset = resolvePreset(body.presetId);
    if (!preset) {
      return NextResponse.json({ error: "unknown presetId" }, { status: 400 });
    }

    if (action === "run_protocol_simulation" || action === "run_eval") {
      const report = runSimulation(preset);
      if (action === "run_protocol_simulation") {
        return NextResponse.json({ report, dispatchPreview: buildDispatchPreview(preset) }, {
          headers: { "Cache-Control": "no-store" },
        });
      }
      const evalReport = runCrisisEvals({ preset, library: getFixtures().library, report }, new Date().toISOString());
      return NextResponse.json({ report, evalReport }, { headers: { "Cache-Control": "no-store" } });
    }

    if (action === "record_human_decision") {
      const runKind = body.runKind === "live_agent_run" ? "live_agent_run" : "protocol_simulation";
      const decision = DECISION_CHOICES.includes(body.decision as HumanDecisionChoice)
        ? (body.decision as HumanDecisionChoice)
        : null;
      if (!decision || typeof body.reason !== "string") {
        return NextResponse.json({ error: "decision and reason required" }, { status: 400 });
      }
      const fixtures = getFixtures();
      const presetDigest = fixtures.presetDigests[preset.presetId];
      let agentRunDigest: string;
      if (runKind === "protocol_simulation") {
        const report = runSimulation(preset);
        // 绑定页面所见报告：客户端回传 reportId 时必须与确定性重跑一致，
        // 防止收据被绑定到另一份报告或已变更 fixture（页面组件回传接入前，缺省不回传则放行，见审计结论）。
        const reportId = typeof body.reportId === "string" ? body.reportId.trim() : "";
        if (reportId && reportId !== report.reportId) {
          return NextResponse.json(
            { error: "reportId 与当前 fixture 的确定性重跑不一致，收据拒绝绑定" },
            { status: 400 },
          );
        }
        agentRunDigest = canonicalDigest(report);
      } else {
        // 最低限度收紧：live 收据必须绑定 64 位十六进制运行哈希（真实性注册表超出本期范围，见审计结论）。
        if (typeof body.agentRunDigest !== "string" || !/^[0-9a-f]{64}$/i.test(body.agentRunDigest.trim())) {
          return NextResponse.json({ error: "live_agent_run 收据必须提供真实运行的 64 位十六进制 agentRunDigest" }, { status: 400 });
        }
        agentRunDigest = body.agentRunDigest.trim().toLowerCase();
      }
      const receipt = buildHumanDecisionReceipt({
        preset,
        presetDigest,
        agentRunDigest,
        runKind,
        decision,
        reason: body.reason,
        decidedAt: typeof body.decidedAt === "string" ? body.decidedAt : "",
        authorityBasis: typeof body.authorityBasis === "string" ? body.authorityBasis : undefined,
      });
      return NextResponse.json({ receipt, note: HUMAN_RECEIPT_NOTE }, { headers: { "Cache-Control": "no-store" } });
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "crisis_sim_action_failed";
    console.error("[crisis-sim/action]", message);
    return NextResponse.json(
      { error: message },
      { status: /invalid|required|must|未知|必须/.test(message) ? 400 : 503 },
    );
  }
}
