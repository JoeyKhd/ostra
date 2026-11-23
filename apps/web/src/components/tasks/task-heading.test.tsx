import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { projectIdSchema, runnerIdSchema, taskIdSchema } from "@ostra/protocol";

import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";
import { composerWordsOf } from "@/task/thread/composer-words";
import type { ComposerSituation } from "@/task/thread/composer-words";

import { PhoneTaskSections } from "./phone-task-sections";
import { statusWithSubState } from "./review/task-rounds";
import { headingOf, openTabOf, reviewedOf, statusDoingOf, tabsOf } from "./task-heading";
import { nextTickIn, TaskStatusLine } from "./task-status-line";
import { composerMode } from "./task-ticket";
import { TaskTopBar } from "./task-top-bar";

// Milestone 10, ticket 15 (F-151/c7, F-151/c9; the README's choice 10 and 15, parts.md part 15,
// `s3.md`, `s2.md`, `s1.md`): a review task's page says only what a review does, and the status
// line names the box when no turn runs. The page's parts as the task page draws them, from
// `tasks.get`'s answer for S3 (the AI review of PR #483), S2 (its code task in review) and a refine
// task: the tabs, the key line, title and crumb, the top bar, the composer's words, and the status
// line on fake timers.

type Task = RouterOutputs["tasks"]["get"];

const now = Date.UTC(2026, 10, 22, 15, 52);
const codeTaskId = taskIdSchema.parse("01900000-0000-7000-8000-0000000000a1");
const reviewTaskId = taskIdSchema.parse("01900000-0000-7000-8000-0000000000a2");
const prUrl = "https://github.com/acme/calculator-web/pull/483";
const runner = { id: runnerIdSchema.parse("01900000-0000-7000-8000-0000000000a3"), name: "build-fleet-03", kind: "personal" as const, executor: "docker" as const, isolated: true };

const capabilities: Task["capabilities"] = {
  send: false,
  interrupt: false,
  answerApprovals: false,
  takeOver: false,
  setEffort: false,
  steersMidTurn: false,
  questionFreeText: false,
  stop: false,
  reopen: true,
  reopenInBox: false,
  reopenBlocked: null,
  reopenWithoutText: false,
  retrySync: false,
  answerQuestions: false,
  answerPlan: false,
};

/** A task as `tasks.get` answers for it: S2's `CALC-192` by default. */
const taskOf = (over: Partial<Task>): Task => ({
  id: codeTaskId,
  projectId: projectIdSchema.parse("01900000-0000-7000-8000-0000000000a4"),
  key: "CALC-192",
  title: "Add a history panel",
  kind: "code",
  source: "prompt",
  state: "in_review",
  subState: "ci_running",
  reviewOf: null,
  aiReview: null,
  review: null,
  roundCounts: { ci: { used: 0, limit: 2 }, review: { used: 0, limit: 2 }, automaticTurns: { used: 0, limit: 4 }, lastPersonActionAt: null },
  reason: null,
  group: "in-review",
  waiting: null,
  queue: null,
  branchName: "ostra/calc-192-history-panel",
  headSeq: 0,
  createdAt: now - 48 * 60_000,
  updatedAt: now,
  driver: null,
  creator: null,
  runner,
  repos: [
    {
      repoId: "01900000-0000-7000-8000-0000000000a5",
      fullName: "acme/calculator-web",
      checkoutDir: "calculator-web",
      branchName: "ostra/calc-192-history-panel",
      baseBranch: "main",
      state: "pr_open",
      headSha: "4be21c0e9f".padEnd(40, "0"),
      ci: null,
      pr: { number: 483, url: prUrl, state: "open" },
      behindBy: null,
      behindCheckedAt: null,
      pullRequests: [],
    },
  ],
  session: null,
  agent: null,
  effort: { level: "high", levels: [] },
  messageFiles: { model: null, agentTakesImages: false, oldRunner: null },
  needsYou: [],
  ticket: null,
  contextFiles: [],
  sync: [],
  sessions: [],
  box: { state: "idle", idleStopDueAt: now + 11 * 60_000, releasedAt: null, releaseReason: null, runnerName: "build-fleet-03", size: null, waiting: null },
  limit: null,
  startedAt: now - 48 * 60_000,
  approvals: [],
  questions: [],
  plan: null,
  taskRules: [],
  capabilities,
  usage: null,
  spend: { unit: "usd", spent: 0, cap: 25_000_000, reached: false },
  ...over,
});

