import { runnerLimits } from "@ostra/protocol";
import type { PreviewInputEvent, PreviewPageControl, PreviewViewId } from "@ostra/protocol";
import type { PreviewRouteErrorCode } from "@ostra/api";

import { previewHeaders, previewRoutes, refusalCodeOf } from "./preview-stream";

// A viewer's input for the shared page (milestone 8, F-141, F-142, ADR 0068): the mouse, the wheel,
// keys and pasted text, mapped from the frame's pixels to the page's, batched, and posted in order
// to `/api/previews/<viewId>/input` as `{ events }`; and the pane's controls (the width preset, a
// path, a reload) as `{ control }`, one per request. A watch-only viewer sends none: the route would
// refuse them anyway (`watch-only`). Typed text and a path are never logged.

/** The modifier bits DevTools counts: Alt 1, Ctrl 2, Meta 4, Shift 8. */
const MODIFIER_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

/** The modifiers an event holds, as the protocol counts them. */
export const modifiersOf = (event: { readonly altKey: boolean; readonly ctrlKey: boolean; readonly metaKey: boolean; readonly shiftKey: boolean }): number =>
  (event.altKey ? MODIFIER_BITS.alt : 0) | (event.ctrlKey ? MODIFIER_BITS.ctrl : 0) | (event.metaKey ? MODIFIER_BITS.meta : 0) | (event.shiftKey ? MODIFIER_BITS.shift : 0);

/** A DOM mouse button as the protocol names it. */
export const buttonOf = (button: number): "left" | "middle" | "right" | "none" => {
  switch (button) {
    case 0:
      return "left";
    case 1:
      return "middle";
    case 2:
      return "right";
    default:
      return "none";
  }
};

/** The button a move carries, from the DOM's `buttons` bits (left 1, right 2, middle 4). */
export const heldButton = (buttons: number): "left" | "middle" | "right" | "none" => {
  if ((buttons & 1) !== 0) return "left";
  if ((buttons & 2) !== 0) return "right";
  if ((buttons & 4) !== 0) return "middle";
  return "none";
};

