import type { IncomingMessage, ServerResponse } from "node:http";

import type { Logger, SecretStoreAdapter } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { isClosingTurnMessageId, lastMessageIdInTx, proposeNote, readNote, searchNotes } from "@ostra/domain";
import type { AuditLog, Clock } from "@ostra/domain";
import {
  memoryProposalRequestSchema,
  memorySearchRequestSchema,
  noteIdSchema,
  organizationIdSchema,
  projectIdSchema,
  RUNNER_PATH_PREFIX,
  sessionIdSchema,
  taskIdSchema,
} from "@ostra/protocol";
import type { MemoryNoteResponse, MemoryProposalResponse, MemorySearchResponse, OrganizationId, ProjectId, RunnerId, SessionId, TaskId } from "@ostra/protocol";

import { bearerToken, runnerIsLive } from "../gateway/access-token.ts";
import type { AccessTokens } from "../gateway/access-token.ts";
import { checkTaskLease, isTaskToken } from "../gateway/task-token.ts";
import type { TaskTokens } from "../gateway/task-token.ts";
import { readJsonBody, sendError, sendJson } from "../http.ts";

// The memory tools' endpoints (F-110, F-111, ADR 0044; milestone 4's ticket 15): what the sidecar's
// `memory_search`, `memory_read` and `memory_propose` call, on behalf of one task. Each checks the
// task token's task and lease epoch as the credentials endpoint does (a `host` lease's runner is its
// own sidecar, so it calls with its access token), then answers within the task's organization and
// project only. A query, a note's text and a proposal's text never reach a log line: the lines name
// the task, the note and the proposal.

const memoryPath = new RegExp(`^${RUNNER_PATH_PREFIX}/tasks/([^/]+)/memory/(search|proposals|notes/([^/]+))$`);

export type MemoryEndpointDeps = {
  readonly db: Db;
  readonly tokens: AccessTokens;
  readonly taskTokens: TaskTokens;
  readonly secretStore: Pick<SecretStoreAdapter, "get">;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly logger: Logger;
  /** `OSTRA_MEMORY_PROPOSALS_PER_TASK`. */
  readonly proposalsPerTask?: number;
};

/** The task a memory call is for, once its token and lease checked out. Milestone 6: any sidecar call's. */
export type TaskContext = {
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly taskId: TaskId;
  readonly sessionId: SessionId | null;
  /** Milestone 10 (F-151): the runner whose lease the call came under, by its task token or its own access token. */
  readonly runnerId: RunnerId;
};

/**
 * Checks the caller, as the credentials endpoint does; answers the refusal itself and returns
 * `null`. Milestone 6: the sidecar's other task calls (`submit_review`, ticket 17) check it the same way.
 */
export const authorizeTaskCall = async (deps: Pick<MemoryEndpointDeps, "db" | "tokens" | "taskTokens" | "clock">, request: IncomingMessage, response: ServerResponse, taskId: TaskId): Promise<TaskContext | null> => {
  const token = bearerToken(request.headers.authorization);
  let boxId: string;
  let organizationId: OrganizationId;
  let runnerId: RunnerId;
  if (token !== null && isTaskToken(token)) {
    const claims = deps.taskTokens.verify(token);
    if (claims === null) {
      sendError(response, 401, "unauthorized", "the task token is not valid");
      return null;
    }
    if (claims.taskId !== taskId) {
      sendError(response, 403, "unauthorized", "a task token is for its own task only");
      return null;
    }
    const check = await checkTaskLease(deps.db, claims);
    if (!check.ok) {
      if (check.error === "not-found") {
        sendError(response, 404, "not-found", "no such task");
      } else {
        sendError(response, 409, "stale-lease", "this task token's lease has ended", { currentEpoch: check.currentEpoch });
      }
      return null;
    }
    boxId = claims.boxId;
    organizationId = claims.organizationId;
    runnerId = claims.runnerId;
  } else {
    const claims = token === null ? null : deps.tokens.verify(token, deps.clock.now());
    if (claims === null) {
      sendError(response, 401, "unauthorized", "a valid access token is required");
      return null;
    }
    if (!(await runnerIsLive(deps.db, claims))) {
      sendError(response, 403, "unauthorized", "this runner is revoked; register it again");
      return null;
    }
    // A runner's own token reaches memory only for the `host` lease it holds now: a boxed task's
    // memory goes through its sidecar's task token.
    const task = await deps.db.task.findFirst({ where: { id: taskId, organizationId: claims.organizationId }, select: { leaseEpoch: true } });
    if (task === null) {
      sendError(response, 404, "not-found", "no such task");
      return null;
    }
    const lease = await deps.db.lease.findFirst({
      where: { taskId, organizationId: claims.organizationId, epoch: task.leaseEpoch, runnerId: claims.runnerId, state: "active" },
      select: { boxId: true, box: { select: { executor: true } } },
    });
    if (lease === null) {
      sendError(response, 409, "stale-lease", "this runner holds no current lease of the task", { currentEpoch: task.leaseEpoch });
      return null;
    }
    if (lease.box.executor !== "host") {
      sendError(response, 403, "unauthorized", "a docker or kubernetes box's memory goes to its sidecar's task token only");
      return null;
    }
    boxId = lease.boxId;
    organizationId = claims.organizationId;
    runnerId = claims.runnerId;
  }
  const task = await deps.db.task.findFirst({ where: { id: taskId, organizationId }, select: { projectId: true } });
  if (task === null) {
    sendError(response, 404, "not-found", "no such task");
    return null;
  }
  const session = await deps.db.session.findFirst({ where: { taskId, boxId }, orderBy: { startedAt: "desc" }, select: { id: true } });
  return {
    organizationId: organizationIdSchema.parse(organizationId),
    projectId: projectIdSchema.parse(task.projectId),
    taskId,
    sessionId: session === null ? null : sessionIdSchema.parse(session.id),
    runnerId,
  };
};

