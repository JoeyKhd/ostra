import type { Db } from "@ostra/db";
import { projectIdSchema } from "@ostra/protocol";
import type { ProjectId } from "@ostra/protocol";

import { requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import type { AuditLog, ChangeNotices } from "../ports.ts";
import type { UseCaseResult } from "../use-cases/common.ts";

// A project's repo skills (F-021, ADR 0049 amended 2026-11-21, the maintainer's "yes"): whether
// each repo's own skills, its `.agents/skills`, `.claude/skills` and `.opencode/skills`, reach the
// agent beside the profile's. On by default. A project admin (or an organization admin) turns them
// off and on; each change is an audit entry, and one to the value it already has writes nothing.
// The task spec carries the setting at every session's dispatch (`agent.repoSkills`), so a change
// reaches each task's next session.

export type SetRepoSkillsResult = UseCaseResult<{ readonly on: boolean }, "forbidden" | "not-found">;

/** Turns a project's repo skills on or off: a project admin's, an organization admin's, audited. */
export const setRepoSkills = (
  deps: { readonly db: Db; readonly audit: AuditLog; readonly notices: ChangeNotices },
  scope: MemberScope,
  input: { readonly projectId: ProjectId; readonly on: boolean },
): Promise<SetRepoSkillsResult> =>
  deps.db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "project" WHERE "id" = ${input.projectId} AND "organizationId" = ${scope.organizationId} FOR UPDATE`;
    const project = await tx.project.findFirst({
      where: { id: input.projectId, organizationId: scope.organizationId },
      select: { id: true, access: true, repoSkills: true },
    });
    if (project === null) {
      return { ok: false, error: "not-found", message: "No such project" };
    }
    const projectId = projectIdSchema.parse(project.id);
    const access = requireProjectAccess(scope, { id: projectId, organizationId: scope.organizationId, access: project.access }, "admin");
    if (!access.ok) {
      return access.code === "not-found"
        ? { ok: false, error: "not-found", message: "No such project" }
        : { ok: false, error: "forbidden", message: "Only a project admin turns the repos' own skills on or off" };
    }
    if (project.repoSkills === input.on) {
      return { ok: true, on: input.on };
    }
    await tx.project.update({ where: { id: projectId }, data: { repoSkills: input.on } });
    await deps.audit.recordInTx(tx, {
      organizationId: scope.organizationId,
      projectId,
      actor: { kind: "member", id: scope.memberId },
      action: "project.repo-skills-set",
      entity: "project",
      entityId: projectId,
      data: { on: input.on },
    });
    await deps.notices.emitInTx(tx, { organizationId: scope.organizationId, projectId, entity: "project", entityId: projectId });
    return { ok: true, on: input.on };
  });
