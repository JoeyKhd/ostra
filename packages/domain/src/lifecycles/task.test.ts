import { describe, expect, it } from "vitest";

import { taskFromColumns, taskToColumns } from "./mapping.ts";
import { isActive, newTask, transitionTask } from "./task.ts";
import type { CodeTaskState, CommonTaskState, RefineTaskState, ReviewRounds, TaskInput, TaskLifecycle } from "./task.ts";

const off: ReviewRounds = { ci: false, aiReview: false };
const code = (status: CodeTaskState): TaskLifecycle => ({ kind: "code", status });
const refine = (status: RefineTaskState): TaskLifecycle => ({ kind: "refine", status });
const review = (status: RefineTaskState): TaskLifecycle => ({ kind: "review", status });

const step = (task: TaskLifecycle, input: TaskInput): TaskLifecycle => {
  const next = transitionTask(task, input);
  if (!next.ok) {
    throw new Error(next.reason);
  }
  return next.state;
};

// Names the new lifecycle `task`, so the tables read "from, input, to".
const go = (task: TaskLifecycle, input: TaskInput) => {
  const next = transitionTask(task, input);
  return next.ok ? { ok: true as const, task: next.state } : next;
};

describe("milestone 1's path for a code task", () => {
  it("goes queued → preparing → running → in review, waiting for a reviewer, with the review rounds off", () => {
    let task = newTask("code", false);
    expect(task).toEqual(code({ state: "queued" }));
    for (const input of [
      { type: "runner_accepted" },
      { type: "box_ready" },
      { type: "session_ended", withChanges: true, rounds: off },
    ] satisfies TaskInput[]) {
      const next = go(task, input);
      expect(next.ok).toBe(true);
      if (next.ok) {
        task = next.task;
      }
    }
    expect(task).toEqual(code({ state: "in_review", subState: "waiting_for_reviewer" }));
  });

  it("goes to needs you when the session ends without changes (F-065)", () => {
    expect(go(code({ state: "running" }), { type: "session_ended", withChanges: false, rounds: off })).toEqual({
      ok: true,
      task: code({ state: "needs_you", reason: "no_changes" }),
    });
  });

  it("goes to needs you when setup fails or the session crashes", () => {
    expect(go(code({ state: "preparing" }), { type: "setup_failed" })).toEqual({
      ok: true,
      task: code({ state: "needs_you", reason: "setup_failed" }),
    });
    expect(go(code({ state: "running" }), { type: "crashed" })).toEqual({
      ok: true,
      task: code({ state: "needs_you", reason: "crashed" }),
    });
    expect(go(code({ state: "preparing" }), { type: "crashed" })).toEqual({
      ok: true,
      task: code({ state: "needs_you", reason: "crashed" }),
    });
  });

  it("stops from queued, preparing and running (F-025)", () => {
    for (const status of [{ state: "queued" }, { state: "preparing" }, { state: "running" }] satisfies CodeTaskState[]) {
      expect(go(code(status), { type: "stop", reason: "requested" })).toEqual({
        ok: true,
        task: code({ state: "stopped", reason: "requested" }),
      });
    }
  });
});

describe("every kind's shared arrows", () => {
  const kinds = [
    ["code", code],
    ["refine", refine],
    ["review", review],
  ] as const;

  const arrows: readonly (readonly [CommonTaskState, TaskInput, CommonTaskState])[] = [
    [{ state: "awaiting_approval" }, { type: "approve" }, { state: "queued" }],
    [{ state: "awaiting_approval" }, { type: "reject" }, { state: "stopped", reason: "rejected" }],
    [{ state: "queued" }, { type: "runner_accepted" }, { state: "preparing" }],
    [{ state: "preparing" }, { type: "box_ready" }, { state: "running" }],
    [{ state: "preparing" }, { type: "setup_failed" }, { state: "needs_you", reason: "setup_failed" }],
    [{ state: "running" }, { type: "needs_you", reason: "question" }, { state: "needs_you", reason: "question" }],
    [{ state: "running" }, { type: "needs_you", reason: "spend_cap" }, { state: "needs_you", reason: "spend_cap" }],
    [{ state: "running" }, { type: "crashed" }, { state: "needs_you", reason: "crashed" }],
    [{ state: "needs_you", reason: "question" }, { type: "member_acted", boxWarm: false }, { state: "queued" }],
    [{ state: "needs_you", reason: "approval" }, { type: "member_acted", boxWarm: true }, { state: "running" }],
    [{ state: "needs_you", reason: "plan" }, { type: "stop", reason: "requested" }, { state: "stopped", reason: "requested" }],
    [{ state: "awaiting_approval" }, { type: "stop", reason: "requested" }, { state: "stopped", reason: "requested" }],
    [{ state: "stopped", reason: "requested" }, { type: "reopen" }, { state: "queued" }],
  ];

  for (const [kind, make] of kinds) {
    it.each(arrows.map(([from, input, to]) => [from.state, input.type, to.state, from, input, to] as const))(
      `${kind}: %s --%s--> %s`,
      (_from, _input, _to, from, input, to) => {
        expect(go(make(from), input)).toEqual({ ok: true, task: make(to) });
      },
    );
  }

  it("a new task from outside ostra awaits approval", () => {
    expect(newTask("refine", true)).toEqual(refine({ state: "awaiting_approval" }));
    expect(newTask("review", false)).toEqual(review({ state: "queued" }));
  });
});

