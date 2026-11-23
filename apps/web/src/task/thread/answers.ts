import type { ClientMessageId, MemberId, PlanEntry, QuestionId, SessionId, StoredEvent, TaskEventOf, TurnId } from "@ostra/protocol";

// Owner: ticket 12 (milestone 10, F-151: receipts and dividers, parts.md part 12). What a member
// answered, read once from the task's log, so each answer's receipt stands in one place: the plan
// turn's receipt (`Plan approved by Alex Kim, with edits · Show the plan`), the build turn's and a
// new plan turn's markers, a question's time, and a late answer (sent as a reopen, once the box was
// gone), whose receipt stands in its message's place instead of a bubble and of its turn's receipt.
// The fold draws nothing for `plan.proposed` and `plan.answered` (the plan is `tasks.get`'s), so
// this pure read of the same log is the thread's one source for them. Content stays data: the
// entries are drawn as text, never HTML.

/** A plan as the driver answered it, by the turn that proposed it. */
export type PlanAnswer = {
  /** The plan turn that proposed it. */
  readonly turnId: TurnId;
  readonly decision: "approve" | "revise";
  readonly by: MemberId;
  readonly at: number;
  /** The plan as approved (the proposal's entries when the answer named none); empty for a revision. */
  readonly entries: readonly PlanEntry[];
  /** Each approved entry the driver changed or added (no entry of the proposal says the same). */
  readonly edited: readonly boolean[];
  /** The newest progress of the build turns after it (`plan.updated`), each entry's status; `null` before any. */
  readonly progress: readonly PlanEntry["status"][] | null;
  /** The reopen message that carried the answer, when the box was gone: its receipt stands there. */
  readonly late: ClientMessageId | null;
};

/** The divider that opens a turn after a plan's answer: the build turn's, or a new plan turn's. */
export type TurnMarker = { readonly kind: "build-turn" } | { readonly kind: "plan-again"; readonly by: MemberId };

/** What a late answer's message answered: a plan (by its turn) or a question. */
export type LateAnswer = { readonly kind: "plan"; readonly turnId: TurnId } | { readonly kind: "question"; readonly questionId: QuestionId };

export type ThreadAnswers = {
  readonly plans: ReadonlyMap<TurnId, PlanAnswer>;
  readonly markers: ReadonlyMap<TurnId, TurnMarker>;
  /** When each question was answered (`question.answered`), for its receipt's time. */
  readonly questionAt: ReadonlyMap<QuestionId, number>;
  /** The late answers, by the reopen message that carried each. */
  readonly late: ReadonlyMap<ClientMessageId, LateAnswer>;
  /** The questions answered late: their turn draws no receipt, their message does. */
  readonly lateQuestions: ReadonlySet<QuestionId>;
  /** The `turn.released` that let a round's held turn go, by its seq: its round's bubble says so. */
  readonly roundReleases: ReadonlySet<number>;
  /**
   * How a reopen's session came back (`session.restored`, written after the reopen's message), by
   * the message: its divider stands before the message, as the targets read it, not after.
   */
  readonly restoredBefore: ReadonlyMap<ClientMessageId, TaskEventOf<"session.restored">>;
  /** Those restores, by their seq: their own row draws nothing. */
  readonly movedRestores: ReadonlySet<number>;
};

export const noAnswers: ThreadAnswers = { plans: new Map(), markers: new Map(), questionAt: new Map(), late: new Map(), lateQuestions: new Set(), roundReleases: new Set(), restoredBefore: new Map(), movedRestores: new Set() };

/** Marks the approved entries the driver changed: no entry of the proposal says the same (the API's `editedSteps`). */
const editedOf = (proposed: readonly PlanEntry[], approved: readonly PlanEntry[]): readonly boolean[] =>
  approved.map((entry) => !proposed.some((candidate) => candidate.content === entry.content && candidate.priority === entry.priority));

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Reads the log once, in order: each `plan.answered` answers the newest `plan.proposed` before it;
 * the next turn to start is the build turn (an approval) or a new plan turn (a revision); a
 * `user.message` marked `reopen` after an answer and before any turn starts is the late answer that
 * reopened the task. Progress is the newest main-agent `plan.updated` after an approval. A
 * `turn.released` after a round's `turn.held` (same budget) is the round's: its bubble says it.
 */