export const handleMemoryEndpoint =
  (deps: MemoryEndpointDeps) =>
  async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    const match = memoryPath.exec(url.pathname);
    if (match === null) {
      return false;
    }
    const [, rawTaskId, which, rawNoteId] = match;
    const taskId = taskIdSchema.safeParse(decodeURIComponent(rawTaskId ?? ""));
    if (!taskId.success) {
      sendError(response, 404, "not-found", "no such task");
      return true;
    }
    const context = await authorizeTaskCall(deps, request, response, taskId.data);
    if (context === null) {
      return true;
    }
    const logger = deps.logger.child({ component: "memory-endpoints", taskId: context.taskId });

    if (which === "search" && request.method === "POST") {
      const body = await readJsonBody(request, 8 * 1024);
      const parsed = body.ok ? memorySearchRequestSchema.safeParse(body.value) : undefined;
      if (parsed?.success !== true) {
        sendError(response, 400, "bad-request", "the body is not a memory search");
        return true;
      }
      const results = await searchNotes(deps.db, {
        organizationId: context.organizationId,
        projectId: context.projectId,
        query: parsed.data.query,
        limit: parsed.data.limit,
      });
      logger.info("memory.searched", { results: results.length });
      const answer: MemorySearchResponse = { results: [...results] };
      sendJson(response, 200, answer);
      return true;
    }

    if (which?.startsWith("notes/") === true && request.method === "GET") {
      const noteId = noteIdSchema.safeParse(decodeURIComponent(rawNoteId ?? ""));
      const note = noteId.success ? await readNote(deps.db, { organizationId: context.organizationId, projectId: context.projectId, noteId: noteId.data }) : null;
      if (note === null) {
        sendError(response, 404, "not-found", "no such note");
        return true;
      }
      logger.info("memory.read", { noteId: note.noteId });
      const answer: MemoryNoteResponse = note;
      sendJson(response, 200, answer);
      return true;
    }

    if (which === "proposals" && request.method === "POST") {
      const body = await readJsonBody(request, 16 * 1024);
      const parsed = body.ok ? memoryProposalRequestSchema.safeParse(body.value) : undefined;
      if (parsed?.success !== true) {
        logger.info("memory.proposal-refused", { code: "invalid" });
        const refusal: MemoryProposalResponse = { code: "invalid" };
        sendJson(response, 200, refusal);
        return true;
      }
      // A proposal made in the profile's closing turn (ticket 16) is sourced as that turn's.
      const lastMessage = context.sessionId === null ? null : await lastMessageIdInTx(deps.db, context.taskId, context.sessionId);
      const result = await proposeNote(
        {
          db: deps.db,
          audit: deps.audit,
          clock: deps.clock,
          adapters: { secretStore: deps.secretStore },
          ...(deps.proposalsPerTask === undefined ? {} : { proposalsPerTask: deps.proposalsPerTask }),
        },
        {
          organizationId: context.organizationId,
          taskId: context.taskId,
          sessionId: context.sessionId,
          title: parsed.data.title,
          body: parsed.data.body,
          kind: parsed.data.kind,
          scope: parsed.data.scope,
          relatesTo: parsed.data.relatesTo,
          relation: parsed.data.relation,
          source: lastMessage !== null && isClosingTurnMessageId(lastMessage) ? "closing_turn" : "agent",
        },
      );
      if (result.ok) {
        logger.info("memory.proposed", { proposalId: result.proposalId });
        const answer: MemoryProposalResponse = { proposalId: result.proposalId };
        sendJson(response, 200, answer);
        return true;
      }
      logger.info("memory.proposal-refused", { code: result.error });
      switch (result.error) {
        case "secret-found": {
          const refusal: MemoryProposalResponse = { code: "secret-found", found: [...result.found] };
          sendJson(response, 200, refusal);
          return true;
        }
        case "limit-reached": {
          const refusal: MemoryProposalResponse = { code: "limit-reached" };
          sendJson(response, 200, refusal);
          return true;
        }
        case "invalid": {
          const refusal: MemoryProposalResponse = { code: "invalid" };
          sendJson(response, 200, refusal);
          return true;
        }
        case "not-found":
          sendError(response, 404, "not-found", "no such task");
          return true;
        default:
          return result satisfies never;
      }
    }
    sendError(response, 404, "not-found", "no such route");
    return true;
  };
