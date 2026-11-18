import type { Approval, Box, Lease, NeedsYouItem, Runner, Session, Snapshot, Task, TaskRepo } from "@ostra/db";
import { leaseEpochSchema, memberIdSchema, optionIdSchema } from "@ostra/protocol";

import type { ApprovalLifecycle } from "./approval.ts";
import type { BoxLifecycle } from "./box.ts";
import type { LeaseEndReason, LeaseLifecycle } from "./lease.ts";
import type { NeedsYouLifecycle } from "./needs-you.ts";
import type { RunnerLifecycle } from "./runner.ts";
import type { SessionState } from "./session.ts";
import type { SnapshotLifecycle } from "./snapshot.ts";
import type { CodeTaskState, CommonTaskState, NeedsYouReason, RefineTaskState, TaskLifecycle } from "./task.ts";
import type { TaskRepoLifecycle } from "./task-repo.ts";

// The lifecycles' unions to the schema's columns and back (ticket 06's columns). Writing is total.
// Reading checks what the check constraints already guarantee, so a row that breaks them reads as
// an error with the reason, never as a wrong state.

export type Decoded<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

const decoded = <T>(value: T): Decoded<T> => ({ ok: true, value });
const broken = <T>(what: string): Decoded<T> => ({ ok: false, reason: what });

// ---------- task ----------

export type TaskColumns = Pick<Task, "kind" | "state" | "subState" | "needsYouReason" | "stoppedReason">;

export const taskToColumns = (task: TaskLifecycle): TaskColumns => {
  const base = { kind: task.kind, subState: null, needsYouReason: null, stoppedReason: null };
  const status = task.status;
  switch (status.state) {
    case "awaiting_approval":
    case "queued":
    case "preparing":
    case "running":
    case "merged":
    case "done":
      return { ...base, state: status.state };
    case "needs_you":
      return { ...base, state: "needs_you", needsYouReason: status.reason };
    case "stopped":
      return { ...base, state: "stopped", stoppedReason: status.reason };
    case "in_review":
      return { ...base, state: "in_review", subState: status.subState };
    default:
      return status satisfies never;
  }
};

const commonFromColumns = (row: TaskColumns): Decoded<CommonTaskState> | undefined => {
  switch (row.state) {
    case "awaiting_approval":
    case "queued":
    case "preparing":
    case "running":
      return decoded({ state: row.state });
    case "needs_you": {
      const reason = row.needsYouReason;
      if (reason === null || reason === "waiting_for_reviewer") {
        return broken(`a needs_you task has the reason ${String(reason)}`);
      }
      const typed: NeedsYouReason = reason;
      return decoded({ state: "needs_you", reason: typed });
    }
    case "stopped":
      return row.stoppedReason === null
        ? broken("a stopped task has no reason")
        : decoded({ state: "stopped", reason: row.stoppedReason });
    case "in_review":
    case "merged":
    case "done":
      return undefined;
    default:
      return row.state satisfies never;
  }
};

export const taskFromColumns = (row: TaskColumns): Decoded<TaskLifecycle> => {
  if (row.subState !== null && row.state !== "in_review") {
    return broken(`a ${row.state} task has a sub-state`);
  }
  const common = commonFromColumns(row);
  switch (row.kind) {
    case "code": {
      if (common !== undefined) {
        return common.ok ? decoded({ kind: "code", status: common.value }) : common;
      }
      let status: CodeTaskState;
      if (row.state === "in_review") {
        if (row.subState === null) {
          return broken("an in_review task has no sub-state");
        }
        status = { state: "in_review", subState: row.subState };
      } else if (row.state === "merged") {
        status = { state: "merged" };
      } else {
        return broken(`a code task can't be ${row.state}`);
      }
      return decoded({ kind: "code", status });
    }
    case "refine":
    case "review": {
      if (common !== undefined) {
        return common.ok ? decoded({ kind: row.kind, status: common.value }) : common;
      }
      if (row.state !== "done") {
        return broken(`a ${row.kind} task can't be ${row.state}`);
      }
      const status: RefineTaskState = { state: "done" };
      return decoded({ kind: row.kind, status });
    }
    default:
      return row.kind satisfies never;
  }
};

// ---------- session ----------

export type SessionColumns = Pick<Session, "state" | "outcome">;

export const sessionToColumns = (session: SessionState): SessionColumns => {
  switch (session.state) {
    case "ended":
      return { state: "ended", outcome: session.withChanges ? "with_changes" : "without_changes" };
    case "starting":
    case "running":
    case "waiting":
    case "idle":
    case "stopped":
    case "crashed":
      return { state: session.state, outcome: null };
    default:
      return session satisfies never;
  }
};

export const sessionFromColumns = (row: SessionColumns): Decoded<SessionState> => {
  if (row.state === "ended") {
    return row.outcome === null
      ? broken("an ended session has no outcome")
      : decoded({ state: "ended", withChanges: row.outcome === "with_changes" });
  }
  return row.outcome === null ? decoded({ state: row.state }) : broken(`a ${row.state} session has an outcome`);
};

// ---------- box ----------

export type BoxColumns = Pick<Box, "state" | "failedReason">;

export const boxToColumns = (box: BoxLifecycle): BoxColumns =>
  box.state === "failed" ? { state: "failed", failedReason: box.reason } : { state: box.state, failedReason: null };

export const boxFromColumns = (row: BoxColumns): Decoded<BoxLifecycle> => {
  if (row.state === "failed") {
    return decoded({ state: "failed", reason: row.failedReason ?? "unknown" });
  }
  return decoded({ state: row.state });
};

