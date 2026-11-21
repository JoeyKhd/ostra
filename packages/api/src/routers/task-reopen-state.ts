// Whether a task waits for a reopen (F-032, F-033, F-066): what `tasks.get`'s Reopen reads, and the
// upload route's check that a member who isn't the driver may attach files to a task (ticket 14: a
// reopen's sender may). Any member who can open the project may reopen a task that waits for one.

/** The task states a finished or waiting task can be reopened from. */
export const REOPEN_FROM = ["stopped", "in_review", "done"] as const;
/** The needs-you reasons that wait for a reopen, not for an answer to the agent. */
export const REOPEN_FROM_NEEDS_YOU = ["no_changes", "stalled", "spend_cap", "crashed", "setup_failed", "ticket_closed", "files_outside_repos"] as const;
/** The session states of a session that's going: a message to it is a send, not a reopen. */
export const GOING_SESSION_STATES = ["starting", "running", "waiting", "idle"] as const;

const isOneOf = (list: readonly string[], value: string | null): boolean => value !== null && list.includes(value);

/**
 * Whether the task waits for a reopen: stopped, in review or done; merged with a merged repo to
 * start a fresh branch from (F-066); or needing a person for a reason a reopen answers, or with its
 * newest session no longer going (a question that expired cancels its turn).
 */
export const waitsForReopen = (task: {
  readonly state: string;
  readonly needsYouReason: string | null;
  /** Whether a repo of the task records its merge. */
  readonly mergedRepo: boolean;
  /** The newest session's state, `null` before the task has one. */
  readonly sessionState: string | null;
}): boolean =>
  isOneOf(REOPEN_FROM, task.state) ||
  (task.state === "merged" && task.mergedRepo) ||
  (task.state === "needs_you" && (isOneOf(REOPEN_FROM_NEEDS_YOU, task.needsYouReason) || (task.sessionState !== null && !isOneOf(GOING_SESSION_STATES, task.sessionState))));