/** The protocol's largest coordinate and wheel movement. */
const COORDINATE_MAX = 10_000;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * Where a pointer at `client` lands on the shared page, in its CSS pixels: the frame is drawn
 * scaled into `rect`, and the page is `page` (the frame's own size). Kept on the page and whole.
 */
export const pagePoint = (
  client: { readonly x: number; readonly y: number },
  rect: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
  page: { readonly width: number; readonly height: number },
): { readonly x: number; readonly y: number } => {
  const scaleX = rect.width > 0 ? page.width / rect.width : 1;
  const scaleY = rect.height > 0 ? page.height / rect.height : 1;
  const x = clamp(Math.round((client.x - rect.left) * scaleX), 0, Math.min(COORDINATE_MAX, Math.max(0, page.width - 1)));
  const y = clamp(Math.round((client.y - rect.top) * scaleY), 0, Math.min(COORDINATE_MAX, Math.max(0, page.height - 1)));
  return { x, y };
};

/** A wheel's movement in CSS pixels, from the DOM's `deltaMode` (pixels, lines or pages). */
export const wheelPixels = (delta: number, mode: number, pageHeight: number): number => {
  const pixels = mode === 1 ? delta * 16 : mode === 2 ? delta * pageHeight : delta;
  return clamp(Math.round(pixels), -COORDINATE_MAX, COORDINATE_MAX);
};

/**
 * Adds an event to a queue, folding what the page needs only once: a move after a move (the last
 * point counts), and a wheel after a wheel at the same point (the movements add up).
 */
export const coalesce = (queue: readonly PreviewInputEvent[], next: PreviewInputEvent): readonly PreviewInputEvent[] => {
  const last = queue.at(-1);
  if (last !== undefined && next.kind === "mouse" && next.action === "move" && last.kind === "mouse" && last.action === "move" && last.button === next.button && last.modifiers === next.modifiers) {
    return [...queue.slice(0, -1), next];
  }
  if (last !== undefined && next.kind === "wheel" && last.kind === "wheel" && last.x === next.x && last.y === next.y && last.modifiers === next.modifiers) {
    return [
      ...queue.slice(0, -1),
      { ...last, deltaX: clamp(last.deltaX + next.deltaX, -COORDINATE_MAX, COORDINATE_MAX), deltaY: clamp(last.deltaY + next.deltaY, -COORDINATE_MAX, COORDINATE_MAX) },
    ];
  }
  return [...queue, next];
};

/** Splits pasted text into the pieces the protocol takes, in order. */
export const textEvents = (text: string): readonly PreviewInputEvent[] => {
  const pieces: PreviewInputEvent[] = [];
  // By code point, so a character outside the basic plane is never cut in half.
  let piece = "";
  let count = 0;
  for (const character of text) {
    piece += character;
    count += 1;
    if (count === runnerLimits.previewInputTextMaxChars) {
      pieces.push({ kind: "text", text: piece });
      piece = "";
      count = 0;
    }
  }
  if (piece.length > 0) pieces.push({ kind: "text", text: piece });
  return pieces;
};

/** What a post of input or a control came back with. */
export type PreviewInputResult = { readonly ok: true } | { readonly ok: false; readonly status: number; readonly code: PreviewRouteErrorCode | null };

/** Posts one body to a view's input route: `{ events }` or `{ control }`, as JSON. */
export const postPreviewInput = async (
  viewId: PreviewViewId,
  linkToken: string | null,
  body: { readonly events: readonly PreviewInputEvent[] } | { readonly control: PreviewPageControl },
  send: typeof fetch = fetch,
): Promise<PreviewInputResult> => {
  try {
    const response = await send(previewRoutes.input(viewId), {
      method: "POST",
      headers: { ...previewHeaders(linkToken), "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (response.ok) return { ok: true };
    return { ok: false, status: response.status, code: await refusalCodeOf(response) };
  } catch {
    return { ok: false, status: 0, code: null };
  }
};

export type InputTimers = {
  readonly set: (run: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clear: (handle: ReturnType<typeof setTimeout>) => void;
};

const browserTimers: InputTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => { clearTimeout(handle); },
};

export type InputBatcher = {
  /** Queues an event: it goes in the next batch, in order. */
  readonly push: (event: PreviewInputEvent) => void;
  /** Sends what's queued now (after the batch in flight, if any). */
  readonly flush: () => Promise<void>;
  /** Drops what's queued and sends nothing more. */
  readonly dispose: () => void;
};

/**
 * Batches input every `intervalMs` (a full batch goes at once), one request at a time so the page
 * gets the events in the order they happened. `send` answers whether the batch went through; a
 * refusal drops it (the page moves on: a stale click is worse than a lost one).
 */
export const createInputBatcher = (send: (events: readonly PreviewInputEvent[]) => Promise<unknown>, intervalMs = 40, timers: InputTimers = browserTimers): InputBatcher => {
  let queue: readonly PreviewInputEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> = Promise.resolve();
  let disposed = false;

  const flush = (): Promise<void> => {
    if (timer !== null) {
      timers.clear(timer);
      timer = null;
    }
    if (disposed || queue.length === 0) return inFlight;
    const batch = queue.slice(0, runnerLimits.previewInputEventsMax);
    queue = queue.slice(batch.length);
    inFlight = inFlight.then(async () => {
      if (!disposed) await send(batch);
    });
    if (queue.length > 0) return flush();
    return inFlight;
  };

  return {
    push: (event) => {
      if (disposed) return;
      queue = coalesce(queue, event);
      if (queue.length >= runnerLimits.previewInputEventsMax) {
        void flush();
        return;
      }
      timer ??= timers.set(() => { timer = null; void flush(); }, intervalMs);
    },
    flush,
    dispose: () => {
      disposed = true;
      queue = [];
      if (timer !== null) timers.clear(timer);
      timer = null;
    },
  };
};
