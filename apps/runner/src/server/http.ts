import { parseJson, runnerHttpErrorSchema, describeIssues } from "@ostra/protocol";
import type { RunnerHttpError } from "@ostra/protocol";
import type { z } from "zod";
import { userAgent } from "../version.ts";

// One JSON call from the CLI to the ostra server (core or the panel). Every answer is external
// data: it's parsed with its Zod schema here, and the rest of the CLI trusts the inferred type
// (AGENTS.md, Code). Failures are values. Nothing here logs: a caller logs IDs and status only.

export type CallFailure =
  /** The server couldn't be reached, or didn't answer in time. */
  | { readonly kind: "network"; readonly message: string }
  /** The server answered with an error status. `error` is set when the body is ostra's error shape. */
  | { readonly kind: "refused"; readonly status: number; readonly error: RunnerHttpError["error"] | null; readonly body: unknown }
  /** The server answered 2xx with a body its schema refuses. `detail` names paths, never values. */
  | { readonly kind: "invalid-response"; readonly status: number; readonly detail: string };

export type CallResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: CallFailure };

export type CallInput<Schema extends z.ZodType> = {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly schema: Schema;
  /** Sent as JSON. */
  readonly body?: unknown;
  /** Sent as `Authorization: Bearer <token>`. Never logged. */
  readonly bearer?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
};

const DEFAULT_TIMEOUT_MS = 15_000;

const describeNetworkError = (error: unknown): string => {
  if (error instanceof Error) {
    const cause: unknown = error.cause;
    if (typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string") {
      return `${error.name}: ${cause.code}`;
    }
    return error.name === "TimeoutError" ? "the server didn't answer in time" : error.name;
  }
  return "unknown error";
};

/** Calls the server and parses its JSON answer. Never throws. */
export const callJson = async <Schema extends z.ZodType>(input: CallInput<Schema>): Promise<CallResult<z.infer<Schema>>> => {
  const headers: Record<string, string> = { "user-agent": userAgent(), accept: "application/json" };
  if (input.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (input.bearer !== undefined) {
    headers["authorization"] = `Bearer ${input.bearer}`;
  }
  const timeout = AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(input.url, {
      method: input.method,
      headers,
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: input.signal === undefined ? timeout : AbortSignal.any([timeout, input.signal]),
      redirect: "error",
    });
  } catch (error) {
    return { ok: false, failure: { kind: "network", message: describeNetworkError(error) } };
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    return { ok: false, failure: { kind: "network", message: describeNetworkError(error) } };
  }
  const json = parseJson(text);
  const body: unknown = json.ok ? json.value : null;
  if (!response.ok) {
    const parsed = runnerHttpErrorSchema.safeParse(body);
    return {
      ok: false,
      failure: { kind: "refused", status: response.status, error: parsed.success ? parsed.data.error : null, body },
    };
  }
  if (!json.ok) {
    return { ok: false, failure: { kind: "invalid-response", status: response.status, detail: "the body is not JSON" } };
  }
  const parsed = input.schema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      failure: { kind: "invalid-response", status: response.status, detail: describeIssues(parsed.error) },
    };
  }
  return { ok: true, value: parsed.data };
};

/** A failure as a sentence for the person at the terminal. Holds statuses and codes, never a body. */
export const describeFailure = (failure: CallFailure): string => {
  switch (failure.kind) {
    case "network":
      return `couldn't reach the server (${failure.message})`;
    case "refused":
      return failure.error === null
        ? `the server answered ${String(failure.status)}`
        : `the server answered ${String(failure.status)} ${failure.error.code}: ${failure.error.message}`;
    case "invalid-response":
      return `the server's answer wasn't what this runner expects (${failure.detail})`;
    default:
      return failure satisfies never;
  }
};

/** Joins a base URL and an absolute path, keeping the base's own path. */
export const joinUrl = (base: string, path: string): string => `${base.replace(/\/+$/, "")}${path}`;
