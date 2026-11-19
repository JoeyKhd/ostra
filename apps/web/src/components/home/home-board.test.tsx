import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { boardColumns, boardEmpty, cardStatusParts, columnChip, homeHref, moreWords, viewOf } from "./board-words";
import type { BoardCard, BoardData } from "./board-words";
import { BoardColumn, HomeBoard, HomeToolbar, TaskCard } from "./home-board";

// F-062: Home's board view (home-board.md): every task the member can open, in five columns by
// lifecycle state, each card with its project's square, key, age, title, status line and driver.

const now = Date.UTC(2026, 10, 19, 10, 0);
const noop = () => undefined;
const text = (card: BoardCard): string => cardStatusParts(card.status).map((part) => part.text).join("");

const card = (over: Partial<BoardCard> & Pick<BoardCard, "taskId" | "status">): BoardCard => ({
  project: { id: "p-calc", name: "calculator" },
  key: "CALC-142",
  title: "Retry webhook delivery on 5xx",
  driver: "Alex Kim",
  since: now - 4 * 60_000,
  ...over,
});

const approval = card({ taskId: "t1", status: { kind: "needs-you", detail: { reason: "approval", command: "pnpm add p-retry", subject: null, ruleName: null } } });
const queued = card({ taskId: "t2", key: "PIPE-31", status: { kind: "queued", on: { kind: "pool", name: "build-fleet" } } });
const running = card({ taskId: "t3", status: { kind: "running", activity: { verb: "running", subject: "pnpm test percent" } } });
const preparing = card({ taskId: "t4", key: null, driver: null, status: { kind: "preparing", step: "restoring-snapshot" } });
const review = card({ taskId: "t5", status: { kind: "in-review", prs: [481], step: "ci-running" } });
const merged = card({ taskId: "t6", status: { kind: "merged", prs: [2207] } });
const stopped = card({ taskId: "t7", status: { kind: "stopped", reason: { kind: "spend-cap" } } });

const board: BoardData = {
  "needs-you": { total: 5, cards: [approval], next: "c1" },
  queued: { total: 1, cards: [queued], next: null },
  running: { total: 238, cards: [running, preparing], next: "c2" },
  "in-review": { total: 1, cards: [review], next: null },
  finished: { total: 2, cards: [merged, stopped], next: null },
};
const emptyBoard: BoardData = {
  "needs-you": { total: 0, cards: [], next: null },
  queued: { total: 0, cards: [], next: null },
  running: { total: 0, cards: [], next: null },
  "in-review": { total: 0, cards: [], next: null },
  finished: { total: 0, cards: [], next: null },
};

describe("the board's columns", () => {
  it("F-062: five columns in the lifecycle's order, each with its full total and its cards", () => {
    const html = renderToStaticMarkup(<HomeBoard load={{ kind: "ready", data: board }} now={now} onMore={noop} projectName={null} />);
    const order = [...html.matchAll(/data-column="([a-z-]+)"/g)].map((match) => match[1]);
    expect(order).toEqual(["needs-you", "queued", "running", "in-review", "finished"]);
    expect(boardColumns).toEqual(order);
    expect(html).toMatch(/data-column="running"[\s\S]*?data-count="true">238</);
    expect(html).toContain('href="/tasks/t1"');
    expect(html).toContain('data-card="t7"');
  });

  it("F-062: a column past its page offers the rest; an empty column says so and keeps its place", () => {
    expect(moreWords(board.running)).toBe("236 more");
    expect(moreWords(board.queued)).toBeNull();
    const html = renderToStaticMarkup(<BoardColumn column="queued" load={{ kind: "ready", data: { total: 0, cards: [], next: null } }} now={now} onMore={noop} />);
    expect(html).toContain("Nothing queued.");
    expect(html).toContain(">0<");
    expect(renderToStaticMarkup(<BoardColumn column="finished" load={{ kind: "ready", data: { total: 0, cards: [], next: null } }} now={now} onMore={noop} />)).toContain("Nothing finished this week.");
  });

  it("F-062: loading shows a dash and three skeleton cards; a failure keeps the header and offers Retry", () => {
    const loading = renderToStaticMarkup(<BoardColumn column="running" load={{ kind: "loading" }} now={now} onMore={noop} />);
    expect(loading).toContain("–");
    expect(loading.match(/h-\[100px\]/g)?.length).toBe(3);
    const failed = renderToStaticMarkup(<BoardColumn column="running" load={{ kind: "error", retry: noop }} now={now} onMore={noop} />);
    expect(failed).toContain("Running");
    expect(failed).toContain("Retry");
  });

  it("F-062: no tasks at all, and none in the picked project", () => {
    expect(boardEmpty(emptyBoard)).toBe(true);
    expect(boardEmpty(board)).toBe(false);
    expect(renderToStaticMarkup(<HomeBoard load={{ kind: "ready", data: emptyBoard }} now={now} onMore={noop} projectName={null} />)).toContain("No tasks yet. Start one with New task, or from a ticket.");
    expect(renderToStaticMarkup(<HomeBoard load={{ kind: "ready", data: emptyBoard }} now={now} onMore={noop} projectName="calculator" />)).toContain("No tasks in calculator yet.");
  });

  it("F-062, F-075: on a phone the state picker names each column with its total", () => {
    expect(columnChip("needs-you", board)).toBe("Needs you 5");
    expect(columnChip("needs-you", null)).toBe("Needs you");
  });
});

