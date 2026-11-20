import type { DbEnum } from "@ostra/db";
import type { RoundKind } from "@ostra/protocol";

import type { RoundVerdict } from "../lifecycles/m6.ts";

// The rounds and their caps (F-035, F-101, F-105; ADR 0041, ADR 0058, Q224). A CI round and a
// findings round are automatic turns: the coding agent's turns no person asked for. Each kind has
// its own cap, and together they have one more; all three counters run since a person last acted
// (a message, a reopen, an answer, "Keep working", "Fix this", a "changes requested" review), so
// "at most 4 automatic turns before a person has to act" means exactly that. A "changes requested"
// round is a person's action: no cap applies, and it resets the counters.

export type TaskRoundKind = DbEnum.RoundKind;

/** The task's counters, as its columns hold them. */
export type RoundCounters = { readonly ciRounds: number; readonly reviewRounds: number; readonly automaticTurns: number };

/** `OSTRA_CI_ROUNDS`, `OSTRA_REVIEW_ROUNDS` and `OSTRA_AUTOMATIC_TURNS`. */
export type RoundLimits = { readonly ciRounds: number; readonly reviewRounds: number; readonly automaticTurns: number };

/** The working values. */
export const DEFAULT_ROUND_LIMITS: RoundLimits = { ciRounds: 2, reviewRounds: 2, automaticTurns: 4 };

export const NO_ROUNDS: RoundCounters = { ciRounds: 0, reviewRounds: 0, automaticTurns: 0 };

/** Whether one more round of the kind may start, or which cap stops it (and the task needs you). */
export const roundAllowed = (task: RoundCounters, kind: TaskRoundKind, limits: RoundLimits = DEFAULT_ROUND_LIMITS): RoundVerdict => {
  switch (kind) {
    case "changes_requested":
      return { kind: "allowed" };
    case "ci":
      if (task.ciRounds >= limits.ciRounds) {
        return { kind: "capped", reason: "rounds" };
      }
      break;
    case "findings":
      if (task.reviewRounds >= limits.reviewRounds) {
        return { kind: "capped", reason: "rounds" };
      }
      break;
    default:
      return kind satisfies never;
  }
  return task.automaticTurns >= limits.automaticTurns ? { kind: "capped", reason: "automatic-turns" } : { kind: "allowed" };
};

/** The counters after a round of the kind starts. A "changes requested" round is a person's action. */
export const countRound = (task: RoundCounters, kind: TaskRoundKind): RoundCounters => {
  switch (kind) {
    case "ci":
      return { ciRounds: task.ciRounds + 1, reviewRounds: task.reviewRounds, automaticTurns: task.automaticTurns + 1 };
    case "findings":
      return { ciRounds: task.ciRounds, reviewRounds: task.reviewRounds + 1, automaticTurns: task.automaticTurns + 1 };
    case "changes_requested":
      return resetOnPersonAction();
    default:
      return kind satisfies never;
  }
};

/** What a person's action does to the counters: they start again from nothing. */
export const resetOnPersonAction = (): RoundCounters => NO_ROUNDS;

/** The actions that count as a person acting on a task (ADR 0058). */
export const personActions = ["message", "reopen", "answer", "keep-working", "fix-this", "changes-requested"] as const;
export type PersonAction = (typeof personActions)[number];

/** A round's kind as the protocol spells it (`round.started`), and as the schema does. */
export const roundKindToDb = { ci: "ci", findings: "findings", "changes-requested": "changes_requested" } as const satisfies Record<RoundKind, TaskRoundKind>;
export const roundKindFromDb = { ci: "ci", findings: "findings", changes_requested: "changes-requested" } as const satisfies Record<TaskRoundKind, RoundKind>;
