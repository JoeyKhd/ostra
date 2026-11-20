import { startSubIssues } from "@ostra/domain";
import type { TrackerFor } from "@ostra/domain";
import { agentProfileIdSchema, connectionIdSchema, projectIdSchema, taskIdSchema, ticketIdSchema } from "@ostra/protocol";
import type { OrganizationId, ProjectId, TicketId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { ApiDeps } from "../trpc/context.ts";
import { denied, loadProjectAccess, memberProcedure, router, unwrap } from "../trpc/init.ts";
import type { ProjectAccess } from "../trpc/init.ts";
import { cacheTree, flatten, leavesOf, trackerTree } from "./ticket-tree.ts";
import type { TreeNode } from "./ticket-tree.ts";

// A parent ticket (F-077, F-010; milestone 6's ticket 25): its page lists its sub-issues to
// `OSTRA_SUB_ISSUES_DEPTH` levels with each one's task, its state, its PRs and what it needs, the
// children on no board of the project (which nothing starts), and the parent's own refine task.
// "Start sub-issues" starts one task per leaf through the domain's `startSubIssues`; the parent never
// gets a code task. Any member who can open the project; another organization's ticket, or a
// restricted project's the member isn't on, is NOT_FOUND. A ticket's text is data.

const FINISHED: readonly string[] = ["stopped", "merged", "done"];
const shortIdOf = (id: string): string => id.replaceAll("-", "").slice(-8);

const taskStateSchema = z.enum(["awaiting_approval", "queued", "preparing", "running", "needs_you", "in_review", "stopped", "merged", "done"]);

type TicketAccess = { readonly ticketId: TicketId; readonly projectId: ProjectId };

/** A procedure on one cached ticket: its project is checked as `projectProcedure` does. */
const ticketProcedure = <S extends z.ZodType<{ readonly ticketId: TicketId }>>(schema: S) =>
  memberProcedure.input(schema).use(async ({ ctx, input, next }) => {
    const row = await ctx.deps.db.ticket.findFirst({ where: { id: input.ticketId, organizationId: ctx.scope.organizationId, removedAt: null }, select: { id: true, projectId: true } });
    if (row === null) {
      throw denied("not-found", "ticket");
    }
    let project: ProjectAccess;
    try {
      project = await loadProjectAccess(ctx.deps.db, ctx.scope, projectIdSchema.parse(row.projectId), "read");
    } catch (error) {
      if (error instanceof TRPCError && error.code === "NOT_FOUND") {
        throw denied("not-found", "ticket");
      }
      throw error;
    }
    const ticket: TicketAccess = { ticketId: ticketIdSchema.parse(row.id), projectId: project.projectId };
    return next({ ctx: { ...ctx, project, ticket } });
  });

/** The domain's tracker lookup over the panel's tracker directory: `null` when it can't be read now. */
const trackerForDeps =
  (deps: ApiDeps): TrackerFor =>
  async (organizationId, connectionId) => {
    const lookup = await deps.trackers.forConnection(organizationId, connectionId);
    return lookup.ok ? lookup.tracker : null;
  };

const taskViewSchema = z.object({
  id: taskIdSchema,
  shortId: z.string(),
  state: taskStateSchema,
  /** Why it needs a person, while it does. */
  needsYou: z.string().nullable(),
  prs: z.array(z.object({ repo: z.string(), number: z.number().int(), url: z.string().nullable(), state: z.string() })),
});
type TaskView = z.infer<typeof taskViewSchema>;

/** Each ticket's code task: the active one, else the newest finished one, with its PRs. */
const codeTasksOf = async (deps: ApiDeps, organizationId: OrganizationId, ticketIds: readonly string[]): Promise<ReadonlyMap<string, TaskView>> => {
  const byTicket = new Map<string, TaskView & { readonly active: boolean }>();
  if (ticketIds.length === 0) return byTicket;
  const rows = await deps.db.task.findMany({
    where: { organizationId, ticketId: { in: [...ticketIds] }, kind: "code" },
    orderBy: { createdAt: "desc" },
    select: { id: true, ticketId: true, state: true, needsYouReason: true, repos: { select: { prNumber: true, prUrl: true, state: true, repo: { select: { fullName: true } } } } },
  });
  for (const row of rows) {
    if (row.ticketId === null) continue;
    const active = !FINISHED.includes(row.state);
    const held = byTicket.get(row.ticketId);
    if (held === undefined || (!held.active && active)) {
      byTicket.set(row.ticketId, {
        id: taskIdSchema.parse(row.id),
        shortId: shortIdOf(row.id),
        state: row.state,
        needsYou: row.state === "needs_you" ? row.needsYouReason : null,
        prs: row.repos.flatMap((repo) => (repo.prNumber === null ? [] : [{ repo: repo.repo.fullName, number: repo.prNumber, url: repo.prUrl, state: repo.state }])),
        active,
      });
    }
  }
  return byTicket;
};

const childSchema = z.object({
  key: z.string(),
  title: z.string(),
  url: z.string(),
  open: z.boolean(),
  /** 1 for the parent's own children. */
  depth: z.number().int(),
  parentKey: z.string(),
  /** Its row on one of the project's boards, or `null` when it's on none of them. */
  ticketId: ticketIdSchema.nullable(),
  place: z.enum(["board", "elsewhere"]),
  /** An open ticket without open children: what "Start sub-issues" starts, when it's on a board. */
  leaf: z.boolean(),
  /** Why "Start sub-issues" leaves it out: on no board of the project, or below the last level read. */
  skipped: z.enum(["not-on-a-board", "too-deep"]).nullable(),
  task: taskViewSchema.nullable(),
});

const startSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("leaves"), tasks: z.number().int() }),
  z.object({ kind: z.literal("over-limit"), count: z.number().int(), max: z.number().int() }),
  z.object({ kind: z.literal("no-children") }),
]);

