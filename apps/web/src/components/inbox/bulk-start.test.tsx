import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { boardIdSchema, poolIdSchema, taskIdSchema, ticketIdSchema } from "@ostra/protocol";
import type { TaskId, TicketId } from "@ostra/protocol";

import { progressOf } from "@/components/tickets/parent-progress";
import type { Child } from "@/components/tickets/parent-progress";
import type { RouterOutputs } from "@/lib/trpc";

import { planOf, plannedTasks, ResultLine, resultOfItem } from "./bulk-start";
import { TicketRow } from "./inbox-view";
import type { InboxTicket } from "./inbox-words";

// Ticket 32 (F-107, F-077): what a ticked ticket's start would do, the tick column, and a parent's
// progress over its sub-issues.

const now = Date.UTC(2026, 10, 20, 12);
const id = (n: number): TicketId => ticketIdSchema.parse(`01900000-0000-7000-8000-${String(n).padStart(12, "0")}`);
const task = (n: number): TaskId => taskIdSchema.parse(`01900000-0000-7000-9000-${String(n).padStart(12, "0")}`);

const ticket = (n: number, over: Partial<InboxTicket> = {}): InboxTicket => ({
  id: id(n),
  key: `CALC-${String(n)}`,
  title: `Ticket ${String(n)}`,
  url: `https://linear.app/acme/issue/CALC-${String(n)}`,
  board: { id: boardIdSchema.parse("01900000-0000-7000-8000-0000000000b1"), name: "Calculator", key: "CALC" },
  status: { id: "s-todo", name: "Todo", category: "open" },
  priority: null,
  labels: [],
  assignee: null,
  updatedAt: now,
  task: null,
  subIssues: 0,
  codeStart: { tasks: 1, overLimit: false },
  ...over,
});

describe("a bulk start's plan (inbox-bulk-start.md)", () => {
  it("F-107/c1: counts one task per plain ticket, one per sub-issue for a parent's code start, and none for a ticket that has a task", () => {
    const plain = ticket(1);
    const held = ticket(2, { task: { id: task(2), state: "queued", active: true, shortId: "a17be093" } });
    const parent = ticket(3, { subIssues: 3, codeStart: { tasks: 3, overLimit: false } });
    expect(planOf(plain, "code")).toEqual({ kind: "start", tasks: 1 });
    expect(planOf(held, "code")).toEqual({ kind: "skip", tasks: 0, reason: "has-task" });
    expect(planOf(parent, "code")).toEqual({ kind: "sub-issues", tasks: 3 });
    expect(plannedTasks([plain, held, parent], "code")).toBe(4);
  });

  it("F-077: a parent over the limit, or with no sub-issue on the project's boards, starts nothing; a refine start refines the parent itself", () => {
    const over = ticket(4, { subIssues: 64, codeStart: { tasks: 64, overLimit: true } });
    const elsewhere = ticket(5, { subIssues: 1, codeStart: { tasks: 0, overLimit: false } });
    expect(planOf(over, "code")).toMatchObject({ kind: "skip", reason: "over-limit", count: 64 });
    expect(planOf(elsewhere, "code")).toMatchObject({ kind: "skip", reason: "no-leaf" });
    expect(planOf(over, "refine")).toEqual({ kind: "start", tasks: 1 });
  });

  it("F-107: a row's tick is a labelled checkbox, and a ticked parent says how many tasks it starts", () => {
    const parent = ticket(6, { subIssues: 2, codeStart: { tasks: 2, overLimit: false } });
    const html = renderToStaticMarkup(
      <TicketRow ticket={parent} several={false} selected={false} onSelect={() => undefined} now={now} tick={{ ticked: true, disabled: false, onTick: () => undefined, startsTasks: 2, parentHref: "/projects/p/tickets/t" }} />,
    );
    expect(html).toContain('aria-label="Select CALC-6"');
    expect(html).toContain("2 sub-issues");
    expect(html).toContain("starts 2 tasks");
    expect(html).toContain('href="/projects/p/tickets/t"');
  });
});

const child = (n: number, state: NonNullable<Child["task"]>["state"] | null, over: Partial<Child> = {}): Child => ({
  key: `CALC-${String(n)}`,
  title: `Child ${String(n)}`,
  url: `https://linear.app/acme/issue/CALC-${String(n)}`,
  open: true,
  depth: 1,
  parentKey: "CALC-180",
  ticketId: id(n),
  place: "board",
  leaf: true,
  skipped: null,
  task: state === null ? null : { id: task(n), shortId: "3f9c21ab", state, needsYou: null, prs: [] },
  ...over,
});

describe("a bulk start's results (inbox-bulk-start.md)", () => {
  const item = (state: "running" | "queued", wait: NonNullable<RouterOutputs["inbox"]["bulkStart"]["items"][number]["task"]>["wait"]) =>
    resultOfItem(
      {
        ticket: { id: id(7), key: "CALC-7", title: "Ticket 7" },
        state: "started",
        reason: null,
        task: { id: task(7), shortId: "0000000a", state, wait, poolName: wait === null ? null : "build-fleet" },
      },
      "calculator",
    );

  it("F-107/c1: a started task says its state with its ID, and a queued one says why it waits", () => {
    const running = renderToStaticMarkup(<ResultLine result={item("running", null)} />);
    expect(running).toContain("Started");
    expect(running).toContain("Running · ");
    expect(running).toContain(">0000000a</a>");
    const queued = renderToStaticMarkup(<ResultLine result={item("queued", { code: "pool-full", poolId: poolIdSchema.parse("01900000-0000-7000-8000-0000000000f1") })} />);
    expect(queued).toContain("Queued");
    expect(queued).toContain(">0000000a</a> · build-fleet is at its cap of boxes.");
    expect(queued).not.toContain("Started");
  });
});

describe("a parent's progress (ticket-parent.md)", () => {
  it("F-077/c2: merged fills first, then in review or running; a stopped child keeps the parent unfinished, and a closed or mid-level one isn't counted", () => {
    const progress = progressOf([
      child(1, "merged"),
      child(2, "in_review"),
      child(3, "needs_you"),
      child(4, "running"),
      child(5, "queued"),
      child(6, null),
      child(7, "stopped"),
      child(8, null, { open: false }),
      child(9, null, { leaf: false }),
    ]);
    expect(progress).toMatchObject({ total: 7, merged: 1, moving: 2 });
    expect(progress.parts.map((part) => [part.kind, part.n])).toEqual([
      ["merged", 1],
      ["moving", 2],
      ["needsYou", 1],
      ["queued", 1],
      ["stopped", 1],
      ["notStarted", 1],
    ]);
  });
});
