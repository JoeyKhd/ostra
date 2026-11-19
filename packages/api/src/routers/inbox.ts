import { parseBoardMapping } from "@ostra/domain";
import type { BoardMapping } from "@ostra/domain";
import type { Prisma } from "@ostra/db";
import { boardIdSchema, connectionIdSchema, memberIdSchema, projectIdSchema, taskIdSchema, ticketIdSchema } from "@ostra/protocol";
import type { ProjectId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { ApiDeps } from "../trpc/context.ts";
import { projectProcedure, router } from "../trpc/init.ts";

// F-010, F-007, ticket 29: the project's Inbox. It lists the open tickets of the project's boards
// from the ticket cache, and never calls the tracker: a read costs the database, and the cache's
// age shows beside it (`source`). A ticket's text is untrusted: it is returned as data, and the
// panel renders it as such. Members who can read the project read its Inbox; another organization's
// project, and a restricted one the member isn't on, are `NOT_FOUND` (ADR 0026).

/** Tasks in these states no longer hold their ticket (spec section 11, item 12). */
const FINISHED: readonly string[] = ["stopped", "merged", "done"];

const taskStateSchema = z.enum(["awaiting_approval", "queued", "preparing", "running", "needs_you", "in_review", "stopped", "merged", "done"]);

const taskMarkSchema = z.object({
  id: taskIdSchema,
  state: taskStateSchema,
  /** The task holds the ticket now. A finished earlier task is shown too, with `false`. */
  active: z.boolean(),
  /** The task's short ID (the last 8 hex digits), as the list shows it. */
  shortId: z.string(),
});

const statusCategorySchema = z.enum(["open", "started", "done", "cancelled"]);

const ticketRowSchema = z.object({
  id: ticketIdSchema,
  key: z.string(),
  title: z.string(),
  url: z.string(),
  board: z.object({ id: boardIdSchema, name: z.string(), key: z.string().nullable() }),
  status: z.object({ id: z.string().nullable(), name: z.string().nullable(), category: statusCategorySchema.nullable() }),
  /** Linear's scale: 1 urgent to 4 low; `null` for none. */
  priority: z.number().int().nullable(),
  labels: z.array(z.string()),
  assignee: z.object({ id: z.string().nullable(), name: z.string() }).nullable(),
  /** Epoch ms of the tracker's last change to the ticket, as cached. */
  updatedAt: z.number().int(),
  task: taskMarkSchema.nullable(),
});
type TicketRow = z.infer<typeof ticketRowSchema>;

const sourceSchema = z.object({
  /** The project's attached boards. Empty: the Inbox has nothing to list. */
  boards: z.array(z.object({ id: boardIdSchema, name: z.string(), key: z.string().nullable(), lastPolledAt: z.number().int().nullable() })),
  /** `null` until the organization connects Linear. */
  connection: z
    .object({
      connectionId: connectionIdSchema,
      workspaceName: z.string().nullable(),
      state: z.enum(["pending", "active", "failed", "revoked"]),
      mode: z.enum(["webhooks", "polling"]),
      pollSeconds: z.number().int(),
    })
    .nullable(),
  /** The newest of the boards' last poll and the connection's last event: the cache's age. */
  cacheUpdatedAt: z.number().int().nullable(),
  /** The connection can't be asked right now (failed, or revoked): the list is the cache as it was. */
  stale: z.boolean(),
});

/** The first page's default (spec section 11, item 10): the mapped open statuses. */
const statusTokens = z.array(z.string().min(1).max(256)).max(50);

const listInput = z.strictObject({
  projectId: projectIdSchema,
  /** One board, or every board of the project. */
  boardId: boardIdSchema.optional(),
  /**
   * What to show, by token: `open` (each board's mapped open statuses), `started` and `done` (the
   * status categories), or a status ID. Default `open`.
   */
  status: statusTokens.default(["open"]),
  labels: z.array(z.string().min(1).max(200)).max(50).optional(),
  /** Linear's scale; `0` is no priority. */
  priorities: z.array(z.number().int().min(0).max(4)).max(5).optional(),
  /** The tracker's assignee IDs; `unassigned` for none. */
  assignees: z.array(z.string().min(1).max(256)).max(50).optional(),
  /** Matches the title or the key, ignoring case. */
  text: z.string().trim().max(200).optional(),
  /** The previous page's `nextCursor`. */
  cursor: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
type ListInput = z.infer<typeof listInput>;

const cursorSchema = z.string().regex(/^\d{1,16}\.[0-9a-f-]{36}$/);

const encodeCursor = (updatedAt: Date, id: string): string => Buffer.from(`${String(updatedAt.getTime())}.${id}`).toString("base64url");

const decodeCursor = (cursor: string): { readonly at: Date; readonly id: string } | null => {
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  if (!cursorSchema.safeParse(text).success) return null;
  const [ms = "", id = ""] = text.split(".");
  return { at: new Date(Number(ms)), id };
};

const shortIdOf = (id: string): string => id.replaceAll("-", "").slice(-8);

type BoardRow = { readonly id: string; readonly name: string; readonly key: string | null; readonly lastPolledAt: Date | null; readonly statusMap: unknown };

/** The `where` for one board's status tokens. */
const statusWhere = (mapping: BoardMapping | null, tokens: readonly string[]): Prisma.TicketWhereInput[] =>
  tokens.map((token): Prisma.TicketWhereInput => {
    switch (token) {
      case "open":
        // A board without a mapping falls back to the tracker's own open category.
        return mapping === null ? { statusCategory: "open" } : { statusId: { in: mapping.open } };
      case "started":
        return { statusCategory: "started" };
      case "done":
        return { statusCategory: { in: ["done", "cancelled"] } };
      default:
        return { statusId: token };
    }
  });

/** The tickets that match the filter, as a `where` over the project's attached boards. */
const whereOf = (organizationId: string, projectId: ProjectId, boards: readonly BoardRow[], input: Pick<ListInput, "status" | "labels" | "priorities" | "assignees" | "text">): Prisma.TicketWhereInput => {
  const perBoard = boards.map((board): Prisma.TicketWhereInput => ({ boardId: board.id, OR: statusWhere(parseBoardMapping(board.statusMap), input.status) }));
  const and: Prisma.TicketWhereInput[] = [{ OR: perBoard }];
  if (input.labels !== undefined && input.labels.length > 0) {
    and.push({ OR: input.labels.map((label): Prisma.TicketWhereInput => ({ labels: { array_contains: [label] } })) });
  }
  if (input.priorities !== undefined && input.priorities.length > 0) {
    // "No priority" is a null, or Linear's 0.
    and.push({ OR: input.priorities.map((priority): Prisma.TicketWhereInput => (priority === 0 ? { OR: [{ priority: null }, { priority: 0 }] } : { priority })) });
  }
  if (input.assignees !== undefined && input.assignees.length > 0) {
    const ids = input.assignees.filter((assignee) => assignee !== "unassigned");
    and.push({ OR: [...(ids.length > 0 ? [{ assigneeId: { in: ids } }] : []), ...(input.assignees.includes("unassigned") ? [{ assigneeId: null }] : [])] });
  }
  if (input.text !== undefined && input.text !== "") {
    and.push({ OR: [{ title: { contains: input.text, mode: "insensitive" } }, { key: { contains: input.text, mode: "insensitive" } }] });
  }
  return { organizationId, projectId, removedAt: null, AND: and };
};

/** The project's attached boards and the connection behind them: what the cache's age and state are read from. */
const sourceOf = async (deps: ApiDeps, organizationId: string, boards: readonly BoardRow[], connectionId: string | null) => {
  const connection = await deps.db.connection.findFirst({
    where: connectionId === null ? { organizationId, kind: "linear", state: { not: "revoked" } } : { id: connectionId, organizationId },
  });
  const polled = boards.flatMap((board) => (board.lastPolledAt === null ? [] : [board.lastPolledAt.getTime()]));
  const newest = Math.max(0, ...polled, connection?.lastEventAt?.getTime() ?? 0);
  return {
    boards: boards.map((board) => ({ id: boardIdSchema.parse(board.id), name: board.name, key: board.key, lastPolledAt: board.lastPolledAt?.getTime() ?? null })),
    connection:
      connection === null
        ? null
        : {
            connectionId: connectionIdSchema.parse(connection.id),
            workspaceName: connection.externalWorkspaceName,
            state: connection.state,
            mode: connection.webhookMode,
            pollSeconds: deps.settings.trackerPollSeconds,
          },
    cacheUpdatedAt: newest === 0 ? null : newest,
    stale: connection !== null && connection.state !== "active",
  };
};

const attachedBoards = (deps: ApiDeps, organizationId: string, projectId: ProjectId, boardId?: string): Promise<BoardRow[]> =>
  deps.db.board.findMany({
    where: { organizationId, projectId, detachedAt: null, ...(boardId === undefined ? {} : { id: boardId }) },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, key: true, lastPolledAt: true, statusMap: true },
  });

/** Each ticket's task: the active one, else the most recent finished one. */
const tasksOf = async (deps: ApiDeps, organizationId: string, ticketIds: readonly string[]) => {
  if (ticketIds.length === 0) return new Map<string, z.infer<typeof taskMarkSchema>>();
  const rows = await deps.db.task.findMany({
    where: { organizationId, ticketId: { in: [...ticketIds] }, kind: "code" },
    orderBy: { createdAt: "desc" },
    select: { id: true, ticketId: true, state: true },
  });
  const byTicket = new Map<string, z.infer<typeof taskMarkSchema>>();
  for (const row of rows) {
    if (row.ticketId === null) continue;
    const active = !FINISHED.includes(row.state);
    const held = byTicket.get(row.ticketId);
    // The newest task wins unless an older one is active (there is at most one active).
    if (held === undefined || (!held.active && active)) {
      byTicket.set(row.ticketId, { id: taskIdSchema.parse(row.id), state: row.state, active, shortId: shortIdOf(row.id) });
    }
  }
  return byTicket;
};

type TicketRecord = {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly url: string;
  readonly boardId: string;
  readonly statusId: string | null;
  readonly statusName: string | null;
  readonly statusCategory: z.infer<typeof statusCategorySchema> | null;
  readonly priority: number | null;
  readonly labels: unknown;
  readonly assigneeId: string | null;
  readonly assigneeName: string | null;
  readonly trackerUpdatedAt: Date;
};

const rowOf = (record: TicketRecord, boards: ReadonlyMap<string, BoardRow>, tasks: ReadonlyMap<string, z.infer<typeof taskMarkSchema>>): TicketRow => {
  const board = boards.get(record.boardId);
  const labels = z.array(z.string()).safeParse(record.labels);
  return {
    id: ticketIdSchema.parse(record.id),
    key: record.key,
    title: record.title,
    url: record.url,
    board: { id: boardIdSchema.parse(record.boardId), name: board?.name ?? "", key: board?.key ?? null },
    status: { id: record.statusId, name: record.statusName, category: record.statusCategory },
    priority: record.priority === null || record.priority === 0 ? null : record.priority,
    labels: labels.success ? labels.data : [],
    assignee: record.assigneeName === null ? null : { id: record.assigneeId, name: record.assigneeName },
    updatedAt: record.trackerUpdatedAt.getTime(),
    task: tasks.get(record.id) ?? null,
  };
};

const IMAGE_MARKDOWN = /!\[[^\]]*\]\([^)]+\)/g;

