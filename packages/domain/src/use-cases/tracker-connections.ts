import type { TrackerAdapter, TrackerCapabilities } from "@ostra/adapter-sdk";
import type { DbEnum, Tx } from "@ostra/db";
import { boardIdSchema, connectionIdSchema, projectIdSchema } from "@ostra/protocol";
import type { BoardId, ConnectionId, OrganizationId, ProjectId } from "@ostra/protocol";
import { z } from "zod";

import type { BoardPauseReason } from "../lifecycles/m11-trackers.ts";
import type { AuditInput, Ports } from "../ports.ts";

// Milestone 11 (F-152, ADR 0071; spec section 5.4, ticket 05): an organization holds several tracker
// connections, of any kind and any mix, each named, one per site or workspace. Every path names its
// connection: nothing here finds "the organization's Linear" by kind. A connection is looked up by
// its ID and the organization; a board's tracker is its own connection's; a client's tickets move
// only through their own connection. Names, sites and IDs only: no token, secret or ticket text.

// ---------- the kinds ----------

/** The trackers ostra has adapters for. */
export const trackerKinds = ["linear", "jira"] as const satisfies readonly DbEnum.ConnectionKind[];
export type TrackerKind = (typeof trackerKinds)[number];

/** The picker's tiles with no adapter yet: shown "Coming soon", disabled, with nothing to fill in (F-152/c8). */
export const comingSoonTrackerKinds = ["trello", "notion"] as const;
export type ComingSoonTrackerKind = (typeof comingSoonTrackerKinds)[number];

/** Whether a connection's kind is a tracker's (GitHub's isn't). */
export const isTrackerKind = (kind: DbEnum.ConnectionKind): kind is TrackerKind => {
  switch (kind) {
    case "linear":
    case "jira":
      return true;
    case "github":
      return false;
    default:
      return kind satisfies never;
  }
};

/** Each kind's word, as a connection's default name and the paused line say it. */
export const trackerKindNames = { linear: "Linear", jira: "Jira" } as const satisfies Record<TrackerKind, string>;

/** What each kind's adapter declares (`LINEAR_CAPABILITIES`, `JIRA_CAPABILITIES`): injected, as the domain builds no adapter. */
export type TrackerKindCapabilities = Readonly<Record<TrackerKind, TrackerCapabilities>>;

// ---------- a connection's tracker ----------

/** What core and the API need to act for one connection: its adapter, built with its own token. */
export type ConnectionTracker = {
  readonly connectionId: ConnectionId;
  readonly kind: TrackerKind;
  /** The name an admin gave the connection: what the panel and a ticket's chip call it. */
  readonly name: string;
  readonly tracker: TrackerAdapter;
  /** The connection's own user, for the echo check; `null` with an API key. */
  readonly ownUserId: string | null;
};

/** Whether a connection's tracker may serve a board: only its own connection's. */
export const trackerServesBoard = (tracker: Pick<ConnectionTracker, "connectionId">, board: { readonly connectionId: string }): boolean =>
  tracker.connectionId === board.connectionId;

// ---------- names and sites ----------

/** The longest name a connection takes. */
export const CONNECTION_NAME_MAX = 60;

/** A connection's name as an admin types it: trimmed, 1 to 60 characters, not blank. */
export const connectionNameSchema = z.string().trim().min(1).max(CONNECTION_NAME_MAX);

/**
 * The name a connection is prefilled with: the workspace's or site's title and the kind (`Globex
 * Jira`, `Acme Linear`), or the kind alone while the title isn't known.
 */
export const defaultConnectionName = (kind: TrackerKind, siteTitle: string | null): string => {
  const word = trackerKindNames[kind];
  const title = (siteTitle ?? "").replace(/\s+/g, " ").trim();
  if (title === "") {
    return word;
  }
  if (title.toLowerCase().endsWith(` ${word.toLowerCase()}`) || title.toLowerCase() === word.toLowerCase()) {
    return title.slice(0, CONNECTION_NAME_MAX).trim();
  }
  return `${title.slice(0, CONNECTION_NAME_MAX - word.length - 1).trim()} ${word}`;
};

