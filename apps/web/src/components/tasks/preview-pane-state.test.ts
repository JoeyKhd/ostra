import { describe, expect, it } from "vitest";

import { memberIdSchema, previewKeySchema, previewLinkIdSchema, previewViewportSchema, runnerLimits, viewportPresetSizes } from "@ostra/protocol";

import { orderedPreviews, paneStateOf, presetName, reopens, selectedPreview, shareLevelOf, shareShortName, viewportFor, viewportWithScale } from "./preview-pane-state";
import type { PaneView, PreviewItem, PreviewList, PreviewSharing } from "./preview-pane-state";

// The preview pane's own rules (milestone 8, ticket 21; task-preview.md): which preview shows and
// in what order, the size the shared page is asked for, the pane's state from the list and its
// view, and the share button's words. The browser spec (`e2e/24-preview.spec.ts`) drives them live.

const sharing = (over: Partial<PreviewSharing> = {}): PreviewSharing => ({ level: "members", memberIds: [], links: [], ...over });

const item = (key: string, label: string, over: Partial<PreviewItem> = {}): PreviewItem => ({
  key: previewKeySchema.parse(key),
  target: key.startsWith("app-") ? { process: key.slice(4) } : key.startsWith("service-") ? { service: key.slice(8) } : { port: Number(key.slice(5)) },
  port: 5173,
  label,
  primary: false,
  path: "/",
  source: key.startsWith("port-") ? "announced" : "declared",
  sharing: sharing(),
  watchers: 0,
  framing: null,
  ...over,
});

const web = item("app-web", "web", { primary: true });
const api = item("app-api", "api", { port: 3001 });
const mail = item("service-mailpit", "mailpit", { port: 8025 });
const storybook = item("port-6006", "storybook", { port: 6006 });

const list = (over: Partial<Pick<PreviewList, "previews" | "box" | "can">> = {}): Pick<PreviewList, "previews" | "box" | "can"> => ({
  previews: [web],
  box: "running",
  can: { stream: true, tunnel: false, native: false },
  ...over,
});

const words = { failed: () => "failed" };
const open = (frame: Extract<PaneView, { kind: "open" }>["frame"]): PaneView => ({ kind: "open", frame });

describe("the preview pane", () => {
  it("F-141/c1: lists the task's previews primary first, then the declared processes, the services and the agent's, each by label, and shows the address's or the first", () => {
    expect(orderedPreviews([storybook, mail, api, web]).map((one) => one.label)).toEqual(["web", "api", "mailpit", "storybook"]);
    expect(selectedPreview([storybook, web, api], "app-api")?.label).toBe("api");
    // A preview the address names that the task no longer has: the primary.
    expect(selectedPreview([storybook, web], "app-gone")?.label).toBe("web");
    expect(selectedPreview([], null)).toBeNull();
  });

  it("F-141/c1: Fit asks the box for the pane's own size within the browser view's bounds, and a preset for its own size", () => {
    expect(viewportFor("fit", { width: 614, height: 772 })).toEqual({ width: 614, height: 772 });
    // Never below a side's least, nor past the pixel cap (Q326): every answer is one the box takes.
    for (const room of [{ width: 40, height: 30 }, { width: 3000, height: 2000 }, { width: 1800, height: 1000 }, { width: 1352, height: 780 }]) {
      const asked = viewportFor("fit", room);
      expect(previewViewportSchema.safeParse(asked).success).toBe(true);
      expect(asked.width * asked.height).toBeLessThanOrEqual(runnerLimits.browserViewMaxPixels);
    }
    expect(viewportFor("tablet", { width: 614, height: 772 })).toEqual({ width: 834, height: 1112 });
    expect(viewportFor("desktop", { width: 614, height: 772 })).toEqual(viewportPresetSizes.desktop);
    expect(presetName("phone")).toBe("Phone 390");
    expect(presetName("fit")).toBe("Fit");
  });

  it("F-141/c1, c2: the pane is live once its view draws a frame, starts while it waits, says the stream dropped, and opens a new view after core closes one", () => {
    expect(paneStateOf(list(), "running", { kind: "opening" }, words)).toEqual({ kind: "starting" });
    expect(paneStateOf(list(), "running", open({ kind: "connecting" }), words)).toEqual({ kind: "starting" });
    expect(paneStateOf(list(), "running", open({ kind: "live" }), words)).toEqual({ kind: "live" });
    expect(paneStateOf(list(), "running", open({ kind: "reconnecting" }), words)).toEqual({ kind: "dropped", lost: false });
    expect(paneStateOf(list(), "running", open({ kind: "lost" }), words)).toEqual({ kind: "dropped", lost: true });
    expect(paneStateOf(list(), "running", open({ kind: "closed", close: { reason: "app-stopped" } }), words)).toEqual({ kind: "crashed" });
    expect(paneStateOf(list(), "running", open({ kind: "closed", close: { reason: "refused", refusal: "too-many-pages" } }), words)).toEqual({ kind: "refused", refusal: "too-many-pages" });
    expect(reopens({ kind: "closed", close: { reason: "closed" } })).toBe(true);
    expect(reopens({ kind: "closed", close: { reason: "app-stopped" } })).toBe(false);
    expect(reopens({ kind: "closed", close: { reason: "refused", refusal: "other" } })).toBe(false);
    expect(paneStateOf(list({ previews: [] }), "running", { kind: "idle" }, words)).toEqual({ kind: "none" });
  });

  it("F-141/c5: a task whose box went to sleep wakes to preview, and one whose box is gone starts the app", () => {
    expect(paneStateOf(list({ box: "stopped" }), "needs_you", { kind: "idle" }, words)).toEqual({ kind: "stopped", asleep: true });
    expect(paneStateOf(list({ box: "stopped" }), "stopped", { kind: "idle" }, words)).toEqual({ kind: "stopped", asleep: false });
    expect(paneStateOf(list({ box: "none" }), "merged", { kind: "idle" }, words)).toEqual({ kind: "stopped", asleep: false });
    expect(paneStateOf(list({ box: "starting" }), "stopped", { kind: "idle" }, words)).toEqual({ kind: "starting" });
  });

  it("F-141/c6: a runner below minor 7, or one that can't show the app, gives the reason and never a view", () => {
    expect(paneStateOf(list({ can: { refused: "runner-needs-upgrade" } }), "running", { kind: "idle" }, words)).toEqual({ kind: "too-old", reason: "runner-needs-upgrade" });
    // A box with no browser can't stream: the same refusal, not a fallback.
    expect(paneStateOf(list({ can: { stream: false, tunnel: true, native: false } }), "running", { kind: "idle" }, words)).toEqual({ kind: "too-old", reason: "runner-cannot-preview" });
    expect(paneStateOf(list(), "running", { kind: "refused", reason: "runner-needs-upgrade" }, words)).toEqual({ kind: "too-old", reason: "runner-needs-upgrade" });
  });
});

