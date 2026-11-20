import type { DbEnum } from "@ostra/db";
import type { MemberId, ReviewRunId, TaskId } from "@ostra/protocol";

import { moveTo, refuse } from "./transition.ts";
import type { Transition } from "./transition.ts";

// Milestone 6's lifecycles (spec section 5.4; ADR 0056, ADR 0057, ADR 0058; domain-model.md). Each
// is a discriminated union with one transition function, and every switch is exhaustive. An outside
// task's approval is inside the task's own union (`awaiting_approval` → `queued` | `stopped`, in
// `task.ts`), and so are the code task's in-review sub-states. The state names come from the
// schema's enums, so a state added on one side only is a type error.

// ---------- an automation (F-011, F-106) ----------

export type AutomationPauseReason = DbEnum.AutomationPauseReason;

export type AutomationLifecycle =
  | { readonly state: "enabled" }
  | { readonly state: "paused"; readonly reason: AutomationPauseReason; readonly at: number }
  | { readonly state: "deleted"; readonly at: number };

export type AutomationInput =
  /** A project admin paused it, or the 21st start of an hour did (`hourly_limit`). */
  | { readonly type: "pause"; readonly reason: AutomationPauseReason; readonly at: number }
  /** A project admin resumed it: the next tick or match acts on it, never a past time. */
  | { readonly type: "resume" }
  /** A project admin deleted it: it stops at the next tick, and its tasks keep running. */
  | { readonly type: "delete"; readonly at: number };

export const transitionAutomation = (automation: AutomationLifecycle, input: AutomationInput): Transition<AutomationLifecycle> => {
  switch (automation.state) {
    case "enabled":
      switch (input.type) {
        case "pause":
          return moveTo({ state: "paused", reason: input.reason, at: input.at });
        case "resume":
          return refuse(input, automation.state);
        case "delete":
          return moveTo({ state: "deleted", at: input.at });
        default:
          return input satisfies never;
      }
    case "paused":
      switch (input.type) {
        case "pause":
          return refuse(input, automation.state);
        case "resume":
          return moveTo({ state: "enabled" });
        case "delete":
          return moveTo({ state: "deleted", at: input.at });
        default:
          return input satisfies never;
      }
    case "deleted":
      return refuse(input, automation.state);
    default:
      return automation satisfies never;
  }
};

/** The automation's lifecycle from its row's columns. */
export const automationFromRow = (row: {
  readonly deletedAt: Date | null;
  readonly pausedAt: Date | null;
  readonly pausedReason: AutomationPauseReason | null;
}): AutomationLifecycle => {
  if (row.deletedAt !== null) {
    return { state: "deleted", at: row.deletedAt.getTime() };
  }
  if (row.pausedAt !== null && row.pausedReason !== null) {
    return { state: "paused", reason: row.pausedReason, at: row.pausedAt.getTime() };
  }
  return { state: "enabled" };
};

// ---------- an occurrence, and an intake rule's match (F-106, F-011) ----------

export type AutomationSkipReason = DbEnum.AutomationSkipReason;

/** An occurrence of a schedule, or a rule's match of a ticket: due, then started, skipped or missed. */
export type AutomationRunLifecycle =
  | { readonly state: "due" }
  | { readonly state: "started"; readonly taskId: TaskId | null }
  | { readonly state: "skipped"; readonly reason: AutomationSkipReason }
  | { readonly state: "missed" };

export type AutomationRunInput =
  /** Its task started (`null`: a schedule that checked a filter and started its matches as a bulk start). */
  | { readonly type: "start"; readonly taskId: TaskId | null }
  | { readonly type: "skip"; readonly reason: AutomationSkipReason }
  /** It came due while the install was down, and more than the missed window ago. */
  | { readonly type: "miss" };