/** A connection as a refusal names it: "already connected as Globex Jira". */
export type ConnectionHolder = { readonly id: ConnectionId; readonly name: string };

type ConnectionReader = Pick<Tx, "connection">;

const holderOf = (row: { readonly id: string; readonly name: string | null; readonly kind: DbEnum.ConnectionKind; readonly externalWorkspaceName: string | null }): ConnectionHolder => ({
  id: connectionIdSchema.parse(row.id),
  name: row.name ?? (isTrackerKind(row.kind) ? defaultConnectionName(row.kind, row.externalWorkspaceName) : row.kind),
});

/**
 * The connection of the organization, not revoked, that already has this name, compared without
 * case: a second is `name-taken`. `besides` is the connection being renamed.
 */
export const nameTakenBy = async (db: ConnectionReader, organizationId: OrganizationId, name: string, besides: ConnectionId | null = null): Promise<ConnectionHolder | null> => {
  const row = await db.connection.findFirst({
    where: {
      organizationId,
      kind: { in: [...trackerKinds] },
      state: { not: "revoked" },
      name: { equals: name.trim(), mode: "insensitive" },
      ...(besides === null ? {} : { id: { not: besides } }),
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, kind: true, externalWorkspaceName: true },
  });
  return row === null ? null : holderOf(row);
};

/**
 * The connection of the organization, not revoked, that holds this site or workspace (ADR 0071: one
 * per site, per organization), for the refusals that name it. `besides` is the connection asking.
 */
export const siteTakenBy = async (
  db: ConnectionReader,
  organizationId: OrganizationId,
  kind: TrackerKind,
  externalWorkspaceId: string,
  besides: ConnectionId | null = null,
): Promise<ConnectionHolder | null> => {
  const row = await db.connection.findFirst({
    where: { organizationId, kind, externalWorkspaceId, state: { not: "revoked" }, ...(besides === null ? {} : { id: { not: besides } }) },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, kind: true, externalWorkspaceName: true },
  });
  return row === null ? null : holderOf(row);
};

/** `base`, or `base 2`, `base 3`… : the first name no connection of the organization holds. */
export const freeConnectionName = async (db: ConnectionReader, organizationId: OrganizationId, base: string): Promise<string> => {
  const trimmed = base.trim().slice(0, CONNECTION_NAME_MAX);
  for (let n = 1; ; n += 1) {
    const suffix = n === 1 ? "" : ` ${String(n)}`;
    const candidate = `${trimmed.slice(0, CONNECTION_NAME_MAX - suffix.length).trim()}${suffix}`;
    if ((await nameTakenBy(db, organizationId, candidate)) === null) {
      return candidate;
    }
  }
};

// ---------- Jira's last read-back ----------

/** The permissions the read-back checks in each Jira project (ADR 0047). */
export const jiraProjectPermissions = ["BROWSE_PROJECTS", "CREATE_ISSUES", "EDIT_ISSUES", "TRANSITION_ISSUES", "ADD_COMMENTS"] as const;
export type JiraProjectPermission = (typeof jiraProjectPermissions)[number];

/**
 * `Connection.accessCheck`: a Jira token's last read-back (ticket 06 writes it), per project its ID,
 * key, name and the permissions it holds there, and whether workflows read. IDs and names only,
 * never the token or Jira's body. ostra owns the format: strict.
 */
export const trackerAccessCheckSchema = z.strictObject({
  projects: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(64),
        key: z.string().min(1).max(64),
        name: z.string().max(256),
        permissions: z.array(z.enum(jiraProjectPermissions)).max(jiraProjectPermissions.length),
      }),
    )
    .max(2000),
  workflowsReadable: z.boolean(),
});
export type TrackerAccessCheck = z.infer<typeof trackerAccessCheckSchema>;

