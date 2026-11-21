import { notificationIdSchema, previewAccessIdSchema } from "@ostra/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PreviewShareRows } from "./preview-shares";
import type { PreviewShare } from "./preview-shares";

// F-142 (milestone 8): a preview shared with the member by name shows among the Needs you rows,
// opening the preview's own page; the live run is `e2e/24-preview-shared.spec.ts`.

const share = (over: Partial<PreviewShare> = {}): PreviewShare => ({
  notificationId: notificationIdSchema.parse("0193a1f0-0000-7000-8000-00000000a001"),
  previewId: previewAccessIdSchema.parse("0193a1f0-0000-7000-8000-00000000b001"),
  label: "web",
  port: 5173,
  sharedBy: "Alex Kim",
  read: false,
  createdAt: Date.UTC(2026, 10, 21, 9),
  ...over,
});

describe("a preview shared with you, on Needs you", () => {
  it("F-142/c3: names who shared which preview, and Watch opens the preview's own page", () => {
    const html = renderToStaticMarkup(<PreviewShareRows shares={[share()]} />);
    expect(html).toContain("Alex Kim shared web :5173 with you");
    expect(html).toContain('href="/previews/0193a1f0-0000-7000-8000-00000000b001"');
    expect(html).toContain('aria-label="Watch web :5173"');
    // A sharer who's gone is a member; no rows, no list.
    expect(renderToStaticMarkup(<PreviewShareRows shares={[share({ sharedBy: null, port: null, read: true })]} />)).toContain("A member shared web with you");
    expect(renderToStaticMarkup(<PreviewShareRows shares={[]} />)).toBe("");
  });
});
