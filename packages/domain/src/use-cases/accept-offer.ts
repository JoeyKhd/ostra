import type { Tx } from "@ostra/db";
import { commandIdSchema, commandResultSchema, commandSeqSchema, runnerIdSchema } from "@ostra/protocol";
import { z } from "zod";

import type { Ports } from "../ports.ts";
import { notImplemented } from "./common.ts";
import type { UseCaseResult } from "./common.ts";

// ADR 0034: a runner's answer to a dispatch offer, from its `command-ack`. `accepted` makes the lease
// accepted and the task `preparing`; `rejected` ends the lease and requeues the task. An answer to a
// stale offer (a newer epoch exists, or the offer timed out) changes nothing. Written by ticket 26.

export const acceptOfferInputSchema = z.strictObject({
  runnerId: runnerIdSchema,
  commandId: commandIdSchema,
  seq: commandSeqSchema,
  result: commandResultSchema,
});
export type AcceptOfferInput = z.infer<typeof acceptOfferInputSchema>;

export type AcceptOfferResult = UseCaseResult<
  { readonly outcome: "accepted" | "requeued" },
  "unknown-command" | "not-a-dispatch" | "stale"
>;

export type AcceptOfferDeps = Pick<Ports, "jobs" | "notices" | "clock"> & { readonly tx: Tx };

export type AcceptOffer = (deps: AcceptOfferDeps, input: AcceptOfferInput) => Promise<AcceptOfferResult>;

export const acceptOffer: AcceptOffer = () => notImplemented("26");
