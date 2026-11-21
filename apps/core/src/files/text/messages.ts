import { z } from "zod";

import type { DocumentKind } from "./kinds.ts";
import type { TextReadLimits } from "./limits.ts";
import { textFailureReasons } from "./result.ts";
import type { ExtractedText } from "./result.ts";

// What the pool and its text workers say to each other (F-150). A worker reads untrusted documents,
// so the pool checks each answer before trusting it; the worker imports only these types.

/** The pool asks a worker to read one document. The bytes are the worker's own copy, moved to it. */
export type WorkerRequest = {
  readonly type: "read";
  readonly id: number;
  readonly bytes: Uint8Array;
  readonly kind: DocumentKind;
  /** The file's safe name, for the text's first line. Never logged. */
  readonly name: string;
  readonly limits: TextReadLimits;
};

/** A worker is ready, or answers one read: the text or the reason, and how many network calls it refused meanwhile. */
export type WorkerAnswer =
  | { readonly type: "ready" }
  | { readonly type: "result"; readonly id: number; readonly result: ExtractedText; readonly refusedCalls: number };

export const extractedTextSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("ready"), markdown: z.string(), words: z.number().int().nonnegative(), truncated: z.boolean() }),
  z.strictObject({ state: z.literal("failed"), reason: z.enum(textFailureReasons) }),
]);

export const workerAnswerSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ready") }),
  z.strictObject({ type: z.literal("result"), id: z.number().int().positive(), result: extractedTextSchema, refusedCalls: z.number().int().nonnegative() }),
]);

// The schema reads exactly what the worker sends.
workerAnswerSchema satisfies z.ZodType<WorkerAnswer>;
