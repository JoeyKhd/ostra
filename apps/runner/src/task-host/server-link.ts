import {
  memoryNoteResponseSchema,
  memoryProposalResponseSchema,
  memorySearchResponseSchema,
  PROTOCOL_MINOR,
  runnerHeaders,
  runnerPaths,
  snapshotCredentialsResponseSchema,
  taskCredentialsResponseSchema,
  taskSpecResponseSchema,
  taskTokenResponseSchema,
  pullCredentialResponseSchema,
  pushCredentialResponseSchema,
  registryCredentialRefusalSchema,
} from "@ostra/protocol";
import type {
  BlobRef,
  LeaseEpoch,
  MemoryNoteResponse,
  MemoryProposalRequest,
  MemoryProposalResponse,
  MemorySearchRequest,
  MemorySearchResponse,
  NoteId,
  ServiceSecrets,
  SnapshotCredentials,
  SnapshotId,
  RegistryCredential,
  TaskCredentials,
  TaskId,
  TaskSpec,
} from "@ostra/protocol";
import type { RunnerConnection, SessionChannel, SessionRef } from "../connection/peer.ts";
import { createBulkClient } from "../server/bulk.ts";
import type { BulkResult, DownloadInput, Downloaded, UploadInput } from "../server/bulk.ts";
import { callJson, describeFailure, joinUrl } from "../server/http.ts";
import type { TokenSource } from "../connection/peer.ts";
import type { z } from "zod";

// How the task host talks to the server (ADR 0029, ticket 21): the same code runs a task on every
// executor, and only this link differs. On `host` it's the runner's own connection plus its HTTP
// calls with the runner's access token; in a `docker` box's sidecar it's the sidecar's own
// connection, with a token for its one task (ticket 22).

export type LinkFailure =
  /** The lease epoch is behind the task's: the task moved on (ADR 0034). */
  | { readonly kind: "stale-lease"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };

export type LinkResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: LinkFailure };

/**
 * Milestone 4 (ticket 20, ADR 0044): a memory call's failure. `refused` is core's answer, in its own
 * words, which the tool hands the agent; `unavailable` is a network failure, a timeout or a server
 * error. Neither carries a query or a note's text.
 */
export type MemoryCallFailure = { readonly kind: "refused"; readonly status: number; readonly message: string } | { readonly kind: "unavailable" };

export type MemoryCallResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: MemoryCallFailure };

/**
 * Milestone 4 (ticket 20): the sidecar's memory endpoints on core (`/runner/v1/tasks/:taskId/memory/*`),
 * with the link's own token: the runner's on `host`, the box's task token in a sidecar. The token
 * stays in the runner's memory; the agent's MCP bearer never reaches core.
 */
export type MemoryLink = {
  readonly search: (taskId: TaskId, request: MemorySearchRequest) => Promise<MemoryCallResult<MemorySearchResponse>>;
  readonly read: (taskId: TaskId, noteId: NoteId) => Promise<MemoryCallResult<MemoryNoteResponse>>;
  readonly propose: (taskId: TaskId, request: MemoryProposalRequest) => Promise<MemoryCallResult<MemoryProposalResponse>>;
};

export type ServerLink = {
  readonly fetchSpec: (taskId: TaskId, leaseEpoch: LeaseEpoch) => Promise<LinkResult<TaskSpec>>;
  /** The task's credentials, after the server checks the lease. Held in memory only. */
  readonly fetchCredentials: (taskId: TaskId, leaseEpoch: LeaseEpoch) => Promise<LinkResult<TaskCredentials>>;
  readonly openSession: (ref: SessionRef) => Promise<SessionChannel>;
  readonly statusChanged: () => void;
  /** Minor 1, the bulk path (ADR 0043): a blob of the task up, in resumable chunks with its digest. */
  readonly uploadBlob: (input: UploadInput) => Promise<BulkResult<BlobRef>>;
  /** Minor 1, the bulk path: a blob of the task down. The caller checks its digest. */
  readonly downloadBlob: (input: DownloadInput) => Promise<BulkResult<Downloaded>>;
  /** Minor 3 (milestone 4): the memory tools' calls, on behalf of the task. */
  readonly memory: MemoryLink;
};

/** How long a memory call may take before the tool says memory is unavailable. */
const MEMORY_TIMEOUT_MS = 15_000;

const memoryFailureOf = (failure: Parameters<typeof describeFailure>[0]): MemoryCallFailure => {
  if (failure.kind === "refused" && failure.status >= 400 && failure.status < 500) {
    const message =
      failure.error?.message ??
      (failure.status === 404 ? "There's no approved memory note with that ID." : `Memory refused the call (status ${String(failure.status)}).`);
    return { kind: "refused", status: failure.status, message: message.slice(0, 500) };
  }
  return { kind: "unavailable" };
};

const failureOf = (failure: Parameters<typeof describeFailure>[0]): LinkFailure =>
  failure.kind === "refused" && failure.status === 409
    ? { kind: "stale-lease", message: "the server says the lease epoch is stale" }
    : { kind: "unavailable", message: describeFailure(failure) };