export const transitionAutomationRun = (run: AutomationRunLifecycle, input: AutomationRunInput): Transition<AutomationRunLifecycle> => {
  switch (run.state) {
    case "due":
      switch (input.type) {
        case "start":
          return moveTo({ state: "started", taskId: input.taskId });
        case "skip":
          return moveTo({ state: "skipped", reason: input.reason });
        case "miss":
          return moveTo({ state: "missed" });
        default:
          return input satisfies never;
      }
    case "started":
    case "skipped":
    case "missed":
      // Final: the row's unique key makes the occurrence, or the match, once.
      return refuse(input, run.state);
    default:
      return run satisfies never;
  }
};

// ---------- a bulk start's item (F-107) ----------

export type BulkItemLifecycle =
  | { readonly state: "pending" }
  | { readonly state: "started"; readonly taskId: TaskId }
  | { readonly state: "skipped"; readonly reason: string }
  | { readonly state: "failed"; readonly reason: string };

export type BulkItemInput =
  | { readonly type: "start"; readonly taskId: TaskId }
  /** Not started, for a reason a member can act on: the ticket has an active task, closed, left the board. */
  | { readonly type: "skip"; readonly reason: string }
  | { readonly type: "fail"; readonly reason: string };

export const transitionBulkItem = (item: BulkItemLifecycle, input: BulkItemInput): Transition<BulkItemLifecycle> => {
  switch (item.state) {
    case "pending":
      switch (input.type) {
        case "start":
          return moveTo({ state: "started", taskId: input.taskId });
        case "skip":
          return moveTo({ state: "skipped", reason: input.reason });
        case "fail":
          return moveTo({ state: "failed", reason: input.reason });
        default:
          return input satisfies never;
      }
    case "started":
    case "skipped":
    case "failed":
      // Final: a retried request answers the same result.
      return refuse(input, item.state);
    default:
      return item satisfies never;
  }
};

// ---------- a Linear agent session (F-012, ADR 0057) ----------

export type AgentSessionLifecycle =
  | { readonly state: "active" }
  | { readonly state: "awaiting_approval" }
  | { readonly state: "ended"; readonly at: number; readonly why: AgentSessionEnd };

/** Why a session ended: its task ended, a stop from Linear, a stop in ostra, a rejection, or no board for the team. */
export type AgentSessionEnd = "task-ended" | "stopped-in-linear" | "stopped-in-ostra" | "rejected" | "no-board";

export type AgentSessionInput =
  /** Its task is an outside task waiting for a member's approval. */
  | { readonly type: "await_approval" }
  /** A member approved the task. */
  | { readonly type: "approved" }
  | { readonly type: "end"; readonly at: number; readonly why: AgentSessionEnd };

export const transitionAgentSession = (session: AgentSessionLifecycle, input: AgentSessionInput): Transition<AgentSessionLifecycle> => {
  switch (session.state) {
    case "active":
      switch (input.type) {
        case "await_approval":
          return moveTo({ state: "awaiting_approval" });
        case "approved":
          return refuse(input, session.state);
        case "end":
          return moveTo({ state: "ended", at: input.at, why: input.why });
        default:
          return input satisfies never;
      }
    case "awaiting_approval":
      switch (input.type) {
        case "await_approval":
          return refuse(input, session.state);
        case "approved":
          return moveTo({ state: "active" });
        case "end":
          return moveTo({ state: "ended", at: input.at, why: input.why });
        default:
          return input satisfies never;
      }
    case "ended":
      // Final: a later event of the same session changes nothing (a stop is honoured once).
      return refuse(input, session.state);
    default:
      return session satisfies never;
  }
};

// ---------- a refine draft (F-099) ----------

export type DraftSource = DbEnum.DraftSource;

/**
 * A refine task's draft: each save is a new version (the agent's, or a member's edit); "Update
 * ticket" applies the latest to the tracker; "Mark ready" moves the ticket to its board's ready
 * status after that.
 */
export type DraftLifecycle =
  | { readonly state: "draft"; readonly version: number; readonly source: DraftSource }
  | { readonly state: "applied"; readonly version: number; readonly appliedAt: number; readonly appliedBy: MemberId }
  | { readonly state: "ready"; readonly version: number; readonly readyAt: number };

