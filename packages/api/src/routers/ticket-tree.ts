import type { BoardRef, TrackerAdapter } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { leavesToStart } from "@ostra/domain";
import type { Leaves, TicketTree } from "@ostra/domain";
import { boardIdSchema, externalTicketIdSchema, ticketIdSchema, ticketKeySchema } from "@ostra/protocol";
import type { BoardId, ExternalTicketId, OrganizationId, TicketId } from "@ostra/protocol";

// A parent ticket's sub-issues as the panel reads them (F-077, milestone 6's ticket 25), read-only:
// from the tracker through `getTicketContext` on the parent's page, to `OSTRA_SUB_ISSUES_DEPTH`
// levels as the start walks them, or from the ticket cache when the tracker can't be read and for
// the Inbox, which never calls the tracker. Each node is mapped to its cached row on one of the
// project's boards; a child on none of them is "elsewhere", and its own children aren't read, as the
// start doesn't read them. The leaves are the domain's (`leavesToStart`), so "starts N tasks" says
// what "Start sub-issues" does. A ticket's text is data throughout.

export type TreeNode = {
  readonly externalId: ExternalTicketId;
  readonly key: string;
  /** The title as the tracker gives it, or as the project's cache holds it; the key for a row the cache has on another project's board. */
  readonly title: string;
  readonly url: string;
  readonly open: boolean;
  /** 1 for the parent's own children. */
  readonly depth: number;
  readonly parentExternalId: ExternalTicketId;
  /** Its row on one of the project's boards, or `null` when it's on none of them. */
  readonly cached: { readonly ticketId: TicketId; readonly boardId: BoardId } | null;
  readonly children: readonly TreeNode[];
};

type ProjectBoards = { readonly organizationId: OrganizationId; readonly boardIds: readonly string[] };

/** The cached rows of these tickets on the project's boards, by external ID. */
const cachedOn = async (db: Db, boards: ProjectBoards, externalIds: readonly string[]) => {
  if (externalIds.length === 0 || boards.boardIds.length === 0) {
    return new Map<string, { readonly ticketId: TicketId; readonly boardId: BoardId; readonly title: string }>();
  }
  const rows = await db.ticket.findMany({
    where: { organizationId: boards.organizationId, boardId: { in: [...boards.boardIds] }, externalId: { in: [...externalIds] }, removedAt: null },
    select: { id: true, boardId: true, externalId: true, title: true },
    orderBy: { createdAt: "asc" },
  });
  const found = new Map<string, { readonly ticketId: TicketId; readonly boardId: BoardId; readonly title: string }>();
  for (const row of rows) {
    if (!found.has(row.externalId)) {
      found.set(row.externalId, { ticketId: ticketIdSchema.parse(row.id), boardId: boardIdSchema.parse(row.boardId), title: row.title });
    }
  }
  return found;
};

/**
 * The tree from the ticket cache: each level's children by their parent's external ID, on the
 * connection. Two levels past `depth` are read, so a node at the last level knows it has children.
 */
export const cacheTree = async (
  db: Db,
  boards: ProjectBoards,
  root: { readonly connectionId: string; readonly externalId: string },
  depth: number,
): Promise<readonly TreeNode[]> => {
  type Row = { readonly id: string; readonly boardId: string; readonly externalId: string; readonly parentExternalId: string | null; readonly key: string; readonly title: string; readonly url: string; readonly open: boolean };
  const levels: Row[][] = [];
  let frontier: readonly string[] = [root.externalId];
  const seen = new Set<string>([root.externalId]);
  for (let level = 1; level <= depth + 1 && frontier.length > 0; level += 1) {
    const rows = await db.ticket.findMany({
      where: { organizationId: boards.organizationId, connectionId: root.connectionId, parentExternalId: { in: [...frontier] }, removedAt: null },
      select: { id: true, boardId: true, externalId: true, parentExternalId: true, key: true, title: true, url: true, open: true },
      orderBy: [{ key: "asc" }, { createdAt: "asc" }],
    });
    // A ticket cached on several boards is one node: the project's row when it has one.
    const byExternal = new Map<string, Row>();
    for (const row of rows) {
      if (seen.has(row.externalId) && !byExternal.has(row.externalId)) {
        continue;
      }
      const held = byExternal.get(row.externalId);
      if (held === undefined || (!boards.boardIds.includes(held.boardId) && boards.boardIds.includes(row.boardId))) {
        byExternal.set(row.externalId, row);
      }
    }
    const kept = [...byExternal.values()];
    for (const row of kept) {
      seen.add(row.externalId);
    }
    levels.push(kept);
    // As the start does, the children of a ticket on no board of the project aren't followed.
    frontier = kept.filter((row) => row.open && boards.boardIds.includes(row.boardId)).map((row) => row.externalId);
  }
  const build = (parent: string, level: number): TreeNode[] =>
    (levels[level - 1] ?? [])
      .filter((row) => row.parentExternalId === parent)
      .map((row): TreeNode => {
        const onBoard = boards.boardIds.includes(row.boardId);
        return {
          externalId: externalTicketIdSchema.parse(row.externalId),
          key: row.key,
          // Another project's cached copy stays its own: only the key and the tracker's link.
          title: onBoard ? row.title : row.key,
          url: row.url,
          open: row.open,
          depth: level,
          parentExternalId: externalTicketIdSchema.parse(parent),
          cached: onBoard ? { ticketId: ticketIdSchema.parse(row.id), boardId: boardIdSchema.parse(row.boardId) } : null,
          children: onBoard ? build(row.externalId, level + 1) : [],
        };
      });
  return build(root.externalId, 1);
};

