import { reachability } from "@ostra/adapter-sdk";
import type { TrackerBoard, TrackerStatus, TrackerWorkflow } from "@ostra/adapter-sdk";
import type { DbEnum } from "@ostra/db";
import {
  attachBoard,
  attachBoardInputSchema,
  boardMappingSchema,
  boardPauseReasons,
  boardStateOf,
  detachBoard,
  mappingReachability,
  mappingSteps,
  parseBoardMapping,
  saveBoardMapping,
  trackerKindNames,
  trackerKinds,
  unknownMappedStatuses,
  visibleProjects,
} from "@ostra/domain";
import type { BoardMapping, BoardState, ConnectionTracker, MemberScope, TrackerConnection } from "@ostra/domain";
import { boardIdSchema, connectionIdSchema, organizationIdSchema, projectIdSchema } from "@ostra/protocol";
import type { BoardId, ConnectionId, OrganizationId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { capabilitiesSchema, ticketConnectionOf } from "../services/ticket-trackers.ts";
import type { TrackerLookup } from "../services/trackers.ts";
import type { ApiDeps } from "../trpc/context.ts";
import { adminProcedure, boardProcedure, projectProcedure, router, unwrap } from "../trpc/init.ts";

// F-007, F-031, ticket 28: a project's boards. A board is a tracker's team or project attached to a
// project, with the status mapping that says what the Inbox shows and how ticket sync moves a
// ticket. A project admin attaches, edits and detaches; every member who can open the project
// reads. A team may be a board in several projects, each a board of its own (`domain-model.md`).
//
// Milestone 11 (F-152, F-008, ADR 0071; boards-mixed.md, "Data"): a board belongs to one of the
// organization's tracker connections, of any kind, and every procedure goes through the board's
// own connection, never "the organization's" tracker. Attaching names the connection; the attach
// picker lists every connection's teams or projects, grouped. A board whose connection isn't
// active is paused (`boardStateOf`): it still shows, its mapping reads only, and the tracker isn't
// asked. A board on a tracker whose statuses form a graph (Jira) answers its workflow, with each
// step's transition lines and the statuses no route leaves.
//
// The panel is enqueue-only (ADR 0037): it cannot create a pg-boss schedule. A board's polling
// schedule is core's to make from the `Board` rows, which it does for every attached board of
// every kind; attaching enqueues the first full poll, so the Inbox fills at once.

const categoryOrder = ["open", "started", "done", "cancelled"] as const;
const connectionStates = ["pending", "active", "failed", "revoked"] as const;

const statusViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.enum(categoryOrder),
  /** The tracker's own type, such as Linear's `unstarted`: the pickers group and icon by it. */
  vendorType: z.string(),
  position: z.number(),
});

const integrationSchema = z.enum(["installed", "not_installed", "unknown"]);

/** The board's connection, as a project's members may see it (ADR 0071): its kind, name, state and mode. */
const boardConnectionSchema = z.object({
  id: connectionIdSchema,
  kind: z.enum(trackerKinds),
  name: z.string(),
  state: z.enum(connectionStates),
  mode: z.enum(["webhooks", "polling"]),
  /** Milestone 6 (F-012): agent mode is on (Linear's), so the board's "Start from Linear" can be switched. */
  agentMode: z.boolean(),
});

/** `boardStateOf` as the page draws it: attached, or paused with why and since when (epoch ms). */
const boardStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("attached") }),
  z.object({ state: z.literal("paused"), pausedBy: z.enum(boardPauseReasons), since: z.number().int() }),
]);

