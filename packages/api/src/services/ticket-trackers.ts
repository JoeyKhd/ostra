import type { DbEnum } from "@ostra/db";
import { defaultConnectionName, isTrackerKind, trackerKinds } from "@ostra/domain";
import { connectionIdSchema } from "@ostra/protocol";
import { z } from "zod";

import type { ApiDeps } from "../trpc/context.ts";

// Milestone 11 (F-152/c4, F-008; ADR 0071; ticket-chips.md, "Data"): every ticket the panel shows
// names its tracker, so Globex's `PROJ-12` (Jira) and Acme's `CALC-170` (Linear) read apart. A
// ticket's tracker is its board's connection: its kind (the mark and the word) and its name. Both
// are what a project's members may see of a connection (ADR 0071, "Who sees what"); nothing else of
// the connection is answered here.

/** What a connection's adapter declares (`TrackerCapabilities`): the panel shows a row only where it does. */
export const capabilitiesSchema = z.object({
  agentSessions: z.boolean(),
  subIssues: z.boolean(),
  statusGraph: z.boolean(),
  webhooks: z.boolean(),
  commentEdit: z.boolean(),
  attachments: z.boolean(),
  transitions: z.boolean(),
  mentions: z.boolean(),
  agentScopes: z.array(z.string()).readonly(),
  agentSessionLink: z.boolean(),
  ticketFields: z.object({ acceptanceCriteria: z.boolean() }),
  ticketFiles: z.enum(["all", "images", "none"]),
  magicWords: z.boolean(),
  richText: z.enum(["markdown", "adf"]),
  jqlFilter: z.boolean(),
});

/** A ticket's tracker: its board's connection, by ID, kind and name (`Globex Jira`). */
export const ticketConnectionSchema = z.object({ id: connectionIdSchema, kind: z.enum(trackerKinds), name: z.string() });
export type TicketConnection = z.infer<typeof ticketConnectionSchema>;

/** The columns a ticket's tracker is read from. */
export const ticketConnectionSelect = { id: true, kind: true, name: true, externalWorkspaceName: true } as const;

type ConnectionNameRow = {
  readonly id: string;
  readonly kind: DbEnum.ConnectionKind;
  readonly name: string | null;
  readonly externalWorkspaceName: string | null;
};

/** A connection row as a ticket's tracker; `null` for a connection that isn't a tracker's (GitHub's). */
export const ticketConnectionOf = (row: ConnectionNameRow): TicketConnection | null =>
  isTrackerKind(row.kind) ? { id: connectionIdSchema.parse(row.id), kind: row.kind, name: row.name ?? defaultConnectionName(row.kind, row.externalWorkspaceName) } : null;

/** The organization's connections by ID as tickets' trackers, each read once; another organization's are never read. */
export const ticketConnectionsOf = async (deps: Pick<ApiDeps, "db">, organizationId: string, ids: readonly string[]): Promise<ReadonlyMap<string, TicketConnection>> => {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return new Map();
  const rows = await deps.db.connection.findMany({ where: { organizationId, id: { in: wanted } }, select: ticketConnectionSelect });
  return new Map(
    rows.flatMap((row) => {
      const connection = ticketConnectionOf(row);
      return connection === null ? [] : [[row.id, connection] as const];
    }),
  );
};

/** Each task's ticket's tracker, by task ID: `null` for a task without a ticket. */
export const taskTicketConnectionsOf = async (
  deps: Pick<ApiDeps, "db">,
  organizationId: string,
  tasks: readonly { readonly id: string; readonly ticketId: string | null }[],
): Promise<ReadonlyMap<string, TicketConnection>> => {
  const ticketIds = tasks.flatMap((task) => (task.ticketId === null ? [] : [task.ticketId]));
  if (ticketIds.length === 0) return new Map();
  const tickets = await deps.db.ticket.findMany({ where: { organizationId, id: { in: ticketIds } }, select: { id: true, connectionId: true } });
  const connections = await ticketConnectionsOf(deps, organizationId, tickets.map((ticket) => ticket.connectionId));
  const byTicket = new Map(tickets.flatMap((ticket) => {
    const connection = connections.get(ticket.connectionId);
    return connection === undefined ? [] : [[ticket.id, connection] as const];
  }));
  return new Map(
    tasks.flatMap((task) => {
      const connection = task.ticketId === null ? undefined : byTicket.get(task.ticketId);
      return connection === undefined ? [] : [[task.id, connection] as const];
    }),
  );
};
