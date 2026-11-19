import { cliDeviceTokenErrorSchema, cliHttpErrorSchema } from "@ostra/protocol";
import { z } from "zod";

// The CLI's calls to the web app (F-103, ADR 0051). The token goes as a bearer and nowhere else;
// a refusal comes back with the server's own words, which the CLI prints as they are.

export type CliHttpResult<T> =
  | { readonly ok: true; readonly status: number; readonly value: T }
  /** The server answered with an error body: its code and words. */
  | { readonly ok: false; readonly kind: "refused"; readonly status: number; readonly code: string; readonly message: string }
  /** No answer, or one the CLI can't read. */
  | { readonly ok: false; readonly kind: "unreachable"; readonly message: string };

export type CliRequest = {
  readonly serverUrl: string;
  readonly path: string;
  readonly method: "GET" | "POST" | "DELETE";
  readonly token?: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
};

/** Calls the server and reads the answer with `schema`; an error body is read with the CLI's error schema. */
export const cliRequest = async <S extends z.ZodType>(request: CliRequest, schema: S, okStatuses: readonly number[] = [200]): Promise<CliHttpResult<z.infer<S>>> => {
  const url = new URL(request.path, request.serverUrl);
  const host = url.host;
  let response: Response;
  try {
    response = await fetch(url, {
      method: request.method,
      headers: {
        accept: "application/json",
        ...(request.body === undefined ? {} : { "content-type": "application/json" }),
        ...(request.token === undefined ? {} : { authorization: `Bearer ${request.token}` }),
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal: request.signal ?? AbortSignal.timeout(30_000),
    });
  } catch {
    return { ok: false, kind: "unreachable", message: `couldn't reach ${host}` };
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { ok: false, kind: "unreachable", message: `${host} answered ${String(response.status)} with something that isn't JSON` };
  }
  if (okStatuses.includes(response.status)) {
    const parsed = schema.safeParse(json);
    return parsed.success
      ? { ok: true, status: response.status, value: parsed.data }
      : { ok: false, kind: "unreachable", message: `${host} answered in a shape this CLI doesn't know` };
  }
  // Every endpoint's error body, and the device grant's own codes (RFC 8628) while it waits.
  const error = z.union([cliHttpErrorSchema, cliDeviceTokenErrorSchema]).safeParse(json);
  if (error.success) {
    return { ok: false, kind: "refused", status: response.status, code: error.data.error.code, message: error.data.error.message };
  }
  return { ok: false, kind: "refused", status: response.status, code: "unknown", message: `${host} answered ${String(response.status)}` };
};
