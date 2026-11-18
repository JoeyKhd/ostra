import { z } from "zod";

import { boxIdSchema, runnerIdSchema, taskIdSchema } from "../ids.ts";
import { leaseEpochSchema } from "../common.ts";

// Who is on the other end of a runner protocol session (ADR 0034, ADR 0029).
//
// - `runner`: a pool or personal runner. On the `host` executor it also does the sidecar's work,
//   so it's the only peer there.
// - `sidecar`: a `docker` or `kubernetes` box's sidecar, which connects itself with a token for one
//   task, tied to the lease. It carries that one task's events and commands.
//
// `hello` is the one message that tolerates unknown fields, so these are loose objects.

export const runnerPeerSchema = z.looseObject({
  kind: z.literal("runner"),
  runnerId: runnerIdSchema,
});

export const sidecarPeerSchema = z.looseObject({
  kind: z.literal("sidecar"),
  taskId: taskIdSchema,
  boxId: boxIdSchema,
  leaseEpoch: leaseEpochSchema,
});

export const peerSchema = z.discriminatedUnion("kind", [runnerPeerSchema, sidecarPeerSchema]);
export type Peer = z.infer<typeof peerSchema>;
export type PeerKind = Peer["kind"];
