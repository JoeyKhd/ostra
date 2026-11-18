import type { IncomingMessage, ServerResponse } from "node:http";

import { parseJson } from "@ostra/protocol";
import type { RunnerHttpError } from "@ostra/protocol";

// Small HTTP helpers for core's endpoints. A body is read up to a cap and for at most 10 s, so a
// slow or partial body can't hold a connection (ported from spikes/runner-transport's replica).

const BODY_TIMEOUT_MS = 10_000;

export type BodyRead = { readonly ok: true; readonly value: unknown; readonly raw: Buffer } | { readonly ok: false; readonly reason: "too-large" | "not-json" | "timeout" };

/** Reads a request's body as bytes, up to `cap`. */
export const readBody = (request: IncomingMessage, cap: number): Promise<Buffer | "too-large" | "timeout"> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (value: Buffer | "too-large" | "timeout"): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      settle("timeout");
      request.destroy();
    }, BODY_TIMEOUT_MS);
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > cap) {
        settle("too-large");
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      settle(Buffer.concat(chunks));
    });
    request.on("error", () => {
      settle("timeout");
    });
  });

/** Reads a JSON body, up to `cap` bytes. */
export const readJsonBody = async (request: IncomingMessage, cap = 64 * 1024): Promise<BodyRead> => {
  const raw = await readBody(request, cap);
  if (raw === "too-large" || raw === "timeout") {
    return { ok: false, reason: raw };
  }
  const json = parseJson(raw.toString("utf8"));
  return json.ok ? { ok: true, value: json.value, raw } : { ok: false, reason: "not-json" };
};

export const sendJson = (response: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void => {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(text)),
    "cache-control": "no-store",
    ...headers,
  });
  response.end(text);
};

export type ErrorCode = RunnerHttpError["error"]["code"];

/** A runner endpoint's error body (`runnerHttpErrorSchema`). The message never holds content. */
export const sendError = (
  response: ServerResponse,
  status: number,
  code: ErrorCode,
  message: string,
  extra: { readonly currentEpoch?: number } = {},
): void => {
  const body: RunnerHttpError = { error: { code, message, ...extra } };
  sendJson(response, status, body);
};
