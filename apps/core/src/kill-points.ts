// Named kill points (ticket 21, F-043): the places a server killed mid-flight must lose nothing.
// Each is a no-op unless the restart harness armed it in a test process of core
// (`src/testing/restart-child.ts`); armed, the process ends itself with SIGKILL right there, as a
// crash or an operator's `kill -9` would, with no cleanup. A production server never arms one.

export const killPointNames = [
  /** Inside an `events` frame's transaction, before it commits. */
  "ingest.batch-open",
  /** After the batch committed, before the acks go to the runner. */
  "ingest.batch-committed",
  /** A `dispatch` committed to the outbox, before the runner acked it. */
  "dispatch.offered",
  /** Inside `webhook.process`, after its handler acted and before the delivery is marked. */
  "webhook.process",
  /** Inside `ticket.sync`, after the tracker answered and before the write is recorded done. */
  "ticket.sync.answered",
  /** Inside `task.open-pull-requests`, after GitHub opened the PR and before its row records it. */
  "open-pull-requests.answered",
] as const;

export type KillPointName = (typeof killPointNames)[number];

let armed: KillPointName | null = null;

/** Arms one kill point for this process. The harness's child process only. */
export const armKillPoint = (name: KillPointName | null): void => {
  armed = name;
};

export const isKillPointName = (value: string): value is KillPointName => killPointNames.some((name) => name === value);

/** Ends the process here, at once, when this point is the armed one. */
export const killPoint = (name: KillPointName): void => {
  if (armed === name) {
    process.kill(process.pid, "SIGKILL");
  }
};
