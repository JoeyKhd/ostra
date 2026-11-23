import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { taskIdSchema } from "@ostra/protocol";

import type { Child } from "./parent-progress";
import { ElsewhereRow, refinedLine } from "./ticket-parent-view";

// Milestone 6's review follow-ups (ticket 41, F-077): the parent ticket's page against
// `ticket-parent.md`: where a child on no board of the project is, and the Refined row's line.

const child = (over: Partial<Child> = {}): Child => ({
  key: "OPS-12",
  title: "Rotate the keys",
  url: "https://linear.app/acme/issue/OPS-12",
  open: true,
  depth: 1,
  parentKey: "CALC-180",
  ticketId: null,
  place: "elsewhere",
  leaf: true,
  skipped: "not-on-a-board",
  task: null,
  elsewhere: { board: "Operations", project: "platform" },
  ...over,
});

const refineTask = { id: taskIdSchema.parse("01900000-0000-7000-9000-0000000000a1"), shortId: "000000a1", state: "done" as const };

describe("a parent ticket's page (ticket-parent.md)", () => {
  it("F-077/c2: a child on no board of the project names the board and project that have it, or says no project's board does", () => {
    const there = renderToStaticMarkup(<ElsewhereRow child={child()} />);
    expect(there).toContain("Board Operations");
    expect(there).toContain(`in <span class="font-mono">platform</span>`);
    expect(there).toContain("Open in the tracker");
    const nowhere = renderToStaticMarkup(<ElsewhereRow child={child({ elsewhere: null })} />);
    expect(nowhere).toContain("on no project&#x27;s board");
  });

  it("F-077/c2: the Refined row says the draft applied, by whom and when, with its sub-issues; else ready, or stopped", () => {
    const at = Date.UTC(2026, 10, 18, 9);
    expect(refinedLine({ ...refineTask, draft: { kind: "applied", version: 3, byName: "Alex Kim", at, subTickets: 2 } })).toBe("Draft v3 applied by Alex Kim, 18 Nov · 2 sub-issues created");
    expect(refinedLine({ ...refineTask, draft: { kind: "applied", version: 1, byName: null, at, subTickets: 1 } })).toBe("Draft v1 applied by someone, 18 Nov · 1 sub-issue created");
    expect(refinedLine({ ...refineTask, state: "needs_you", draft: { kind: "ready", version: 2 } })).toBe("Draft ready, not applied yet");
    expect(refinedLine({ ...refineTask, state: "stopped", draft: null })).toBe("Stopped");
    expect(refinedLine({ ...refineTask, state: "running", draft: null })).toBeNull();
  });
});
