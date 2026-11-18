// Newline-delimited JSON frames over a byte stream, with a size limit. Each
// side validates every frame against its schema before acting on it.

import type { z } from "zod";
import { MAX_FRAME_BYTES } from "./protocol.ts";

export type LineSplitter = {
  /** Feeds bytes; returns the complete lines they finish. Throws on an oversized line. */
  readonly push: (chunk: Buffer) => string[];
};

export const createLineSplitter = (maxBytes = MAX_FRAME_BYTES): LineSplitter => {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  return {
    push: (chunk) => {
      const lines: string[] = [];
      let start = 0;
      for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, start)) {
        pending.push(chunk.subarray(start, i));
        const line = Buffer.concat(pending).toString("utf8");
        pending = [];
        pendingBytes = 0;
        if (line.length > 0) lines.push(line);
        start = i + 1;
      }
      if (start < chunk.length) {
        const rest = chunk.subarray(start);
        pendingBytes += rest.length;
        if (pendingBytes > maxBytes) throw new Error(`frame longer than ${String(maxBytes)} bytes`);
        pending.push(rest);
      }
      return lines;
    },
  };
};

export const encodeFrame = (frame: unknown): string => `${JSON.stringify(frame)}\n`;

export type ParsedFrame<T> = { readonly ok: true; readonly frame: T } | { readonly ok: false; readonly reason: string };

/** Parses one line against a schema. Never echoes the line's content in the reason. */
export const parseFrame = <T,>(schema: z.ZodType<T>, line: string): ParsedFrame<T> => {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, reason: "not JSON" };
  }
  const result = schema.safeParse(raw);
  if (!result.success) return { ok: false, reason: `invalid frame: ${result.error.issues.map((i) => `${i.path.join(".")} ${i.code}`).join("; ")}` };
  return { ok: true, frame: result.data };
};

/** Splits a buffer into base64 chunks of at most `size` source bytes. */
export const toBase64Chunks = (data: Buffer, size: number): string[] => {
  const out: string[] = [];
  for (let offset = 0; offset < data.length; offset += size) out.push(data.subarray(offset, offset + size).toString("base64"));
  return out;
};
