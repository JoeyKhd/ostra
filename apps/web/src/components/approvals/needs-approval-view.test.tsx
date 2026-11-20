import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RowActions } from "./needs-approval-view";

// Milestone 6's review follow-ups (ticket 41, F-040): a Needs approval row's action cell, as
// `needs-approval.md` gives it.

const idle = () => undefined;
const cell = (over: Partial<Parameters<typeof RowActions>[0]> = {}) =>
  renderToStaticMarkup(<RowActions name="CALC-201" expanded={false} answered={null} busy={false} onToggle={idle} onReject={idle} onApprove={idle} {...over} />);

describe("Needs approval's rows (needs-approval.md)", () => {
  it("F-040/c1: a collapsed row shows its Reject and Approve, an expanded one its chevron, an answered one that it's done", () => {
    const collapsed = cell();
    expect(collapsed).toContain(`aria-label="Reject CALC-201"`);
    expect(collapsed).toContain(`aria-label="Approve CALC-201"`);
    expect(collapsed).not.toContain("Hide CALC-201");
    const expanded = cell({ expanded: true });
    expect(expanded).toContain(`aria-label="Hide CALC-201"`);
    expect(expanded).not.toContain("Approve CALC-201");
    expect(cell({ answered: "approved" })).not.toContain("<button");
  });
});
