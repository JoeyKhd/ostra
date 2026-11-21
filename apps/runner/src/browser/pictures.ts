import { encodeFrameReel, frameReelMaxFrames, RECORD_STEP_DEADLINE_MS, runnerLimits } from "@ostra/protocol";
import type { FrameReelFrame, FrameReelStep, RecordStep, RecordStepFailure, RecordStepFailureReason } from "@ostra/protocol";
import { z } from "zod";
import { isDevToolsError } from "./devtools-client.ts";
import type { DevToolsClient } from "./devtools-client.ts";
import { openPage } from "./page.ts";
import type { KeyInput, Page, Viewport } from "./page.ts";

// Milestone 8's ticket 13 (F-121, ADR 0068): a screenshot and a recording of the running app, each
// in a page of its own in the box's browser, never the page a member watches (ticket 18).
//
// - **A screenshot** loads its address at the size asked, waits for the page's network to go quiet
//   (no request in flight for `quietMs`, at most `settleMaxMs`: a page that keeps polling is taken
//   as it is then), and captures a PNG: the viewport, or the full page up to 10,000 px high.
// - **A recording** loads its address, then runs its steps under a screencast at 10 frames a second,
//   held by the frames' acks (spike 07), its frames JPEG at quality 60. Each step has a deadline
//   and the recording a length; a step that fails ends it there, with the frames it has. Its
//   frames, their times and its steps are one frame reel (ticket 01's format) within its limits.
// - **The steps are data.** A selector, a text and a value reach the page as JSON in a fixed
//   function's argument, never as code of their own; a key is looked up in a closed table. Nothing
//   of a page, a step or a caption is logged here: this module logs nothing.
//
// Ported from spikes/box-browser-stream/ (a page of its own per picture, PNG screenshots, and
// recordings as a 10 fps screencast by held acks, kept as JPEG q60 frames).

/** How long things take; tests shorten them. */
export type PictureTiming = {
  /** How long no request may be in flight before a screenshot. */
  readonly quietMs: number;
  /** The longest a page may take to go quiet, in ms. */
  readonly settleMaxMs: number;
  /** The longest a page may take to load. */
  readonly navigateMs: number;
  /** The longest one step of a recording may take. */
  readonly stepMs: number;
  /** How often a step looks for its element again. */
  readonly pollMs: number;
  /** How long a recording goes on after its last step, so the last change is in it. */
  readonly tailMs: number;
};

export const defaultPictureTiming: PictureTiming = {
  quietMs: 500,
  settleMaxMs: runnerLimits.screenshotSettleMaxMs,
  navigateMs: 30_000,
  stepMs: RECORD_STEP_DEADLINE_MS,
  pollMs: 100,
  tailMs: 500,
};

/** The quality a recording's frames are kept at (spike 07: a 30 s reel fits 32 MiB at q60; PNG frames don't). */
const RECORDING_QUALITY = 60;
/** The gap between two frames a recording keeps: 10 a second. */
const FRAME_GAP_MS = Math.ceil(1000 / runnerLimits.recordingFramesPerSecond);
/** Room the reel's header and each frame's 8 bytes take, below `recordingMaxBytes`. */
const REEL_HEADER_ROOM = 512 * 1024;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms)).unref();
  });

/** Why a page-level picture didn't come out: its page didn't load (Chromium's words in `detail`), or the browser stopped answering. */
export type PictureFailure = { readonly code: "page-failed"; readonly detail: string | null } | { readonly code: "browser-failed" };

export type Screenshot = { readonly png: Buffer; readonly width: number; readonly height: number };

