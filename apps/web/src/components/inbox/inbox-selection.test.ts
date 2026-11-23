import { describe, expect, it } from "vitest";

import { boardIdSchema, taskIdSchema, ticketIdSchema } from "@ostra/protocol";

import { noTicks, tickAll, tickedRows, toggleTick, untick } from "./inbox-selection";
import type { InboxTicket } from "./inbox-words";

// Milestone 6's review follow-ups (ticket 41, F-107): the Inbox's ticks across its refresh, which
// replaces every row and moves a changed ticket to the top.

const now = Date.UTC(2026, 10, 20, 12);

const ticket = (n: number, over: Partial<InboxTicket> = {}): InboxTicket => ({
  id: ticketIdSchema.parse(`01900000-0000-7000-8000-${String(n).padStart(12, "0")}`),
  key: `CALC-${String(n)}`,
  title: `Ticket ${String(n)}`,
  url: `https://linear.app/acme/issue/CALC-${String(n)}`,
  board: { id: boardIdSchema.parse("01900000-0000-7000-8000-0000000000b1"), name: "Calculator", key: "CALC", connection: null, paused: false },
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

const keys = (rows: readonly InboxTicket[]): readonly string[] => rows.map((row) => row.key);

describe("the Inbox's ticks (inbox-bulk-start.md)", () => {
  it("F-107/c1: a refresh keeps every tick by its ticket, with the refreshed copy, in the list's new order, and a Shift range still starts at the ticket last ticked", () => {
    const [t1, t2, t3, t4, t5, t6, t7] = [1, 2, 3, 4, 5, 6, 7].map((n) => ticket(n));
    if (t1 === undefined || t2 === undefined || t3 === undefined || t4 === undefined || t5 === undefined || t6 === undefined || t7 === undefined) throw new Error("no rows");
    const before = [t1, t2, t3, t4, t5];
    let ticks = toggleTick(noTicks, before, t2, false);
    ticks = toggleTick(ticks, before, t4, false);
    expect(keys(tickedRows(ticks, before))).toEqual(["CALC-2", "CALC-4"]);

    // The refresh: two new tickets on top, CALC-4 changed and moved up, CALC-2 gained a task.
    const started = ticket(2, { task: { id: taskIdSchema.parse("01900000-0000-7000-9000-000000000002"), shortId: "00000002", state: "queued", active: true } });
    const after = [t6, t7, ticket(4, { title: "Renamed" }), t1, started, t3, t5];
    const kept = tickedRows(ticks, after);
    expect(keys(kept)).toEqual(["CALC-4", "CALC-2"]);
    expect(kept[0]?.title).toBe("Renamed");
    expect(kept[1]?.task?.shortId).toBe("00000002");

    // Shift-clicking CALC-7 ticks the rows from CALC-4 (the last ticked) up to it, as the list is now.
    ticks = toggleTick(ticks, after, t7, true);
    expect(keys(tickedRows(ticks, after))).toEqual(["CALC-7", "CALC-4", "CALC-2"]);

    // A ticked ticket the next refresh no longer lists keeps its tick, after the rest, in the order ticked.
    expect(keys(tickedRows(ticks, [t6, t7, t1]))).toEqual(["CALC-7", "CALC-2", "CALC-4"]);
  });

  it("F-107/c1: ⌘A ticks every loaded row, and started rows untick", () => {
    const rows = [1, 2, 3].map((n) => ticket(n));
    const all = tickAll(rows);
    expect(keys(tickedRows(all, rows))).toEqual(["CALC-1", "CALC-2", "CALC-3"]);
    const left = untick(all, [String(rows[0]?.id), String(rows[2]?.id)]);
    expect(keys(tickedRows(left, rows))).toEqual(["CALC-2"]);
    expect(untick(left, ["not-ticked"])).toBe(left);
  });
});