export type DraftInput =
  /** A new version: the agent handed one in, or a member saved an edit. */
  | { readonly type: "save"; readonly source: DraftSource }
  /** "Update ticket" (or "Create ticket"): the version is written to the tracker through the outbox. */
  | { readonly type: "apply"; readonly version: number; readonly at: number; readonly byMemberId: MemberId }
  /** "Mark ready", after the ticket holds the draft. */
  | { readonly type: "mark_ready"; readonly at: number };

/** The first version of a draft. */
export const firstDraft = (source: DraftSource): DraftLifecycle => ({ state: "draft", version: 1, source });

export const transitionDraft = (draft: DraftLifecycle, input: DraftInput): Transition<DraftLifecycle> => {
  switch (input.type) {
    case "save":
      // Any state takes a new version: an edit after "Update ticket" is a draft again.
      return moveTo({ state: "draft", version: draft.version + 1, source: input.source });
    case "apply":
      // Only the latest version, so a stale click never writes an older text.
      return draft.state === "draft" && input.version === draft.version
        ? moveTo({ state: "applied", version: draft.version, appliedAt: input.at, appliedBy: input.byMemberId })
        : refuse(input, draft.state);
    case "mark_ready":
      return draft.state === "applied" ? moveTo({ state: "ready", version: draft.version, readyAt: input.at }) : refuse(input, draft.state);
    default:
      return input satisfies never;
  }
};

// ---------- a CI run per head (F-035, ADR 0058) ----------

export type CiRunState = DbEnum.CiRunState;
export type CiVerdictName = Exclude<CiRunState, "pending">;

export type CiRunLifecycle = { readonly state: "pending" } | { readonly state: CiVerdictName; readonly completedAt: number };

export type CiRunInput = { readonly type: "verdict"; readonly verdict: CiVerdictName; readonly at: number };

/** A head's CI: pending until its verdict, which is final. A new push is a new head, and a new run. */
export const transitionCiRun = (run: CiRunLifecycle, input: CiRunInput): Transition<CiRunLifecycle> => {
  switch (run.state) {
    case "pending":
      return moveTo({ state: input.verdict, completedAt: input.at });
    case "passed":
    case "failed":
    case "none":
    case "timed_out":
      return refuse(input, run.state);
    default:
      return run satisfies never;
  }
};

// ---------- a round (F-035, F-101, F-105) ----------

export type RoundCapReason = "rounds" | "automatic-turns";

export type RoundLifecycle =
  | { readonly state: "started" }
  /** Waiting for the budget gate (a full budget holds an automatic turn, ADR 0055). */
  | { readonly state: "held" }
  | { readonly state: "capped"; readonly reason: RoundCapReason };

export type RoundInput = { readonly type: "hold" } | { readonly type: "release" };

/** A round as it's made: started when it's allowed, capped (and the task needs you) when not. */
export const newRound = (allowed: RoundVerdict): RoundLifecycle =>
  allowed.kind === "allowed" ? { state: "started" } : { state: "capped", reason: allowed.reason };

/** `roundAllowed`'s answer (`../review-loop/rounds.ts`). */
export type RoundVerdict = { readonly kind: "allowed" } | { readonly kind: "capped"; readonly reason: RoundCapReason };

export const transitionRound = (round: RoundLifecycle, input: RoundInput): Transition<RoundLifecycle> => {
  switch (round.state) {
    case "started":
      switch (input.type) {
        case "hold":
          return moveTo({ state: "held" });
        case "release":
          return refuse(input, round.state);
        default:
          return input satisfies never;
      }
    case "held":
      switch (input.type) {
        case "hold":
          return refuse(input, round.state);
        case "release":
          return moveTo({ state: "started" });
        default:
          return input satisfies never;
      }
    case "capped":
      // Final: a person acts, and the next round is a new row.
      return refuse(input, round.state);
    default:
      return round satisfies never;
  }
};

// ---------- a review run (F-100) ----------

