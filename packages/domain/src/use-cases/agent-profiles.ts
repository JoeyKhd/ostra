import type { Tx } from "@ostra/db";
import { agentProfileIdSchema } from "@ostra/protocol";
import type { AgentProfileId, OrganizationId } from "@ostra/protocol";

// The built-in OpenCode profile (Q28, ADR 0032): every organization has one, and a project's
// default code profile points at it (F-086). Its model is the admin's pick among the providers'
// models (`agentProfiles.setDefaultModel`, F-088); until they pick, the profile has none.

export const BUILT_IN_PROFILE_NAME = "OpenCode";
export const BUILT_IN_PROFILE_ADAPTER = "opencode";

/** The organization's built-in OpenCode profile, created on first use. Idempotent. */
export const ensureBuiltInAgentProfile = async (tx: Tx, organizationId: OrganizationId): Promise<AgentProfileId> => {
  const existing = await tx.agentProfile.findFirst({
    where: { organizationId, builtIn: true, adapter: BUILT_IN_PROFILE_ADAPTER },
    select: { id: true },
  });
  if (existing !== null) {
    return agentProfileIdSchema.parse(existing.id);
  }
  const created = await tx.agentProfile.create({
    data: { organizationId, name: BUILT_IN_PROFILE_NAME, adapter: BUILT_IN_PROFILE_ADAPTER, builtIn: true },
    select: { id: true },
  });
  return agentProfileIdSchema.parse(created.id);
};
