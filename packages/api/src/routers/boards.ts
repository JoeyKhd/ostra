import { attachBoard, attachBoardInputSchema, boardMappingSchema, detachBoard, parseBoardMapping, saveBoardMapping, unknownMappedStatuses, visibleProjects } from "@ostra/domain";
import type { TrackerStatus } from "@ostra/adapter-sdk";
import { boardIdSchema, connectionIdSchema, organizationIdSchema, projectIdSchema } from "@ostra/protocol";
import type { ConnectionId, OrganizationId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { TrackerLookup } from "../services/trackers.ts";
import type { ApiDeps } from "../trpc/context.ts";
import { boardProcedure, projectProcedure, router, unwrap } from "../trpc/init.ts";

// F-007, F-031, ticket 28: a project's boards. A board is a tracker team attached to a project,
// with the status mapping that says what the Inbox shows and how ticket sync moves a ticket. A
// project admin attaches, edits and detaches; every member who can open the project reads. A team
// may be a board in several projects, each a board of its own (`domain-model.md`).
//
// The panel is enqueue-only (ADR 0037): it cannot create a pg-boss schedule. A board's polling
// schedule is core's to make from the `Board` rows (ticket 14), which it does for every board that
// isn't detached; attaching enqueues the first full poll, so the Inbox fills at once.

const categoryOrder = ["open", "started", "done", "cancelled"] as const;

const statusViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.enum(categoryOrder),
  /** The tracker's own type, such as Linear's `unstarted`: the pickers group and icon by it. */
  vendorType: z.string(),
  position: z.number(),
});

const integrationSchema = z.enum(["installed", "not_installed", "unknown"]);

const boardViewSchema = z.object({
  id: boardIdSchema,
  name: z.string(),
  /** The team's key as of the last read, such as `OST`. */
  key: z.string().nullable(),
  externalId: z.string(),
  /** Epoch ms. */
  attachedAt: z.number().int(),
  openTickets: z.number().int(),
  /** Epoch ms of the last poll, or `null`. */
  lastPolledAt: z.number().int().nullable(),
  /** The newest delivery the connection received for this board, or `null`. */
  lastEvent: z.object({ at: z.number().int(), type: z.string(), ticketKey: z.string().nullable() }).nullable(),
  integration: integrationSchema,
  /** `null` while the board has none (a milestone 1 row): it needs a mapping before it can be used. */
  mapping: boardMappingSchema.nullable(),
  /** Every status of the team, grouped by category, or `null` when the tracker couldn't be asked. */
  statusGroups: z.array(z.object({ category: z.enum(categoryOrder), statuses: z.array(statusViewSchema) })).nullable(),
  statusesError: z.string().nullable(),
  /** Mapped statuses the team no longer has: the page asks for another. */
  missingStatuses: z.array(z.string()),
  /** Milestone 6 (F-012): "Start from Linear": a delegation in this board's team starts a task here. */
  startFromLinear: z.boolean(),
});

const boardsViewSchema = z.object({
  /** What a member needs of the connection; `null` until the organization connects Linear. */
  connection: z
    .object({
      connectionId: connectionIdSchema,
      workspaceName: z.string().nullable(),
      mode: z.enum(["webhooks", "polling"]),
      state: z.enum(["pending", "active", "failed", "revoked"]),
      /** Polling mode's interval, in seconds. */
      pollSeconds: z.number().int(),
      /** Milestone 6 (F-012): agent mode is on, so a board's "Start from Linear" can be switched. */
      agentMode: z.boolean(),
    })
    .nullable(),
  /** The caller may attach, edit and detach: a project admin. */
  canEdit: z.boolean(),
  boards: z.array(boardViewSchema),
});

const teamSchema = z.object({
  externalId: z.string(),
  key: z.string(),
  name: z.string(),
  /** Already a board of this project. */
  attached: z.boolean(),
  /** The other projects (that the caller can open) which have this team as a board. */
  alsoOn: z.array(z.object({ projectId: projectIdSchema, name: z.string() })),
});

const groupStatuses = (statuses: readonly TrackerStatus[]) =>
  categoryOrder
    .map((category) => ({
      category,
      statuses: statuses
        .filter((status) => status.category === category)
        .sort((a, b) => a.position - b.position)
        .map((status) => ({ id: status.id, name: status.name, category: status.category, vendorType: status.vendorType, position: status.position })),
    }))
    .filter((group) => group.statuses.length > 0);