/** S3: the AI review of PR #483, round 2 of 3, posted with one nit, its box released. */
const s3 = taskOf({
  id: reviewTaskId,
  key: "41b31700",
  title: "Review: Add a history panel",
  kind: "review",
  state: "done",
  subState: null,
  group: "finished",
  repos: [],
  reviewOf: { taskId: codeTaskId, key: "CALC-192", title: "Add a history panel", prs: [{ repo: "acme/calculator-web", number: 483, url: prUrl }], run: { round: 2, state: "posted", blocking: 0, nits: 1 } },
  review: { round: 2, limit: 3, state: "posted", blocking: 0, nits: 1, url: `${prUrl}#pullrequestreview-2`, codeTask: { id: codeTaskId, key: "CALC-192", title: "Add a history panel" }, prNumber: 483 },
  box: { state: "released", idleStopDueAt: null, releasedAt: now - 60_000, releaseReason: "session_ended", runnerName: "build-fleet-03", size: null, waiting: null },
});
const s2 = taskOf({});
const refine = taskOf({ kind: "refine", state: "needs_you", subState: null, reason: "draft_ready", group: "needs-you", repos: [], box: null, title: "Shape the history panel's ticket" });

const html = (node: ReactNode): string => renderToStaticMarkup(node);
const textOf = (markup: string): string => markup.replaceAll(/<[^>]+>/g, "").replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replaceAll(/\s+/g, " ").trim();

const topBarOf = (task: Task, properties: { readonly on: boolean } | null = null): string =>
  html(
    <TaskTopBar
      task={task}
      expanded={false}
      side={task.kind === "code" ? "properties" : null}
      onSide={() => undefined}
      onCollapse={() => undefined}
      stop={{ stopping: false, pending: false, run: () => undefined }}
      local={{ load: { kind: "loading" }, onOpen: () => undefined }}
      reviewed={reviewedOf(task)}
      properties={properties === null ? null : { on: properties.on, onToggle: () => undefined }}
    />,
  );