export const inboxRouter = router({
  /**
   * The project's tickets from the cache, newest change first, paged by cursor. The default filter is
   * the mapped open statuses (spec section 11, item 10); `status` widens it. Each ticket carries its
   * task: the active one, else the latest finished one. It never calls the tracker.
   */
  list: projectProcedure("read", listInput)
    .output(
      z.object({
        tickets: z.array(ticketRowSchema),
        /** The next page's `cursor`, or `null` at the end. */
        nextCursor: z.string().nullable(),
        /** The tickets the filter matches, over every page. */
        total: z.number().int(),
        source: sourceSchema,
      }),
    )
    .query(async ({ ctx, input }) => {
      const { db } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const boards = await attachedBoards(ctx.deps, organizationId, input.projectId, input.boardId);
      const source = await sourceOf(ctx.deps, organizationId, boards, null);
      if (boards.length === 0) {
        return { tickets: [], nextCursor: null, total: 0, source };
      }
      const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
      if (input.cursor !== undefined && cursor === null) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "That page cursor isn't one this Inbox gave" });
      }
      const where = whereOf(organizationId, input.projectId, boards, input);
      const [total, records] = await Promise.all([
        db.ticket.count({ where }),
        db.ticket.findMany({
          where:
            cursor === null
              ? where
              : { AND: [where, { OR: [{ trackerUpdatedAt: { lt: cursor.at } }, { trackerUpdatedAt: cursor.at, id: { lt: cursor.id } }] }] },
          orderBy: [{ trackerUpdatedAt: "desc" }, { id: "desc" }],
          // One more than a page tells whether another exists.
          take: input.limit + 1,
        }),
      ]);
      const page = records.slice(0, input.limit);
      const last = page.at(-1);
      const tasks = await tasksOf(ctx.deps, organizationId, page.map((record) => record.id));
      const byBoard = new Map(boards.map((board) => [board.id, board] as const));
      return {
        tickets: page.map((record) => rowOf(record, byBoard, tasks)),
        nextCursor: records.length > input.limit && last !== undefined ? encodeCursor(last.trackerUpdatedAt, last.id) : null,
        total,
        source,
      };
    }),

  /**
   * One ticket's cached copy, for the preview and the "Start a task" panel: the description (markdown,
   * untrusted), what the agent will get, and the task it has. The cache answers; Linear isn't asked.
   */
  get: projectProcedure("read", z.strictObject({ projectId: projectIdSchema, ticketId: ticketIdSchema }))
    .output(
      ticketRowSchema.extend({
        /** Markdown, untrusted: rendered as data, never as HTML. */
        description: z.string().nullable(),
        parentKey: z.string().nullable(),
        /** Images the description shows, counted from its markdown. */
        imageCount: z.number().int(),
        /** Who drives the ticket's active task. */
        driver: z.object({ memberId: memberIdSchema, name: z.string() }).nullable(),
        source: sourceSchema,
      }),
    )
    .query(async ({ ctx, input }) => {
      const { db } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const record = await db.ticket.findFirst({ where: { id: input.ticketId, organizationId, projectId: input.projectId, removedAt: null } });
      if (record === null) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such ticket in this project" });
      }
      const boards = await attachedBoards(ctx.deps, organizationId, input.projectId);
      const board = boards.find((candidate) => candidate.id === record.boardId);
      const [tasks, source] = await Promise.all([tasksOf(ctx.deps, organizationId, [record.id]), sourceOf(ctx.deps, organizationId, board === undefined ? [] : [board], record.connectionId)]);
      const task = tasks.get(record.id) ?? null;
      const active = task?.active === true ? await db.task.findFirst({ where: { id: task.id, organizationId }, select: { driverMemberId: true } }) : null;
      const driverId = active?.driverMemberId ?? null;
      const driver = driverId === null ? null : await db.member.findFirst({ where: { id: driverId, organizationId }, select: { id: true, user: { select: { name: true } } } });
      const byBoard = new Map(boards.map((candidate) => [candidate.id, candidate] as const));
      return {
        ...rowOf(record, byBoard, tasks),
        description: record.description,
        parentKey: record.parentExternalId === null ? null : (await db.ticket.findFirst({ where: { organizationId, boardId: record.boardId, externalId: record.parentExternalId }, select: { key: true } }))?.key ?? null,
        imageCount: (record.description?.match(IMAGE_MARKDOWN) ?? []).length,
        driver: driver === null ? null : { memberId: memberIdSchema.parse(driver.id), name: driver.user.name },
        source,
      };
    }),

  /** What the filters offer: the labels, statuses and assignees of the project's cached tickets. */
  filters: projectProcedure("read", z.strictObject({ projectId: projectIdSchema }))
    .output(
      z.object({
        statuses: z.array(z.object({ id: z.string(), name: z.string(), category: statusCategorySchema.nullable() })),
        labels: z.array(z.string()),
        assignees: z.array(z.object({ id: z.string(), name: z.string() })),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { db } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const boards = await attachedBoards(ctx.deps, organizationId, input.projectId);
      const boardIds = boards.map((board) => board.id);
      const where = { organizationId, projectId: input.projectId, boardId: { in: boardIds }, removedAt: null };
      const [statuses, assignees, labels] = await Promise.all([
        db.ticket.groupBy({ by: ["statusId", "statusName", "statusCategory"], where, orderBy: { statusName: "asc" } }),
        db.ticket.groupBy({ by: ["assigneeId", "assigneeName"], where: { ...where, assigneeName: { not: null } }, orderBy: { assigneeName: "asc" } }),
        boardIds.length === 0
          ? Promise.resolve<unknown>([])
          : db.$queryRaw`
              SELECT DISTINCT label FROM "ticket", jsonb_array_elements_text("labels") AS label
              WHERE "organizationId" = ${organizationId} AND "projectId" = ${input.projectId} AND "boardId" = ANY(${boardIds}::text[]) AND "removedAt" IS NULL
              ORDER BY label LIMIT 200`,
      ]);
      return {
        statuses: statuses.flatMap((row) => (row.statusId === null || row.statusName === null ? [] : [{ id: row.statusId, name: row.statusName, category: row.statusCategory }])),
        labels: z.array(z.object({ label: z.string() })).parse(labels).map((row) => row.label),
        assignees: assignees.flatMap((row) => (row.assigneeId === null || row.assigneeName === null ? [] : [{ id: row.assigneeId, name: row.assigneeName }])),
      };
    }),
});

/** The tickets that match the default filter, per project: the sidebar's Inbox count (one grouped query). */
export const inboxCounts = async (
  deps: ApiDeps,
  organizationId: string,
  projectIds: readonly string[],
): Promise<ReadonlyMap<string, number>> => {
  const counts = new Map<string, number>();
  if (projectIds.length === 0) return counts;
  const boards = await deps.db.board.findMany({
    where: { organizationId, projectId: { in: [...projectIds] }, detachedAt: null },
    select: { id: true, projectId: true, statusMap: true },
  });
  if (boards.length === 0) return counts;
  const grouped = await deps.db.ticket.groupBy({
    by: ["boardId", "statusId"],
    where: { organizationId, boardId: { in: boards.map((board) => board.id) }, removedAt: null, statusId: { not: null } },
    _count: { _all: true },
  });
  for (const board of boards) {
    const mapping = parseBoardMapping(board.statusMap);
    if (mapping === null) continue;
    const open = new Set(mapping.open);
    const sum = grouped.filter((row) => row.boardId === board.id && row.statusId !== null && open.has(row.statusId)).reduce((total, row) => total + row._count._all, 0);
    counts.set(board.projectId, (counts.get(board.projectId) ?? 0) + sum);
  }
  return counts;
};
