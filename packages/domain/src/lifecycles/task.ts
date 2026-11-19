import type { DbEnum } from "@ostra/db";
import type { RepoId, SessionLimit, TaskKind } from "@ostra/protocol";

import { moveTo, refuse } from "./transition.ts";
import type { Transition } from "./transition.ts";

// A task's lifecycle (context/domain-model.md, "A task's lifecycle"; ADR 0028): a discriminated
// union per kind. Every kind shares six states; a code task adds `in_review` (with its sub-state)
// and `merged`; refine and review add `done`. Milestone 1 drives the code kind: queued → preparing
// → running → in review (`waiting_for_reviewer`, the CI and AI review rounds being off until
// milestone 6), or → needs you (no changes, a crash, a failed setup), or → stopped.

// The names come from the schema's enums (Prisma's types are the source), so a state added on one
// side without the other is a type error.

/**
 * Why a task needs a person (domain-model.md, "When a task needs you"). A code task waiting for a
 * reviewer is in review, not here: that reason is a needs-you item's only.
 */
export type NeedsYouReason = Exclude<DbEnum.NeedsYouReason, "waiting_for_reviewer">;

/** Why a task stopped. */
export type TaskStopReason = DbEnum.TaskStopReason;

/** What a code task in review waits on. */
export type InReviewSubState = DbEnum.TaskSubState;

/** The six states every kind shares. */
export type CommonTaskState =
  | { readonly state: "awaiting_approval" }
  | { readonly state: "queued" }
  | { readonly state: "preparing" }
  | { readonly state: "running" }
  | { readonly state: "needs_you"; readonly reason: NeedsYouReason }
  | { readonly state: "stopped"; readonly reason: TaskStopReason };

export type CodeTaskState =
  | CommonTaskState
  | { readonly state: "in_review"; readonly subState: InReviewSubState }
  | { readonly state: "merged" };

export type RefineTaskState = CommonTaskState | { readonly state: "done" };
export type ReviewTaskState = CommonTaskState | { readonly state: "done" };

/** A task's kind and its state, together: a code state can never sit on a refine task. */
export type TaskLifecycle =
  | { readonly kind: "code"; readonly status: CodeTaskState }
  | { readonly kind: "refine"; readonly status: RefineTaskState }
  | { readonly kind: "review"; readonly status: ReviewTaskState };

export type TaskStateName = CodeTaskState["state"] | RefineTaskState["state"];

/** The review rounds a project runs before a reviewer (ADR 0041). Both are off until milestone 6. */
export type ReviewRounds = { readonly ci: boolean; readonly aiReview: boolean };

