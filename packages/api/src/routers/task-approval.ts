import { approveOutsideTask, rejectOutsideTask, setOutsideApproval, visibleProjects } from "@ostra/domain";
import { agentProfileIdSchema, automationIdSchema, projectIdSchema, taskIdSchema, ticketIdSchema } from "@ostra/protocol";
import type { OrganizationId, ProjectId } from "@ostra/protocol";
import { z } from "zod";

import type { ApiDeps } from "../trpc/context.ts";
import { adminProcedure, loadProjectAccess, memberProcedure, taskProcedure, unwrap } from "../trpc/init.ts";

// Outside tasks and their approval (F-040, F-012; ADR 0031, ADR 0057; milestone 6's ticket 26).
// "Needs approval" lists the tasks waiting for a member's answer in the projects the member can
// open: outside tasks (a Linear user ostra matched to no member who can open the project) and the
// tasks of a rule that asks for approval. Each says who started it by the name the tracker gave, and
// never their address: the task has none to give. Any member who can open the project approves or
// rejects; the first answer wins (the task's row lock, ticket 14). Only an organization admin
// switches a project's approval off.

const shortIdOf = (id: string): string => id.replaceAll("-", "").slice(-8);

const startedBySchema = z.discriminatedUnion("kind", [
  /** A tracker user from outside: the name Linear gave, never an address. */
  z.object({ kind: z.literal("outside"), name: z.string() }),
  /** A rule that asks for approval. */
  z.object({ kind: z.literal("automation"), automationId: automationIdSchema, name: z.string() }),
  /** A member's start that waits (a rule's "Start all" never does; kept for completeness). */
  z.object({ kind: z.literal("member"), name: z.string().nullable() }),
]);

const waitingTaskSchema = z.object({
  taskId: taskIdSchema,
  shortId: z.string(),
  title: z.string(),
  kind: z.enum(["refine", "code", "review"]),
  createdAt: z.number().int(),
  project: z.object({ id: projectIdSchema, name: z.string() }),
  startedBy: startedBySchema,
  ticket: z.object({ id: ticketIdSchema, key: z.string(), title: z.string(), url: z.string() }).nullable(),
  /** The profile it runs: an outside task's is the project's default for its kind. */
  profile: z.object({ id: agentProfileIdSchema, name: z.string() }).nullable(),
  /** The project's pools, in its order: an outside task runs on one of them, never on a personal runner. */
  pools: z.array(z.string()),
  poolOnly: z.boolean(),
});

const outsideApprovalSchema = z.object({
  projectId: projectIdSchema,
  on: z.boolean(),
  /** The organization admin who last switched it; `null` while it's the default. */
  changedByName: z.string().nullable(),
});

const outsideApprovalOf = async (deps: ApiDeps, organizationId: OrganizationId, projectId: ProjectId): Promise<z.infer<typeof outsideApprovalSchema>> => {
  const project = await deps.db.project.findFirstOrThrow({ where: { id: projectId, organizationId }, select: { outsideApproval: true, outsideApprovalChangedByMemberId: true } });
  const changer =
    project.outsideApprovalChangedByMemberId === null
      ? null
      : await deps.db.member.findFirst({ where: { id: project.outsideApprovalChangedByMemberId, organizationId }, select: { user: { select: { name: true } } } });
  return { projectId, on: project.outsideApproval, changedByName: changer?.user.name ?? null };
};

