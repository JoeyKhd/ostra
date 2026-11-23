import type { AdapterError } from "@ostra/adapter-sdk";
import type { Tx } from "@ostra/db";
import { boardIdSchema, connectionIdSchema, projectIdSchema } from "@ostra/protocol";
import type { BoardId } from "@ostra/protocol";
import { z } from "zod";

import { requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import type { Ports } from "../ports.ts";
import { boardMappingSchema, draftBoardMapping, parseBoardMapping, unknownMappedStatuses } from "../tickets/board-mapping.ts";
import type { BoardMapping } from "../tickets/board-mapping.ts";
import { boardStateOf } from "../lifecycles/m11-trackers.ts";
import type { UseCaseResult } from "./common.ts";
import { isTrackerKind, trackerServesBoard } from "./tracker-connections.ts";
import type { ConnectionTracker } from "./tracker-connections.ts";

// F-007, F-031: a project admin attaches a tracker's team to the project as a board, and edits its
// status mapping (spec section 3, step 2). Attaching reads the team's statuses and the GitHub
// integration check through the tracker adapter, drafts the mapping (`draftBoardMapping`) and
// saves the board; the admin can change any of the four targets, `doneBy` and the magic word.
// Written by ticket 28. The tracker is asked inside the caller's transaction, so the board and
// the answer it was drafted from commit together.
// Milestone 11 (F-152, ADR 0071): a board is a team or project of one of the organization's
// active connections, of any kind, named by the connection and its external ID; the same external
// ID under two connections is two boards. A connection's tracker only ever serves its own boards.

export const attachBoardInputSchema = z.strictObject({
  projectId: projectIdSchema,
  /** The connection the team or project is on: one of the organization's, active. */
  connectionId: connectionIdSchema,
  /** The tracker's ID of the team or project (`listBoards`). */
  externalId: z.string().min(1).max(256),
});
export type AttachBoardInput = z.infer<typeof attachBoardInputSchema>;

export type AttachBoardResult = UseCaseResult<
  { readonly boardId: BoardId; readonly mapping: BoardMapping; readonly integrationInstalled: boolean },
  | "not-found"
  | "forbidden"
  /** The connection isn't the organization's, isn't a tracker's, or isn't active: a paused one's board can't be attached. */
  | "no-connection"
  | "already-attached"
  | "no-started-status"
  | "no-done-status"
  /** The tracker didn't answer, or refused: words, never its body. */
  | "tracker-failed"
>;

export type AttachBoardDeps = Pick<Ports, "notices" | "audit" | "clock"> & {
  readonly tx: Tx;
  readonly scope: MemberScope;
  readonly tracker: ConnectionTracker;
};

export type AttachBoard = (deps: AttachBoardDeps, input: AttachBoardInput) => Promise<AttachBoardResult>;

const refuseAttach = (error: Exclude<AttachBoardResult, { readonly ok: true }>["error"], message: string): AttachBoardResult => ({ ok: false, error, message });

/** An adapter's failure as words for a person: the adapter's own message never holds content. */
const trackerWords = (error: AdapterError): string => `The tracker did not answer (${error.code}): ${error.message}`;

export const attachBoard: AttachBoard = async (deps, input) => {
  const { tx, scope, tracker } = deps;
  const organizationId = scope.organizationId;
  const project = await tx.project.findFirst({ where: { id: input.projectId, organizationId }, select: { id: true, access: true } });
  if (project === null) {
    return refuseAttach("not-found", "No such project");
  }
  const access = requireProjectAccess(scope, { id: projectIdSchema.parse(project.id), organizationId, access: project.access }, "admin");
  if (!access.ok) {
    return access.code === "not-found" ? refuseAttach("not-found", "No such project") : refuseAttach("forbidden", "Only the project's admins attach a board");
  }
  // The board's own connection, by its ID and the organization: never "the organization's" tracker.
  if (!trackerServesBoard(tracker, { connectionId: input.connectionId })) {
    return refuseAttach("no-connection", "That tracker isn't this connection's");
  }
  const connection = await tx.connection.findFirst({ where: { id: input.connectionId, organizationId }, select: { id: true, kind: true, state: true } });
  if (connection === null || !isTrackerKind(connection.kind)) {
    return refuseAttach("no-connection", "No such tracker connection in this organization");
  }
  if (connection.state !== "active") {
    return refuseAttach("no-connection", "That tracker connection isn't connected: finish or fix it on Trackers first");
  }
  const existing = await tx.board.findFirst({ where: { projectId: project.id, organizationId, connectionId: connection.id, externalId: input.externalId } });
  if (existing !== null && existing.detachedAt === null) {
    return refuseAttach("already-attached", "That team is already a board of this project");
  }

  const boards = await tracker.tracker.listBoards();
  if (!boards.ok) {
    return refuseAttach("tracker-failed", trackerWords(boards.error));
  }
  const team = boards.value.find((candidate) => candidate.externalId === input.externalId);
  if (team === undefined) {
    return refuseAttach("not-found", "The connection can't see that team");
  }
  const statuses = await tracker.tracker.listStatuses({ externalId: team.externalId });
  if (!statuses.ok) {
    return refuseAttach("tracker-failed", trackerWords(statuses.error));
  }
  // A tracker that can't say whether its GitHub integration is installed reads as not installed:
  // ostra then moves the ticket to done itself, which an installed integration does no harm to
  // (the move is a no-op when the ticket is already there).
  const integration = await tracker.tracker.detectCodeHostIntegration({ externalId: team.externalId });
  const installed = integration.ok && integration.value.installed;

  // A tracker that moves by transitions (Jira) has Done moved by ostra by default (choice 8).
  const draft = draftBoardMapping(statuses.value, { installed, transitions: tracker.tracker.capabilities.transitions });
  if (!draft.ok) {
    return refuseAttach(draft.reason, draft.reason === "no-started-status" ? "The team has no started status to move tickets to" : "The team has no done status to move tickets to");
  }
  // Attaching a team again keeps the mapping it had, when every status in it still exists.
  const kept = existing === null ? null : parseBoardMapping(existing.statusMap);
  const mapping = kept !== null && unknownMappedStatuses(kept, statuses.value).length === 0 ? kept : draft.mapping;

  const data = { name: team.name, key: team.key, statusMap: mapping, integrationDetected: integration.ok ? installed : null, detachedAt: null };
  const board =
    existing === null
      ? await tx.board.create({ data: { organizationId, projectId: project.id, connectionId: connection.id, externalId: team.externalId, ...data }, select: { id: true } })
      : await tx.board.update({ where: { id: existing.id }, data: { ...data, pollCursor: null }, select: { id: true } });
  const boardId = boardIdSchema.parse(board.id);
  const projectId = projectIdSchema.parse(project.id);

  await deps.audit.recordInTx(tx, {
    organizationId,
    projectId,
    actor: { kind: "member", id: scope.memberId },
    action: "board.attached",
    entity: "project",
    entityId: projectId,
    data: { boardId, connectionId: input.connectionId, kind: connection.kind, key: team.key, doneBy: mapping.doneBy, integrationInstalled: installed },
  });
  await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "project", entityId: projectId });
  return { ok: true, boardId, mapping, integrationInstalled: installed };
};