// ---------- runner, needs-you item, snapshot ----------

export type RunnerColumns = Pick<Runner, "state">;
export const runnerToColumns = (runner: RunnerLifecycle): RunnerColumns => ({ state: runner.state });
export const runnerFromColumns = (row: RunnerColumns): Decoded<RunnerLifecycle> => decoded({ state: row.state });

export type NeedsYouColumns = Pick<NeedsYouItem, "state">;
export const needsYouToColumns = (item: NeedsYouLifecycle): NeedsYouColumns => ({ state: item.state });
export const needsYouFromColumns = (row: NeedsYouColumns): Decoded<NeedsYouLifecycle> => decoded({ state: row.state });

export type SnapshotColumns = Pick<Snapshot, "state" | "failedReason">;
export const snapshotToColumns = (snapshot: SnapshotLifecycle): SnapshotColumns =>
  snapshot.state === "failed"
    ? { state: "failed", failedReason: snapshot.reason }
    : { state: snapshot.state, failedReason: null };
export const snapshotFromColumns = (row: SnapshotColumns): Decoded<SnapshotLifecycle> =>
  row.state === "failed"
    ? decoded({ state: "failed", reason: row.failedReason ?? "unknown" })
    : decoded({ state: row.state });

// ---------- task repo ----------

export type TaskRepoColumns = Pick<TaskRepo, "state" | "prNumber">;

export const taskRepoToColumns = (repo: TaskRepoLifecycle): TaskRepoColumns => {
  switch (repo.state) {
    case "no_branch":
    case "branch_pushed":
      return { state: repo.state, prNumber: null };
    case "pr_open":
    case "merged":
    case "closed_unmerged":
      return { state: repo.state, prNumber: repo.prNumber };
    default:
      return repo satisfies never;
  }
};

export const taskRepoFromColumns = (row: TaskRepoColumns): Decoded<TaskRepoLifecycle> => {
  switch (row.state) {
    case "no_branch":
    case "branch_pushed":
      return decoded({ state: row.state });
    case "pr_open":
    case "merged":
    case "closed_unmerged":
      return row.prNumber === null ? broken(`a ${row.state} repo has no PR number`) : decoded({ state: row.state, prNumber: row.prNumber });
    default:
      return row.state satisfies never;
  }
};

// ---------- approval ----------

export type ApprovalColumns = Pick<Approval, "state" | "decision" | "optionId" | "answeredByMemberId" | "ruleId" | "closedReason">;

const noAnswer = { decision: null, optionId: null, answeredByMemberId: null, ruleId: null, closedReason: null } as const;

export const approvalToColumns = (approval: ApprovalLifecycle): ApprovalColumns => {
  switch (approval.state) {
    case "open":
      return { ...noAnswer, state: "open" };
    case "answered":
      return {
        ...noAnswer,
        state: "answered",
        decision: approval.decision,
        optionId: approval.optionId,
        answeredByMemberId: approval.memberId,
      };
    case "answered_by_rule":
      return { ...noAnswer, state: "answered_by_rule", decision: approval.decision, ruleId: approval.ruleId };
    case "closed":
      return { ...noAnswer, state: "closed", closedReason: approval.reason };
    default:
      return approval satisfies never;
  }
};

export const approvalFromColumns = (row: ApprovalColumns): Decoded<ApprovalLifecycle> => {
  switch (row.state) {
    case "open":
      return decoded({ state: "open" });
    case "answered":
      return row.decision === null || row.optionId === null || row.answeredByMemberId === null
        ? broken("an answered approval lacks its answer")
        : decoded({
            state: "answered",
            decision: row.decision,
            optionId: optionIdSchema.parse(row.optionId),
            memberId: memberIdSchema.parse(row.answeredByMemberId),
          });
    case "answered_by_rule":
      return row.decision === null || row.ruleId === null
        ? broken("a rule-answered approval lacks its rule")
        : decoded({ state: "answered_by_rule", decision: row.decision, ruleId: row.ruleId });
    case "closed":
      return row.closedReason === null ? broken("a closed approval has no reason") : decoded({ state: "closed", reason: row.closedReason });
    default:
      return row.state satisfies never;
  }
};

// ---------- lease ----------

export type LeaseColumns = Pick<Lease, "state" | "epoch" | "endReason">;

const leaseEndReasons: ReadonlySet<string> = new Set<LeaseEndReason>([
  "released",
  "grace-expired",
  "superseded",
  "rejected",
  "offer-timeout",
]);
const isLeaseEndReason = (reason: string): reason is LeaseEndReason => leaseEndReasons.has(reason);

export const leaseToColumns = (lease: LeaseLifecycle): LeaseColumns =>
  lease.state === "active"
    ? { state: "active", epoch: lease.epoch, endReason: null }
    : { state: "ended", epoch: lease.epoch, endReason: lease.reason };

export const leaseFromColumns = (row: LeaseColumns): Decoded<LeaseLifecycle> => {
  const epoch = leaseEpochSchema.safeParse(row.epoch);
  if (!epoch.success) {
    return broken("a lease's epoch is not a positive integer");
  }
  if (row.state === "active") {
    return decoded({ state: "active", epoch: epoch.data });
  }
  return row.endReason !== null && isLeaseEndReason(row.endReason)
    ? decoded({ state: "ended", epoch: epoch.data, reason: row.endReason })
    : broken("an ended lease has no known reason");
};