/**
 * The task token a `docker` or `kubernetes` box's sidecar connects with (ADR 0034, Q129), asked with
 * the runner's own access token. Never logged.
 */
export const fetchTaskToken =
  (input: { readonly serverUrl: string; readonly tokens: TokenSource }) =>
  async (taskId: TaskId, leaseEpoch: LeaseEpoch): Promise<LinkResult<string>> => {
    const token = await input.tokens.get();
    if (!token.ok) {
      return { ok: false, failure: { kind: "unavailable", message: token.message } };
    }
    const result = await callJson({
      url: joinUrl(input.serverUrl, runnerPaths.taskToken(taskId)),
      method: "POST",
      schema: taskTokenResponseSchema,
      body: { leaseEpoch },
      bearer: token.token,
      timeoutMs: 30_000,
    });
    return result.ok ? { ok: true, value: result.value.taskToken } : { ok: false, failure: failureOf(result.failure) };
  };

/** Core's `409` code on a registry credential request, when its body says one. */
const registryRefusalOf = (failure: Parameters<typeof describeFailure>[0]): string | null => {
  if (failure.kind !== "refused" || failure.status !== 409) {
    return null;
  }
  const parsed = registryCredentialRefusalSchema.safeParse(failure.body);
  return parsed.success ? parsed.data.error.code : null;
};

/**
 * Milestone 5 (F-120, ADR 0060): the pull credential for the lease's registry image, asked with the
 * runner's own access token. `null` when core has none to give (`no-image`: the registry is pulled
 * with the cluster's own identity, `node` auth). The runner hands it to its engine's pull or the
 * box's pull secret, and keeps it nowhere. Never logged.
 */
export const fetchPullCredential =
  (input: { readonly serverUrl: string; readonly tokens: TokenSource }) =>
  async (taskId: TaskId, leaseEpoch: LeaseEpoch): Promise<LinkResult<RegistryCredential | null>> => {
    const token = await input.tokens.get();
    if (!token.ok) {
      return { ok: false, failure: { kind: "unavailable", message: token.message } };
    }
    const result = await callJson({
      url: joinUrl(input.serverUrl, runnerPaths.taskPullCredential(taskId)),
      method: "POST",
      schema: pullCredentialResponseSchema,
      body: { leaseEpoch },
      bearer: token.token,
      headers: { [runnerHeaders.minor]: String(PROTOCOL_MINOR) },
      timeoutMs: 30_000,
    });
    if (result.ok) {
      return { ok: true, value: result.value };
    }
    return registryRefusalOf(result.failure) === "no-image" ? { ok: true, value: null } : { ok: false, failure: failureOf(result.failure) };
  };

/**
 * Milestone 5 (F-120): the push credential for a snapshot build this runner was given, while it's
 * building. A `409` (`not-the-builder`) means core took the build back. Never logged.
 */
export const fetchPushCredential =
  (input: { readonly serverUrl: string; readonly tokens: TokenSource }) =>
  async (snapshotId: SnapshotId): Promise<LinkResult<RegistryCredential>> => {
    const token = await input.tokens.get();
    if (!token.ok) {
      return { ok: false, failure: { kind: "unavailable", message: token.message } };
    }
    const result = await callJson({
      url: joinUrl(input.serverUrl, runnerPaths.snapshotPushCredential(snapshotId)),
      method: "POST",
      schema: pushCredentialResponseSchema,
      body: {},
      bearer: token.token,
      headers: { [runnerHeaders.minor]: String(PROTOCOL_MINOR) },
      timeoutMs: 30_000,
    });
    return result.ok ? { ok: true, value: result.value } : { ok: false, failure: failureOf(result.failure) };
  };

/**
 * Milestone 3 (F-094): a `docker` box's services' secret variables, which the pool runner sets on
 * each service's container. A boxed lease's credentials go to its task token only (Q129), so the
 * pool runner asks with the task token it fetched for the box's sidecar, before the sidecar starts,
 * and keeps the services' part alone: the rest of the answer is dropped at once. Never logged.
 */
export const fetchServiceSecrets =
  (input: { readonly serverUrl: string }) =>
  async (taskId: TaskId, leaseEpoch: LeaseEpoch, taskToken: string): Promise<LinkResult<readonly ServiceSecrets[]>> => {
    const result = await callJson({
      url: joinUrl(input.serverUrl, runnerPaths.taskCredentials(taskId)),
      method: "POST",
      schema: taskCredentialsResponseSchema,
      body: { taskId, leaseEpoch },
      bearer: taskToken,
      headers: { [runnerHeaders.minor]: String(PROTOCOL_MINOR) },
      timeoutMs: 30_000,
    });
    return result.ok ? { ok: true, value: result.value.services ?? [] } : { ok: false, failure: failureOf(result.failure) };
  };

/**
 * Milestone 3 (F-051): a snapshot build's credentials, a git token per repo and the setup secrets,
 * answered only to the runner the build went to while it builds. Held in memory for the build only.
 */