export const saveBoardMappingInputSchema = z.strictObject({
  boardId: boardIdSchema,
  mapping: boardMappingSchema,
});
export type SaveBoardMappingInput = z.infer<typeof saveBoardMappingInputSchema>;

export type SaveBoardMappingResult = UseCaseResult<
  { readonly mapping: BoardMapping },
  | "not-found"
  | "forbidden"
  | "unknown-status"
  | "tracker-failed"
  /** Milestone 11 (F-152/c5): the board's connection isn't active: its mapping reads only until it is. */
  | "board-paused"
>;

export type SaveBoardMapping = (deps: AttachBoardDeps, input: SaveBoardMappingInput) => Promise<SaveBoardMappingResult>;

const refuseSave = (error: Exclude<SaveBoardMappingResult, { readonly ok: true }>["error"], message: string): SaveBoardMappingResult => ({ ok: false, error, message });

export const saveBoardMapping: SaveBoardMapping = async (deps, input) => {
  const { tx, scope, tracker } = deps;
  const organizationId = scope.organizationId;
  const board = await tx.board.findFirst({
    where: { id: input.boardId, organizationId },
    include: { project: { select: { id: true, access: true } }, connection: { select: { state: true } } },
  });
  if (board === null) {
    return refuseSave("not-found", "No such board");
  }
  const access = requireProjectAccess(scope, { id: projectIdSchema.parse(board.project.id), organizationId, access: board.project.access }, "admin");
  if (!access.ok) {
    return access.code === "not-found" ? refuseSave("not-found", "No such board") : refuseSave("forbidden", "Only the project's admins change a board's mapping");
  }
  if (boardStateOf(board, board.connection).state === "paused") {
    return refuseSave("board-paused", "This board's tracker connection isn't connected: its mapping reads only until it is");
  }
  // Only the board's own connection's tracker reads its statuses (ADR 0071).
  if (!trackerServesBoard(tracker, board)) {
    return refuseSave("tracker-failed", "That tracker isn't this board's connection's");
  }
  const statuses = await tracker.tracker.listStatuses({ externalId: board.externalId });
  if (!statuses.ok) {
    return refuseSave("tracker-failed", trackerWords(statuses.error));
  }
  const gone = unknownMappedStatuses(input.mapping, statuses.value);
  if (gone.length > 0) {
    return refuseSave("unknown-status", "A mapped status is gone from the tracker. Pick another.");
  }
  await tx.board.update({ where: { id: board.id }, data: { statusMap: input.mapping } });
  const projectId = projectIdSchema.parse(board.project.id);
  await deps.audit.recordInTx(tx, {
    organizationId,
    projectId,
    actor: { kind: "member", id: scope.memberId },
    action: "board.mapping-saved",
    entity: "project",
    entityId: projectId,
    data: { boardId: input.boardId, doneBy: input.mapping.doneBy, magicWord: input.mapping.magicWord, openStatuses: input.mapping.open.length },
  });
  await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "project", entityId: projectId });
  return { ok: true, mapping: input.mapping };
};