/** Reads `Connection.accessCheck` (storage); `null` when there's none, or it can't be read. */
export const parseTrackerAccessCheck = (value: unknown): TrackerAccessCheck | null => {
  const parsed = trackerAccessCheckSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

// ---------- the view ----------

/** A board a connection's boards list names: its team or project, and the project it's attached to. */
export type TrackerConnectionBoard = {
  readonly id: BoardId;
  readonly name: string;
  readonly key: string | null;
  /** The project, with its access, so a reader shows a member only the projects they may open. */
  readonly project: { readonly id: ProjectId; readonly name: string; readonly access: DbEnum.ProjectAccess };
};

type TrackerConnectionCommon = {
  readonly id: ConnectionId;
  readonly name: string;
  /** Linear's workspace URL key, or Jira's host (`globex.atlassian.net`); `null` until known. */
  readonly site: string | null;
  /** A listed connection is never revoked: a revoked one is history, and its boards pause. */
  readonly state: Exclude<DbEnum.ConnectionState, "revoked">;
  readonly webhookMode: DbEnum.WebhookMode;
  readonly lastEventAt: number | null;
  readonly failedReason: string | null;
  /** "Webhooks silent since …": polling found changes the webhooks never brought. */
  readonly silentSince: number | null;
  /** Its boards that aren't detached, oldest first. */
  readonly boards: readonly TrackerConnectionBoard[];
  /** What its kind's adapter declares. */
  readonly capabilities: TrackerCapabilities;
  readonly createdAt: number;
};

export type LinearTrackerConnection = TrackerConnectionCommon & {
  readonly kind: "linear";
  readonly appUserName: string | null;
  readonly agentModeAt: number | null;
  readonly accessTokenExpiresAt: number | null;
};

export type JiraTrackerConnection = TrackerConnectionCommon & {
  readonly kind: "jira";
  /** The site's cloud ID; `null` before step 1. */
  readonly cloudId: string | null;
  /** The service account's email: not a secret, an admin's to see. */
  readonly accountEmail: string | null;
  /** The token's expiry date as the admin gave it, `YYYY-MM-DD`. */
  readonly tokenExpiresOn: string | null;
  readonly accessCheck: TrackerAccessCheck | null;
  /** Whether the token reads workflows (`read:workflow:jira`); `null` before the read-back. */
  readonly workflowsReadable: boolean | null;
  /** The first signed delivery: the webhook's secret is shown until then. */
  readonly firstDeliveryAt: number | null;
  readonly badSignatureAt: number | null;
};

/** A tracker connection as the panel lists it, one shape per kind. */
export type TrackerConnection = LinearTrackerConnection | JiraTrackerConnection;

type ConnectionViewRow = Awaited<ReturnType<typeof readConnectionRows>>[number];

const readConnectionRows = (db: ConnectionReader, where: { readonly organizationId: OrganizationId; readonly id?: ConnectionId }) =>
  db.connection.findMany({
    where: { ...where, kind: { in: [...trackerKinds] }, state: { not: "revoked" } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      kind: true,
      name: true,
      state: true,
      webhookMode: true,
      lastEventAt: true,
      failedReason: true,
      webhooksSilentSince: true,
      externalWorkspaceId: true,
      externalWorkspaceKey: true,
      externalWorkspaceName: true,
      appUserName: true,
      agentModeAt: true,
      accessTokenExpiresAt: true,
      accountEmail: true,
      tokenExpiresOn: true,
      accessCheck: true,
      firstDeliveryAt: true,
      badSignatureAt: true,
      createdAt: true,
      boards: {
        where: { detachedAt: null },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, name: true, key: true, project: { select: { id: true, name: true, access: true } } },
      },
    },
  });

const timeOf = (value: Date | null): number | null => value?.getTime() ?? null;