/** The tasks waiting for approval in the projects the member can open, oldest first. */
export const needsApprovalProcedure = memberProcedure
  .input(z.strictObject({ projectId: projectIdSchema.nullable() }))
  .output(z.object({ tasks: z.array(waitingTaskSchema), outsideApproval: outsideApprovalSchema.nullable() }))
  .query(async ({ ctx, input }) => {
    const { db } = ctx.deps;
    const organizationId = ctx.scope.organizationId;
    let projectIds: ProjectId[];
    if (input.projectId === null) {
      const projects = await db.project.findMany({ where: { organizationId }, select: { id: true, access: true } });
      projectIds = visibleProjects(
        ctx.scope,
        projects.map((project) => ({ id: projectIdSchema.parse(project.id), organizationId, access: project.access })),
      ).map((project) => project.id);
    } else {
      projectIds = [(await loadProjectAccess(db, ctx.scope, input.projectId, "read")).projectId];
    }
    const rows = await db.task.findMany({
      where: { organizationId, projectId: { in: projectIds }, state: "awaiting_approval" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 200,
      select: {
        id: true,
        title: true,
        kind: true,
        createdAt: true,
        poolOnly: true,
        trackerActorName: true,
        creatorMemberId: true,
        project: { select: { id: true, name: true } },
        automation: { select: { id: true, name: true } },
        ticket: { select: { id: true, key: true, title: true, url: true } },
        agentProfile: { select: { id: true, name: true } },
      },
    });
    const [pools, creators] = await Promise.all([
      db.projectPool.findMany({ where: { organizationId, projectId: { in: [...new Set(rows.map((row) => row.project.id))] } }, orderBy: [{ position: "asc" }, { pool: { name: "asc" } }], select: { projectId: true, pool: { select: { name: true } } } }),
      db.member.findMany({ where: { organizationId, id: { in: rows.flatMap((row) => (row.creatorMemberId === null ? [] : [row.creatorMemberId])) } }, select: { id: true, user: { select: { name: true } } } }),
    ]);
    const creatorName = new Map(creators.map((member) => [member.id, member.user.name] as const));
    const tasks = rows.map((row) => ({
      taskId: taskIdSchema.parse(row.id),
      shortId: shortIdOf(row.id),
      title: row.title,
      kind: row.kind,
      createdAt: row.createdAt.getTime(),
      project: { id: projectIdSchema.parse(row.project.id), name: row.project.name },
      startedBy:
        row.trackerActorName !== null
          ? { kind: "outside" as const, name: row.trackerActorName }
          : row.automation !== null
            ? { kind: "automation" as const, automationId: automationIdSchema.parse(row.automation.id), name: row.automation.name }
            : { kind: "member" as const, name: row.creatorMemberId === null ? null : (creatorName.get(row.creatorMemberId) ?? null) },
      ticket: row.ticket === null ? null : { id: ticketIdSchema.parse(row.ticket.id), key: row.ticket.key, title: row.ticket.title, url: row.ticket.url },
      profile: row.agentProfile === null ? null : { id: agentProfileIdSchema.parse(row.agentProfile.id), name: row.agentProfile.name },
      pools: pools.filter((pool) => pool.projectId === row.project.id).map((pool) => pool.pool.name),
      poolOnly: row.poolOnly,
    }));
    return { tasks, outsideApproval: input.projectId === null ? null : await outsideApprovalOf(ctx.deps, organizationId, input.projectId) };
  });

const decisionCodes = { forbidden: "FORBIDDEN", "not-found": "NOT_FOUND", "not-awaiting-approval": "CONFLICT" } as const;

/** "Approve": the task is queued, then runs on one of the project's pools. The first answer wins. */
export const approveProcedure = taskProcedure("read", z.strictObject({ taskId: taskIdSchema }))
  .output(z.object({ taskId: taskIdSchema, approvedAt: z.number().int() }))
  .mutation(async ({ ctx, input }) => {
    const approved = unwrap(await approveOutsideTask({ db: ctx.deps.db, ...ctx.deps.ports, publicUrl: ctx.deps.settings.publicUrl }, ctx.scope, { taskId: input.taskId }), decisionCodes);
    return { taskId: input.taskId, approvedAt: approved.approvedAt };
  });

/** "Reject", with an optional reason for the project's members and the agent session: the task stops. */
export const rejectProcedure = taskProcedure("read", z.strictObject({ taskId: taskIdSchema, reason: z.string().max(300).nullable() }))
  .output(z.object({ taskId: taskIdSchema, stoppedAt: z.number().int() }))
  .mutation(async ({ ctx, input }) => {
    const rejected = unwrap(
      await rejectOutsideTask({ db: ctx.deps.db, ...ctx.deps.ports, publicUrl: ctx.deps.settings.publicUrl }, ctx.scope, { taskId: input.taskId, reason: input.reason }),
      decisionCodes,
    );
    return { taskId: input.taskId, stoppedAt: rejected.stoppedAt };
  });

/** "Outside tasks need approval", per project: an organization admin's switch only (ADR 0057). */
export const setOutsideApprovalProcedure = adminProcedure
  .input(z.strictObject({ projectId: projectIdSchema, on: z.boolean() }))
  .output(outsideApprovalSchema)
  .mutation(async ({ ctx, input }) => {
    unwrap(await setOutsideApproval({ db: ctx.deps.db, ...ctx.deps.ports }, ctx.scope, input), { forbidden: "FORBIDDEN", "not-found": "NOT_FOUND" });
    return outsideApprovalOf(ctx.deps, ctx.scope.organizationId, input.projectId);
  });