describe("a review task's page (F-151/c7)", () => {
  it("F-151/c7: a review task has exactly the Activity and Event log tabs; a `?tab=` it hasn't opens Activity", () => {
    expect(tabsOf("review")).toEqual(["activity", "events"]);
    for (const param of ["changes", "checks", "draft", "nonsense", null]) expect(openTabOf("review", param, false)).toBe("activity");
    expect(openTabOf("review", "events", false)).toBe("events");
  });

  it("F-151/c7: a review task's top bar has copy link, Properties, Open the code task and PR #483, and no Take it local, Changes, Checks or Stop", () => {
    const bar = topBarOf({ ...s3, capabilities: { ...capabilities, stop: false } }, { on: true });
    expect(bar).toContain('data-action="copy-link"');
    expect(bar).toContain('data-action="properties-toggle"');
    expect(bar).toContain('aria-pressed="true"');
    expect(bar).toContain(`href="/tasks/${codeTaskId}"`);
    expect(bar).toContain('data-action="open-code-task"');
    expect(bar).toContain('title="CALC-192 Add a history panel"');
    expect(textOf(bar)).toBe("Properties Open the code task PR #483");
    expect(bar).toContain(`href="${prUrl}"`);
    expect(bar).not.toContain('data-action="take-it-local"');
    expect(bar).not.toContain('data-action="stop"');
    expect(bar).not.toContain('data-action="open-review"');
    expect(bar).not.toContain('data-testid="side-pane-toggle"');
    // Nor a PR line on a phone: its checkout makes no PR (the code task's PR is the top bar's).
    const phone = html(<PhoneTaskSections task={{ ...s3, repos: s2.repos, canRetry: false }} retry={{ run: () => undefined, pending: false }} details={null} />);
    expect(phone).not.toContain('data-testid="phone-prs"');
    expect(html(<PhoneTaskSections task={{ ...s2, canRetry: false }} retry={{ run: () => undefined, pending: false }} details={null} />)).toContain('data-testid="phone-prs"');
    // Off, the toggle says so; Stop shows only while a turn runs (its session live).
    expect(topBarOf(s3, { on: false })).toContain('aria-pressed="false"');
    expect(topBarOf({ ...s3, state: "running", capabilities: { ...capabilities, stop: true } }, { on: true })).toContain('data-action="stop"');
  });

  it("F-151/c7: a review task's key line, title and crumb name what it reviews: `CALC-192 · AI review`, `Review of PR #483`", () => {
    expect(headingOf(s3)).toEqual({ key: "CALC-192", source: "AI review", title: "Review of PR #483", crumb: "Review of PR #483" });
    // Before its first round, from what it reviews; with no PR yet, its own title.
    expect(headingOf({ ...s3, review: null })).toEqual({ key: "CALC-192", source: "AI review", title: "Review of PR #483", crumb: "Review of PR #483" });
    const noPr = { ...s3, review: null, reviewOf: s3.reviewOf === null ? null : { ...s3.reviewOf, prs: [] } };
    expect(headingOf(noPr).title).toBe("Review: Add a history panel");
  });

  it("F-151/c7: a review task's composer reopens the review on a fresh box", () => {
    const mode = composerMode({ state: "done", send: false, reopen: true, boxState: "released" });
    if (mode.kind !== "reopen") throw new Error("a done review reopens");
    const situation: ComposerSituation = { agent: "OpenCode", running: false, interrupt: false, steers: true, waits: null, refine: false, review: true };
    expect(composerWordsOf(mode, situation)).toEqual({ placeholder: "Message OpenCode to reopen the review…", hint: "Send reopens the review on a fresh box.", send: "Reopen" });
    expect(composerWordsOf(mode, { ...situation, review: false }).placeholder).toBe("Reopen with a message…");
  });

  it("F-151/c7: a refine task keeps its Draft tab and has no Take it local", () => {
    expect(tabsOf("refine")).toEqual(["activity", "draft", "events"]);
    expect(openTabOf("refine", null, true)).toBe("draft");
    expect(openTabOf("refine", null, false)).toBe("activity");
    expect(openTabOf("refine", "changes", true)).toBe("activity");
    const bar = topBarOf({ ...refine, capabilities: { ...capabilities, stop: true } });
    expect(bar).toContain('data-action="copy-link"');
    expect(bar).toContain('data-action="stop"');
    expect(bar).not.toContain('data-action="take-it-local"');
    expect(bar).not.toContain('data-action="open-code-task"');
    expect(headingOf(refine)).toEqual({ key: "CALC-192", source: "from a prompt", title: "Shape the history panel's ticket", crumb: "CALC-192" });
  });

  it("F-151/c7: a code task's tabs and top bar are unchanged: Preview | Properties, copy link, Review, PR #483, Take it local", () => {
    expect(tabsOf("code")).toEqual(["activity", "changes", "checks", "events"]);
    expect(openTabOf("code", "checks", false)).toBe("checks");
    expect(openTabOf("code", "draft", false)).toBe("activity");
    const bar = topBarOf(s2);
    expect(bar).toContain('data-testid="side-pane-toggle"');
    const order = ["side-pane-toggle", "copy-link", "open-review", "PR #483", "take-it-local"].map((mark) => bar.indexOf(mark));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(bar).not.toContain('data-action="open-code-task"');
    expect(bar).not.toContain('data-action="properties-toggle"');
    expect(bar).not.toContain('data-action="stop"');
    // Stop while the session is live (`s1.md`, `s5.md`).
    expect(topBarOf({ ...s2, state: "running", capabilities: { ...capabilities, stop: true } })).toContain('data-action="stop"');
    expect(headingOf(s2)).toEqual({ key: "CALC-192", source: "from a prompt", title: "Add a history panel", crumb: "CALC-192" });
  });
});