const boardViewSchema = z.object({
  id: boardIdSchema,
  name: z.string(),
  /** The team's or project's key as of the last read, such as `OST`. */
  key: z.string().nullable(),
  externalId: z.string(),
  /** Milestone 11: the connection the board is on (`Globex Jira · project`). */
  connection: boardConnectionSchema,
  /** Milestone 11 (F-152/c5): a paused board reads only, and nothing moves on its tracker. */
  state: boardStateSchema,
  /** What the board's tracker declares: the page draws Jira's transition lines, Linear's magic word. */
  capabilities: capabilitiesSchema,
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
  /** Every status of the board, grouped by category, or `null` when the tracker couldn't be asked (or the board is paused). */
  statusGroups: z.array(z.object({ category: z.enum(categoryOrder), statuses: z.array(statusViewSchema) })).nullable(),
  statusesError: z.string().nullable(),
  /** Mapped statuses the board no longer has: the page asks for another. */
  missingStatuses: z.array(z.string()),
  /** Milestone 6 (F-012): "Start from Linear": a delegation in this board's team starts a task here. */
  startFromLinear: z.boolean(),
  /**
   * F-097 (Q31): the project's "Make a ticket for every prompt task" names this board. Read from the
   * row, so it stays `true` while the board is paused (prompt-tickets.md's paused state), when
   * `projects.get`'s `promptTicketBoardId` is `null`.
   */
  ticketsForPromptTasks: z.boolean(),
});

const boardsViewSchema = z.object({
  /**
   * The organization's tracker connections that aren't revoked, oldest first: none, and the page
   * asks to connect one; none active, and there's nothing to attach yet.
   */
  connections: z.array(z.object({ id: connectionIdSchema, kind: z.enum(trackerKinds), name: z.string(), state: z.enum(["pending", "active", "failed"]) })),
  /** Polling mode's interval, in seconds. */
  pollSeconds: z.number().int(),
  /** The caller may attach, edit and detach: a project admin. */
  canEdit: z.boolean(),
  boards: z.array(boardViewSchema),
});

/** A connection's head in the attach picker and Create a project: its mark, name and state. */
const groupHeadFields = {
  id: connectionIdSchema,
  kind: z.enum(trackerKinds),
  name: z.string(),
  /** `pending` and `failed` list nothing: the picker says to finish or fix it on Trackers first. */
  state: z.enum(["pending", "active", "failed"]),
  /** Why an active connection lists nothing: its tracker couldn't be asked. `null` otherwise. */
  error: z.string().nullable(),
};

const attachableSchema = z.object({
  connections: z.array(
    z.object({
      ...groupHeadFields,
      items: z.array(
        z.object({
          externalId: z.string(),
          key: z.string(),
          name: z.string(),
          /** Already a board of this project: shown faint, not pickable. */
          attachedHere: z.boolean(),
          /** The other projects (that the caller can open) which have it as a board: it can feed several. */
          alsoOn: z.array(z.object({ projectId: projectIdSchema, name: z.string() })),
        }),
      ),
    }),
  ),
});

const teamsSchema = z.object({
  connections: z.array(z.object({ ...groupHeadFields, items: z.array(z.object({ externalId: z.string(), key: z.string(), name: z.string() })) })),
});

const workflowStatusSchema = z.object({ id: z.string(), name: z.string(), category: z.enum(categoryOrder) });
const fromSchema = z.union([z.array(z.string()), z.literal("any")]);

const workflowSchema = z.discriminatedUnion("readable", [
  /** The credential can't read the graph (Jira without `read:workflow:jira`): the statuses alone, no lines or warnings. */
  z.object({ readable: z.literal(false), statuses: z.array(workflowStatusSchema) }),
  z.object({
    readable: z.literal(true),
    statuses: z.array(workflowStatusSchema),
    /** Each transition by name, from its statuses (or `any`, a global one) to one. */
    transitions: z.array(z.object({ id: z.string(), name: z.string(), from: fromSchema, to: z.string() })),
    /** `mappingReachability`: per step of the mapping, its `by …` lines and the statuses no route leaves toward its target. */
    steps: z.array(
      z.object({
        step: z.enum(mappingSteps),
        target: z.string(),
        by: z.array(z.object({ transition: z.object({ id: z.string(), name: z.string() }), from: fromSchema })),
        unreachable: z.array(z.string()),
      }),
    ),
    /** The target-status picker's right column: per status, the statuses a route reaches it from, and those none does. */
    reach: z.array(z.object({ statusId: z.string(), reachedFrom: z.array(z.string()), unreachable: z.array(z.string()), global: z.boolean() })),
  }),
]);

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

