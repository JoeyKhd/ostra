import { randomBytes } from "node:crypto";

import type { Ticket, TrackerStatus } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { draftBoardMapping } from "@ostra/domain";
import type { BoardMapping, DoneBy } from "@ostra/domain";
import { boardIdSchema, connectionIdSchema, taskIdSchema, ticketIdSchema } from "@ostra/protocol";
import type { BoardId, ConnectionId, OrganizationId, ProjectId, TaskId, TicketId } from "@ostra/protocol";

import type { FakeSecretStore } from "./fake-adapters.ts";

// Rows the tracker tests of core need (tickets 14, 15, 16): a tracker connection with its token in
// the fake secret store, a board with its mapping, a cached ticket, and a task from it.

export const seedTrackerConnection = async (
  db: Db,
  secretStore: FakeSecretStore,
  organizationId: OrganizationId,
  options: {
    readonly token?: string;
    readonly appUserId?: string | null;
    readonly state?: "active" | "failed" | "revoked" | "pending";
    readonly webhookMode?: "webhooks" | "polling";
    readonly credentialKind?: "app_oauth" | "api_key";
  } = {},
): Promise<ConnectionId> => {
  const ref = await secretStore.put({ organizationId, purpose: "linear.access-token" }, options.token ?? `lin_oauth_${randomBytes(8).toString("hex")}`);
  if (!ref.ok) throw new Error("the fake secret store refused");
  const row = await db.connection.create({
    data: {
      organizationId,
      kind: "linear",
      appId: `client-${randomBytes(4).toString("hex")}`,
      state: options.state ?? "active",
      webhookMode: options.webhookMode ?? "polling",
      credentialKind: options.credentialKind ?? "app_oauth",
      accessTokenSecretRef: ref.value,
      appUserId: options.appUserId === undefined ? null : options.appUserId,
    },
  });
  return connectionIdSchema.parse(row.id);
};

/** A mapping drafted from a board's statuses, as the panel's draft gives it, with `doneBy` chosen. */
export const mappingFor = (statuses: readonly TrackerStatus[], doneBy: DoneBy): BoardMapping => {
  const draft = draftBoardMapping(statuses, { installed: doneBy === "integration" });
  if (!draft.ok) throw new Error(`no mapping: ${draft.reason}`);
  return draft.mapping;
};

export const seedBoard = async (
  db: Db,
  input: {
    readonly organizationId: OrganizationId;
    readonly projectId: ProjectId;
    readonly connectionId: ConnectionId;
    readonly externalId: string;
    readonly key?: string;
    readonly mapping: BoardMapping | null;
  },
): Promise<BoardId> => {
  const row = await db.board.create({
    data: {
      organizationId: input.organizationId,
      projectId: input.projectId,
      connectionId: input.connectionId,
      externalId: input.externalId,
      name: "Board",
      key: input.key ?? null,
      statusMap: input.mapping ?? {},
    },
  });
  return boardIdSchema.parse(row.id);
};

/** The ticket's cache row on a board, as ingest leaves it. */
export const seedTicketRow = async (
  db: Db,
  input: { readonly organizationId: OrganizationId; readonly projectId: ProjectId; readonly boardId: BoardId; readonly connectionId: ConnectionId; readonly ticket: Ticket },
): Promise<TicketId> => {
  const { ticket } = input;
  const row = await db.ticket.create({
    data: {
      organizationId: input.organizationId,
      projectId: input.projectId,
      boardId: input.boardId,
      connectionId: input.connectionId,
      externalId: ticket.externalId,
      key: ticket.key,
      title: ticket.title,
      description: ticket.description,
      statusId: ticket.status.id,
      statusName: ticket.status.name,
      statusCategory: ticket.status.category,
      url: ticket.url,
      labels: [...ticket.labels],
      trackerUpdatedAt: new Date(ticket.updatedAt),
    },
  });
  return ticketIdSchema.parse(row.id);
};

export const seedTicketTask = async (
  db: Db,
  input: {
    readonly organizationId: OrganizationId;
    readonly projectId: ProjectId;
    readonly boardId: BoardId | null;
    readonly ticketId: TicketId | null;
    readonly ticketKey?: string | null;
    readonly state?: "queued" | "running" | "in_review" | "merged" | "stopped";
    readonly title?: string;
  },
): Promise<TaskId> => {
  const state = input.state ?? "running";
  const row = await db.task.create({
    data: {
      organizationId: input.organizationId,
      projectId: input.projectId,
      kind: "code",
      source: input.ticketId === null ? "prompt" : "ticket",
      title: input.title ?? "Fix the login page",
      prompt: input.ticketId === null ? "Fix the login page" : null,
      ticketKey: input.ticketKey ?? null,
      ticketId: input.ticketId,
      boardId: input.boardId,
      branchName: `ostra/${randomBytes(4).toString("hex")}-fix-the-login-page`,
      state,
      ...(state === "in_review" ? { subState: "waiting_for_reviewer" as const } : {}),
      ...(state === "stopped" ? { stoppedReason: "requested" as const } : {}),
    },
  });
  return taskIdSchema.parse(row.id);
};