/** What moves a task. Each names what happened, never the state it should go to. */
export type TaskInput =
  // ---- every kind ----
  /** A member approves a task someone outside ostra started (F-040). */
  | { readonly type: "approve" }
  /** A member rejects it. */
  | { readonly type: "reject" }
  /** A runner accepted the dispatch: the box is being made. */
  | { readonly type: "runner_accepted" }
  /** The box is ready and the session started. */
  | { readonly type: "box_ready" }
  | { readonly type: "setup_failed" }
  /** The session, the box or the environment crashed. */
  | { readonly type: "crashed" }
  /** Something a person must act on came up while the task ran (a question, an approval, a stall…). */
  | { readonly type: "needs_you"; readonly reason: Exclude<NeedsYouReason, "setup_failed" | "crashed" | "no_changes"> }
  /** A member answered, approved, steered or reopened. `boxWarm`: the box is still there, so the task runs at once. */
  | { readonly type: "member_acted"; readonly boxWarm: boolean }
  | { readonly type: "stop"; readonly reason: TaskStopReason }
  /**
   * Reopen a task (F-032): from stopped, merged or done, and in milestone 2 also from in review and
   * needs you, as the domain model's diagrams say. A use case may refuse more (`reopenTask` refuses
   * a merged task until F-066's fresh branch, milestone 3).
   */
  | { readonly type: "reopen" }
  /** A runaway limit stopped the session (F-068): the maximum duration, the stall or the spend cap. */
  | { readonly type: "limit_reached"; readonly limit: SessionLimit }
  // ---- milestone 3 ----
  /** A plan turn ended with its plan (`plan.proposed`, F-063): the driver approves it or asks for changes. */
  | { readonly type: "plan_proposed" }
  /** The driver answered the plan. `boxWarm`: the box is still there, so the next turn runs at once. */
  | { readonly type: "plan_answered"; readonly boxWarm: boolean }
  /** The ticket moved to done or cancelled while the task ran, outside ostra's own writes (F-066, ADR 0052). */
  | { readonly type: "ticket_closed" }
  /** "Keep working" on a task whose ticket closed: it carries on. `boxWarm` as above. */
  | { readonly type: "keep_working"; readonly boxWarm: boolean }
  /**
   * A member reopened a task whose PR merged (F-066): it's queued again, and each merged repo gets a
   * fresh branch from its base (`<old branch>-2`, `-3`) and a new PR on its first push.
   */
  | { readonly type: "reopen_after_merge"; readonly mergedRepoIds: readonly RepoId[] }
  // ---- code ----
  /**
   * The session ended; `withChanges` when any repo's branch is ahead (F-030, F-065).
   * `filesOutsideRepos`: the agent left files outside every repo (Q133), which is why a session
   * without changes needs you then, instead of for `no_changes`.
   */
  | { readonly type: "session_ended"; readonly withChanges: boolean; readonly rounds: ReviewRounds; readonly filesOutsideRepos?: boolean }
  /**
   * Protocol minor 1: a turn ended and its work left the box (`session.saved`). `withChanges`: a
   * branch is ahead; `prOpen`: the task already has an open PR. Either goes to review (the first
   * PR, or the same PRs updated); neither raises needs you (F-065). The session stays idle.
   */
  | { readonly type: "work_saved"; readonly withChanges: boolean; readonly prOpen: boolean; readonly rounds: ReviewRounds }
  | { readonly type: "ci_passed"; readonly rounds: ReviewRounds }
  | { readonly type: "ci_failed"; readonly capReached: boolean }
  /** The agent pushed a fix. */
  | { readonly type: "pushed" }
  | { readonly type: "ai_review_done"; readonly blocking: boolean; readonly capReached: boolean }
  /** A "changes requested" review, `@ostra`, Update branch or a diff comment (F-105). */
  | { readonly type: "changes_requested" }
  | { readonly type: "last_pr_merged" }
  | { readonly type: "all_prs_closed" }
  /**
   * A PR someone reopened on the code host (Q107): a merged task, or one stopped because its PRs
   * closed, is in review again.
   */
  | { readonly type: "pr_reopened" }
  // ---- refine ----
  | { readonly type: "draft_handed_in" }
  | { readonly type: "draft_accepted" }
  // ---- review ----
  | { readonly type: "findings_posted" };

type Common = CommonTaskState;

/** The needs-you reason a runaway limit raises: the maximum duration reads as a stall (spec section 5.4). */
export const limitReason = (limit: SessionLimit): Extract<NeedsYouReason, "stalled" | "spend_cap"> => {
  switch (limit) {
    case "max-duration":
    case "stall":
      return "stalled";
    case "spend-cap":
      return "spend_cap";
    default:
      return limit satisfies never;
  }
};