describe("code: in review", () => {
  const ci = { ci: true, aiReview: true };
  const inReview = (subState: Extract<CodeTaskState, { state: "in_review" }>["subState"]) =>
    code({ state: "in_review", subState });

  it.each([
    ["running", code({ state: "running" }), { type: "session_ended", withChanges: true, rounds: ci }, inReview("ci_running")],
    [
      "running, AI review only",
      code({ state: "running" }),
      { type: "session_ended", withChanges: true, rounds: { ci: false, aiReview: true } },
      inReview("ai_review"),
    ],
    ["ci_running passes", inReview("ci_running"), { type: "ci_passed", rounds: ci }, inReview("ai_review")],
    ["ci_running passes, no AI review", inReview("ci_running"), { type: "ci_passed", rounds: { ci: true, aiReview: false } }, inReview("waiting_for_reviewer")],
    ["ci_running fails", inReview("ci_running"), { type: "ci_failed", capReached: false }, inReview("fixing_ci")],
    ["ci_running fails at the cap", inReview("ci_running"), { type: "ci_failed", capReached: true }, code({ state: "needs_you", reason: "round_cap" })],
    ["fixing_ci pushes", inReview("fixing_ci"), { type: "pushed" }, inReview("ci_running")],
    ["ai_review blocking", inReview("ai_review"), { type: "ai_review_done", blocking: true, capReached: false }, inReview("fixing_findings")],
    ["ai_review blocking at the cap", inReview("ai_review"), { type: "ai_review_done", blocking: true, capReached: true }, code({ state: "needs_you", reason: "round_cap" })],
    ["ai_review clean", inReview("ai_review"), { type: "ai_review_done", blocking: false, capReached: false }, inReview("waiting_for_reviewer")],
    ["fixing_findings pushes", inReview("fixing_findings"), { type: "pushed" }, inReview("ci_running")],
    ["fixing_ci crashes", inReview("fixing_ci"), { type: "crashed" }, code({ state: "needs_you", reason: "crashed" })],
    ["fixing_findings at the spend cap", inReview("fixing_findings"), { type: "needs_you", reason: "spend_cap" }, code({ state: "needs_you", reason: "spend_cap" })],
    ["waiting: changes requested", inReview("waiting_for_reviewer"), { type: "changes_requested" }, code({ state: "queued" })],
    ["waiting: @ostra", inReview("waiting_for_reviewer"), { type: "member_acted", boxWarm: false }, code({ state: "queued" })],
    ["waiting: the last PR merges", inReview("waiting_for_reviewer"), { type: "last_pr_merged" }, code({ state: "merged" })],
    ["every PR closed", inReview("ci_running"), { type: "all_prs_closed" }, code({ state: "stopped", reason: "prs_closed" })],
    ["stopped in review", inReview("ai_review"), { type: "stop", reason: "requested" }, code({ state: "stopped", reason: "requested" })],
    ["merged reopens", code({ state: "merged" }), { type: "reopen" }, code({ state: "queued" })],
    ["a merged task's PR reopened on the host (Q107)", code({ state: "merged" }), { type: "pr_reopened" }, inReview("waiting_for_reviewer")],
    ["a task stopped as prs_closed, its PR reopened", code({ state: "stopped", reason: "prs_closed" }), { type: "pr_reopened" }, inReview("waiting_for_reviewer")],
  ] satisfies readonly (readonly [string, TaskLifecycle, TaskInput, TaskLifecycle])[])("%s", (_name, from, input, to) => {
    expect(go(from, input)).toEqual({ ok: true, task: to });
  });
});

describe("refine and review", () => {
  it("refine: running → needs you (the draft) → done → reopened", () => {
    let task = refine({ state: "running" });
    task = step(task, { type: "draft_handed_in" });
    expect(task).toEqual(refine({ state: "needs_you", reason: "draft_ready" }));
    task = step(task, { type: "draft_accepted" });
    expect(task).toEqual(refine({ state: "done" }));
    expect(step(task, { type: "reopen" })).toEqual(refine({ state: "queued" }));
  });

  it("review: running → done (findings posted) → the next round reopens it", () => {
    const done = step(review({ state: "running" }), { type: "findings_posted" });
    expect(done).toEqual(review({ state: "done" }));
    expect(step(done, { type: "reopen" })).toEqual(review({ state: "queued" }));
  });
});

