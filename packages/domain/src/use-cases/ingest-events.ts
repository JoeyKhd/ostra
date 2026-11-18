import type { Tx } from "@ostra/db";
import { runnerEventSchema, runnerIdSchema } from "@ostra/protocol";
import type { LeaseEpoch, SessionId, SessionSeq, TaskId, TaskSeq } from "@ostra/protocol";
import { z } from "zod";

import type { Ports } from "../ports.ts";
import { notImplemented } from "./common.ts";

// ADR 0034, ADR 0035, F-045: one `events` frame, saved in one transaction. Idempotent on
// `(sessionId, sessionSeq)`; numbered per task under a share lock on the task row (so a grace sweep
// can't interleave); the lease epoch checked; reactions enqueued (`task.session-ended` for a
// `session.ended`); acked per session only after the commit. A batch that doesn't start at the
// session's cursor plus one gets `resendFrom`. A stale epoch is refused, never quarantined (Q111).
// Written by ticket 25.

export const ingestEventsInputSchema = z.strictObject({
  runnerId: runnerIdSchema,
  events: z.array(runnerEventSchema).min(1),
});
export type IngestEventsInput = z.infer<typeof ingestEventsInputSchema>;

/** One session's outcome, which becomes its `ack` or `error` frame. */
export type SessionIngestOutcome =
  | {
      readonly kind: "saved";
      readonly sessionId: SessionId;
      readonly taskId: TaskId;
      /** The highest session number now saved. */
      readonly upTo: SessionSeq;
      /** The newest task number given, for the wake-up NOTIFY. */
      readonly headSeq: TaskSeq;
      readonly duplicates: number;
    }
  | { readonly kind: "gap"; readonly sessionId: SessionId; readonly upTo: number; readonly resendFrom: SessionSeq }
  | { readonly kind: "stale-lease"; readonly sessionId: SessionId; readonly currentEpoch: LeaseEpoch }
  | { readonly kind: "unknown-session"; readonly sessionId: SessionId };

export type IngestEventsResult = { readonly outcomes: readonly SessionIngestOutcome[] };

export type IngestEventsDeps = Pick<Ports, "jobs" | "notices" | "clock"> & { readonly tx: Tx };

export type IngestEvents = (deps: IngestEventsDeps, input: IngestEventsInput) => Promise<IngestEventsResult>;

export const ingestEvents: IngestEvents = () => notImplemented("25");
