import type { RecordStep } from "@ostra/protocol";
import type { AttachmentItem } from "@ostra/task-view";

import { formatClock } from "@/lib/format";
import { plural, t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// The words and sizes of the thread's pictures (app-targets/m8/task-attachments.md; F-121,
// milestone 8's ticket 17). Pure, so the strip, the viewer and their tests read one place.

export type AttachmentView = RouterOutputs["tasks"]["attachments"]["attachments"][number];

/** A thumbnail's height in the thread, and in the viewer's filmstrip. */
export const THUMB_HEIGHT = 110;
export const FILM_HEIGHT = 75;

/** A picture's width at `height`, at its capture's own aspect: 1280×800 at 110 is 176, 390×844 is 51. */
export const thumbWidth = (size: { readonly width: number; readonly height: number }, height: number = THUMB_HEIGHT): number =>
  Math.max(24, Math.round((size.width / Math.max(1, size.height)) * height));

/** A recording's length, `0:42`. */
export const durationText = (ms: number | null): string => {
  const seconds = Math.max(0, Math.round((ms ?? 0) / 1000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
};

/** A blob's size, `212 KB` or `3.1 MB`. */
export const bytesText = (bytes: number): string =>
  bytes < 1024 * 1024 ? t("task.attachments.kb", { n: Math.max(1, Math.round(bytes / 1024)) }) : t("task.attachments.mb", { n: (bytes / (1024 * 1024)).toFixed(1) });

/** What a picture shows: `web`, `:4100`, `mailpit`. */
export const targetText = (target: AttachmentItem["target"]): string => ("process" in target ? target.process : "port" in target ? `:${String(target.port)}` : target.service);

/** The same, from the attachments' list. */
export const viewTargetText = (target: AttachmentView["target"]): string => {
  switch (target.kind) {
    case "process":
    case "service":
      return target.name;
    case "port":
      return `:${String(target.port)}`;
    default:
      return target satisfies never;
  }
};

/**
 * The capture row's subject: `3 screenshots of` and the route when they share one, else
 * `3 screenshots`; the after-turn's `the environment's 3 routes`.
 */
export const captureSubject = (items: readonly Pick<AttachmentItem, "path" | "source">[]): { readonly words: string; readonly route: string | null } => {
  const routes = new Set(items.map((item) => item.path));
  const [first] = items;
  if (first?.source === "after-turn") return { words: plural(routes.size, "task.attachments.afterTurnOne", "task.attachments.afterTurn"), route: routes.size === 1 ? first.path : null };
  if (routes.size === 1 && first !== undefined) return { words: plural(items.length, "task.attachments.shotsOfOne", "task.attachments.shotsOf"), route: first.path };
  return { words: plural(items.length, "task.attachments.shotsOne", "task.attachments.shots"), route: null };
};

/** Each thumbnail's caption: the width, then the route on the first and wherever the route changes. */
export const captions = (items: readonly Pick<AttachmentItem, "path" | "width" | "kind">[]): readonly string[] =>
  items.map((item, index) => {
    if (item.kind === "recording") return `${String(item.width)} · ${t("task.attachments.recording")}`;
    const previous = items[index - 1];
    return previous?.path === item.path ? String(item.width) : `${String(item.width)} · ${item.path}`;
  });

/** A thumbnail button's name: `Screenshot of /history at 1280 wide, 14:31, open`. */
export const thumbName = (item: Pick<AttachmentItem, "kind" | "path" | "width" | "at">): string =>
  item.kind === "recording"
    ? t("task.attachments.openRecording", { route: item.path, width: item.width, time: formatClock(item.at) })
    : t("task.attachments.openScreenshot", { route: item.path, width: item.width, time: formatClock(item.at) });

/** The properties panel's widths: each once, widest first, `1280 · 768 · 390`. */
export const widthsText = (views: readonly Pick<AttachmentView, "width">[]): string =>
  [...new Set(views.map((view) => view.width))].sort((a, b) => b - a).join(" · ");

/** The panel's "Captured": `3 screenshots · 1 recording`. */
export const capturedText = (views: readonly Pick<AttachmentView, "kind">[]): string => {
  const shots = views.filter((view) => view.kind === "screenshot").length;
  const recordings = views.length - shots;
  const parts = [shots === 0 ? null : plural(shots, "task.attachments.countShotOne", "task.attachments.countShots"), recordings === 0 ? null : plural(recordings, "task.attachments.countRecordingOne", "task.attachments.countRecordings")];
  return parts.filter((part) => part !== null).join(" · ");
};

/**
 * An earlier capture of the same route at the same width, for the viewer's "Compare with": the
 * newest before this one, or `null`.
 */
export const earlierOf = (views: readonly AttachmentView[], view: AttachmentView): AttachmentView | null =>
  views.filter((other) => other.kind === "screenshot" && other.attachmentId !== view.attachmentId && other.path === view.path && other.width === view.width && other.createdAt < view.createdAt).at(-1) ?? null;

/** The pictures the viewer moves through: the turn's, or the one alone outside a turn. */
export const viewerSet = (views: readonly AttachmentView[], open: AttachmentView): readonly AttachmentView[] => {
  const turnId = open.turn?.turnId ?? null;
  return turnId === null ? [open] : views.filter((view) => view.turn?.turnId === turnId);
};

/** Where a frame reel is at `ms`: the frame shown then, the last at or before it. */
export const frameAt = (times: readonly number[], ms: number): number => {
  let low = 0;
  let high = times.length - 1;
  let found = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((times[middle] ?? 0) <= ms) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
};

/** The step playing at `ms`: the last that started at or before it, or `-1` before the first. */
export const stepAt = (starts: readonly number[], ms: number): number => {
  let at = -1;
  starts.forEach((start, index) => {
    if (start <= ms) at = index;
  });
  return at;
};

/** A recording's step in words, as the reel holds it: the agent's selectors and texts are shown as data. */
export const stepWords = (step: RecordStep): string => {
  switch (step.action) {
    case "goto":
      return t("task.attachments.step.goto", { path: step.path });
    case "click":
      return "text" in step.target ? t("task.attachments.step.clickText", { text: step.target.text }) : t("task.attachments.step.click", { selector: step.target.selector });
    case "fill":
      return t("task.attachments.step.fill", { selector: step.selector, value: step.value });
    case "press":
      return t("task.attachments.step.press", { key: step.key });
    case "scroll":
      return t("task.attachments.step.scroll", { x: step.deltaX, y: step.deltaY });
    case "wait":
      return "ms" in step.until ? t("task.attachments.step.waitMs", { ms: step.until.ms }) : t("task.attachments.step.waitFor", { selector: step.until.selector });
    default:
      return step satisfies never;
  }
};
