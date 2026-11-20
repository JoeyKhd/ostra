import { memberIdSchema, ticketKeySchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { footnote, lineCount, markItems, moveItem, onLinearRows, shownChips, siblingUrl, versionChip } from "./draft-words";

// F-099 (ticket 34): the refine draft's pure parts. Whose words each item is decides the "edited by
// you · the agent's: …" lines, the footnote names what "Update ticket" writes, and the On Linear
// rows follow what core wrote.

describe("the refine draft's words (F-099, ticket 34)", () => {
  it("F-099: marks an edited item with the agent's words, an added one, and the agent's removed ones, whatever moved", () => {
    const agent = ["The footer shows the version", "GET /version returns the version", "The About dialog shows it"];
    const { marks, removed } = markItems(["The footer shows the version", "GET /version returns the version and the SHA", "The About dialog shows it"], agent);
    expect(marks).toEqual([{ kind: "same" }, { kind: "edited", agent: "GET /version returns the version" }, { kind: "same" }]);
    expect(removed).toEqual([]);

    // Moved, one removed, one added.
    const second = markItems(["The About dialog shows it", "A new one"], agent);
    expect(second.marks).toEqual([{ kind: "same" }, { kind: "edited", agent: "GET /version returns the version" }]);
    expect(second.removed).toEqual([{ index: 0, text: "The footer shows the version" }]);
    expect(markItems(["a", "b", "c"], ["a"]).marks).toEqual([{ kind: "same" }, { kind: "added" }, { kind: "added" }]);
    // No agent version: nothing is marked.
    expect(markItems(["a"], null)).toEqual({ marks: [{ kind: "same" }], removed: [] });
  });

  it("F-099: names each version by who made it, and the applied one as applied", () => {
    const base = { version: 3, appliedAt: null };
    expect(versionChip({ ...base, version: 1, source: "agent", editedBy: null }, "m1")).toBe("v1 · agent");
    expect(versionChip({ ...base, source: "member", editedBy: { memberId: memberIdSchema.parse("m1"), name: "Alex Kim" } }, "m1")).toBe("v3 · your edit");
    expect(versionChip({ ...base, source: "member", editedBy: { memberId: memberIdSchema.parse("m2"), name: "Sam Rivera" } }, "m1")).toBe("v3 · Sam Rivera");
    expect(versionChip({ ...base, appliedAt: 1, source: "member", editedBy: { memberId: memberIdSchema.parse("m1"), name: "Alex Kim" } }, "m1")).toBe("v3 · applied");
    expect(shownChips([1, 2, 3, 4, 5])).toEqual({ shown: [1, 2, 3, 4, 5], more: [] });
    expect(shownChips([1, 2, 3, 4, 5, 6, 7])).toEqual({ shown: [4, 5, 6, 7], more: [1, 2, 3] });
  });

  it("F-099: the footnote names the version, the ticket, the sub-issues and the ready status", () => {
    expect(footnote({ version: 3, ticketKey: "CALC-180", boardName: "Calculator", subTickets: 2, subIssues: true, readyStatus: "Todo" })).toBe(
      "Update ticket writes version 3 to CALC-180 on Linear and creates 2 sub-issues. Mark ready moves it to Todo.",
    );
    expect(footnote({ version: 1, ticketKey: "CALC-180", boardName: null, subTickets: 1, subIssues: false, readyStatus: null })).toBe(
      "Update ticket writes version 1 to CALC-180 on Linear and creates 1 linked ticket.",
    );
    expect(footnote({ version: 2, ticketKey: "CALC-180", boardName: null, subTickets: 0, subIssues: true, readyStatus: null })).toBe("Update ticket writes version 2 to CALC-180 on Linear.");
    expect(footnote({ version: 2, ticketKey: null, boardName: "Calculator", subTickets: 2, subIssues: true, readyStatus: null })).toBe(
      "Create ticket makes a new ticket on Calculator from version 2, with 2 sub-issues.",
    );
  });

  it("F-099: the On Linear rows are pending until core wrote the version, and the move follows its write", () => {
    const applied = { appliedAt: 1, images: [{ attachedAt: null }], subTickets: 2, createdTicket: false };
    expect(onLinearRows({ ...applied, written: null, move: null }).map((row) => [row.label, row.state])).toEqual([
      ["Updated the description", "pending"],
      ["Attached 1 image", "pending"],
      ["Created 2 sub-issues", "pending"],
    ]);
    const written = onLinearRows({ ...applied, images: [{ attachedAt: 2 }], written: { ticketKey: ticketKeySchema.parse("CALC-180"), subTickets: [ticketKeySchema.parse("CALC-181"), ticketKeySchema.parse("CALC-182")] }, move: { state: "failed", status: "Todo" } });
    expect(written.map((row) => [row.label, row.state])).toEqual([
      ["Updated the description", "done"],
      ["Attached 1 image", "done"],
      ["Created 2 sub-issues", "done"],
      ["Moved to Todo", "failed"],
    ]);
    expect(onLinearRows({ appliedAt: null, written: null, images: [], subTickets: 0, createdTicket: false, move: null })).toEqual([]);
  });

  it("moves an item up and down, and not past an end; counts a sub-ticket's lines; finds a sub-issue's address", () => {
    expect(moveItem(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(lineCount("one\ntwo\nthree\n")).toBe(3);
    expect(lineCount("  ")).toBe(0);
    expect(siblingUrl({ key: "OST-1", url: "https://linear.app/ostra-test/issue/OST-1/the-title" }, "OST-2")).toBe("https://linear.app/ostra-test/issue/OST-2");
    expect(siblingUrl({ key: "OST-1", url: "https://tracker.example/x" }, "OST-2")).toBeNull();
  });
});
