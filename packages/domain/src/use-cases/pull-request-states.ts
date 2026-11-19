import type { Tx } from "@ostra/db";
import type { ConnectionId, OrganizationId, TaskRepoId } from "@ostra/protocol";

import type { Ports } from "../ports.ts";
import { notYet } from "./common.ts";
import type { UseCaseResult } from "./common.ts";

// A PR's state (F-031, F-044, F-079; spec section 4, "A PR's state"): from the App's
// `pull_request` webhook and from the reconcile every few minutes, which must agree, so both call
// this one use case. Body: ticket 16.

export type PullRequestState = "open" | "merged" | "closed";

export type RecordPullRequestStateInput = {
  readonly organizationId: OrganizationId;
  readonly connectionId: ConnectionId;
  /** The code host's repo ID and the PR's number, which find the task repo. */
  readonly hostRepoId: string;
  readonly prNumber: number;
  readonly state: PullRequestState;
  readonly headSha: string | null;
  /** When the code host says it changed, in ms since the epoch: an older report changes nothing. */
  readonly changedAt: number;
  readonly source: "webhook" | "reconcile";
};

export type RecordPullRequestStateResult = UseCaseResult<
  {
    readonly taskRepoId: TaskRepoId | null;
    /** What the task did: merged, stopped (`prs_closed`), or nothing. */
    readonly taskOutcome: "merged" | "stopped" | "unchanged";
  },
  "stale"
>;

export type RecordPullRequestStateDeps = Pick<Ports, "jobs" | "notices" | "clock" | "audit"> & { readonly tx: Tx };

/**
 * Moves the task repo (`pr_merged`, `pr_closed`, `pr_reopened`), and the task once its last PR
 * merged or every PR closed. The last PR closing enqueues `box.release` and the ticket's "done"
 * write when the board says ostra moves it there.
 */
export type RecordPullRequestState = (deps: RecordPullRequestStateDeps, input: RecordPullRequestStateInput) => Promise<RecordPullRequestStateResult>;

export const recordPullRequestState: RecordPullRequestState = () => notYet("16");