export type ScreenshotRequest = {
  /** The address the box's browser opens, such as `http://localhost:5173/settings`. */
  readonly url: string;
  readonly viewport: Viewport;
  readonly fullPage: boolean;
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PNG's size from its header; `null` for bytes that aren't one. */
export const pngSize = (bytes: Buffer): { readonly width: number; readonly height: number } | null => {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("latin1", 12, 16) !== "IHDR") {
    return null;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

const isJpeg = (bytes: Uint8Array): boolean => bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;

/** A DevTools failure as a picture's: a navigation's error is the page's; the browser going, or anything else, is the browser's. */
const failureOf = (error: unknown): PictureFailure => {
  if (isDevToolsError(error) && error.kind === "protocol" && error.method === "Page.navigate") {
    return { code: "page-failed", detail: error.detail };
  }
  if (isDevToolsError(error) && error.kind === "deadline" && (error.method === "Page.navigate" || error.method === "Page.loadEventFired")) {
    return { code: "page-failed", detail: "the page didn't finish loading in time" };
  }
  return { code: "browser-failed" };
};

const requestSchema = z.looseObject({ requestId: z.string(), type: z.string().optional() });
const finishedSchema = z.looseObject({ requestId: z.string() });

/**
 * The page's requests in flight, from the Network domain's events (enabled before the page loads):
 * an EventSource never ends, so it doesn't count; a WebSocket isn't a request.
 */
const watchNetwork = (page: Page): { readonly quiet: (quietMs: number, maxMs: number) => Promise<boolean>; readonly stop: () => void } => {
  const inFlight = new Set<string>();
  let changedAt = Date.now();
  const offs = [
    page.onEvent("Network.requestWillBeSent", (params) => {
      const request = requestSchema.safeParse(params);
      if (request.success && request.data.type !== "EventSource") {
        inFlight.add(request.data.requestId);
        changedAt = Date.now();
      }
    }),
    ...["Network.loadingFinished", "Network.loadingFailed"].map((method) =>
      page.onEvent(method, (params) => {
        const done = finishedSchema.safeParse(params);
        if (done.success && inFlight.delete(done.data.requestId)) {
          changedAt = Date.now();
        }
      }),
    ),
  ];
  return {
    quiet: async (quietMs, maxMs) => {
      const deadline = Date.now() + maxMs;
      for (;;) {
        if (inFlight.size === 0 && Date.now() - changedAt >= quietMs) {
          return true;
        }
        if (Date.now() >= deadline) {
          return false;
        }
        await sleep(Math.min(50, deadline - Date.now()));
      }
    },
    stop: () => {
      for (const off of offs) {
        off();
      }
    },
  };
};

/**
 * A screenshot in a page of its own: the address loaded at the viewport, the network quiet (at most
 * `settleMaxMs`), then a PNG of the viewport or of the full page (at most `screenshotMaxHeightPx`
 * high and `screenshotMaxWidthPx` wide). The page is closed whatever happens.
 */
export const takeScreenshot = async (
  client: DevToolsClient,
  request: ScreenshotRequest,
  timing: PictureTiming = defaultPictureTiming,
): Promise<{ readonly ok: true; readonly value: Screenshot } | { readonly ok: false; readonly failure: PictureFailure }> => {
  let page: Page | undefined;
  try {
    page = await openPage(client, request.viewport);
    await client.command("Network.enable", {}, { sessionId: page.sessionId });
    const network = watchNetwork(page);
    try {
      await page.navigate(request.url, timing.navigateMs);
      await network.quiet(timing.quietMs, timing.settleMaxMs);
    } finally {
      network.stop();
    }
    const png = await page.screenshot({
      format: "png",
      fullPage: request.fullPage,
      maxHeight: runnerLimits.screenshotMaxHeightPx,
      maxWidth: runnerLimits.screenshotMaxWidthPx,
      // A phone or a tablet shows a page laid out wider than it zoomed out: its full page too.
      ...(request.viewport.mobile ? { fitWidth: request.viewport.width } : {}),
    });
    const size = pngSize(png);
    if (size === null || size.width > runnerLimits.screenshotMaxWidthPx || size.height > runnerLimits.screenshotMaxHeightPx) {
      return { ok: false, failure: { code: "browser-failed" } };
    }
    return { ok: true, value: { png, ...size } };
  } catch (error) {
    return { ok: false, failure: failureOf(error) };
  } finally {
    await page?.close();
  }
};

// ---------- a recording ----------

/** One key as `Input.dispatchKeyEvent` takes it: its name, its code, its virtual-key code and the text it types. */
type KeyDefinition = { readonly key: string; readonly code: string; readonly keyCode: number; readonly text?: string };

/** The keys a `press` step names that type no character, or a whitespace one (spike 07: virtual-key codes from `code`). */
const NAMED_KEYS: Readonly<Record<string, KeyDefinition>> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

/** The modifiers a `press` step may put before its key, and DevTools' bit for each. */
const MODIFIERS: Readonly<Record<string, number>> = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Command: 4, Shift: 8 };

/** One character as a key: a letter or a digit has its own code; anything else types its text. */
const characterKey = (character: string): KeyDefinition => {
  const upper = character.toUpperCase();
  if (/^[A-Z]$/.test(upper)) {
    return { key: character, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: character };
  }
  if (/^[0-9]$/.test(character)) {
    return { key: character, code: `Digit${character}`, keyCode: character.charCodeAt(0), text: character };
  }
  return { key: character, code: "", keyCode: 0, text: character };
};

/**
 * A `press` step's key, from the closed table: one character or a named key, after modifiers
 * (`Control+a`, `Shift+Tab`). `null` for anything else, which the step refuses.
 */
export const keyOf = (name: string): { readonly key: KeyDefinition; readonly modifiers: number } | null => {
  const parts = name === "+" ? ["+"] : name.split("+");
  const last = parts.pop();
  if (last === undefined || last === "") {
    return null;
  }
  let modifiers = 0;
  for (const part of parts) {
    const bit = MODIFIERS[part];
    if (bit === undefined) {
      return null;
    }
    modifiers |= bit;
  }
  const named = NAMED_KEYS[last];
  if (named !== undefined) {
    return { key: named, modifiers };
  }
  // One character: one UTF-16 unit, or one code point past the first plane (two units).
  const oneCharacter = last.length === 1 || (last.length === 2 && (last.codePointAt(0) ?? 0) > 0xffff);
  return oneCharacter ? { key: characterKey(last), modifiers } : null;
};

/**
 * What the page runs to find a step's element, with the step's selector or text as its JSON
 * argument: never code of its own. It finds the element (by CSS, or the deepest visible element
 * holding the text), scrolls it to the middle, and answers where its middle is; with `focus`, it
 * focuses it and selects what it holds, as a `fill` replaces it. A selector that isn't CSS says so.
 */
const FIND_ELEMENT = `(arg) => {
  try {
    const visible = (el) => {
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const norm = (text) => String(text ?? "").replace(/\\s+/g, " ").trim();
    let el = null;
    if (typeof arg.selector === "string") {
      try {
        el = document.querySelector(arg.selector);
      } catch (error) {
        return { state: "invalid" };
      }
    } else {
      const want = norm(arg.text);
      const holds = new Set(Array.from(document.querySelectorAll("body *")).filter((each) => norm(each.textContent).includes(want) && visible(each)));
      const deepest = Array.from(holds).filter((each) => !Array.from(each.children).some((child) => holds.has(child)));
      el = deepest.find((each) => norm(each.textContent) === want) ?? deepest[0] ?? null;
    }
    if (el === null) return { state: "missing" };
    if (!arg.exists) el.scrollIntoView({ block: "center", inline: "center" });
    if (!arg.exists && !visible(el)) return { state: "missing" };
    if (arg.focus) {
      el.focus();
      if (typeof el.select === "function") {
        el.select();
      } else {
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
    const box = el.getBoundingClientRect();
    return { state: "found", x: box.left + box.width / 2, y: box.top + box.height / 2 };
  } catch (error) {
    return { state: "missing" };
  }
}`;

const foundSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("found"), x: z.number(), y: z.number() }),
  z.object({ state: z.literal("missing") }),
  z.object({ state: z.literal("invalid") }),
]);

