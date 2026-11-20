import { agentDisplayName } from "@ostra/domain";
import type { Db } from "@ostra/db";
import { agentProfileIdSchema, modelIdSchema } from "@ostra/protocol";
import { z } from "zod";

// An agent profile as the panel shows it: its name, its agent's display name and its model's name
// (task.md, task-new.md). `model` is `null` while an admin hasn't picked one: a task can't start.

export const agentProfileViewSchema = z.object({
  id: agentProfileIdSchema,
  name: z.string(),
  /** The `AgentAdapter`'s registered name, such as `opencode`. */
  adapter: z.string(),
  /** The agent's display name, such as `OpenCode`. */
  agentName: z.string(),
  model: z.object({ id: modelIdSchema, name: z.string() }).nullable(),
  /** Milestone 6 (ticket 34): the built-in Refine or Review profile, which the panel marks `built-in`; `null` for any other. */
  builtInKind: z.enum(["refine", "review"]).nullable(),
});
export type AgentProfileView = z.infer<typeof agentProfileViewSchema>;

/** One profile of the organization, or `null` when there's none by that ID. */
export const loadAgentProfileView = async (db: Db, organizationId: string, profileId: string | null): Promise<AgentProfileView | null> => {
  if (profileId === null) return null;
  const profile = await db.agentProfile.findFirst({
    where: { id: profileId, organizationId },
    select: { id: true, name: true, adapter: true, builtInKind: true, model: { select: { id: true, displayName: true, endpointModelId: true } } },
  });
  if (profile === null) return null;
  return {
    id: agentProfileIdSchema.parse(profile.id),
    name: profile.name,
    adapter: profile.adapter,
    agentName: agentDisplayName(profile.adapter),
    builtInKind: profile.builtInKind === "refine" || profile.builtInKind === "review" ? profile.builtInKind : null,
    model: profile.model === null ? null : { id: modelIdSchema.parse(profile.model.id), name: profile.model.displayName ?? profile.model.endpointModelId },
  };
};
