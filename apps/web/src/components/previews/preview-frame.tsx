"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";

import type { PreviewClose, PreviewViewId } from "@ostra/protocol";
import type { PreviewRouteErrorCode } from "@ostra/api";

import { cn } from "@/lib/cn";

import { buttonOf, createInputBatcher, heldButton, modifiersOf, pagePoint, postPreviewInput, textEvents, wheelPixels } from "./preview-input";
import type { InputBatcher } from "./preview-input";
import { openPreviewStream, refusalRetries } from "./preview-stream";
import type { PreviewFrame as StreamFrame } from "./preview-stream";

// The frame that draws a view (milestone 8, F-141, F-142; task-preview.md and preview-viewer.md):
// the browser view's JPEG frames onto a `<canvas>`, each from a `blob:` URL revoked once drawn,
// scaled down to fit and never up. With input, the frame takes the focus and sends the member's
// mouse, wheel, keys and pasted text to the shared page; Tab still moves the focus on, and Escape
// or ⌘. (Ctrl+. elsewhere) hands it back, so the panel's keyboard rules hold (milestone 7). One
// interface for the pane and the viewer page: ticket 26 adds the native preview's `<iframe>` behind
// the same props (`mode`).

/** What the frame shows now, for its owner's footer and states. */
export type FrameStatus =
  /** Waiting for the first frame: the box hasn't connected the view yet. */
  | { readonly kind: "connecting" }
  | { readonly kind: "live" }
  /** The stream dropped after frames came: it's being opened again. */
  | { readonly kind: "reconnecting" }
  /** It didn't come back in time: `Retry` starts again. */
  | { readonly kind: "lost" }
  /** Core ended the view, with why. */
  | { readonly kind: "closed"; readonly close: PreviewClose }
  /** The route refused the stream for good. */
  | { readonly kind: "refused"; readonly code: PreviewRouteErrorCode | null };

/** A page's size in CSS pixels: the frame's own. */
export type FrameSize = { readonly width: number; readonly height: number };

/** How long a dropped stream is tried again before it's lost (task-preview.md, "The stream dropped"). */
export const RECONNECT_FOR_MS = 30_000;
/** How long a view waits for its box to connect before it's lost (task-preview.md, "Starting": 90 s). */
export const CONNECT_FOR_MS = 90_000;

/** The wait before the next try: quick at first, then once every few seconds. */
const backoff = (tries: number): number => Math.min(4_000, 500 * 2 ** Math.min(tries, 3));

const wait = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });

export type PreviewFrameProps = {
  /** The browser view today; ticket 26 adds `native` (an `<iframe>` on the preview host). */
  readonly mode: "stream";
  readonly viewId: PreviewViewId;
  /** The viewer page's link token, sent in `x-ostra-preview-link`; `null` in the pane (the session). */
  readonly linkToken: string | null;
  /** Whether the viewer may give input: without it the frame takes no focus and sends nothing. */
  readonly input: boolean;
  /** The frame's accessible name: `web :5173 at /history, live`. */
  readonly name: string;
  readonly onStatus: (status: FrameStatus) => void;
  readonly onSize?: (size: FrameSize) => void;
  /** The scale the frame is drawn at, in percent (100 at its own size, less when it's fitted down). */
  readonly onScale?: (percent: number) => void;
  /** Escape or ⌘. in the frame: the owner moves the focus back to its toolbar. */
  readonly onLeave?: () => void;
  /** Bumped to start the stream again after it was lost. */
  readonly attempt: number;
  /** The last picture, dimmed: the app stopped answering. */
  readonly dimmed?: boolean;
  /** Something laid over the frame (the reconnecting pill). */
  readonly overlay?: ReactNode;
  /** Wraps the canvas: the viewer page's watch-only tooltip. */
  readonly wrap?: (canvas: ReactNode) => ReactNode;
  /** The picture's own edge: the viewer page's frame hugs the picture, the pane's fills its viewport. */
  readonly hug?: boolean;
  readonly className?: string;
};