type FindArgument = { readonly selector: string } | { readonly text: string };

/** What a step throws, with why: the recording ends there. */
type StepFailed = Error & { readonly stepFailure: RecordStepFailureReason };

const stepFailed = (reason: RecordStepFailureReason): StepFailed => Object.assign(new Error(`step: ${reason}`), { stepFailure: reason });

const isStepFailed = (error: unknown): error is StepFailed => error instanceof Error && typeof Reflect.get(error, "stepFailure") === "string";

/** Looks for the element until it's there or the step's time is up. */
const findElement = async (
  page: Page,
  target: FindArgument,
  options: { readonly focus: boolean; readonly exists: boolean },
  deadline: number,
  pollMs: number,
): Promise<{ readonly x: number; readonly y: number }> => {
  const expression = `(${FIND_ELEMENT})(${JSON.stringify({ ...target, focus: options.focus, exists: options.exists })})`;
  for (;;) {
    let found: z.infer<typeof foundSchema>;
    try {
      found = await page.evaluate(expression, foundSchema);
    } catch (error) {
      if (isDevToolsError(error) && error.kind === "closed") {
        throw stepFailed("browser-failed");
      }
      // A page that answers in no shape ostra asked for (or a browser that can't evaluate it): not there.
      throw stepFailed("not-found");
    }
    if (found.state === "found") {
      return found;
    }
    if (found.state === "invalid") {
      throw stepFailed("invalid-selector");
    }
    if (Date.now() + pollMs > deadline) {
      throw stepFailed("not-found");
    }
    await sleep(pollMs);
  }
};