describe("the status line (F-151/c9)", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
  afterEach(() => { vi.useRealTimers(); });

  const lineOf = (task: Task, over: { readonly running?: boolean; readonly doing?: ReturnType<typeof statusDoingOf>; readonly place?: string | null } = {}): string =>
    textOf(
      html(
        <TaskStatusLine
          task={task}
          label={statusWithSubState(task)}
          running={over.running ?? false}
          doing={over.doing ?? []}
          place={over.place ?? null}
          review={task.review}
          stoppedAt={null}
          reconnecting={false}
        />,
      ),
    );

  it("F-151/c9: with no turn running it reads `box idle, stops in 11 min` and counts down each minute, then `box released`", () => {
    expect(lineOf(s2, { place: "PR #483" })).toBe("In review · CI running·PR #483·box idle, stops in 11 min");
    // The minutes are rounded up, and the line ticks when they change: exactly a minute on, then each minute.
    expect(nextTickIn(now + 11 * 60_000, now)).toBe(60_000);
    expect(nextTickIn(now + 10 * 60_000 + 30_000, now)).toBe(30_000);
    vi.advanceTimersByTime(30_000);
    expect(lineOf(s2, { place: "PR #483" })).toBe("In review · CI running·PR #483·box idle, stops in 11 min");
    vi.advanceTimersByTime(30_000);
    expect(lineOf(s2, { place: "PR #483" })).toBe("In review · CI running·PR #483·box idle, stops in 10 min");
    vi.advanceTimersByTime(9 * 60_000);
    expect(lineOf(s2, { place: "PR #483" })).toBe("In review · CI running·PR #483·box idle, stops in 1 min");
    // The idle minutes are up: the box is released.
    vi.advanceTimersByTime(60_000);
    const released = { ...s2, box: { state: "released" as const, idleStopDueAt: null, releasedAt: Date.now(), releaseReason: "idle_expired" as const, runnerName: "build-fleet-03", size: null, waiting: null } };
    expect(lineOf(released, { place: "PR #483" })).toBe("In review · CI running·PR #483·box released");
  });

  it("F-151/c9: a stopped box reads `box stopped`; S3 reads its round and `box released`", () => {
    const stopped = { ...s2, state: "done" as const, subState: null, box: { state: "stopped" as const, idleStopDueAt: null, releasedAt: null, releaseReason: null, runnerName: "build-fleet-03", size: null, waiting: null } };
    expect(lineOf(stopped)).toBe("Done·box stopped");
    expect(lineOf(s3)).toBe("Done·round 2 of 3: nothing blocking, 1 nit·box released");
    // Before its hand-in, the round alone.
    expect(lineOf({ ...s3, state: "running", review: s3.review === null ? null : { ...s3.review, state: "running", nits: 0 } }, { running: true })).toBe("Running·round 2 of 3·Started 48 min ago on build-fleet-03");
  });

  it("F-151/c9: while a turn runs, the activity and `Started … on {runner}`, and no box words", () => {
    const working = taskOf({ state: "running", subState: null, group: "running", createdAt: now - 4 * 60_000, box: { state: "running", idleStopDueAt: null, releasedAt: null, releaseReason: null, runnerName: "build-fleet-03", size: null, waiting: null } });
    const doing = statusDoingOf({ kind: "running", command: "pnpm test history" });
    expect(lineOf(working, { running: true, doing })).toBe("Running·Running pnpm test history·Started 4 min ago on build-fleet-03");
    // A box `tasks.get` still calls idle says nothing while the turn runs.
    const idleBox = { ...working, box: s2.box };
    expect(lineOf(idleBox, { running: true, doing })).toBe("Running·Running pnpm test history·Started 4 min ago on build-fleet-03");
    // A file by its name (`s5.md`): `Editing shortcuts.ts`.
    expect(statusDoingOf({ kind: "editing", path: "src/keys/shortcuts.ts" }).map((segment) => segment.text).join("")).toBe("Editing shortcuts.ts");
    expect(statusDoingOf({ kind: "editing", path: "src/keys/shortcuts.ts" }).find((segment) => segment.mono)?.text).toBe("shortcuts.ts");
    expect(statusDoingOf(null)).toEqual([]);
    expect(t("task.status.box.released")).toBe("box released");
  });
});
