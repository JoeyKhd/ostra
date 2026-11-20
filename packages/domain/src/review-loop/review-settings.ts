import type { Tx } from "@ostra/db";
import { projectIdSchema } from "@ostra/protocol";
import type { ProjectId } from "@ostra/protocol";
import { z } from "zod";

import { requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import type { UseCaseResult } from "../use-cases/common.ts";
import type { M6Deps } from "../use-cases/m6-signatures.ts";

// A project's "Review" settings (F-100, F-101; milestone 6's ticket 28; spec section 5.4): the AI
// review switch is the project's, and a project admin's to change; the round limits are the
// install's (`OSTRA_CI_ROUNDS`, `OSTRA_REVIEW_ROUNDS`, `OSTRA_AUTOMATIC_TURNS`), shown and never
// changed here. A change is audited; one to the value it already has writes nothing.

export type SetAiReviewResult = UseCaseResult<{ readonly on: boolean }, "forbidden" | "not-found">;

/** Turns a project's AI review on or off: a project admin's, an organization admin's, audited. */
export const setAiReview = (
  deps: Pick<M6Deps, "db" | "audit" | "notices">,
  scope: MemberScope,
  input: { readonly projectId: ProjectId; readonly on: boolean },
): Promise<SetAiReviewResult> =>
  deps.db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "project" WHERE "id" = ${input.projectId} AND "organizationId" = ${scope.organizationId} FOR UPDATE`;
    const project = await tx.project.findFirst({
      where: { id: input.projectId, organizationId: scope.organizationId },
      select: { id: true, access: true, aiReview: true },
    });
    if (project === null) {
      return { ok: false, error: "not-found", message: "No such project" };
    }
    const projectId = projectIdSchema.parse(project.id);
    const access = requireProjectAccess(scope, { id: projectId, organizationId: scope.organizationId, access: project.access }, "admin");
    if (!access.ok) {
      return access.code === "not-found"
        ? { ok: false, error: "not-found", message: "No such project" }
        : { ok: false, error: "forbidden", message: "Only a project admin turns the AI review on or off" };
    }
    if (project.aiReview === input.on) {
      return { ok: true, on: input.on };
    }
    await tx.project.update({ where: { id: projectId }, data: { aiReview: input.on } });
    await deps.audit.recordInTx(tx, {
      organizationId: scope.organizationId,
      projectId,
      actor: { kind: "member", id: scope.memberId },
      action: "project.ai-review-set",
      entity: "project",
      entityId: projectId,
      data: { on: input.on },
    });
    await deps.notices.emitInTx(tx, { organizationId: scope.organizationId, projectId, entity: "project", entityId: projectId });
    return { ok: true, on: input.on };
  });

/**
 * The acceptance criteria a code task is reviewed against (F-100, F-102): those of the ticket's
 * refine draft a member applied, newest first; `null` when no draft was applied, and the ticket's
 * own text says them.
 */
export const acceptedCriteriaOfTicketInTx = async (tx: Pick<Tx, "refineDraft">, ticketId: string | null): Promise<readonly string[] | null> => {
  if (ticketId === null) {
    return null;
  }
  const draft = await tx.refineDraft.findFirst({ where: { appliedAt: { not: null }, task: { ticketId } }, orderBy: { appliedAt: "desc" }, select: { acceptanceCriteria: true } });
  const criteria = z.array(z.string()).safeParse(draft?.acceptanceCriteria);
  return criteria.success && criteria.data.length > 0 ? criteria.data : null;
};
