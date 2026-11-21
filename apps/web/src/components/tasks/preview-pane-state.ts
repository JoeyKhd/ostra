import { browserViewFrameBounds, runnerLimits, viewportPresetSizes } from "@ostra/protocol";
import type { PreviewCloseReason, PreviewKey, PreviewOpenRefusal, PreviewRefusalReason, PreviewViewport, ViewportPreset } from "@ostra/protocol";

import type { FrameStatus } from "@/components/previews/preview-frame";
import { formatClock } from "@/lib/format";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// The preview pane's state (milestone 8, F-141; task-preview.md, "The pane's states"): one union,
// worked out from the task's previews (`previews.list`), the view the pane opened and what its frame
// reports, each case with an exhaustive switch where it's drawn. Pure, so each rule is tested alone.

export type PreviewList = RouterOutputs["previews"]["list"];
export type PreviewItem = PreviewList["previews"][number];
export type PreviewSharing = PreviewItem["sharing"];

/** The width presets: `fit` is the pane's own size, 1:1 (the default, task-preview.md open point 3). */
export const widthPresets = ["fit", "desktop", "tablet", "phone"] as const;
export type WidthPreset = (typeof widthPresets)[number];

export const isWidthPreset = (value: string | null): value is WidthPreset => widthPresets.some((preset) => preset === value);

/**
 * The page size a preset asks the box for. `fit` is the room the pane has, kept within the browser
 * view's bounds (each side 200 to 1920, at most 1440×900's pixels: Q326), so it's never refused.
 */
export const viewportFor = (preset: WidthPreset, room: { readonly width: number; readonly height: number }): PreviewViewport => {
  if (preset !== "fit") return viewportPresetSizes[preset];
  const width = Math.max(runnerLimits.browserViewMinSide, Math.min(runnerLimits.browserViewMaxSide, Math.floor(room.width)));
  const height = Math.max(runnerLimits.browserViewMinSide, Math.min(runnerLimits.browserViewMaxSide, Math.floor(room.height)));
  const bounded = browserViewFrameBounds({ width, height });
  return { width: Math.max(runnerLimits.browserViewMinSide, bounded.width), height: Math.max(runnerLimits.browserViewMinSide, bounded.height) };
};

/** The preset a member's screenshot is taken at: a fixed preset as it is, and `fit` by its width. */
export const screenshotPreset = (preset: WidthPreset, width: number): ViewportPreset => {
  if (preset !== "fit") return preset;
  if (width >= 1000) return "desktop";
  return width >= 600 ? "tablet" : "phone";
};

/** The preset's name in the toolbar: `Fit`, `Desktop 1440`, `Tablet 834`, `Phone 390`. */
export const presetName = (preset: WidthPreset): string => {
  switch (preset) {
    case "fit":
      return t("task.preview.width.fit");
    case "desktop":
      return t("task.preview.width.desktop", { width: viewportPresetSizes.desktop.width });
    case "tablet":
      return t("task.preview.width.tablet", { width: viewportPresetSizes.tablet.width });
    case "phone":
      return t("task.preview.width.phone", { width: viewportPresetSizes.phone.width });
    default:
      return preset satisfies never;
  }
};

/** The previews in the switcher's order: primary first, then declared, services and the agent's, each by label. */
export const orderedPreviews = (previews: readonly PreviewItem[]): readonly PreviewItem[] => {
  const rank = (item: PreviewItem): number => {
    if (item.primary) return 0;
    if (item.source === "announced") return 3;
    return "service" in item.target ? 2 : 1;
  };
  return [...previews].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
};

/** Where a preview comes from, as its chip says it. */
export type PreviewOrigin = "declared" | "service" | "announced";

export const originOf = (item: PreviewItem): PreviewOrigin => {
  if (item.source === "announced") return "announced";
  return "service" in item.target ? "service" : "declared";
};

/** The preview the pane shows: the one in the address when it's still listed, else the first. */
export const selectedPreview = (previews: readonly PreviewItem[], key: string | null): PreviewItem | null => {
  const ordered = orderedPreviews(previews);
  return ordered.find((item) => item.key === key) ?? ordered[0] ?? null;
};

/** What the pane shows. */
export type PaneState =
  /** Nothing declared or announced (`task-preview-none`). */
  | { readonly kind: "none" }
  /** The runner can't show a preview: below minor 7, or nothing to show it with. It never falls back. */
  | { readonly kind: "too-old"; readonly reason: PreviewRefusalReason }
  /** No box: asleep (`Wake to preview`) or the task ended (`Start the app`), behind the last screenshot. */
  | { readonly kind: "stopped"; readonly asleep: boolean }
  /** The box, or the app in it, is starting, or the view waits for its first frame. */
  | { readonly kind: "starting" }
  | { readonly kind: "live" }
  /** The stream dropped: the last picture with `Reconnecting…`, then `Lost the stream.` after 30 s. */
  | { readonly kind: "dropped"; readonly lost: boolean }
  /** The box refused the view, with its reason. */
  | { readonly kind: "refused"; readonly refusal: PreviewOpenRefusal }
  /** The app stopped answering: the last picture dimmed, with a banner. */
  | { readonly kind: "crashed" }
  /** The view couldn't open, or its stream was refused, in words. */
  | { readonly kind: "failed"; readonly words: string };

/** Why `previews.open` didn't. */
export type OpenRefusal = "no-box" | "port-not-allowed" | "runner-needs-upgrade" | "runner-cannot-preview" | "level-unknown";