const pressKey = async (page: Page, name: string): Promise<void> => {
  const parsed = keyOf(name);
  if (parsed === null) {
    throw stepFailed("unknown-key");
  }
  const { key, modifiers } = parsed;
  // With a modifier other than Shift, a key types nothing: Control+a selects, it doesn't write an "a".
  const text = key.text !== undefined && (modifiers & ~8) === 0 ? key.text : null;
  const base: Omit<KeyInput, "type"> = {
    key: key.key,
    code: key.code,
    windowsVirtualKeyCode: key.keyCode,
    modifiers,
  };
  await page.key({ ...base, ...(text === null ? { type: "rawKeyDown" } : { type: "keyDown", text }) });
  await page.key({ ...base, type: "keyUp" });
};

/** A step's work in the page, within `deadline`. Navigation and DevTools failures become the step's. */
const runStep = async (page: Page, origin: string, step: RecordStep, deadline: number, timing: PictureTiming, viewport: Viewport): Promise<void> => {
  const left = (): number => Math.max(1, deadline - Date.now());
  switch (step.action) {
    case "goto":
      await page.navigate(`${origin}${step.path}`, left());
      return;
    case "click": {
      const at = await findElement(page, step.target, { focus: false, exists: false }, deadline, timing.pollMs);
      await page.mouse({ type: "mouseMoved", x: at.x, y: at.y });
      await page.mouse({ type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 });
      await page.mouse({ type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 });
      return;
    }
    case "fill": {
      await findElement(page, { selector: step.selector }, { focus: true, exists: false }, deadline, timing.pollMs);
      if (step.value === "") {
        await pressKey(page, "Backspace");
      } else {
        await page.insertText(step.value);
      }
      return;
    }
    case "press":
      await pressKey(page, step.key);
      return;
    case "scroll":
      await page.mouse({ type: "mouseWheel", x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 2), deltaX: step.deltaX, deltaY: step.deltaY });
      await sleep(Math.min(200, left()));
      return;
    case "wait":
      if ("ms" in step.until) {
        await sleep(Math.min(step.until.ms, left()));
        return;
      }
      await findElement(page, { selector: step.until.selector }, { focus: false, exists: true }, deadline, timing.pollMs);
      return;
    default:
      step satisfies never;
  }
};

/** A step's failure, from what it threw. */
const stepFailureOf = (error: unknown, number: number, step: RecordStep): RecordStepFailure => {
  if (isStepFailed(error)) {
    return { number, action: step.action, reason: error.stepFailure, detail: null };
  }
  if (isDevToolsError(error)) {
    if (error.kind === "closed") {
      return { number, action: step.action, reason: "browser-failed", detail: null };
    }
    if (error.method === "Page.navigate" && error.kind === "protocol") {
      return { number, action: step.action, reason: "navigation-failed", detail: error.detail };
    }
    if (error.kind === "deadline") {
      return { number, action: step.action, reason: "deadline", detail: null };
    }
  }
  return { number, action: step.action, reason: "browser-failed", detail: null };
};

export type RecordingRequest = {
  /** The app's origin in the box, such as `http://localhost:5173`: each `goto` is a path on it. */
  readonly origin: string;
  readonly viewport: Viewport;
  readonly steps: readonly RecordStep[];
  /** The longest it records, in ms: at most `recordingMaxSeconds`. */
  readonly maxMs: number;
};

export type Recording = {
  readonly reel: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
  readonly frameCount: number;
  /** The step it stopped at, when one failed; the reel holds the frames and steps before it, and it. */
  readonly failedStep: RecordStepFailure | null;
};

export type RecordingOutcome =
  | { readonly ok: true; readonly value: Recording }
  | { readonly ok: false; readonly failure: PictureFailure | { readonly code: "nothing-recorded"; readonly step: RecordStepFailure } };

