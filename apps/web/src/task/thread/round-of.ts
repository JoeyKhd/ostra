import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import type { TaskUIMessage } from "@ostra/task-view";

import type { Limits, TaskRound } from "@/components/tasks/review/review-words";
import { useTRPC } from "@/lib/trpc";

import { useTaskContext } from "../task-context";
import { useThreadParts } from "./thread-context";

// Owner: ticket 12 (milestone 10, F-151: ostra's outlined rounds, parts.md part 2). A CI, findings
// or changes-requested round's message is drawn with its round (`tasks.rounds`, which the task page
// already reads): `CI round 1 of 2`, each failing job with its log, `automatic turn 1 of 4`, and the
// budget's hold inside its bubble. A round's message is written with the round, in one transaction
// (`start-round.ts`; a held round's at its hold), so the round is the one of its kind made nearest
// the message's time.

export type RoundKind = TaskRound["kind"];

/** A round's message, by its intent: `fix-ci`, `fix-findings` and `changes-requested`. */
export const roundKindOf = (intent: string | undefined): RoundKind | null =>
  intent === "fix-ci" ? "ci" : intent === "fix-findings" ? "findings" : intent === "changes-requested" ? "changes-requested" : null;

/** How far from its message a round may have been made and still be its round. */
const SAME_ROUND_MS = 60_000;

/** The round of `kind` made nearest `at` (and not after it by more than a minute), that ran or waits. */
export const roundAt = (rounds: readonly TaskRound[], kind: RoundKind, at: number): TaskRound | null => {
  let best: TaskRound | null = null;
  for (const round of rounds) {
    if (round.kind !== kind || round.state === "capped") continue;
    const gap = Math.abs(round.createdAt - at);
    if (gap > SAME_ROUND_MS) continue;
    if (best === null || gap < Math.abs(best.createdAt - at)) best = round;
  }
  return best;
};

/**
 * `automatic turn {k}`: the round's place among the automatic turns since a person last acted (a
 * member's own message, or a person's round: changes requested on GitHub). The panel's count resets
 * on those (`recordPersonActionInTx`), so the thread counts the same way.
 */
export const automaticTurnOf = (rounds: readonly TaskRound[], round: TaskRound, personBefore: number | null): number | null => {
  if (!round.automatic) return null;
  const since = Math.max(
    personBefore ?? Number.NEGATIVE_INFINITY,
    ...rounds.filter((other) => !other.automatic && other.createdAt <= round.createdAt).map((other) => other.createdAt),
  );
  return rounds.filter((other) => other.automatic && other.state !== "capped" && other.createdAt > since && other.createdAt <= round.createdAt).length;
};

/** The newest message a person wrote before `at`: a member's own, not a round's. `null` with none. */
const personBefore = (messages: Iterable<TaskUIMessage>, at: number): number | null => {
  let latest: number | null = null;
  for (const message of messages) {
    const meta = message.metadata;
    if (message.role !== "user" || meta?.author === undefined || meta.optimistic === true || meta.at === undefined || meta.at >= at) continue;
    if (roundKindOf(meta.author.intent) !== null) continue;
    if (latest === null || meta.at > latest) latest = meta.at;
  }
  return latest;
};

export type RoundView = { readonly round: TaskRound; readonly limits: Limits; readonly automaticTurn: number | null };

/** A round's message's round, once `tasks.rounds` is read; `null` for any other message or a review task. */
export const useRoundOf = (message: TaskUIMessage): RoundView | null => {
  const trpc = useTRPC();
  const { store } = useTaskContext();
  const { workspace, taskKind } = useThreadParts();
  const meta = message.metadata;
  const kind = roundKindOf(meta?.author?.intent);
  const at = meta?.at ?? null;
  const rounds = useQuery(trpc.tasks.rounds.queryOptions({ taskId: workspace.taskId }, { enabled: kind !== null && taskKind === "code", staleTime: 15_000 }));
  const person = useSyncExternalStore(
    store.subscribe,
    () => (at === null || kind === null ? null : personBefore(store.get().messages.values(), at)),
    () => (at === null || kind === null ? null : personBefore(store.get().messages.values(), at)),
  );
  if (kind === null || at === null || rounds.data === undefined) return null;
  const round = roundAt(rounds.data.rounds, kind, at);
  return round === null ? null : { round, limits: rounds.data.limits, automaticTurn: automaticTurnOf(rounds.data.rounds, round, person) };
};