export const ticketsRouter = router({
  /**
   * A parent ticket's page: its sub-issues from the tracker (or the cache when the tracker can't be
   * read), each with its task, what "Start sub-issues" would start, and the parent's refine task.
   */
  parent: ticketProcedure(z.strictObject({ ticketId: ticketIdSchema }))
    .output(
      z.object({
        ticket: z.object({ id: ticketIdSchema, projectId: projectIdSchema, key: z.string(), title: z.string(), url: z.string() }),
        /** Where the tree was read: the tracker, or the cache when the tracker couldn't be read. */
        source: z.enum(["tracker", "cache"]),
        depth: z.number().int(),
        children: z.array(childSchema),
        start: startSchema,
        refineTask: z.object({ id: taskIdSchema, shortId: z.string(), state: taskStateSchema }).nullable(),
      }),
    )
    .query(async ({ ctx }) => {
      const { db, settings } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const { subIssuesDepth: depth, subIssuesMax: max } = settings.team;
      const parent = await db.ticket.findFirstOrThrow({ where: { id: ctx.ticket.ticketId, organizationId }, include: { board: { select: { externalId: true } } } });
      const boardIds = (await db.board.findMany({ where: { organizationId, projectId: ctx.ticket.projectId, detachedAt: null }, select: { id: true } })).map((board) => board.id);
      const boards = { organizationId, boardIds };
      const lookup = await ctx.deps.trackers.forConnection(organizationId, connectionIdSchema.parse(parent.connectionId));
      const fromTracker = lookup.ok ? await trackerTree(db, lookup.tracker.tracker, boards, { externalId: parent.externalId, board: { externalId: parent.board.externalId } }, depth) : null;
      const children = fromTracker ?? (await cacheTree(db, boards, parent, depth));
      const leaves = leavesOf(parent, children, boardIds, depth, max);
      const skippedAs = new Map<string, "not-on-a-board" | "too-deep">(leaves.ok ? leaves.skipped.map((skip) => [skip.key, skip.reason] as const) : []);
      const nodes = flatten(children);
      const keyOf = new Map<string, string>([[parent.externalId, parent.key], ...nodes.map((node) => [node.externalId, node.key] as const)]);
      const tasks = await codeTasksOf(ctx.deps, organizationId, nodes.flatMap((node) => (node.cached === null ? [] : [node.cached.ticketId])));
      const refine = await db.task.findFirst({ where: { organizationId, ticketId: parent.id, kind: "refine" }, orderBy: { createdAt: "desc" }, select: { id: true, state: true } });
      const isLeaf = (node: TreeNode): boolean => node.open && !node.children.some((child) => child.open);
      return {
        ticket: { id: ticketIdSchema.parse(parent.id), projectId: ctx.ticket.projectId, key: parent.key, title: parent.title, url: parent.url },
        source: fromTracker === null ? ("cache" as const) : ("tracker" as const),
        depth,
        children: nodes.map((node) => {
          const task = node.cached === null ? undefined : tasks.get(node.cached.ticketId);
          return {
            key: node.key,
            title: node.title,
            url: node.url,
            open: node.open,
            depth: node.depth,
            parentKey: keyOf.get(node.parentExternalId) ?? parent.key,
            ticketId: node.cached?.ticketId ?? null,
            place: node.cached === null ? ("elsewhere" as const) : ("board" as const),
            leaf: isLeaf(node),
            skipped: node.open ? (skippedAs.get(node.key) ?? (node.cached === null ? "not-on-a-board" : null)) : null,
            task: task === undefined ? null : { id: task.id, shortId: task.shortId, state: task.state, needsYou: task.needsYou, prs: task.prs },
          };
        }),
        start: leaves.ok ? { kind: "leaves" as const, tasks: leaves.start.length } : leaves.reason === "over-limit" ? { kind: "over-limit" as const, count: leaves.count, max: leaves.max } : { kind: "no-children" as const },
        refineTask: refine === null ? null : { id: taskIdSchema.parse(refine.id), shortId: shortIdOf(refine.id), state: refine.state },
      };
    }),

  /**
   * "Start sub-issues": one code task per open leaf on the project's boards, through the one start
   * (each through the one-active-task rule), with the member as each one's starter. Over
   * `OSTRA_SUB_ISSUES_MAX` leaves nothing starts. Asking again starts nothing twice: a leaf that has
   * its task is `skipped: has-task`, whatever the request's key.
   */
  startSubIssues: ticketProcedure(
    z.strictObject({ ticketId: ticketIdSchema, requestKey: z.string().trim().min(1).max(200), agentProfileId: agentProfileIdSchema.nullable().default(null) }),
  )
    .output(
      z.object({
        result: z.enum(["started", "over-limit", "no-children"]),
        /** Over the limit: how many leaves there are, and the limit. */
        count: z.number().int(),
        max: z.number().int(),
        outcomes: z.array(z.object({ key: z.string(), state: z.enum(["started", "skipped", "failed"]), taskId: taskIdSchema.nullable(), reason: z.string().nullable() })),
        skipped: z.array(z.object({ key: z.string(), reason: z.enum(["not-on-a-board", "too-deep"]) })),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { db, ports, settings } = ctx.deps;
      const max = settings.team.subIssuesMax;
      const result = unwrap(
        await startSubIssues(
          { db, ...ports, publicUrl: settings.publicUrl, trackerFor: trackerForDeps(ctx.deps), subIssuesMax: max, subIssuesDepth: settings.team.subIssuesDepth },
          ctx.scope,
          { projectId: ctx.ticket.projectId, ticketId: ctx.ticket.ticketId, agentProfileId: input.agentProfileId },
        ),
        { forbidden: "FORBIDDEN", "not-found": "NOT_FOUND", "tracker-failed": "BAD_GATEWAY" },
      );
      const { leaves } = result;
      if (!leaves.ok) {
        return leaves.reason === "over-limit"
          ? { result: "over-limit" as const, count: leaves.count, max: leaves.max, outcomes: [], skipped: [] }
          : { result: "no-children" as const, count: 0, max, outcomes: [], skipped: [] };
      }
      return {
        result: "started" as const,
        count: leaves.start.length,
        max,
        outcomes: result.outcomes.map((outcome) => {
          switch (outcome.state) {
            case "started":
              return { key: outcome.key, state: outcome.state, taskId: outcome.taskId, reason: null };
            case "skipped":
              return { key: outcome.key, state: outcome.state, taskId: outcome.taskId, reason: outcome.reason };
            case "failed":
              return { key: outcome.key, state: outcome.state, taskId: null, reason: outcome.reason };
            default:
              return outcome satisfies never;
          }
        }),
        skipped: leaves.skipped.map((skip) => ({ key: skip.key, reason: skip.reason })),
      };
    }),
});