// ---------- detach ----------

export const detachBoardInputSchema = z.strictObject({ boardId: boardIdSchema });
export type DetachBoardInput = z.infer<typeof detachBoardInputSchema>;

export type DetachBoardResult = UseCaseResult<{ readonly boardId: BoardId }, "not-found" | "forbidden" | "already-detached">;

export type DetachBoardDeps = Pick<Ports, "notices" | "audit" | "clock"> & { readonly tx: Tx; readonly scope: MemberScope };

/**
 * Marks the board detached. It stops polling (core drops the schedule of a detached board) and
 * starts no new task; its cached tickets stay, and its tasks keep their links. When it was the
 * board the project's prompt tasks get their tickets on (F-097), that setting goes off with it.
 */
export const detachBoard = async (deps: DetachBoardDeps, input: DetachBoardInput): Promise<DetachBoardResult> => {
  const { tx, scope } = deps;
  const organizationId = scope.organizationId;
  const refuse = (error: Exclude<DetachBoardResult, { readonly ok: true }>["error"], message: string): DetachBoardResult => ({ ok: false, error, message });
  const board = await tx.board.findFirst({ where: { id: input.boardId, organizationId }, include: { project: { select: { id: true, access: true } } } });
  if (board === null) {
    return refuse("not-found", "No such board");
  }
  const access = requireProjectAccess(scope, { id: projectIdSchema.parse(board.project.id), organizationId, access: board.project.access }, "admin");
  if (!access.ok) {
    return access.code === "not-found" ? refuse("not-found", "No such board") : refuse("forbidden", "Only the project's admins detach a board");
  }
  if (board.detachedAt !== null) {
    return refuse("already-detached", "That board is already detached");
  }
  await tx.board.update({ where: { id: board.id }, data: { detachedAt: new Date(deps.clock.now()), ticketsForPromptTasks: false } });
  const projectId = projectIdSchema.parse(board.project.id);
  await deps.audit.recordInTx(tx, {
    organizationId,
    projectId,
    actor: { kind: "member", id: scope.memberId },
    action: "board.detached",
    entity: "project",
    entityId: projectId,
    data: { boardId: input.boardId },
  });
  await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "project", entityId: projectId });
  return { ok: true, boardId: input.boardId };
};
