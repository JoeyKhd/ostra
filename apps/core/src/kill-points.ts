import { writeSync } from "node:fs";

// Named kill points (ticket 21, F-043): the places a server killed mid-flight must lose nothing.
// Each is a no-op unless the restart harness armed it in a test process of core
// (`src/testing/restart-child.ts`); armed, the process ends itself with SIGKILL right there, as a
// crash or an operator's `kill -9` would, with no cleanup. A production server never arms one.
//
// Ticket 37's schedule hunt arms a point for its Nth pass (`afterHits`), so the kill lands in the
// middle of a tick's work, and reads the one line the process prints on stdout as it dies,
// `{ "killPoint": <name>, "hit": <n> }`, to kill the other replicas at that moment.

export const killPointNames = [
  /** Inside an `events` frame's transaction, before it commits. */
  "ingest.batch-open",
  /** After the batch committed, before the acks go to the runner. */
  "ingest.batch-committed",
  /** A `dispatch` committed to the outbox, before the runner acked it. */
  "dispatch.offered",
  /** Inside `webhook.process`, after its handler acted and before the delivery is marked. */
  "webhook.process",
  /** Inside `ticket.sync`, before the tracker is called (ticket 38: spike 8's first kill point). */
  "ticket.sync.before",
  /** Inside `ticket.sync`, after the tracker answered and before the write is recorded done. */
  "ticket.sync.answered",
  /** Inside `task.open-pull-requests`, before GitHub is called (ticket 38: spike 8's first kill point). */
  "open-pull-requests.before",
  /** Inside `task.open-pull-requests`, after GitHub opened the PR and before its row records it. */
  "open-pull-requests.answered",
  /** Inside a schedule's tick transaction: its occurrence, its job and its next time written, before it commits (ticket 37). */
  "scheduler.tick-written",
  /** Inside `automation.occurrence`'s transaction: the task started and recorded, before it commits (ticket 37). */
  "automation.occurrence-started",
  /** After `automation.occurrence` committed, before its job completes (ticket 37). */
  "automation.occurrence-committed",
] as const;

export type KillPointName = (typeof killPointNames)[number];

let armed: KillPointName | null = null;
let killOnHit = 1;
let hits = 0;

/** Arms one kill point for this process, for its `afterHits`th pass (the first by default). The harness's child process only. */
export const armKillPoint = (name: KillPointName | null, afterHits = 1): void => {
  armed = name;
  killOnHit = Math.max(1, Math.floor(afterHits));
  hits = 0;
};

export const isKillPointName = (value: string): value is KillPointName => killPointNames.some((name) => name === value);

/** Ends the process here, at once, when this point is the armed one and this is the pass it was armed for. */
export const killPoint = (name: KillPointName): void => {
  if (armed !== name) {
    return;
  }
  hits += 1;
  if (hits < killOnHit) {
    return;
  }
  // Written synchronously, so the line is out before the process is gone.
  try {
    // eslint-disable-next-line no-restricted-syntax -- the process ends on the next line: nothing waits on this write but the line itself
    writeSync(1, `${JSON.stringify({ killPoint: name, hit: hits })}\n`);
  } catch {
    // Nobody reads it: the kill still happens.
  }
  process.kill(process.pid, "SIGKILL");
};