/**
 * The tree from the tracker, read-only: one `getTicketContext` per open ticket on the project's
 * boards, to `depth` levels and one more read at the last level to tell a ticket that has children.
 * `null` when the tracker can't be read; the caller falls back to the cache.
 */
export const trackerTree = async (
  db: Db,
  tracker: TrackerAdapter,
  boards: ProjectBoards,
  root: { readonly externalId: string; readonly board: BoardRef },
  depth: number,
): Promise<readonly TreeNode[] | null> => {
  const seen = new Set<string>([root.externalId]);
  const read = async (externalId: string, board: BoardRef, level: number): Promise<TreeNode[] | null> => {
    const context = await tracker.getTicketContext(board, { externalId: externalTicketIdSchema.parse(externalId) });
    if (!context.ok) {
      return null;
    }
    const children = context.value.children.filter((child) => !seen.has(child.externalId));
    for (const child of children) {
      seen.add(child.externalId);
    }
    const cached = await cachedOn(db, boards, children.map((child) => child.externalId));
    const nodes: TreeNode[] = [];
    for (const child of children) {
      const row = cached.get(child.externalId) ?? null;
      let below: TreeNode[] = [];
      if (child.open && row !== null && level <= depth) {
        const boardRow = await db.board.findFirst({ where: { id: row.boardId, organizationId: boards.organizationId }, select: { externalId: true } });
        const read2 = boardRow === null ? [] : await read(child.externalId, { externalId: boardRow.externalId }, level + 1);
        if (read2 === null) {
          return null;
        }
        below = read2;
      }
      nodes.push({
        externalId: child.externalId,
        key: child.key,
        title: child.title,
        url: child.url,
        open: child.open,
        depth: level,
        parentExternalId: externalTicketIdSchema.parse(externalId),
        cached: row === null ? null : { ticketId: row.ticketId, boardId: row.boardId },
        children: below,
      });
    }
    return nodes;
  };
  return read(root.externalId, root.board, 1);
};

/** The tree as the domain's leaf walk takes it. */
const domainTree = (root: { readonly externalId: string; readonly key: string }, children: readonly TreeNode[]): TicketTree => {
  const node = (child: TreeNode): TicketTree => ({
    externalId: child.externalId,
    key: ticketKeySchema.parse(child.key),
    open: child.open,
    boardId: child.cached?.boardId ?? null,
    children: child.children.map(node),
  });
  return { externalId: externalTicketIdSchema.parse(root.externalId), key: ticketKeySchema.parse(root.key), open: true, boardId: null, children: children.map(node) };
};

/** What a code start on the ticket starts: its leaves (the domain's walk), or the ticket itself. */
export const leavesOf = (root: { readonly externalId: string; readonly key: string }, children: readonly TreeNode[], boardIds: readonly string[], depth: number, max: number): Leaves =>
  leavesToStart(domainTree(root, children), new Set(boardIds.map((id) => boardIdSchema.parse(id))), depth, max);

/** Every node, parents before their children. */
export const flatten = (nodes: readonly TreeNode[]): readonly TreeNode[] => nodes.flatMap((node) => [node, ...flatten(node.children)]);