export const fetchSnapshotCredentials =
  (input: { readonly serverUrl: string; readonly tokens: TokenSource }) =>
  async (snapshotId: SnapshotId): Promise<LinkResult<SnapshotCredentials>> => {
    const token = await input.tokens.get();
    if (!token.ok) {
      return { ok: false, failure: { kind: "unavailable", message: token.message } };
    }
    const result = await callJson({
      url: joinUrl(input.serverUrl, runnerPaths.snapshotCredentials(snapshotId)),
      method: "POST",
      schema: snapshotCredentialsResponseSchema,
      body: { snapshotId },
      bearer: token.token,
      headers: { [runnerHeaders.minor]: String(PROTOCOL_MINOR) },
      timeoutMs: 30_000,
    });
    return result.ok ? { ok: true, value: result.value } : { ok: false, failure: failureOf(result.failure) };
  };

/** The runner's own link: its connection for events, and HTTP with its access token for the rest. */
export const runnerServerLink = (input: {
  readonly serverUrl: string;
  readonly tokens: TokenSource;
  readonly connection: Pick<RunnerConnection, "openSession" | "statusChanged">;
}): ServerLink => {
  const bearer = async (): Promise<{ readonly ok: true; readonly token: string } | { readonly ok: false; readonly failure: LinkFailure }> => {
    const token = await input.tokens.get();
    return token.ok ? { ok: true, token: token.token } : { ok: false, failure: { kind: "unavailable", message: token.message } };
  };
  const bulk = createBulkClient({
    serverUrl: input.serverUrl,
    bearer: async () => {
      const token = await input.tokens.get();
      return token.ok ? { ok: true, token: token.token } : { ok: false, message: token.message };
    },
  });
  return {
    fetchSpec: async (taskId, leaseEpoch) => {
      const token = await bearer();
      if (!token.ok) {
        return token;
      }
      const result = await callJson({
        url: `${joinUrl(input.serverUrl, runnerPaths.taskSpec(taskId))}?leaseEpoch=${String(leaseEpoch)}`,
        method: "GET",
        schema: taskSpecResponseSchema,
        bearer: token.token,
        // The spec in this build's shape. A minor-0 server ignores the header and sends minor 0's,
        // which this minor's schema reads, since every minor-1 field is optional.
        headers: { [runnerHeaders.minor]: String(PROTOCOL_MINOR) },
        timeoutMs: 30_000,
      });
      return result.ok ? { ok: true, value: result.value } : { ok: false, failure: failureOf(result.failure) };
    },
    fetchCredentials: async (taskId, leaseEpoch) => {
      const token = await bearer();
      if (!token.ok) {
        return token;
      }
      const result = await callJson({
        url: joinUrl(input.serverUrl, runnerPaths.taskCredentials(taskId)),
        method: "POST",
        schema: taskCredentialsResponseSchema,
        body: { taskId, leaseEpoch },
        bearer: token.token,
        // Minor 2: the credentials in this build's shape, with the MCP servers' headers. A server
        // below minor 2 ignores the header and answers minor 1's, which this schema reads.
        headers: { [runnerHeaders.minor]: String(PROTOCOL_MINOR) },
        timeoutMs: 30_000,
      });
      return result.ok ? { ok: true, value: result.value } : { ok: false, failure: failureOf(result.failure) };
    },
    openSession: (ref) => input.connection.openSession(ref),
    memory: memoryLink({ serverUrl: input.serverUrl, tokens: input.tokens }),
    uploadBlob: (upload) => bulk.upload(upload),
    downloadBlob: (download) => bulk.download(download),
    statusChanged: () => {
      input.connection.statusChanged();
    },
  };
};

/** The memory endpoints with the link's token (minor 3). Never logs: a query and a note's text stay out. */
export const memoryLink = (input: { readonly serverUrl: string; readonly tokens: TokenSource }): MemoryLink => {
  const call = async <Schema extends z.ZodType>(
    url: string,
    schema: Schema,
    body?: unknown,
  ): Promise<MemoryCallResult<z.infer<Schema>>> => {
    const token = await input.tokens.get();
    if (!token.ok) {
      return { ok: false, failure: { kind: "unavailable" } };
    }
    const result = await callJson({
      url: joinUrl(input.serverUrl, url),
      method: body === undefined ? "GET" : "POST",
      schema,
      ...(body === undefined ? {} : { body }),
      bearer: token.token,
      headers: { [runnerHeaders.minor]: String(PROTOCOL_MINOR) },
      timeoutMs: MEMORY_TIMEOUT_MS,
    });
    return result.ok ? { ok: true, value: result.value } : { ok: false, failure: memoryFailureOf(result.failure) };
  };
  return {
    search: (taskId, request) => call(runnerPaths.taskMemorySearch(taskId), memorySearchResponseSchema, request),
    read: (taskId, noteId) => call(runnerPaths.taskMemoryNote(taskId, noteId), memoryNoteResponseSchema),
    propose: (taskId, request) => call(runnerPaths.taskMemoryProposals(taskId), memoryProposalResponseSchema, request),
  };
};