/** One of the organization's connections' adapter, by its ID, or the tRPC error that says why not. */
const trackerOf = async (deps: ApiDeps, organizationId: OrganizationId, connectionId: ConnectionId): Promise<ConnectionTracker> => {
  const found = await deps.trackers.forConnection(organizationId, connectionId);
  if (!found.ok) {
    throw new TRPCError({ code: found.error === "no-connection" ? "NOT_FOUND" : "PRECONDITION_FAILED", message: found.message });
  }
  return found.tracker;
};

/** The words of a failed listing: Linear lists teams, Jira projects. */
const boardsWord = (connection: Pick<TrackerConnection, "kind" | "name">): string => `${connection.name} did not list its ${connection.kind === "jira" ? "projects" : "teams"}`;

type ListedBoards = { readonly connection: TrackerConnection; readonly boards: readonly TrackerBoard[]; readonly error: string | null };

/** Every connection that isn't revoked, oldest first, with the teams or projects an active one lists. */
const listedBoardsOf = async (deps: ApiDeps, organizationId: OrganizationId): Promise<readonly ListedBoards[]> => {
  const connections = await deps.trackers.connectionsOf(organizationId);
  return Promise.all(
    connections.map(async (connection): Promise<ListedBoards> => {
      if (connection.state !== "active") {
        return { connection, boards: [], error: null };
      }
      const found = await deps.trackers.forConnection(organizationId, connection.id);
      if (!found.ok) {
        return { connection, boards: [], error: found.message };
      }
      const listed = await found.tracker.tracker.listBoards();
      return listed.ok ? { connection, boards: listed.value, error: null } : { connection, boards: [], error: `${boardsWord(connection)}: ${listed.error.message}` };
    }),
  );
};

const groupHeadOf = (connection: TrackerConnection, error: string | null) => ({ id: connection.id, kind: connection.kind, name: connection.name, state: connection.state, error });

/** When each paused board's connection stopped: its newest disconnect or failure, else its row's last change. */
const pausedSinceOf = async (
  deps: ApiDeps,
  organizationId: OrganizationId,
  connections: readonly { readonly id: string; readonly updatedAt: Date }[],
): Promise<ReadonlyMap<string, number>> => {
  if (connections.length === 0) return new Map();
  const entries = await deps.db.auditEntry.findMany({
    where: { organizationId, entity: "connection", entityId: { in: connections.map((connection) => connection.id) }, action: { in: ["tracker.disconnected", "tracker.failed", "linear.disconnected"] } },
    orderBy: { createdAt: "desc" },
    select: { entityId: true, createdAt: true },
  });
  return new Map(connections.map((connection) => [connection.id, (entries.find((entry) => entry.entityId === connection.id)?.createdAt ?? connection.updatedAt).getTime()] as const));
};

const boardStateViewOf = (state: BoardState, since: number): z.infer<typeof boardStateSchema> => {
  switch (state.state) {
    case "attached":
      return { state: "attached" };
    case "paused":
      return { state: "paused", pausedBy: state.pausedBy, since };
    case "detached":
      // A detached board is never listed (the query leaves it out); it reads as paused should it race.
      return { state: "paused", pausedBy: "disconnected", since };
    default:
      return state satisfies never;
  }
};

/** A paused board's refusal: its mapping reads only, and its tracker isn't asked (F-152/c5). */
const refusePaused = (connection: { readonly name: string | null; readonly kind: DbEnum.ConnectionKind }): never => {
  const kind = connection.kind === "github" ? "GitHub" : trackerKindNames[connection.kind];
  throw new TRPCError({ code: "PRECONDITION_FAILED", message: `This board is paused: ${connection.name ?? kind} isn't connected, so its mapping reads only until it is` });
};

/** The board and its connection, inside the caller's organization (the procedure already checked it). */
const boardWithConnection = (deps: ApiDeps, organizationId: OrganizationId, boardId: BoardId) =>
  deps.db.board.findFirstOrThrow({
    where: { id: boardId, organizationId },
    select: { id: true, externalId: true, statusMap: true, detachedAt: true, connectionId: true, connection: { select: { state: true, name: true, kind: true } } },
  });