const viewOf = (row: ConnectionViewRow, capabilities: TrackerKindCapabilities): TrackerConnection | null => {
  if (row.state === "revoked") {
    return null;
  }
  const common = {
    id: connectionIdSchema.parse(row.id),
    site: row.externalWorkspaceKey,
    state: row.state,
    webhookMode: row.webhookMode,
    lastEventAt: timeOf(row.lastEventAt),
    failedReason: row.failedReason,
    silentSince: timeOf(row.webhooksSilentSince),
    boards: row.boards.map((board) => ({
      id: boardIdSchema.parse(board.id),
      name: board.name,
      key: board.key,
      project: { id: projectIdSchema.parse(board.project.id), name: board.project.name, access: board.project.access },
    })),
    createdAt: row.createdAt.getTime(),
  };
  switch (row.kind) {
    case "linear":
      return {
        ...common,
        kind: "linear",
        name: row.name ?? defaultConnectionName("linear", row.externalWorkspaceName),
        capabilities: capabilities.linear,
        appUserName: row.appUserName,
        agentModeAt: timeOf(row.agentModeAt),
        accessTokenExpiresAt: timeOf(row.accessTokenExpiresAt),
      };
    case "jira": {
      const accessCheck = parseTrackerAccessCheck(row.accessCheck);
      return {
        ...common,
        kind: "jira",
        name: row.name ?? defaultConnectionName("jira", row.externalWorkspaceName),
        capabilities: capabilities.jira,
        cloudId: row.externalWorkspaceId,
        accountEmail: row.accountEmail,
        tokenExpiresOn: row.tokenExpiresOn?.toISOString().slice(0, 10) ?? null,
        accessCheck,
        workflowsReadable: accessCheck?.workflowsReadable ?? null,
        firstDeliveryAt: timeOf(row.firstDeliveryAt),
        badSignatureAt: timeOf(row.badSignatureAt),
      };
    }
    case "github":
      return null;
    default:
      return row.kind satisfies never;
  }
};

/**
 * Every tracker connection of the organization that isn't revoked, of any kind, oldest first, each
 * with its boards and its kind's capabilities. Another organization's rows are never read.
 */
export const trackerConnectionsOf = async (db: ConnectionReader, organizationId: OrganizationId, capabilities: TrackerKindCapabilities): Promise<readonly TrackerConnection[]> =>
  (await readConnectionRows(db, { organizationId })).flatMap((row) => {
    const view = viewOf(row, capabilities);
    return view === null ? [] : [view];
  });

/** One of the organization's tracker connections by its ID, or `null`: another organization's, a revoked one, or none. */
export const trackerConnectionOf = async (
  db: ConnectionReader,
  organizationId: OrganizationId,
  connectionId: ConnectionId,
  capabilities: TrackerKindCapabilities,
): Promise<TrackerConnection | null> => {
  const [row] = await readConnectionRows(db, { organizationId, id: connectionId });
  return row === undefined ? null : viewOf(row, capabilities);
};

// ---------- resume ----------

export type ResumeBoardsResult = {
  /** The boards that moved to the connection. */
  readonly boards: number;
  /** The revoked connections of the same site it took boards from or newly succeeded, oldest first. */
  readonly from: readonly ConnectionId[];
};

/**
 * Connecting the same site or workspace again resumes its paused boards (ADR 0071, choice 12),
 * called in the transaction that makes `connectionId` active: the boards of every revoked
 * connection of the same kind and `externalWorkspaceId` that aren't detached, with their tickets,
 * move to it, keeping their mappings and polling cursors; the old rows get `resumedIntoId`;
 * `tracker.resumed` is audited with the count. Another site's boards, and another organization's,
 * never move. A board whose project already holds the same team under the new connection stays.
 */