/** The transitions every kind shares. `undefined`: the input isn't a shared one. */
const commonTransition = (status: Common, input: TaskInput): Transition<Common> | undefined => {
  const from = status.state;
  switch (input.type) {
    case "approve":
      return from === "awaiting_approval" ? moveTo({ state: "queued" }) : refuse(input, from);
    case "reject":
      return from === "awaiting_approval" ? moveTo({ state: "stopped", reason: "rejected" }) : refuse(input, from);
    case "runner_accepted":
      return from === "queued" ? moveTo({ state: "preparing" }) : refuse(input, from);
    case "box_ready":
      return from === "preparing" ? moveTo({ state: "running" }) : refuse(input, from);
    case "setup_failed":
      return from === "preparing" ? moveTo({ state: "needs_you", reason: "setup_failed" }) : refuse(input, from);
    case "crashed":
      return from === "preparing" || from === "running"
        ? moveTo({ state: "needs_you", reason: "crashed" })
        : refuse(input, from);
    case "needs_you":
      return from === "running" ? moveTo({ state: "needs_you", reason: input.reason }) : refuse(input, from);
    case "member_acted":
      return from === "needs_you" ? moveTo(input.boxWarm ? { state: "running" } : { state: "queued" }) : refuse(input, from);
    case "stop":
      return from === "stopped" ? refuse(input, from) : moveTo({ state: "stopped", reason: input.reason });
    case "reopen":
      return from === "stopped" || from === "needs_you" ? moveTo({ state: "queued" }) : refuse(input, from);
    case "limit_reached":
      return from === "running" ? moveTo({ state: "needs_you", reason: limitReason(input.limit) }) : refuse(input, from);
    case "plan_proposed":
      return from === "running" ? moveTo({ state: "needs_you", reason: "plan" }) : refuse(input, from);
    case "plan_answered":
      return status.state === "needs_you" && status.reason === "plan"
        ? moveTo(input.boxWarm ? { state: "running" } : { state: "queued" })
        : refuse(input, from);
    case "ticket_closed":
      return from === "running" ? moveTo({ state: "needs_you", reason: "ticket_closed" }) : refuse(input, from);
    case "keep_working":
      return status.state === "needs_you" && status.reason === "ticket_closed"
        ? moveTo(input.boxWarm ? { state: "running" } : { state: "queued" })
        : refuse(input, from);
    case "reopen_after_merge":
    case "session_ended":
    case "work_saved":
    case "ci_passed":
    case "ci_failed":
    case "pushed":
    case "ai_review_done":
    case "changes_requested":
    case "last_pr_merged":
    case "all_prs_closed":
    case "pr_reopened":
    case "draft_handed_in":
    case "draft_accepted":
    case "findings_posted":
      return undefined;
    default:
      return input satisfies never;
  }
};

const isCommon = (status: CodeTaskState | RefineTaskState | ReviewTaskState): status is Common =>
  status.state !== "in_review" && status.state !== "merged" && status.state !== "done";

/** Where a code task goes when its session ends with changes: the first review round that's on. */
const firstReviewState = (rounds: ReviewRounds): CodeTaskState =>
  rounds.ci
    ? { state: "in_review", subState: "ci_running" }
    : rounds.aiReview
      ? { state: "in_review", subState: "ai_review" }
      : { state: "in_review", subState: "waiting_for_reviewer" };