/** The pane's view: none yet, being opened, open with its frame's status, or refused. */
export type PaneView =
  | { readonly kind: "idle" }
  | { readonly kind: "opening" }
  | { readonly kind: "open"; readonly frame: FrameStatus }
  | { readonly kind: "refused"; readonly reason: OpenRefusal };

const finished: ReadonlySet<string> = new Set(["stopped", "merged", "done", "failed"]);

/** The pane's state from the list, the task's state and the view. */
export const paneStateOf = (list: Pick<PreviewList, "previews" | "box" | "can">, taskState: string, view: PaneView, words: { readonly failed: (view: PaneView) => string }): PaneState => {
  if (list.previews.length === 0) return { kind: "none" };
  if ("refused" in list.can) return { kind: "too-old", reason: list.can.refused };
  switch (list.box) {
    case "none":
    case "stopped":
      return { kind: "stopped", asleep: list.box === "stopped" && !finished.has(taskState) };
    case "starting":
      return { kind: "starting" };
    case "running":
      break;
    default:
      return list.box satisfies never;
  }
  // A box that runs but can't stream (no browser in it): the same refusal as a runner that can't.
  if (!list.can.stream) return { kind: "too-old", reason: "runner-cannot-preview" };
  switch (view.kind) {
    case "idle":
    case "opening":
      return { kind: "starting" };
    case "refused":
      return view.reason === "runner-needs-upgrade" || view.reason === "runner-cannot-preview" ? { kind: "too-old", reason: view.reason } : { kind: "failed", words: words.failed(view) };
    case "open":
      break;
    default:
      return view satisfies never;
  }
  const frame = view.frame;
  switch (frame.kind) {
    case "connecting":
      return { kind: "starting" };
    case "live":
      return { kind: "live" };
    case "reconnecting":
      return { kind: "dropped", lost: false };
    case "lost":
      return { kind: "dropped", lost: true };
    case "closed":
      if (frame.close.reason === "refused") return { kind: "refused", refusal: frame.close.refusal };
      return closedState(frame.close.reason);
    case "refused":
      return { kind: "failed", words: words.failed(view) };
    default:
      return frame satisfies never;
  }
};

/** A view core closed: the app stopped (the banner), or it went and the pane opens another. */
const closedState = (reason: PreviewCloseReason): PaneState => {
  switch (reason) {
    case "app-stopped":
    case "page-crashed":
      return { kind: "crashed" };
    case "closed":
    case "box-stopping":
    case "stale-lease":
    case "protocol-violation":
      return { kind: "starting" };
    default:
      return reason satisfies never;
  }
};

/** Whether the pane should open a fresh view: core closed this one for a reason that isn't the app's. */
export const reopens = (frame: FrameStatus): boolean =>
  frame.kind === "closed" && frame.close.reason !== "refused" && frame.close.reason !== "app-stopped" && frame.close.reason !== "page-crashed";

/** The share button's short name (task-preview.md, "Share"): the widest access the preview has now. */
export type ShareLevel = "members" | "named" | "link" | "public";

/** The links the share menu counts: the active ones. */
export const activeLinks = (sharing: PreviewSharing): PreviewSharing["links"] => sharing.links.filter((link) => link.state === "active");

/** The level the share menu shows chosen: an active public link, else an active link, else the level below them. */
export const shareLevelOf = (sharing: PreviewSharing): ShareLevel => {
  const active = activeLinks(sharing);
  if (active.some((link) => link.kind === "public")) return "public";
  if (active.length > 0) return "link";
  return sharing.level;
};

/** How long a link has left, short: `24 h`, `52 min`, `6 d`. */
export const shortExpiry = (expiresAt: number, now: number): string => {
  const ms = Math.max(0, expiresAt - now);
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return t("task.preview.share.shortMinutes", { n: minutes });
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return t("task.preview.share.shortHours", { n: hours });
  return t("task.preview.share.shortDays", { n: Math.round(ms / 86_400_000) });
};

/** The share button's words: `Members`, `People · 3`, `Link · 24 h`, `Public`. */
export const shareShortName = (sharing: PreviewSharing, now: number): string => {
  const level = shareLevelOf(sharing);
  switch (level) {
    case "members":
      return t("task.preview.share.short.members");
    case "named":
      return t("task.preview.share.short.named", { n: sharing.memberIds.length });
    case "link": {
      const soonest = activeLinks(sharing)
        .map((link) => link.expiresAt)
        .filter((at): at is number => at !== null)
        .sort((a, b) => b - a)[0];
      return soonest === undefined ? t("task.preview.share.short.linkOnly") : t("task.preview.share.short.link", { expiry: shortExpiry(soonest, now) });
    }
    case "public":
      return t("task.preview.share.short.public");
    default:
      return level satisfies never;
  }
};

/** A link's line in the share menu: who made it and when, and how often it was opened. */
export const linkLine = (link: PreviewSharing["links"][number], maker: string): string => {
  const made = t("task.preview.share.made", { who: maker, time: formatClock(link.createdAt) });
  if (link.firstUsedAt === null) return `${made} · ${t("task.preview.share.openedNever")}`;
  if (link.opens <= 1) return `${made} · ${t("task.preview.share.openedOnce", { time: formatClock(link.firstUsedAt) })}`;
  return `${made} · ${t("task.preview.share.openedMany", { n: link.opens, time: formatClock(link.firstUsedAt) })}`;
};

/** The expiry choices of a new link, in hours (24 the default), up to the install's longest. */
export const expiryChoices = (linkMaxDays: number): readonly number[] => [1, 24, 24 * 7].filter((hours) => hours <= linkMaxDays * 24);

/** A key for the address: the preview's own, so a link reopens it. */
export const previewKeyParam = (key: PreviewKey): string => key;
