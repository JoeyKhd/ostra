import type { PreviewInputEvent } from "@ostra/protocol";
import type { KeyInput, MouseInput, Page } from "./page.ts";

// Milestone 8's ticket 18 (F-141, ADR 0068 "The browser view"): a member's input onto the shared
// page, in order, as DevTools takes it. Mouse and wheel are `Input.dispatchMouseEvent`; a key is
// `dispatchKeyEvent`, a `keyDown` with its text for a key that types one, else a `rawKeyDown` with
// its Windows virtual-key code (spike 07: DevTools wants one for a key that types nothing, and the
// member's page sends only `key` and `code`, so it's derived from them here); pasted text is
// `insertText`, accents and symbols intact. Files and the member's clipboard never cross. Nothing
// here is logged: typed text and keys stay out of every log line.
//
// Ported from spikes/box-browser-stream/src/sidecar/input.ts and src/viewer/viewer.ts.

/** The modifier bits DevTools counts: Alt 1, Ctrl 2, Meta 4, Shift 8. */
const CTRL = 2;
const META = 4;

/** Windows virtual-key codes by `KeyboardEvent.code`, for the keys whose code names no letter or digit. */
const NAMED_KEY_CODES: Readonly<Record<string, number>> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  NumpadEnter: 13,
  ShiftLeft: 16,
  ShiftRight: 16,
  ControlLeft: 17,
  ControlRight: 17,
  AltLeft: 18,
  AltRight: 18,
  Pause: 19,
  CapsLock: 20,
  Escape: 27,
  Space: 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  MetaLeft: 91,
  MetaRight: 92,
  ContextMenu: 93,
  NumpadMultiply: 106,
  NumpadAdd: 107,
  NumpadSubtract: 109,
  NumpadDecimal: 110,
  NumpadDivide: 111,
  Semicolon: 186,
  Equal: 187,
  Comma: 188,
  Minus: 189,
  Period: 190,
  Slash: 191,
  Backquote: 192,
  BracketLeft: 219,
  Backslash: 220,
  BracketRight: 221,
  Quote: 222,
};

/** The same by `KeyboardEvent.key`, when the code doesn't say (a key a member's layout moved). */
const NAMED_KEYS: Readonly<Record<string, number>> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Escape: 27,
  " ": 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
  Meta: 91,
};

/** One character: a key that types it (a code point, so an accent is one). */
const ONE_CHARACTER = /^.$/su;

/** A key's Windows virtual-key code, from its `code` and then its `key`; 0 when neither says. */
export const virtualKeyCode = (code: string, key: string): number => {
  const named = NAMED_KEY_CODES[code];
  if (named !== undefined) return named;
  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  if (letter !== undefined) return letter.charCodeAt(0);
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code)?.[1];
  if (digit !== undefined) return digit.charCodeAt(0);
  const fn = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code)?.[1];
  if (fn !== undefined) return 111 + Number(fn);
  const byKey = NAMED_KEYS[key];
  if (byKey !== undefined) return byKey;
  if (ONE_CHARACTER.test(key)) {
    const upper = key.toUpperCase();
    if (/^[A-Z0-9]$/.test(upper)) return upper.charCodeAt(0);
  }
  return 0;
};

/** The text a key types: one character, or a carriage return for Enter; none with Ctrl or Meta held. */
const typedText = (key: string, modifiers: number): string | null => {
  if ((modifiers & (CTRL | META)) !== 0) return null;
  if (key === "Enter") return "\r";
  return ONE_CHARACTER.test(key) ? key : null;
};

const BUTTON_MASKS = { none: 0, left: 1, right: 2, middle: 4 } as const;

const mouseTypes = { move: "mouseMoved", down: "mousePressed", up: "mouseReleased" } as const;

/** One mouse event as DevTools takes it: a press holds its button down, a release lets go, a move carries what's held. */
export const mouseInputOf = (event: Extract<PreviewInputEvent, { kind: "mouse" }>): MouseInput => ({
  type: mouseTypes[event.action],
  x: event.x,
  y: event.y,
  button: event.button,
  buttons: event.action === "up" ? 0 : BUTTON_MASKS[event.button],
  clickCount: event.clickCount,
  modifiers: event.modifiers,
});

/** One key event as DevTools takes it: `keyDown` with the text a key types, `rawKeyDown` for the rest, `keyUp`. */
export const keyInputOf = (event: Extract<PreviewInputEvent, { kind: "key" }>): KeyInput => {
  const base = { key: event.key, code: event.code, windowsVirtualKeyCode: virtualKeyCode(event.code, event.key), modifiers: event.modifiers };
  if (event.action === "up") return { ...base, type: "keyUp" };
  const text = typedText(event.key, event.modifiers);
  return text === null ? { ...base, type: "rawKeyDown" } : { ...base, type: "keyDown", text };
};

/** Applies one event to the page. */
const dispatchOne = async (page: Page, event: PreviewInputEvent): Promise<void> => {
  switch (event.kind) {
    case "mouse":
      await page.mouse(mouseInputOf(event));
      return;
    case "wheel":
      await page.mouse({ type: "mouseWheel", x: event.x, y: event.y, deltaX: event.deltaX, deltaY: event.deltaY, modifiers: event.modifiers });
      return;
    case "key":
      await page.key(keyInputOf(event));
      return;
    case "text":
      await page.insertText(event.text);
      return;
    default:
      event satisfies never;
  }
};

/**
 * Applies a batch of input to the page, in order, one event after the other. An event the page
 * refuses is counted and the rest still go: a member's next click shouldn't wait on a bad key.
 */
export const dispatchViewInput = async (page: Page, events: readonly PreviewInputEvent[]): Promise<{ readonly applied: number; readonly failed: number }> => {
  let applied = 0;
  let failed = 0;
  for (const event of events) {
    try {
      await dispatchOne(page, event);
      applied += 1;
    } catch {
      failed += 1;
    }
  }
  return { applied, failed };
};