describe("a card", () => {
  it("F-062: each state's status line", () => {
    expect(text(approval)).toBe("Approval: pnpm add p-retry");
    expect(text(queued)).toBe("Waiting for a box on build-fleet");
    expect(text(card({ taskId: "x", status: { kind: "queued", on: { kind: "personal" } } }))).toBe("Waiting for your runner");
    expect(text(running)).toBe("Running pnpm test percent");
    expect(text(card({ taskId: "x", status: { kind: "running", activity: { verb: "editing", subject: "src/settings/theme.ts" } } }))).toBe("Editing src/settings/theme.ts");
    expect(text(preparing)).toBe("Preparing · restoring snapshot");
    expect(text(review)).toBe("PR #481 · CI running");
    expect(text(card({ taskId: "x", status: { kind: "in-review", prs: [1, 2, 3], step: "ci-running" } }))).toBe("3 PRs · CI running");
    expect(text(merged)).toBe("Merged · PR #2207");
    expect(text(card({ taskId: "x", status: { kind: "merged", prs: [1, 2] } }))).toBe("Merged · 2 PRs");
    expect(text(card({ taskId: "x", status: { kind: "done" } }))).toBe("Done");
    expect(text(stopped)).toBe("Stopped: spend cap reached");
    expect(text(card({ taskId: "x", status: { kind: "stopped", reason: { kind: "by", name: "Sam Rivera" } } }))).toBe("Stopped: by Sam Rivera");
  });

  it("F-062: the card's lines; commands in mono; a prompt task says Prompt; no driver, no avatar", () => {
    const html = renderToStaticMarkup(<TaskCard card={approval} now={now} />);
    expect(html).toContain("CALC-142");
    expect(html).toContain(">4m<");
    expect(html).toContain('<code class="font-mono text-[11.5px] text-text">pnpm add p-retry</code>');
    expect(html).toContain('aria-label="Alex Kim"');
    expect(html).toContain("calculator");
    const prompt = renderToStaticMarkup(<TaskCard card={preparing} now={now} />);
    expect(prompt).toContain(">Prompt<");
    expect(prompt).not.toContain("role=\"img\"");
  });
});

describe("the toolbar and the URL", () => {
  it("F-062: ?view=board picks the board, the overview has no parameter, a project adds its own", () => {
    expect(viewOf(new URLSearchParams("view=board"))).toBe("board");
    expect(viewOf(new URLSearchParams(""))).toBe("overview");
    expect(viewOf(new URLSearchParams("view=nonsense"))).toBe("overview");
    expect(homeHref("overview", "p1")).toBe("/");
    expect(homeHref("board", null)).toBe("/?view=board");
    expect(homeHref("board", "p 1")).toBe("/?view=board&project=p%201");
  });

  it("F-062: the project filter and the window note show on the board only", () => {
    const projects = [{ id: "b", name: "billing-platform" }, { id: "a", name: "calculator" }];
    const onBoard = renderToStaticMarkup(<HomeToolbar view="board" onView={noop} projects={projects} project={null} onProject={noop} />);
    expect(onBoard).toContain("Finished: last 7 days");
    expect(onBoard).toContain('aria-label="Project"');
    const onOverview = renderToStaticMarkup(<HomeToolbar view="overview" onView={noop} projects={projects} project={null} onProject={noop} />);
    expect(onOverview).not.toContain("Finished: last 7 days");
    expect(onOverview).toContain("Overview");
    expect(onOverview).toContain("Board");
  });
});