/**
 * A recording in a page of its own: its first page loaded (the first step's `goto`, or the
 * origin's `/`), then a screencast at 10 frames a second while its steps run, each within its
 * deadline and the recording's length. A step that fails ends it, with what it has. Its frames
 * stay within `frameReelMaxFrames` and `recordingMaxBytes`; frames past them aren't kept.
 */
export const recordApp = async (client: DevToolsClient, request: RecordingRequest, timing: PictureTiming = defaultPictureTiming): Promise<RecordingOutcome> => {
  let page: Page | undefined;
  try {
    page = await openPage(client, request.viewport);
    const [first] = request.steps;
    // The first page loads before the screencast, so the reel opens on the app, not a blank page:
    // a first `goto` is that load, recorded at the reel's start.
    const opening = first?.action === "goto" ? first.path : "/";
    try {
      await page.navigate(`${request.origin}${opening}`, timing.navigateMs);
    } catch (error) {
      const failure = failureOf(error);
      if (first?.action === "goto" && failure.code === "page-failed") {
        return { ok: false, failure: { code: "nothing-recorded", step: { number: 1, action: "goto", reason: "navigation-failed", detail: failure.detail } } };
      }
      return { ok: false, failure };
    }
    const frames: FrameReelFrame[] = [];
    let bytes = 0;
    let capturing = true;
    const startedAt = Date.now();
    const sinceStart = (): number => Math.round(Date.now() - startedAt);
    const stopCast = await page.startScreencast(
      {
        format: "jpeg",
        quality: RECORDING_QUALITY,
        maxWidth: Math.min(request.viewport.width, runnerLimits.browserViewMaxWidth),
        maxHeight: Math.min(request.viewport.height, runnerLimits.browserViewMaxHeight),
        maxFramesInFlight: 1,
        sendLastFrame: true,
      },
      async (frame) => {
        const atMs = sinceStart();
        const fits = frames.length < frameReelMaxFrames && bytes + frame.data.length + 8 <= runnerLimits.recordingMaxBytes - REEL_HEADER_ROOM;
        if (capturing && atMs <= request.maxMs && fits && isJpeg(frame.data)) {
          frames.push({ atMs, jpeg: frame.data });
          bytes += frame.data.length + 8;
        }
        // The ack waits out the frame's gap: the next frame comes no sooner (spike 07's held acks).
        await sleep(FRAME_GAP_MS - (sinceStart() - atMs));
      },
    );
    const steps: FrameReelStep[] = [];
    let failedStep: RecordStepFailure | null = null;
    const endAt = startedAt + request.maxMs;
    for (const [index, step] of request.steps.entries()) {
      const number = index + 1;
      if (index === 0 && step.action === "goto") {
        // Loaded before the screencast started.
        steps.push({ step, atMs: 0 });
        continue;
      }
      if (Date.now() >= endAt) {
        failedStep = { number, action: step.action, reason: "out-of-time", detail: null };
        break;
      }
      steps.push({ step, atMs: Math.min(sinceStart(), request.maxMs) });
      const deadline = Math.min(Date.now() + timing.stepMs, endAt);
      try {
        await runStep(page, request.origin, step, deadline, timing, request.viewport);
      } catch (error) {
        failedStep = stepFailureOf(error, number, step);
        break;
      }
    }
    if (failedStep?.reason !== "browser-failed") {
      // The last change is in the reel: a click's re-render comes after its step.
      await sleep(Math.min(timing.tailMs, endAt - Date.now()));
    }
    capturing = false;
    await stopCast();
    const durationMs = Math.min(sinceStart(), request.maxMs);
    if (frames.length === 0) {
      // A page that never changed sent no frame: its picture now is the reel's one frame.
      const still = await page.screenshot({ format: "jpeg", quality: RECORDING_QUALITY });
      if (!isJpeg(still)) {
        return { ok: false, failure: { code: "browser-failed" } };
      }
      frames.push({ atMs: 0, jpeg: still });
    }
    const reel = encodeFrameReel({ width: request.viewport.width, height: request.viewport.height, durationMs, steps, frames });
    return {
      ok: true,
      value: { reel, width: request.viewport.width, height: request.viewport.height, durationMs, frameCount: frames.length, failedStep },
    };
  } catch (error) {
    return { ok: false, failure: failureOf(error) };
  } finally {
    await page?.close();
  }
};