export type ReviewRunLifecycle =
  | { readonly state: "running" }
  | { readonly state: "submitted"; readonly blocking: number; readonly nits: number }
  | { readonly state: "posted"; readonly blocking: number; readonly nits: number; readonly postedAt: number }
  /** The review task failed, or the head moved while it ran (the next head gets a new run). */
  | { readonly state: "failed" };

export type ReviewRunInput =
  | { readonly type: "submit"; readonly blocking: number; readonly nits: number }
  | { readonly type: "post"; readonly at: number }
  | { readonly type: "fail" };

export const transitionReviewRun = (run: ReviewRunLifecycle, input: ReviewRunInput): Transition<ReviewRunLifecycle> => {
  switch (run.state) {
    case "running":
      switch (input.type) {
        case "submit":
          return moveTo({ state: "submitted", blocking: input.blocking, nits: input.nits });
        case "post":
          return refuse(input, run.state);
        case "fail":
          return moveTo({ state: "failed" });
        default:
          return input satisfies never;
      }
    case "submitted":
      switch (input.type) {
        case "submit":
          // One submission a run: the tool answers the second with `not-in-review`.
          return refuse(input, run.state);
        case "post":
          return moveTo({ state: "posted", blocking: run.blocking, nits: run.nits, postedAt: input.at });
        case "fail":
          return moveTo({ state: "failed" });
        default:
          return input satisfies never;
      }
    case "posted":
    case "failed":
      return refuse(input, run.state);
    default:
      return run satisfies never;
  }
};

// ---------- a finding (F-100, F-101) ----------

export type FindingLifecycle =
  | { readonly state: "open" }
  | { readonly state: "resolved"; readonly inRunId: ReviewRunId }
  /** Its line left the diff, or its PR closed. */
  | { readonly state: "outdated" };

export type FindingInput = { readonly type: "resolve"; readonly inRunId: ReviewRunId } | { readonly type: "outdate" };

export const transitionFinding = (finding: FindingLifecycle, input: FindingInput): Transition<FindingLifecycle> => {
  switch (finding.state) {
    case "open":
      switch (input.type) {
        case "resolve":
          return moveTo({ state: "resolved", inRunId: input.inRunId });
        case "outdate":
          return moveTo({ state: "outdated" });
        default:
          return input satisfies never;
      }
    case "resolved":
    case "outdated":
      return refuse(input, finding.state);
    default:
      return finding satisfies never;
  }
};

// ---------- an environment proposal (F-113) ----------

export type EnvironmentProposalLifecycle =
  | { readonly state: "proposed" }
  | { readonly state: "accepted"; readonly byMemberId: MemberId; readonly at: number; readonly resultVersion: number }
  | { readonly state: "rejected"; readonly byMemberId: MemberId; readonly at: number }
  /** A newer proposal for the same environment came in before anyone decided. */
  | { readonly state: "superseded" };

export type EnvironmentProposalInput =
  /** A project admin accepted it, as it was or edited: it became the environment's next version. */
  | { readonly type: "accept"; readonly byMemberId: MemberId; readonly at: number; readonly resultVersion: number }
  | { readonly type: "reject"; readonly byMemberId: MemberId; readonly at: number }
  | { readonly type: "supersede" };

export const transitionEnvironmentProposal = (
  proposal: EnvironmentProposalLifecycle,
  input: EnvironmentProposalInput,
): Transition<EnvironmentProposalLifecycle> => {
  switch (proposal.state) {
    case "proposed":
      switch (input.type) {
        case "accept":
          return moveTo({ state: "accepted", byMemberId: input.byMemberId, at: input.at, resultVersion: input.resultVersion });
        case "reject":
          return moveTo({ state: "rejected", byMemberId: input.byMemberId, at: input.at });
        case "supersede":
          return moveTo({ state: "superseded" });
        default:
          return input satisfies never;
      }
    case "accepted":
    case "rejected":
    case "superseded":
      // Final: the first decision wins.
      return refuse(input, proposal.state);
    default:
      return proposal satisfies never;
  }
};
