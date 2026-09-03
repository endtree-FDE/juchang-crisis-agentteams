import { NextResponse } from "next/server";

import { ADMIN_CAPABILITIES } from "@/lib/admin/capability-registry";
import { resolveAdminContext } from "@/lib/admin/server-auth";
import type { AdminRole } from "@/lib/admin/session";
import { isSameOriginControlRequest } from "@/lib/server/agentteams-control-access";

export const AGENT_STUDIO_PROJECT_ID = process.env.AGENT_STUDIO_PROJECT_ID?.trim()
  || "64y6vka0xof25n8";

const STUDIO_ROLES: readonly AdminRole[] = ADMIN_CAPABILITIES.find(
  (capability) => capability.id === "work",
)?.roles ?? [];

export type AgentStudioActor = {
  actorId: string;
  role: AdminRole;
  projectId: string;
};

type AgentStudioAuthorization =
  | { ok: true; actor: AgentStudioActor }
  | { ok: false; response: NextResponse };

export async function authorizeAgentStudio(options: { adminOnly?: boolean } = {}): Promise<AgentStudioAuthorization> {
  const auth = await resolveAdminContext();
  if (!auth.ok) {
    return { ok: false, response: NextResponse.json({ error: auth.error }, { status: auth.status }) };
  }
  if (auth.principal.project.id !== AGENT_STUDIO_PROJECT_ID) {
    return { ok: false, response: NextResponse.json({ error: "agent_studio_project_forbidden" }, { status: 403 }) };
  }
  if (!STUDIO_ROLES.includes(auth.principal.role) || (options.adminOnly && auth.principal.role !== "admin")) {
    return { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return {
    ok: true,
    actor: {
      actorId: auth.principal.uid,
      role: auth.principal.role,
      projectId: auth.principal.project.id,
    },
  };
}

export function rejectInvalidPostOrigin(request: Request) {
  if (!isSameOriginControlRequest(request)) {
    return NextResponse.json({ error: "Origin rejected" }, { status: 403 });
  }
  return null;
}
