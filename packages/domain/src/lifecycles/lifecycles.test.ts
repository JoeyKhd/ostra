import { memberIdSchema, optionIdSchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { transitionApproval } from "./approval.ts";
import type { ApprovalInput, ApprovalLifecycle } from "./approval.ts";
import { transitionBox } from "./box.ts";
import type { BoxInput, BoxLifecycle } from "./box.ts";
import { acceptsWrite, nextEpoch, transitionLease } from "./lease.ts";
import type { LeaseLifecycle } from "./lease.ts";
import {
  approvalFromColumns,
  approvalToColumns,
  boxFromColumns,
  boxToColumns,
  leaseFromColumns,
  leaseToColumns,
  needsYouFromColumns,
  needsYouToColumns,
  runnerFromColumns,
  runnerToColumns,
  sessionFromColumns,
  sessionToColumns,
  snapshotFromColumns,
  snapshotToColumns,
  taskRepoFromColumns,
  taskRepoToColumns,
} from "./mapping.ts";
import { transitionNeedsYou } from "./needs-you.ts";
import type { NeedsYouLifecycle } from "./needs-you.ts";
import { takesTasks, transitionRunner } from "./runner.ts";
import type { RunnerInput, RunnerLifecycle } from "./runner.ts";
import { isSessionActive, transitionSession } from "./session.ts";
import type { SessionInput, SessionState } from "./session.ts";
import { transitionSnapshot } from "./snapshot.ts";
import type { SnapshotInput, SnapshotLifecycle } from "./snapshot.ts";
import { transitionTaskRepo } from "./task-repo.ts";
import type { TaskRepoInput, TaskRepoLifecycle } from "./task-repo.ts";
import type { Transition } from "./transition.ts";

type Arrow<S, I> = readonly [S, I, S];
type Refusal<S, I> = readonly [S, I];

/** Checks a lifecycle's drawn arrows and its refusals, table by table. */
const lifecycleCases = <S extends { readonly state: string }, I extends { readonly type: string }>(
  transition: (state: S, input: I) => Transition<S>,
  arrows: readonly Arrow<S, I>[],
  refusals: readonly Refusal<S, I>[],
): void => {
  it.each(arrows.map(([from, input, to]) => [from.state, input.type, to.state, from, input, to] as const))(
    "%s --%s--> %s",
    (_from, _input, _to, from, input, to) => {
      expect(transition(from, input)).toEqual({ ok: true, state: to });
    },
  );
  it.each(refusals.map(([from, input]) => [from.state, input.type, from, input] as const))(
    "%s refuses %s",
    (_from, _input, from, input) => {
      expect(transition(from, input)).toMatchObject({ ok: false });
    },
  );
};

describe("session", () => {
  const s = (state: SessionState): SessionState => state;
  lifecycleCases<SessionState, SessionInput>(
    transitionSession,
    [
      [s({ state: "starting" }), { type: "agent_ready" }, s({ state: "running" })],
      [s({ state: "running" }), { type: "waiting_on_person" }, s({ state: "waiting" })],
      [s({ state: "waiting" }), { type: "person_answered" }, s({ state: "running" })],
      [s({ state: "running" }), { type: "turn_ended" }, s({ state: "idle" })],
      [s({ state: "waiting" }), { type: "turn_ended" }, s({ state: "idle" })],
      [s({ state: "idle" }), { type: "turn_started" }, s({ state: "running" })],
      [s({ state: "idle" }), { type: "box_stopped", withChanges: true }, s({ state: "ended", withChanges: true })],
      [s({ state: "idle" }), { type: "box_stopped", withChanges: false }, s({ state: "ended", withChanges: false })],
      [s({ state: "idle" }), { type: "stop" }, s({ state: "stopped" })],
      [s({ state: "running" }), { type: "stop" }, s({ state: "stopped" })],
      [s({ state: "idle" }), { type: "crash" }, s({ state: "crashed" })],
      [s({ state: "starting" }), { type: "crash" }, s({ state: "crashed" })],
    ],
    [
      [s({ state: "starting" }), { type: "turn_ended" }],
      [s({ state: "running" }), { type: "box_stopped", withChanges: true }],
      [s({ state: "waiting" }), { type: "agent_ready" }],
      [s({ state: "idle" }), { type: "person_answered" }],
      [s({ state: "ended", withChanges: true }), { type: "turn_started" }],
      [s({ state: "stopped" }), { type: "stop" }],
      [s({ state: "crashed" }), { type: "crash" }],
    ],
  );

  it("counts only starting, running, waiting and idle as active", () => {
    expect(isSessionActive({ state: "waiting" })).toBe(true);
    expect(isSessionActive({ state: "ended", withChanges: false })).toBe(false);
  });

  it.each([
    { state: "starting" },
    { state: "running" },
    { state: "waiting" },
    { state: "idle" },
    { state: "ended", withChanges: true },
    { state: "ended", withChanges: false },
    { state: "stopped" },
    { state: "crashed" },
  ] satisfies SessionState[])("round-trips %j through its columns", (state) => {
    expect(sessionFromColumns(sessionToColumns(state))).toEqual({ ok: true, value: state });
  });
});

describe("box (and the host worktree)", () => {
  const b = (state: BoxLifecycle): BoxLifecycle => state;
  lifecycleCases<BoxLifecycle, BoxInput>(
    transitionBox,
    [
      [b({ state: "creating" }), { type: "created" }, b({ state: "preparing" })],
      [b({ state: "preparing" }), { type: "prepared" }, b({ state: "ready" })],
      [b({ state: "ready" }), { type: "turn_ended" }, b({ state: "idle" })],
      [b({ state: "idle" }), { type: "turn_started" }, b({ state: "ready" })],
      [b({ state: "idle" }), { type: "stop" }, b({ state: "stopped" })],
      [b({ state: "stopped" }), { type: "turn_started" }, b({ state: "ready" })],
      [b({ state: "stopped" }), { type: "release", reason: "prs_closed" }, b({ state: "released", reason: "prs_closed" })],
      [b({ state: "stopped" }), { type: "release", reason: "idle_expired" }, b({ state: "released", reason: "idle_expired" })],
      [b({ state: "creating" }), { type: "fail", reason: "no image" }, b({ state: "failed", reason: "no image" })],
      [b({ state: "preparing" }), { type: "fail", reason: "setup" }, b({ state: "failed", reason: "setup" })],
      [b({ state: "ready" }), { type: "fail", reason: "host lost" }, b({ state: "failed", reason: "host lost" })],
      [b({ state: "idle" }), { type: "fail", reason: "host lost" }, b({ state: "failed", reason: "host lost" })],
    ],
    [
      [b({ state: "creating" }), { type: "prepared" }],
      [b({ state: "preparing" }), { type: "turn_started" }],
      [b({ state: "ready" }), { type: "release", reason: "requested" }],
      [b({ state: "idle" }), { type: "release", reason: "requested" }],
      [b({ state: "idle" }), { type: "created" }],
      [b({ state: "stopped" }), { type: "fail", reason: "x" }],
      [b({ state: "released", reason: "prs_closed" }), { type: "turn_started" }],
      [b({ state: "released", reason: "prs_closed" }), { type: "release", reason: "requested" }],
      [b({ state: "failed", reason: "x" }), { type: "release", reason: "requested" }],
    ],
  );

  it.each([
    { state: "creating" },
    { state: "preparing" },
    { state: "ready" },
    { state: "idle" },
    { state: "stopped" },
    { state: "released", reason: "task_deleted" },
    { state: "released", reason: null },
    { state: "failed", reason: "setup failed" },
  ] satisfies BoxLifecycle[])("round-trips %j through its columns", (state) => {
    expect(boxFromColumns(boxToColumns(state))).toEqual({ ok: true, value: state });
  });
});

describe("runner", () => {
  const r = (state: RunnerLifecycle["state"]): RunnerLifecycle => ({ state });
  const states = ["joining", "online", "offline", "draining", "revoked"] as const;
  const inputs = [
    ["accept", { type: "accept" }],
    ["reject", { type: "reject" }],
    ["disconnected", { type: "disconnected" }],
    ["reconnected", { type: "reconnected" }],
    ["drain", { type: "drain" }],
    ["resume-connected", { type: "resume", connected: true }],
    ["resume-not-connected", { type: "resume", connected: false }],
    ["revoke", { type: "revoke" }],
  ] as const satisfies readonly (readonly [string, RunnerInput])[];
  type InputName = (typeof inputs)[number][0];
  type State = RunnerLifecycle["state"];
  /**
   * The domain model's table (domain-model.md, "A runner's lifecycle"; Q108, Q131): every input from
   * every state, and where it goes, or `null` where it's refused.
   */
  const table: Record<State, Record<InputName, State | null>> = {
    joining: {
      accept: "online",
      reject: "revoked",
      disconnected: null,
      reconnected: null,
      drain: null,
      "resume-connected": null,
      "resume-not-connected": null,
      revoke: "revoked",
    },
    online: {
      accept: null,
      reject: null,
      disconnected: "offline",
      reconnected: null,
      drain: "draining",
      "resume-connected": null,
      "resume-not-connected": null,
      revoke: "revoked",
    },
    offline: {
      accept: null,
      reject: null,
      disconnected: null,
      reconnected: "online",
      drain: "draining",
      "resume-connected": null,
      "resume-not-connected": null,
      revoke: "revoked",
    },
    draining: {
      accept: null,
      reject: null,
      disconnected: "draining",
      reconnected: "draining",
      drain: null,
      "resume-connected": "online",
      "resume-not-connected": "offline",
      revoke: "revoked",
    },
    revoked: {
      accept: null,
      reject: null,
      disconnected: null,
      reconnected: null,
      drain: null,
      "resume-connected": null,
      "resume-not-connected": null,
      revoke: null,
    },
  };

  it.each(states.flatMap((state) => inputs.map(([name, input]) => [state, name, table[state][name], input] as const)))(
    "F-091: from %s, %s goes to %s (null: refused), as the domain model's table says",
    (state, _name, expected, input) => {
      const moved = transitionRunner(r(state), input);
      if (expected === null) {
        expect(moved).toMatchObject({ ok: false });
      } else {
        expect(moved).toEqual({ ok: true, state: r(expected) });
      }
    },
  );

  it("takes tasks only online", () => {
    expect(takesTasks(r("online"))).toBe(true);
    expect(takesTasks(r("draining"))).toBe(false);
  });

  it.each(["joining", "online", "offline", "draining", "revoked"] as const)("round-trips %s", (state) => {
    expect(runnerFromColumns(runnerToColumns(r(state)))).toEqual({ ok: true, value: r(state) });
  });
});

describe("approval", () => {
  const member = memberIdSchema.parse("member-1");
  const option = optionIdSchema.parse("allow-once");
  const open: ApprovalLifecycle = { state: "open" };
  const answered: ApprovalLifecycle = { state: "answered", decision: "allow_once", optionId: option, memberId: member };
  lifecycleCases<ApprovalLifecycle, ApprovalInput>(
    transitionApproval,
    [
      [open, { type: "answer", decision: "allow_once", optionId: option, memberId: member }, answered],
      [open, { type: "rule_answer", decision: "deny", ruleId: "no-migrations" }, { state: "answered_by_rule", decision: "deny", ruleId: "no-migrations" }],
      [open, { type: "cancel" }, { state: "closed", reason: "cancelled" }],
      [open, { type: "expire" }, { state: "closed", reason: "expired" }],
    ],
    [
      [answered, { type: "answer", decision: "deny", optionId: option, memberId: member }],
      [{ state: "answered_by_rule", decision: "deny", ruleId: "r" }, { type: "cancel" }],
      [{ state: "closed", reason: "expired" }, { type: "expire" }],
    ],
  );

  it.each([
    open,
    answered,
    { state: "answered_by_rule", decision: "allow_task", ruleId: "r1" },
    { state: "closed", reason: "cancelled" },
  ] satisfies ApprovalLifecycle[])("round-trips %j", (approval) => {
    expect(approvalFromColumns(approvalToColumns(approval))).toEqual({ ok: true, value: approval });
  });
});

describe("needs-you item", () => {
  const n = (state: NeedsYouLifecycle["state"]): NeedsYouLifecycle => ({ state });
  lifecycleCases(
    transitionNeedsYou,
    [
      [n("open"), { type: "answer" }, n("answered")],
      [n("open"), { type: "dismiss" }, n("dismissed")],
    ],
    [
      [n("answered"), { type: "dismiss" }],
      [n("dismissed"), { type: "answer" }],
    ],
  );

  it.each(["open", "answered", "dismissed"] as const)("round-trips %s", (state) => {
    expect(needsYouFromColumns(needsYouToColumns(n(state)))).toEqual({ ok: true, value: n(state) });
  });
});

describe("task repo", () => {
  const pr = (state: "pr_open" | "merged" | "closed_unmerged"): TaskRepoLifecycle => ({ state, prNumber: 4 });
  lifecycleCases<TaskRepoLifecycle, TaskRepoInput>(
    transitionTaskRepo,
    [
      [{ state: "no_branch" }, { type: "pushed" }, { state: "branch_pushed" }],
      [{ state: "branch_pushed" }, { type: "pushed" }, { state: "branch_pushed" }],
      [{ state: "branch_pushed" }, { type: "pr_opened", prNumber: 4 }, pr("pr_open")],
      [pr("pr_open"), { type: "pushed" }, pr("pr_open")],
      [pr("pr_open"), { type: "pr_merged" }, pr("merged")],
      [pr("pr_open"), { type: "pr_closed" }, pr("closed_unmerged")],
      [pr("closed_unmerged"), { type: "pr_reopened" }, pr("pr_open")],
      [pr("merged"), { type: "fresh_branch" }, { state: "no_branch" }],
    ],
    [
      [{ state: "no_branch" }, { type: "pr_opened", prNumber: 1 }],
      [{ state: "branch_pushed" }, { type: "pr_merged" }],
      [pr("pr_open"), { type: "fresh_branch" }],
      [pr("merged"), { type: "pushed" }],
      [pr("closed_unmerged"), { type: "pr_merged" }],
    ],
  );

  it.each([{ state: "no_branch" }, { state: "branch_pushed" }, pr("pr_open"), pr("merged"), pr("closed_unmerged")] satisfies TaskRepoLifecycle[])(
    "round-trips %j",
    (repo) => {
      expect(taskRepoFromColumns(taskRepoToColumns(repo))).toEqual({ ok: true, value: repo });
    },
  );
});

describe("snapshot", () => {
  const sn = (state: Exclude<SnapshotLifecycle["state"], "failed">): SnapshotLifecycle => ({ state });
  lifecycleCases<SnapshotLifecycle, SnapshotInput>(
    transitionSnapshot,
    [
      [sn("queued"), { type: "build_started" }, sn("building")],
      [sn("building"), { type: "build_finished" }, sn("ready")],
      [sn("building"), { type: "build_failed", reason: "secret found" }, { state: "failed", reason: "secret found" }],
      [sn("ready"), { type: "newer_ready" }, sn("replaced")],
    ],
    [
      [sn("queued"), { type: "build_finished" }],
      [sn("building"), { type: "newer_ready" }],
      [sn("ready"), { type: "build_started" }],
      [sn("replaced"), { type: "newer_ready" }],
      [{ state: "failed", reason: "x" }, { type: "build_started" }],
    ],
  );

  it.each([sn("queued"), sn("building"), sn("ready"), sn("replaced"), { state: "failed", reason: "x" }] satisfies SnapshotLifecycle[])(
    "round-trips %j",
    (snapshot) => {
      expect(snapshotFromColumns(snapshotToColumns(snapshot))).toEqual({ ok: true, value: snapshot });
    },
  );
});

describe("lease", () => {
  const active: LeaseLifecycle = { state: "active", epoch: 3 };
  lifecycleCases(
    transitionLease,
    [[active, { type: "end", reason: "grace-expired" }, { state: "ended", epoch: 3, reason: "grace-expired" }]],
    [[{ state: "ended", epoch: 3, reason: "released" }, { type: "end", reason: "released" }]],
  );

  it("raises the epoch on every dispatch and refuses an older or ended one", () => {
    expect(nextEpoch(0)).toBe(1);
    expect(nextEpoch(3)).toBe(4);
    expect(acceptsWrite(active, 3)).toBe(true);
    expect(acceptsWrite(active, 2)).toBe(false);
    expect(acceptsWrite({ state: "ended", epoch: 3, reason: "grace-expired" }, 3)).toBe(false);
    expect(acceptsWrite(null, 1)).toBe(false);
  });

  it.each([active, { state: "ended", epoch: 2, reason: "offer-timeout" }] satisfies LeaseLifecycle[])("round-trips %j", (lease) => {
    expect(leaseFromColumns(leaseToColumns(lease))).toEqual({ ok: true, value: lease });
  });

  it("refuses an ended lease with an unknown reason", () => {
    expect(leaseFromColumns({ state: "ended", epoch: 1, endReason: "vanished" }).ok).toBe(false);
    expect(leaseFromColumns({ state: "active", epoch: 0, endReason: null }).ok).toBe(false);
  });
});