export const resumeBoardsInTx = async (
  deps: { readonly tx: Tx } & Pick<Ports, "audit" | "notices">,
  input: { readonly organizationId: OrganizationId; readonly connectionId: ConnectionId; readonly actor: AuditInput["actor"] },
): Promise<ResumeBoardsResult> => {
  const { tx } = deps;
  const none: ResumeBoardsResult = { boards: 0, from: [] };
  const connection = await tx.connection.findFirst({
    where: { id: input.connectionId, organizationId: input.organizationId },
    select: { id: true, kind: true, state: true, externalWorkspaceId: true },
  });
  if (connection === null || !isTrackerKind(connection.kind) || connection.state !== "active" || connection.externalWorkspaceId === null) {
    return none;
  }
  const previous = await tx.connection.findMany({
    where: { organizationId: input.organizationId, kind: connection.kind, externalWorkspaceId: connection.externalWorkspaceId, state: "revoked", id: { not: connection.id } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, resumedIntoId: true },
  });
  if (previous.length === 0) {
    return none;
  }
  const previousIds = previous.map((row) => row.id);
  const [paused, held] = await Promise.all([
    tx.board.findMany({
      where: { organizationId: input.organizationId, connectionId: { in: previousIds }, detachedAt: null },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, projectId: true, connectionId: true, externalId: true, agentMode: true },
    }),
    tx.board.findMany({ where: { organizationId: input.organizationId, connectionId: connection.id }, select: { projectId: true, externalId: true, agentMode: true } }),
  ]);
  // One board per team per project under a connection, and one agent-mode board per team: the
  // first paused board takes each place, and a board that would make a second stays where it is.
  const places = new Set(held.map((board) => `${board.projectId}\u0000${board.externalId}`));
  const agentModeTeams = new Set(held.filter((board) => board.agentMode).map((board) => board.externalId));
  const projects = new Set<string>();
  const from = new Set(previous.filter((row) => row.resumedIntoId === null).map((row) => row.id));
  let moved = 0;
  for (const board of paused) {
    const place = `${board.projectId}\u0000${board.externalId}`;
    if (places.has(place)) {
      continue;
    }
    places.add(place);
    const keepsAgentMode = board.agentMode && !agentModeTeams.has(board.externalId);
    if (keepsAgentMode) {
      agentModeTeams.add(board.externalId);
    }
    await tx.board.update({ where: { id: board.id }, data: { connectionId: connection.id, ...(board.agentMode && !keepsAgentMode ? { agentMode: false } : {}) } });
    await tx.ticket.updateMany({ where: { boardId: board.id, organizationId: input.organizationId }, data: { connectionId: connection.id } });
    projects.add(board.projectId);
    from.add(board.connectionId);
    moved += 1;
  }
  if (from.size === 0) {
    // Resumed already: nothing moved, nobody newly named.
    return none;
  }
  await tx.connection.updateMany({ where: { id: { in: previousIds }, organizationId: input.organizationId, resumedIntoId: null }, data: { resumedIntoId: connection.id } });
  const connectionId = connectionIdSchema.parse(connection.id);
  await deps.audit.recordInTx(tx, {
    organizationId: input.organizationId,
    projectId: null,
    actor: input.actor,
    action: "tracker.resumed",
    entity: "connection",
    entityId: connectionId,
    data: { boards: moved, from: from.size },
  });
  for (const projectId of projects) {
    const project = projectIdSchema.parse(projectId);
    await deps.notices.emitInTx(tx, { organizationId: input.organizationId, projectId: project, entity: "project", entityId: project });
  }
  await deps.notices.emitInTx(tx, { organizationId: input.organizationId, projectId: null, entity: "connection", entityId: connectionId });
  return { boards: moved, from: previousIds.filter((id) => from.has(id)).map((id) => connectionIdSchema.parse(id)) };
};

// ---------- words ----------

/**
 * The line a paused board shows (the Boards page, a ticket's task): what stopped and why, with the
 * connection's name and the board's key. Names only.
 */
export const pausedBoardLine = (input: { readonly connectionName: string; readonly kind: TrackerKind; readonly key: string | null; readonly pausedBy: BoardPauseReason }): string => {
  const tickets = input.key === null ? "the board's tickets" : `${input.key}'s tickets`;
  const why = input.pausedBy === "failed" ? `${input.connectionName} can't connect` : `${input.connectionName} was disconnected`;
  return `${why}, so ${tickets} stay as they were and nothing moves on ${trackerKindNames[input.kind]}.`;
};
