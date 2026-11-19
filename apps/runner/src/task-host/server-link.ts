import {
  PROTOCOL_MINOR,
  runnerHeaders,
  runnerPaths,
  taskCredentialsResponseSchema,
  taskSpecResponseSchema,
} from "@ostra/protocol";
import type { LeaseEpoch, TaskCredentials, TaskId, TaskSpec } from "@ostra/protocol";
import type { RunnerConnection, SessionChannel, SessionRef } from "../connection/peer.ts";
import { callJson, describeFailure, joinUrl } from "../server/http.ts";
import type { TokenSource } from "../connection/peer.ts";

// How the task host talks to the server (ADR 0029, ticket 21): the same code runs a task on every
// executor, and only this link differs. On `host` it's the runner's own connection plus its HTTP
// calls with the runner's access token; in a `docker` box's sidecar it's the sidecar's own
// connection, with a token for its one task (ticket 22).

export type LinkFailure =
  /** The lease epoch is behind the task's: the task moved on (ADR 0034). */
  | { readonly kind: "stale-lease"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };

export type LinkResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: LinkFailure };

export type ServerLink = {
  readonly fetchSpec: (taskId: TaskId, leaseEpoch: LeaseEpoch) => Promise<LinkResult<TaskSpec>>;
  /** The task's credentials, after the server checks the lease. Held in memory only. */
  readonly fetchCredentials: (taskId: TaskId, leaseEpoch: LeaseEpoch) => Promise<LinkResult<TaskCredentials>>;
  readonly openSession: (ref: SessionRef) => Promise<SessionChannel>;
  readonly statusChanged: () => void;
};

const failureOf = (failure: Parameters<typeof describeFailure>[0]): LinkFailure =>
  failure.kind === "refused" && failure.status === 409
    ? { kind: "stale-lease", message: "the server says the lease epoch is stale" }
    : { kind: "unavailable", message: describeFailure(failure) };

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
        timeoutMs: 30_000,
      });
      return result.ok ? { ok: true, value: result.value } : { ok: false, failure: failureOf(result.failure) };
    },
    openSession: (ref) => input.connection.openSession(ref),
    statusChanged: () => {
      input.connection.statusChanged();
    },
  };
};
