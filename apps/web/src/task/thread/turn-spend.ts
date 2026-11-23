import { turnIdSchema } from "@ostra/protocol";
import type { StoredEvent, TurnId } from "@ostra/protocol";
import type { PricedTurn } from "@ostra/task-view";

// Owner: ticket 09 (milestone 10, F-151). `tasks.get`'s `usage.turns` priced in core, matched to the
// log's turns for the fold's `turnSpend` and `turnOrdinals`. Core's turn rows have IDs of their own
// (not the agent's `turnId`), so each row is matched to its `turn.started` by its session and its
// start time, which ingest copies from the event. Pure.

/** One turn as `tasks.get`'s `usage.turns` gives it, as far as the fold's figures need. */
export type UsageTurn = {
  readonly turnId: string;
  readonly sessionId: string;
  /** When it started, in ms since the epoch: its `turn.started`'s `at`. */
  readonly startedAt: number;
  readonly spentMicroUsd: number | null;
  readonly estimated: boolean;
};

const keyOf = (sessionId: string, at: number): string => `${sessionId}:${String(at)}`;

/**
 * Every turn of the task, priced, by the log's turn ID where the log holds its start: a page of
 * history that starts later keeps the turns before it, under their rows' IDs, so the numbers count
 * from the task's first turn (`turnOrdinalsOf`) and only the log's turns carry a spend.
 */
export const pricedTurnsOf = (events: readonly StoredEvent[], turns: readonly UsageTurn[]): PricedTurn[] => {
  const started = new Map<string, TurnId>();
  for (const { sessionId, at, event } of events) {
    if (event.kind === "turn.started") started.set(keyOf(sessionId, at), event.turnId);
  }
  return turns.map((turn) => ({
    turnId: started.get(keyOf(turn.sessionId, turn.startedAt)) ?? turnIdSchema.parse(turn.turnId),
    startedAt: turn.startedAt,
    spentMicroUsd: turn.spentMicroUsd,
    estimated: turn.estimated,
  }));
};