/** Saves a mapping through the board's own connection (the domain checks each status against its tracker). A paused board's is refused. */
const saveThroughBoard = async (deps: ApiDeps, scope: MemberScope, boardId: BoardId, mapping: BoardMapping) => {
  const board = await boardWithConnection(deps, scope.organizationId, boardId);
  if (boardStateOf(board, board.connection).state === "paused") {
    return refusePaused(board.connection);
  }
  const tracker = await trackerOf(deps, scope.organizationId, connectionIdSchema.parse(board.connectionId));
  const result = await deps.db.$transaction((tx) => saveBoardMapping({ tx, scope, tracker, ...deps.ports }, { boardId, mapping }), { timeout: 30_000, maxWait: 10_000 });
  return unwrap(result, { "not-found": "NOT_FOUND", forbidden: "FORBIDDEN", "unknown-status": "BAD_REQUEST", "tracker-failed": "BAD_GATEWAY", "board-paused": "PRECONDITION_FAILED" });
};

/** Per status of a workflow, as a target: the statuses a route reaches it from, those none does, and whether a global transition goes there. */
const statusReachOf = (workflow: TrackerWorkflow) =>
  workflow.statuses.map((target) => {
    const reached = reachability(workflow, target.id);
    return {
      statusId: target.id,
      reachedFrom: reached.flatMap(({ status, reach }) => (reach.kind === "route" ? [status.id] : [])),
      unreachable: reached.flatMap(({ status, reach }) => (reach.kind === "unreachable" ? [status.id] : [])),
      global: workflow.transitions.some((transition) => transition.from === "any" && transition.to === target.id),
    };
  });