describe("refused inputs: at least one per state", () => {
  it.each([
    ["awaiting_approval", code({ state: "awaiting_approval" }), { type: "box_ready" }],
    ["queued", code({ state: "queued" }), { type: "approve" }],
    ["queued: no session to end", code({ state: "queued" }), { type: "session_ended", withChanges: true, rounds: off }],
    ["preparing", code({ state: "preparing" }), { type: "runner_accepted" }],
    ["running", code({ state: "running" }), { type: "reopen" }],
    ["running: no PR to merge", code({ state: "running" }), { type: "last_pr_merged" }],
    ["running: no PR to reopen", code({ state: "running" }), { type: "pr_reopened" }],
    ["stopped by a member: a PR reopened doesn't restart it", code({ state: "stopped", reason: "requested" }), { type: "pr_reopened" }],
    ["refine: no PR", refine({ state: "done" }), { type: "pr_reopened" }],
    ["needs_you", code({ state: "needs_you", reason: "no_changes" }), { type: "box_ready" }],
    ["stopped", code({ state: "stopped", reason: "requested" }), { type: "stop", reason: "requested" }],
    ["in_review/waiting", code({ state: "in_review", subState: "waiting_for_reviewer" }), { type: "pushed" }],
    ["in_review/ci_running", code({ state: "in_review", subState: "ci_running" }), { type: "ai_review_done", blocking: false, capReached: false }],
    ["in_review/fixing_ci", code({ state: "in_review", subState: "fixing_ci" }), { type: "ci_passed", rounds: off }],
    ["in_review/ai_review", code({ state: "in_review", subState: "ai_review" }), { type: "crashed" }],
    ["in_review/fixing_findings", code({ state: "in_review", subState: "fixing_findings" }), { type: "ci_failed", capReached: false }],
    ["merged", code({ state: "merged" }), { type: "box_ready" }],
    ["code: no drafts", code({ state: "running" }), { type: "draft_handed_in" }],
    ["refine: no PRs", refine({ state: "running" }), { type: "session_ended", withChanges: true, rounds: off }],
    ["refine: accept without a draft", refine({ state: "needs_you", reason: "question" }), { type: "draft_accepted" }],
    ["refine done", refine({ state: "done" }), { type: "box_ready" }],
    ["review: no CI", review({ state: "running" }), { type: "ci_passed", rounds: off }],
    ["review done", review({ state: "done" }), { type: "findings_posted" }],
  ] satisfies readonly (readonly [string, TaskLifecycle, TaskInput])[])("%s", (_name, from, input) => {
    const next = transitionTask(from, input);
    expect(next.ok).toBe(false);
    expect(next.ok ? "" : next.reason).toContain(input.type);
  });
});

describe("the column mapping", () => {
  const every: readonly TaskLifecycle[] = [
    ...(["code", "refine", "review"] as const).flatMap((kind) =>
      (
        [
          { state: "awaiting_approval" },
          { state: "queued" },
          { state: "preparing" },
          { state: "running" },
          { state: "needs_you", reason: "question" },
          { state: "needs_you", reason: "no_changes" },
          { state: "stopped", reason: "prs_closed" },
        ] satisfies CommonTaskState[]
      ).map((status) => ({ kind, status })),
    ),
    ...(["ci_running", "fixing_ci", "ai_review", "fixing_findings", "waiting_for_reviewer"] as const).map((subState) =>
      code({ state: "in_review", subState }),
    ),
    code({ state: "merged" }),
    refine({ state: "done" }),
    review({ state: "done" }),
  ];

  it.each(every.map((task) => [`${task.kind} ${JSON.stringify(task.status)}`, task] as const))("%s round-trips", (_name, task) => {
    expect(taskFromColumns(taskToColumns(task))).toEqual({ ok: true, value: task });
  });

  it("refuses columns the check constraints forbid", () => {
    const base = { kind: "code", state: "queued", subState: null, needsYouReason: null, stoppedReason: null } as const;
    expect(taskFromColumns({ ...base, subState: "ci_running" }).ok).toBe(false);
    expect(taskFromColumns({ ...base, state: "in_review" }).ok).toBe(false);
    expect(taskFromColumns({ ...base, state: "needs_you" }).ok).toBe(false);
    expect(taskFromColumns({ ...base, state: "needs_you", needsYouReason: "waiting_for_reviewer" }).ok).toBe(false);
    expect(taskFromColumns({ ...base, state: "done" }).ok).toBe(false);
    expect(taskFromColumns({ ...base, kind: "refine", state: "merged" }).ok).toBe(false);
  });

  it("knows which tasks hold a lease's work", () => {
    expect(isActive(code({ state: "running" }))).toBe(true);
    expect(isActive(code({ state: "in_review", subState: "fixing_ci" }))).toBe(true);
    expect(isActive(code({ state: "in_review", subState: "waiting_for_reviewer" }))).toBe(false);
    expect(isActive(code({ state: "queued" }))).toBe(false);
  });
});