const transitionCode = (status: CodeTaskState, input: TaskInput): Transition<CodeTaskState> => {
  const from = status.state === "in_review" ? `in_review/${status.subState}` : status.state;
  switch (input.type) {
    case "session_ended":
      if (status.state !== "running") {
        return refuse(input, from);
      }
      return moveTo(
        input.withChanges
          ? firstReviewState(input.rounds)
          : { state: "needs_you", reason: input.filesOutsideRepos === true ? "files_outside_repos" : "no_changes" },
      );
    case "work_saved":
      if (status.state !== "running") {
        return refuse(input, from);
      }
      return moveTo(input.withChanges || input.prOpen ? firstReviewState(input.rounds) : { state: "needs_you", reason: "no_changes" });
    case "ci_passed":
      if (status.state !== "in_review" || status.subState !== "ci_running") {
        return refuse(input, from);
      }
      return moveTo({ state: "in_review", subState: input.rounds.aiReview ? "ai_review" : "waiting_for_reviewer" });
    case "ci_failed":
      if (status.state !== "in_review" || status.subState !== "ci_running") {
        return refuse(input, from);
      }
      return moveTo(input.capReached ? { state: "needs_you", reason: "round_cap" } : { state: "in_review", subState: "fixing_ci" });
    case "pushed":
      return status.state === "in_review" && (status.subState === "fixing_ci" || status.subState === "fixing_findings")
        ? moveTo({ state: "in_review", subState: "ci_running" })
        : refuse(input, from);
    case "ai_review_done":
      if (status.state !== "in_review" || status.subState !== "ai_review") {
        return refuse(input, from);
      }
      if (!input.blocking) {
        return moveTo({ state: "in_review", subState: "waiting_for_reviewer" });
      }
      return moveTo(
        input.capReached ? { state: "needs_you", reason: "round_cap" } : { state: "in_review", subState: "fixing_findings" },
      );
    case "changes_requested":
      return status.state === "in_review" ? moveTo({ state: "queued" }) : refuse(input, from);
    case "last_pr_merged":
      return status.state === "in_review" ? moveTo({ state: "merged" }) : refuse(input, from);
    case "all_prs_closed":
      return status.state === "in_review" ? moveTo({ state: "stopped", reason: "prs_closed" }) : refuse(input, from);
    case "pr_reopened":
      return status.state === "merged" || (status.state === "stopped" && status.reason === "prs_closed")
        ? moveTo({ state: "in_review", subState: "waiting_for_reviewer" })
        : refuse(input, from);
    case "crashed":
      // A fixing round runs a session in a box, so it can crash while the task is in review.
      if (status.state === "in_review" && (status.subState === "fixing_ci" || status.subState === "fixing_findings")) {
        return moveTo({ state: "needs_you", reason: "crashed" });
      }
      break;
    case "needs_you":
      // A fixing round can stall or reach the spend cap.
      if (status.state === "in_review" && (status.subState === "fixing_ci" || status.subState === "fixing_findings")) {
        return moveTo({ state: "needs_you", reason: input.reason });
      }
      break;
    case "limit_reached":
      if (status.state === "in_review" && (status.subState === "fixing_ci" || status.subState === "fixing_findings")) {
        return moveTo({ state: "needs_you", reason: limitReason(input.limit) });
      }
      break;
    case "member_acted":
      // Reopen, @ostra or Update branch on a task in review.
      if (status.state === "in_review") {
        return moveTo({ state: "queued" });
      }
      break;
    case "reopen":
      if (status.state === "merged" || status.state === "in_review") {
        return moveTo({ state: "queued" });
      }
      break;
    case "reopen_after_merge":
      // A merged task only, and only with the repos whose PR merged named (F-066).
      return status.state === "merged" && input.mergedRepoIds.length > 0 ? moveTo({ state: "queued" }) : refuse(input, from);
    case "stop":
      if (status.state === "in_review" || status.state === "merged") {
        return moveTo({ state: "stopped", reason: input.reason });
      }
      break;
    case "draft_handed_in":
    case "draft_accepted":
    case "findings_posted":
      return refuse(input, from);
    case "approve":
    case "reject":
    case "runner_accepted":
    case "box_ready":
    case "setup_failed":
    case "plan_proposed":
    case "plan_answered":
    case "ticket_closed":
    case "keep_working":
      break;
    default:
      return input satisfies never;
  }
  return isCommon(status) ? (commonTransition(status, input) ?? refuse(input, from)) : refuse(input, from);
};