export const PreviewFrame = ({ viewId, linkToken, input, name, onStatus, onSize, onScale, onLeave, attempt, dimmed = false, overlay, wrap, hug = false, className }: PreviewFrameProps) => {
  const box = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState<FrameSize | null>(null);
  const [room, setRoom] = useState<FrameSize | null>(null);
  const pending = useRef<StreamFrame | null>(null);
  const drawing = useRef(false);
  const sizeRef = useRef<FrameSize | null>(null);
  const batcher = useRef<InputBatcher | null>(null);
  const latest = useRef({ onStatus, onSize, onScale, onLeave });
  latest.current = { onStatus, onSize, onScale, onLeave };

  // Draws the newest frame that came while the last one decoded: a slow decode never queues up.
  const draw = useCallback(() => {
    const target = canvas.current;
    const frame = pending.current;
    if (drawing.current || target === null || frame === null) return;
    pending.current = null;
    drawing.current = true;
    const url = URL.createObjectURL(new Blob([frame.jpeg.slice()], { type: "image/jpeg" }));
    const image = new Image();
    const done = () => {
      URL.revokeObjectURL(url);
      drawing.current = false;
      draw();
    };
    image.onload = () => {
      const { width, height } = frame.header;
      if (target.width !== width || target.height !== height) {
        target.width = width;
        target.height = height;
      }
      target.getContext("2d")?.drawImage(image, 0, 0, width, height);
      target.dataset["frameSeq"] = String(frame.header.seq);
      const known = sizeRef.current;
      if (known?.width !== width || known.height !== height) {
        const next = { width, height };
        sizeRef.current = next;
        setSize(next);
        latest.current.onSize?.(next);
      }
      done();
    };
    image.onerror = done;
    image.src = url;
  }, []);

  // The stream: opened, read, and opened again after a drop, until it ends for good or the frame goes.
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const report = (status: FrameStatus) => {
      if (!signal.aborted) latest.current.onStatus(status);
    };
    void (async () => {
      // `live`: frames came since the last (re)connect; `seen`: any ever did, so a wait is a drop.
      // An object, since the frames' callback sets them between the awaits.
      const got = { live: false, seen: false };
      let since = Date.now();
      let tries = 0;
      report({ kind: "connecting" });
      for (;;) {
        const end = await openPreviewStream(viewId, linkToken, (frame) => {
          if (!got.live) {
            got.live = true;
            got.seen = true;
            tries = 0;
            report({ kind: "live" });
          }
          pending.current = frame;
          draw();
        }, signal);
        if (signal.aborted || end.kind === "aborted") return;
        if (end.kind === "closed") {
          report({ kind: "closed", close: end.close });
          return;
        }
        if (end.kind === "refused" && !refusalRetries(end.code)) {
          report({ kind: "refused", code: end.code });
          return;
        }
        // Dropped, or the box hasn't connected yet: try again, for a while.
        if (got.live) {
          got.live = false;
          since = Date.now();
          report({ kind: "reconnecting" });
        }
        if (Date.now() - since > (got.seen ? RECONNECT_FOR_MS : CONNECT_FOR_MS)) {
          report({ kind: "lost" });
          return;
        }
        await wait(backoff(tries), signal);
        tries += 1;
      }
    })();
    return () => { controller.abort(); };
  }, [viewId, linkToken, attempt, draw]);

  // Input, batched and posted in order; nothing for a viewer who may only watch.
  useEffect(() => {
    if (!input) return;
    const made = createInputBatcher((events) => postPreviewInput(viewId, linkToken, { events }));
    batcher.current = made;
    return () => {
      made.dispose();
      batcher.current = null;
    };
  }, [input, viewId, linkToken]);

  // The room the frame has: the frame scales down to fit it, never up.
  useEffect(() => {
    const node = box.current;
    if (node === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      setRoom({ width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) });
    });
    observer.observe(node);
    return () => { observer.disconnect(); };
  }, []);

  // The wheel needs a listener that may cancel the page's own scroll.
  useEffect(() => {
    const node = canvas.current;
    if (node === null || !input) return;
    const onWheel = (event: WheelEvent) => {
      const page = sizeRef.current;
      if (page === null) return;
      event.preventDefault();
      const point = pagePoint({ x: event.clientX, y: event.clientY }, node.getBoundingClientRect(), page);
      batcher.current?.push({ kind: "wheel", ...point, deltaX: wheelPixels(event.deltaX, event.deltaMode, page.height), deltaY: wheelPixels(event.deltaY, event.deltaMode, page.height), modifiers: modifiersOf(event) });
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => { node.removeEventListener("wheel", onWheel); };
  }, [input]);

  const pointer = (action: "move" | "down" | "up") => (event: PointerEvent<HTMLCanvasElement>) => {
    const page = sizeRef.current;
    if (!input || page === null) return;
    if (action === "down") {
      event.currentTarget.setPointerCapture(event.pointerId);
      box.current?.focus({ preventScroll: true });
    }
    const point = pagePoint({ x: event.clientX, y: event.clientY }, event.currentTarget.getBoundingClientRect(), page);
    const button = action === "move" ? heldButton(event.buttons) : buttonOf(event.button);
    batcher.current?.push({ kind: "mouse", action, ...point, button, clickCount: action === "move" ? 0 : Math.min(3, Math.max(1, event.detail)), modifiers: modifiersOf(event) });
    if (action !== "move") void batcher.current?.flush();
  };

  const onKey = (action: "down" | "up") => (event: KeyboardEvent<HTMLDivElement>) => {
    if (!input) return;
    // Tab moves the focus on, as everywhere in the panel: the frame is never a trap.
    if (event.key === "Tab") return;
    if (action === "down" && (event.key === "Escape" || (event.key === "." && (event.metaKey || event.ctrlKey)))) {
      event.preventDefault();
      latest.current.onLeave?.();
      return;
    }
    // Every other key is the app's: none of the panel's shortcuts fire (they skip a prevented key).
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat && action === "up") return;
    batcher.current?.push({ kind: "key", action, key: event.key.slice(0, 64) || "Unidentified", code: event.code.slice(0, 64), modifiers: modifiersOf(event) });
  };

  const fit = size === null || room === null ? 1 : Math.min(1, room.width / size.width, room.height / size.height);
  const drawn = size === null ? null : { width: Math.max(1, Math.floor(size.width * fit)), height: Math.max(1, Math.floor(size.height * fit)) };
  const percent = Math.round(fit * 100);
  useEffect(() => { latest.current.onScale?.(percent); }, [percent]);

  const picture = (
    <canvas
      ref={canvas}
      data-testid="preview-canvas"
      aria-hidden
      onPointerDown={pointer("down")}
      onPointerUp={pointer("up")}
      onPointerMove={pointer("move")}
      onContextMenu={(event) => { if (input) event.preventDefault(); }}
      className={cn("block bg-transparent", hug ? "rounded-lg border border-line-2" : "rounded-[7px]", input ? "cursor-auto touch-none" : "cursor-default", dimmed && "opacity-40")}
      style={drawn === null ? { width: 0, height: 0 } : { width: drawn.width, height: drawn.height }}
    />
  );

  return (
    <div
      ref={box}
      data-testid="preview-frame"
      data-view-id={viewId}
      data-input={input ? "true" : "false"}
      data-scale={String(Math.round(fit * 100))}
      role={input ? "application" : "img"}
      aria-label={name}
      tabIndex={input ? 0 : undefined}
      onKeyDown={onKey("down")}
      onKeyUp={onKey("up")}
      onPaste={(event) => {
        if (!input) return;
        event.preventDefault();
        for (const piece of textEvents(event.clipboardData.getData("text/plain"))) batcher.current?.push(piece);
      }}
      className={cn("relative grid size-full min-h-0 min-w-0 place-items-center overflow-hidden rounded-lg focus-visible:outline-offset-[-2px]", className)}
    >
      {wrap === undefined ? picture : wrap(picture)}
      {overlay}
    </div>
  );
};