/** The organization's usable Linear tracker, or the tRPC error that says what to do first. */
const requireTracker = async (deps: ApiDeps, organizationId: OrganizationId): Promise<Extract<TrackerLookup, { readonly ok: true }>["tracker"]> => {
  const connectionId = await deps.trackers.linearConnectionOf(organizationId);
  if (connectionId === null) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Connect Linear first: an organization admin does it under Linear" });
  }
  return trackerOf(deps, organizationId, connectionId);
};

const trackerOf = async (deps: ApiDeps, organizationId: OrganizationId, connectionId: ConnectionId) => {
  const found = await deps.trackers.forConnection(organizationId, connectionId);
  if (!found.ok) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: found.message });
  }
  return found.tracker;
};

export const boardsRouter = router({
  /**
   * The connection's teams, marking those already attached to this project, and those which other
   * projects have too (a team may be a board in several projects). Project admins only.
   */
  available: projectProcedure("admin", z.strictObject({ projectId: projectIdSchema }))
    .output(z.array(teamSchema))
    .query(async ({ ctx, input }) => {
      const { db } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const tracker = await requireTracker(ctx.deps, organizationId);
      const listed = await tracker.tracker.listBoards();
      if (!listed.ok) {
        throw new TRPCError({ code: "BAD_GATEWAY", message: `The tracker did not list its teams: ${listed.error.message}` });
      }
      const attached = await db.board.findMany({
        where: { organizationId, connectionId: tracker.connectionId, detachedAt: null },
        select: { externalId: true, projectId: true, project: { select: { id: true, name: true, access: true } } },
      });
      const projects = visibleProjects(
        ctx.scope,
        attached.map((board) => ({ id: projectIdSchema.parse(board.project.id), organizationId, access: board.project.access, name: board.project.name })),
      );
      return listed.value.map((team) => ({
        externalId: team.externalId,
        key: team.key,
        name: team.name,
        attached: attached.some((board) => board.externalId === team.externalId && board.projectId === input.projectId),
        alsoOn: attached
          .filter((board) => board.externalId === team.externalId && board.projectId !== input.projectId)
          .flatMap((board) => projects.filter((project) => project.id === board.projectId).map((project) => ({ projectId: project.id, name: project.name }))),
      }));
    }),

  /**
   * The project's boards with what the boards page shows a member (so nobody needs `linear.status`):
   * the key, the open tickets, the last poll and event, the connection's workspace and mode, the
   * integration check, the mapping, and every status of the team. The statuses are asked of the
   * tracker, so the page also sees a status that was deleted since the mapping was saved.
   */
  get: projectProcedure("read", z.strictObject({ projectId: projectIdSchema }))
    .output(boardsViewSchema)
    .query(async ({ ctx, input }) => {
      const { db, settings } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const rows = await db.board.findMany({ where: { organizationId, projectId: input.projectId, detachedAt: null }, orderBy: { createdAt: "asc" } });
      const connectionId = await ctx.deps.trackers.linearConnectionOf(organizationId);
      const connection = connectionId === null ? null : await db.connection.findFirst({ where: { id: connectionId, organizationId } });
      const canEdit = ctx.project.role === "admin";
      if (connection === null) {
        return { connection: null, canEdit, boards: [] };
      }

      const openCounts = await db.ticket.groupBy({
        by: ["boardId"],
        where: { organizationId, projectId: input.projectId, open: true, removedAt: null },
        _count: { _all: true },
      });
      const found = await ctx.deps.trackers.forConnection(organizationId, connectionIdSchema.parse(connection.id));

      const boards = await Promise.all(
        rows.map(async (row) => {
          const [statuses, integration, delivery] = await Promise.all([
            found.ok ? found.tracker.tracker.listStatuses({ externalId: row.externalId }) : Promise.resolve(null),
            found.ok ? found.tracker.tracker.detectCodeHostIntegration({ externalId: row.externalId }) : Promise.resolve(null),
            db.webhookDelivery.findFirst({
              where: { organizationId, connectionId: connection.id, ...(row.key === null ? {} : { ticketKey: { startsWith: `${row.key}-` } }) },
              orderBy: { receivedAt: "desc" },
              select: { receivedAt: true, event: true, ticketKey: true },
            }),
          ]);
          // The check is refreshed as the page loads; a tracker that can't say leaves the last answer.
          let detected = row.integrationDetected;
          if (integration?.ok === true && integration.value.installed !== row.integrationDetected) {
            detected = integration.value.installed;
            await db.board.update({ where: { id: row.id }, data: { integrationDetected: detected } });
          }
          const mapping = parseBoardMapping(row.statusMap);
          const statusList = statuses?.ok === true ? statuses.value : null;
          return {
            id: boardIdSchema.parse(row.id),
            name: row.name,
            key: row.key,
            externalId: row.externalId,
            attachedAt: row.createdAt.getTime(),
            openTickets: openCounts.find((count) => count.boardId === row.id)?._count._all ?? 0,
            lastPolledAt: row.lastPolledAt?.getTime() ?? null,
            lastEvent: delivery === null ? null : { at: delivery.receivedAt.getTime(), type: delivery.event, ticketKey: delivery.ticketKey },
            integration: detected === null ? ("unknown" as const) : detected ? ("installed" as const) : ("not_installed" as const),
            mapping,
            statusGroups: statusList === null ? null : groupStatuses(statusList),
            statusesError: found.ok ? (statuses?.ok === false ? `The tracker did not list the team's statuses: ${statuses.error.message}` : null) : found.message,
            missingStatuses: statusList === null || mapping === null ? [] : [...unknownMappedStatuses(mapping, statusList)],
            startFromLinear: row.agentMode,
          };
        }),
      );
      return {
        connection: {
          connectionId: connectionIdSchema.parse(connection.id),
          workspaceName: connection.externalWorkspaceName,
          mode: connection.webhookMode,
          state: connection.state,
          pollSeconds: settings.trackerPollSeconds,
          agentMode: connection.agentModeAt !== null,
        },
        canEdit,
        boards,
      };
    }),

  /**
   * Attaches a team as a board: drafts its mapping from the team's statuses and the integration
   * check (spec section 3, step 2), and enqueues the first full poll, in the same transaction.
   */
  attach: projectProcedure("admin", attachBoardInputSchema)
    .output(z.object({ boardId: boardIdSchema, mapping: boardMappingSchema, integrationInstalled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const organizationId = organizationIdSchema.parse(ctx.scope.organizationId);
      const tracker = await requireTracker(ctx.deps, organizationId);
      const result = await db.$transaction(
        async (tx) => {
          const attached = await attachBoard({ tx, scope: ctx.scope, tracker, ...ports }, input);
          if (attached.ok) {
            await ports.jobs.enqueueInTx(tx, "tracker.poll-board", { organizationId, boardId: attached.boardId }, { group: { id: tracker.connectionId } });
          }
          return attached;
        },
        { timeout: 30_000, maxWait: 10_000 },
      );
      const attached = unwrap(result, {
        "not-found": "NOT_FOUND",
        forbidden: "FORBIDDEN",
        "no-connection": "PRECONDITION_FAILED",
        "already-attached": "CONFLICT",
        "no-started-status": "PRECONDITION_FAILED",
        "no-done-status": "PRECONDITION_FAILED",
        "tracker-failed": "BAD_GATEWAY",
      });
      return { boardId: attached.boardId, mapping: attached.mapping, integrationInstalled: attached.integrationInstalled };
    }),

  /** Saves the mapping after checking each status still exists on the team. */
  saveMapping: boardProcedure("admin", z.strictObject({ boardId: boardIdSchema, mapping: boardMappingSchema }))
    .output(z.object({ mapping: boardMappingSchema }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const board = await db.board.findFirstOrThrow({ where: { id: input.boardId, organizationId: ctx.scope.organizationId }, select: { connectionId: true } });
      const tracker = await trackerOf(ctx.deps, ctx.scope.organizationId, connectionIdSchema.parse(board.connectionId));
      const result = await db.$transaction((tx) => saveBoardMapping({ tx, scope: ctx.scope, tracker, ...ports }, input), { timeout: 30_000, maxWait: 10_000 });
      const saved = unwrap(result, { "not-found": "NOT_FOUND", forbidden: "FORBIDDEN", "unknown-status": "BAD_REQUEST", "tracker-failed": "BAD_GATEWAY" });
      return { mapping: saved.mapping };
    }),

  /**
   * Detaches the board: no more polling, no new task from it. Its tickets stay cached and its
   * tasks keep their links.
   */
  detach: boardProcedure("admin", z.strictObject({ boardId: boardIdSchema }))
    .output(z.object({ boardId: boardIdSchema }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const result = await db.$transaction((tx) => detachBoard({ tx, scope: ctx.scope, ...ports }, input));
      const detached = unwrap(result, { "not-found": "NOT_FOUND", forbidden: "FORBIDDEN", "already-detached": "CONFLICT" });
      return { boardId: detached.boardId };
    }),
});