const transitionRefine = (status: RefineTaskState, input: TaskInput): Transition<RefineTaskState> => {
  const from = status.state;
  switch (input.type) {
    case "draft_handed_in":
      return from === "running" ? moveTo({ state: "needs_you", reason: "draft_ready" }) : refuse(input, from);
    case "draft_accepted":
      return status.state === "needs_you" && status.reason === "draft_ready" ? moveTo({ state: "done" }) : refuse(input, from);
    case "reopen":
      return from === "done" ? moveTo({ state: "queued" }) : isCommon(status) ? (commonTransition(status, input) ?? refuse(input, from)) : refuse(input, from);
    case "stop":
      return from === "done" ? moveTo({ state: "stopped", reason: input.reason }) : isCommon(status) ? (commonTransition(status, input) ?? refuse(input, from)) : refuse(input, from);
    case "session_ended":
    case "work_saved":
    case "ci_passed":
    case "ci_failed":
    case "pushed":
    case "ai_review_done":
    case "changes_requested":
    case "last_pr_merged":
    case "all_prs_closed":
    case "pr_reopened":
    case "findings_posted":
    case "reopen_after_merge":
      return refuse(input, from);
    case "approve":
    case "reject":
    case "runner_accepted":
    case "box_ready":
    case "setup_failed":
    case "crashed":
    case "needs_you":
    case "member_acted":
    case "limit_reached":
    case "plan_proposed":
    case "plan_answered":
    case "ticket_closed":
    case "keep_working":
      return isCommon(status) ? (commonTransition(status, input) ?? refuse(input, from)) : refuse(input, from);
    default:
      return input satisfies never;
  }
};

const transitionReview = (status: ReviewTaskState, input: TaskInput): Transition<ReviewTaskState> => {
  const from = status.state;
  switch (input.type) {
    case "findings_posted":
      return from === "running" ? moveTo({ state: "done" }) : refuse(input, from);
    case "reopen":
      return from === "done" ? moveTo({ state: "queued" }) : isCommon(status) ? (commonTransition(status, input) ?? refuse(input, from)) : refuse(input, from);
    case "stop":
      return from === "done" ? moveTo({ state: "stopped", reason: input.reason }) : isCommon(status) ? (commonTransition(status, input) ?? refuse(input, from)) : refuse(input, from);
    case "session_ended":
    case "work_saved":
    case "ci_passed":
    case "ci_failed":
    case "pushed":
    case "ai_review_done":
    case "changes_requested":
    case "last_pr_merged":
    case "all_prs_closed":
    case "pr_reopened":
    case "draft_handed_in":
    case "draft_accepted":
    case "reopen_after_merge":
      return refuse(input, from);
    case "approve":
    case "reject":
    case "runner_accepted":
    case "box_ready":
    case "setup_failed":
    case "crashed":
    case "needs_you":
    case "member_acted":
    case "limit_reached":
    case "plan_proposed":
    case "plan_answered":
    case "ticket_closed":
    case "keep_working":
      return isCommon(status) ? (commonTransition(status, input) ?? refuse(input, from)) : refuse(input, from);
    default:
      return input satisfies never;
  }
};

/** Moves a task by one input. Pure: the caller saves the new state, in the same transaction as what caused it. */
export const transitionTask = (task: TaskLifecycle, input: TaskInput): Transition<TaskLifecycle> => {
  switch (task.kind) {
    case "code": {
      const next = transitionCode(task.status, input);
      return next.ok ? moveTo({ kind: "code", status: next.state }) : next;
    }
    case "refine": {
      const next = transitionRefine(task.status, input);
      return next.ok ? moveTo({ kind: "refine", status: next.state }) : next;
    }
    case "review": {
      const next = transitionReview(task.status, input);
      return next.ok ? moveTo({ kind: "review", status: next.state }) : next;
    }
    default:
      return task satisfies never;
  }
};

/** A new task's lifecycle: queued, or awaiting approval when someone outside ostra started it (F-040). */
export const newTask = (kind: TaskKind, needsApproval: boolean): TaskLifecycle => {
  const status: CommonTaskState = needsApproval ? { state: "awaiting_approval" } : { state: "queued" };
  switch (kind) {
    case "code":
      return { kind, status };
    case "refine":
      return { kind, status };
    case "review":
      return { kind, status };
    default:
      return kind satisfies never;
  }
};

/** Whether a task has an active session's worth of work going (it holds a lease). */
export const isActive = (task: TaskLifecycle): boolean =>
  task.status.state === "preparing" ||
  task.status.state === "running" ||
  (task.status.state === "in_review" && (task.status.subState === "fixing_ci" || task.status.subState === "fixing_findings"));
