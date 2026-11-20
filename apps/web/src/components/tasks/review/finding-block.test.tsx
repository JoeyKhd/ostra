import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { findingIdSchema, reviewRunIdSchema } from "@ostra/protocol";

import { FindingBlock } from "./finding-block";
import type { FindingActions } from "./finding-block";
import type { ReviewFinding } from "./review-words";

// The review screen's finding (review-screen.md, "A finding" and "Merged or closed PR"): an open
// finding offers "Fix this" while its PR is open; on a merged or closed PR only "Remember this" stays.

const finding: ReviewFinding = {
  findingId: findingIdSchema.parse("01900000-0000-7000-8000-0000000000f1"),
  reviewRunId: reviewRunIdSchema.parse("01900000-0000-7000-8000-0000000000e1"),
  round: 1,
  path: "src/pay.ts",
  line: 12,
  side: "new",
  severity: "blocking",
  title: "Rounds the total twice",
  body: "The total is rounded before and after the tax.",
  suggestion: null,
  postedAs: "line_comment",
  state: "open",
};

const actions = (prOpen: boolean): FindingActions => ({
  fixed: false,
  proposalHref: null,
  projectName: "calculator",
  canAct: true,
  prOpen,
  fixing: false,
  remembering: false,
  error: null,
  onFix: () => undefined,
  onRemember: () => undefined,
});

describe("a finding on the review screen", () => {
  it("F-102/c1: Fix this shows on an open PR's finding, and is hidden once the PR is merged or closed, where Remember this stays", () => {
    const open = renderToStaticMarkup(<FindingBlock finding={finding} actions={actions(true)} />);
    expect(open).toContain('data-action="fix-this"');
    expect(open).toContain('data-action="remember-finding"');
    const closed = renderToStaticMarkup(<FindingBlock finding={finding} actions={actions(false)} />);
    expect(closed).not.toContain('data-action="fix-this"');
    expect(closed).toContain('data-action="remember-finding"');
  });
});