describe("the share button", () => {
  const link = (over: Partial<PreviewSharing["links"][number]> = {}): PreviewSharing["links"][number] => ({
    linkId: previewLinkIdSchema.parse("0193a1f0-0000-7000-8000-000000000001"),
    kind: "expiring",
    allowInput: false,
    state: "active",
    expiresAt: 1_000_000 + 24 * 3_600_000,
    createdByMemberId: memberIdSchema.parse("0193a1f0-0000-7000-8000-0000000000aa"),
    createdAt: 1_000_000,
    firstUsedAt: null,
    lastUsedAt: null,
    revokedAt: null,
    opens: 0,
    ...over,
  });

  it("F-142/c2: names the widest access a preview has: its members, named people, a link with its time left, or a public link", () => {
    const now = 1_000_000;
    expect(shareShortName(sharing(), now)).toBe("Members");
    expect(shareShortName(sharing({ level: "named", memberIds: [memberIdSchema.parse("0193a1f0-0000-7000-8000-0000000000bb"), memberIdSchema.parse("0193a1f0-0000-7000-8000-0000000000cc")] }), now)).toBe("People · 2");
    expect(shareShortName(sharing({ links: [link()] }), now)).toBe("Link · 24 h");
    expect(shareShortName(sharing({ links: [link({ expiresAt: now + 52 * 60_000 })] }), now)).toBe("Link · 52 min");
    expect(shareShortName(sharing({ links: [link(), link({ kind: "public", expiresAt: null })] }), now)).toBe("Public");
    // An ended link opens nothing: the level below it is what holds.
    expect(shareLevelOf(sharing({ links: [link({ state: "revoked", revokedAt: now })] }))).toBe("members");
    expect(shareLevelOf(sharing({ level: "named", links: [link({ state: "expired" })] }))).toBe("named");
  });

  it("F-141/c10: the pane asks for its screen's device pixel ratio with the page's size, 1 to 2, and the box takes it", () => {
    for (const [ratio, scale] of [[1, 1], [1.25, 1.25], [1.5, 1.5], [2, 2], [3, 2], [0.75, 1], [Number.NaN, 1]] as const) {
      const asked = viewportWithScale(viewportFor("desktop", { width: 614, height: 772 }), ratio);
      expect(asked, String(ratio)).toEqual({ ...viewportPresetSizes.desktop, scale });
      expect(previewViewportSchema.safeParse(asked).success).toBe(true);
    }
    // The size is still the preset's, or the pane's own room: the ratio sharpens the picture, never the page's layout.
    expect(viewportWithScale(viewportFor("fit", { width: 614, height: 772 }), 2)).toEqual({ width: 614, height: 772, scale: 2 });
  });
});