export const boardsRouter = router({
  /**
   * The teams and projects of every connection before a project exists (project-new.md, "Tracker";
   * grouped as the attach picker groups them): Create a project picks one and attaches it once the
   * project is made. Organization admins only; no connection answers no groups.
   */
  teams: adminProcedure.output(teamsSchema).query(async ({ ctx }) => {
    const organizationId = organizationIdSchema.parse(ctx.scope.organizationId);
    const listed = await listedBoardsOf(ctx.deps, organizationId);
    return {
      connections: listed.map(({ connection, boards, error }) => ({ ...groupHeadOf(connection, error), items: boards.map((board) => ({ externalId: board.externalId, key: board.key, name: board.name })) })),
    };
  }),

  /**
   * The attach picker (boards-attach): per connection that isn't revoked, its teams or projects,
   * marking those already attached to this project and naming the other projects that have them
   * (a board can feed several projects). A pending or failed connection lists nothing, with its
   * state. Project admins only.
   */
  attachable: projectProcedure("admin", z.strictObject({ projectId: projectIdSchema }))
    .output(attachableSchema)
    .query(async ({ ctx, input }) => {
      const organizationId = ctx.scope.organizationId;
      const listed = await listedBoardsOf(ctx.deps, organizationId);
      const attached = await ctx.deps.db.board.findMany({
        where: { organizationId, connectionId: { in: listed.map(({ connection }) => connection.id) }, detachedAt: null },
        select: { externalId: true, projectId: true, connectionId: true, project: { select: { id: true, name: true, access: true } } },
      });
      const projects = visibleProjects(
        ctx.scope,
        attached.map((board) => ({ id: projectIdSchema.parse(board.project.id), organizationId, access: board.project.access, name: board.project.name })),
      );
      return {
        connections: listed.map(({ connection, boards, error }) => {
          const ours = attached.filter((board) => board.connectionId === connection.id);
          return {
            ...groupHeadOf(connection, error),
            items: boards.map((board) => ({
              externalId: board.externalId,
              key: board.key,
              name: board.name,
              attachedHere: ours.some((row) => row.externalId === board.externalId && row.projectId === input.projectId),
              alsoOn: ours
                .filter((row) => row.externalId === board.externalId && row.projectId !== input.projectId)
                .flatMap((row) => projects.filter((project) => project.id === row.projectId).map((project) => ({ projectId: project.id, name: project.name }))),
            })),
          };
        }),
      };
    }),

  /**
   * The project's boards with what the boards page shows a member: each board's connection (kind,
   * name, state, mode), whether it's paused, its tracker's capabilities, the key, the open tickets,
   * the last poll and event, the integration check, the mapping, and every status of the board. The
   * statuses are asked of the board's own connection, so the page also sees a status that was
   * deleted since the mapping was saved; a paused board's tracker isn't asked.
   */
  get: projectProcedure("read", z.strictObject({ projectId: projectIdSchema }))
    .output(boardsViewSchema)
    .query(async ({ ctx, input }) => {
      const { db, settings } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const canEdit = ctx.project.role === "admin";
      const [rows, connections, openCounts] = await Promise.all([
        db.board.findMany({
          where: { organizationId, projectId: input.projectId, detachedAt: null },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          include: { connection: { select: { id: true, kind: true, name: true, externalWorkspaceName: true, state: true, webhookMode: true, agentModeAt: true, updatedAt: true } } },
        }),
        ctx.deps.trackers.connectionsOf(organizationId),
        db.ticket.groupBy({ by: ["boardId"], where: { organizationId, projectId: input.projectId, open: true, removedAt: null }, _count: { _all: true } }),
      ]);
      const since = await pausedSinceOf(
        ctx.deps,
        organizationId,
        rows.filter((row) => boardStateOf(row, row.connection).state === "paused").map((row) => row.connection),
      );
      // Each connection's adapter is built once, for its attached boards only.
      const lookups = new Map<string, Promise<TrackerLookup>>();
      const lookupOf = (connectionId: ConnectionId): Promise<TrackerLookup> => {
        const held = lookups.get(connectionId);
        if (held !== undefined) return held;
        const made = ctx.deps.trackers.forConnection(organizationId, connectionId);
        lookups.set(connectionId, made);
        return made;
      };

      const boards = await Promise.all(
        rows.map(async (row) => {
          const named = ticketConnectionOf(row.connection);
          if (named === null) return [];
          const state = boardStateOf(row, row.connection);
          const found = state.state === "attached" ? await lookupOf(named.id) : null;
          const tracker = found?.ok === true ? found.tracker.tracker : null;
          const [statuses, integration, delivery] = await Promise.all([
            tracker === null ? Promise.resolve(null) : tracker.listStatuses({ externalId: row.externalId }),
            tracker === null ? Promise.resolve(null) : tracker.detectCodeHostIntegration({ externalId: row.externalId }),
            db.webhookDelivery.findFirst({
              where: { organizationId, connectionId: row.connectionId, ...(row.key === null ? {} : { ticketKey: { startsWith: `${row.key}-` } }) },
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
          const statusesError = found === null ? null : !found.ok ? found.message : statuses?.ok === false ? `The tracker did not list the board's statuses: ${statuses.error.message}` : null;
          return [
            {
              id: boardIdSchema.parse(row.id),
              name: row.name,
              key: row.key,
              externalId: row.externalId,
              connection: { ...named, state: row.connection.state, mode: row.connection.webhookMode, agentMode: row.connection.agentModeAt !== null },
              state: boardStateViewOf(state, since.get(row.connectionId) ?? row.connection.updatedAt.getTime()),
              capabilities: ctx.deps.trackers.capabilities[named.kind],
              attachedAt: row.createdAt.getTime(),
              openTickets: openCounts.find((count) => count.boardId === row.id)?._count._all ?? 0,
              lastPolledAt: row.lastPolledAt?.getTime() ?? null,
              lastEvent: delivery === null ? null : { at: delivery.receivedAt.getTime(), type: delivery.event, ticketKey: delivery.ticketKey },
              integration: detected === null ? ("unknown" as const) : detected ? ("installed" as const) : ("not_installed" as const),
              mapping,
              statusGroups: statusList === null ? null : groupStatuses(statusList),
              statusesError,
              missingStatuses: statusList === null || mapping === null ? [] : [...unknownMappedStatuses(mapping, statusList)],
              startFromLinear: row.agentMode,
              ticketsForPromptTasks: row.ticketsForPromptTasks,
            },
          ];
        }),
      );
      return {
        connections: connections.map((connection) => ({ id: connection.id, kind: connection.kind, name: connection.name, state: connection.state })),
        pollSeconds: settings.trackerPollSeconds,
        canEdit,
        boards: boards.flat(),
      };
    }),

  /**
   * Attaches a team or project of one of the organization's active connections as a board: drafts
   * its mapping from its statuses and the integration check (spec section 3, step 2), and enqueues
   * the first full poll, in the same transaction. The same external ID under two connections is two
   * boards (ADR 0071).
   */
  attach: projectProcedure("admin", attachBoardInputSchema)
    .output(z.object({ boardId: boardIdSchema, mapping: boardMappingSchema, integrationInstalled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const tracker = await trackerOf(ctx.deps, organizationId, input.connectionId);
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

  /**
   * A board's workflow (boards-mixed.md, Jira's mapping), from its own connection: the statuses with
   * their categories, the transitions, and for the mapping (the one being edited, or the saved one)
   * each step's `by …` lines and the statuses no route leaves toward its target. Without workflow
   * access, `readable: false` and the statuses alone. Only a tracker whose statuses form a graph
   * has one; a paused board's tracker isn't asked. Every member who can open the project reads it.
   */
  workflow: boardProcedure("read", z.strictObject({ boardId: boardIdSchema, mapping: boardMappingSchema.optional() }))
    .output(workflowSchema)
    .query(async ({ ctx, input }) => {
      const organizationId = ctx.scope.organizationId;
      const board = await boardWithConnection(ctx.deps, organizationId, input.boardId);
      if (boardStateOf(board, board.connection).state !== "attached") {
        return refusePaused(board.connection);
      }
      const tracker = await trackerOf(ctx.deps, organizationId, connectionIdSchema.parse(board.connectionId));
      if (!tracker.tracker.capabilities.statusGraph) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${tracker.name} moves a ticket by writing its status: it has no workflow to read` });
      }
      const read = await tracker.tracker.readWorkflow({ externalId: board.externalId });
      if (!read.ok) {
        throw new TRPCError({ code: "BAD_GATEWAY", message: `The tracker did not answer the board's workflow (${read.error.code}): ${read.error.message}` });
      }
      const workflow = read.value;
      const statuses = [...workflow.statuses].sort((a, b) => a.position - b.position).map((status) => ({ id: status.id, name: status.name, category: status.category }));
      if (!workflow.readable) {
        return { readable: false as const, statuses };
      }
      const mapping = input.mapping ?? parseBoardMapping(board.statusMap);
      const reach = mapping === null ? null : mappingReachability(workflow, mapping);
      return {
        readable: true as const,
        statuses,
        transitions: workflow.transitions.map((transition) => ({ id: transition.id, name: transition.name, from: transition.from === "any" ? ("any" as const) : [...transition.from], to: transition.to })),
        steps:
          reach?.readable === true
            ? reach.steps.map((step) => ({
                step: step.step,
                target: step.target,
                by: step.by.map((line) => ({ transition: { id: line.transition.id, name: line.transition.name }, from: line.from === "any" ? ("any" as const) : [...line.from] })),
                unreachable: [...step.unreachable],
              }))
            : [],
        reach: statusReachOf(workflow),
      };
    }),

  /** Saves the mapping after checking each status still exists on the board's own tracker. A paused board's is refused. */
  saveMapping: boardProcedure("admin", z.strictObject({ boardId: boardIdSchema, mapping: boardMappingSchema }))
    .output(z.object({ mapping: boardMappingSchema }))
    .mutation(async ({ ctx, input }) => {
      const saved = await saveThroughBoard(ctx.deps, ctx.scope, input.boardId, input.mapping);
      return { mapping: saved.mapping };
    }),

  /**
   * "Done is moved by" (boards-mixed.md): the tracker (its own GitHub integration, or a Jira
   * automation rule) or ostra. Named for both kinds; stored as the mapping's `doneBy`
   * (`integration` or `ostra`), checked and audited as a saved mapping. A board without a mapping,
   * or a paused one, is refused.
   */
  setDoneBy: boardProcedure("admin", z.strictObject({ boardId: boardIdSchema, by: z.enum(["tracker", "ostra"]) }))
    .output(z.object({ mapping: boardMappingSchema }))
    .mutation(async ({ ctx, input }) => {
      const board = await boardWithConnection(ctx.deps, ctx.scope.organizationId, input.boardId);
      const mapping = parseBoardMapping(board.statusMap);
      if (mapping === null) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This board has no mapping yet: save one first" });
      }
      const saved = await saveThroughBoard(ctx.deps, ctx.scope, input.boardId, { ...mapping, doneBy: input.by === "tracker" ? "integration" : "ostra" });
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