export const answersOf = (events: readonly StoredEvent[]): ThreadAnswers => {
  const plans = new Map<TurnId, Mutable<PlanAnswer>>();
  const markers = new Map<TurnId, TurnMarker>();
  const questionAt = new Map<QuestionId, number>();
  const late = new Map<ClientMessageId, LateAnswer>();
  const lateQuestions = new Set<QuestionId>();
  const roundReleases = new Set<number>();
  // What each budget holds now: a round's turn, or another (a member's message).
  const heldBy = new Map<string, boolean>();
  const restoredBefore = new Map<ClientMessageId, TaskEventOf<"session.restored">>();
  const movedRestores = new Set<number>();
  let reopen: { readonly id: ClientMessageId; readonly sessionId: SessionId } | null = null;
  let proposal: { readonly turnId: TurnId; readonly entries: readonly PlanEntry[] } | null = null;
  let approved: Mutable<PlanAnswer> | null = null;
  let nextTurn: TurnMarker | null = null;
  // The answer that may have gone as a reopen: until a turn starts, a reopen message carries it.
  let awaiting: LateAnswer | null = null;
  for (const { seq, at, sessionId, event } of events) {
    if (event.kind === "plan.proposed") {
      proposal = { turnId: event.turnId, entries: event.entries };
    } else if (event.kind === "plan.answered") {
      if (proposal === null) continue;
      const entries = event.decision === "approve" ? (event.entries ?? proposal.entries) : [];
      const answer: Mutable<PlanAnswer> = { turnId: proposal.turnId, decision: event.decision, by: event.memberId, at, entries, edited: editedOf(proposal.entries, entries), progress: null, late: null };
      plans.set(proposal.turnId, answer);
      approved = event.decision === "approve" ? answer : null;
      nextTurn = event.decision === "approve" ? { kind: "build-turn" } : { kind: "plan-again", by: event.memberId };
      awaiting = { kind: "plan", turnId: proposal.turnId };
    } else if (event.kind === "question.answered") {
      questionAt.set(event.questionId, at);
      awaiting = { kind: "question", questionId: event.questionId };
    } else if (event.kind === "user.message") {
      if (event.reopen === true) reopen = { id: event.clientMessageId, sessionId };
      if (event.reopen !== true || awaiting === null) continue;
      late.set(event.clientMessageId, awaiting);
      if (awaiting.kind === "question") lateQuestions.add(awaiting.questionId);
      else {
        const answer = plans.get(awaiting.turnId);
        if (answer !== undefined) answer.late = event.clientMessageId;
      }
      awaiting = null;
    } else if (event.kind === "session.restored") {
      if (reopen?.sessionId === sessionId) {
        restoredBefore.set(reopen.id, event);
        movedRestores.add(seq);
      }
      reopen = null;
    } else if (event.kind === "turn.started") {
      reopen = null;
      if (nextTurn !== null) markers.set(event.turnId, nextTurn);
      nextTurn = null;
      awaiting = null;
    } else if (event.kind === "turn.held") {
      heldBy.set(event.budgetId, event.origin === "automatic-round" || event.origin === "changes-requested");
    } else if (event.kind === "turn.released") {
      if (heldBy.get(event.budgetId) === true) roundReleases.add(seq);
      heldBy.delete(event.budgetId);
    } else if (event.kind === "plan.updated" && approved !== null && event.subagentId === undefined && event.turnId !== approved.turnId) {
      approved.progress = event.entries.map((entry) => entry.status);
    }
  }
  return { plans, markers, questionAt, late, lateQuestions, roundReleases, restoredBefore, movedRestores };
};
