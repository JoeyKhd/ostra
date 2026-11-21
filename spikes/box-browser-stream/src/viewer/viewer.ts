// The member's pane, reduced to its core: it reads the length-prefixed JPEG frames from one streamed fetch
// response, draws the newest on a canvas, and sends mouse, wheel, keys and pasted text back as batched POSTs,
// one in flight at a time. The probe at the bottom times input against the app's two probe squares.

type Header = { seq: number; at: number; w: number; h: number };

type WireInput =
  | { t: "mouse"; type: "mousePressed" | "mouseReleased" | "mouseMoved"; x: number; y: number; button: "none" | "left" | "middle" | "right"; buttons: number; clickCount: number; modifiers: number }
  | { t: "wheel"; x: number; y: number; deltaX: number; deltaY: number; modifiers: number }
  | { t: "key"; type: "keyDown" | "keyUp"; key: string; code: string; keyCode: number; text?: string; modifiers: number; repeat: boolean }
  | { t: "text"; text: string };

const params = new URLSearchParams(location.search);
const viewId = params.get("view") ?? "v1";
const base = params.get("base") ?? "/api/previews";

const found = document.getElementById("screen");
if (!(found instanceof HTMLCanvasElement)) throw new Error("no canvas");
const canvas = found;
const context = canvas.getContext("2d", { willReadFrequently: true });
if (context === null) throw new Error("no 2d context");
const ctx = context;

// The app shows two counters as four squares each (bits 0 to 3, mod 16): presses on its counter button, and
// keydowns. The viewer counts what it sent; a frame that shows count k resolves every input up to k, so input
// can be timed while typing continuously, not only one event at a time.
type Counter = { shown: number | null; base: number | null; sent: number[]; resolved: number; lat: number[] };
const newCounter = (): Counter => ({ shown: null, base: null, sent: [], resolved: 0, lat: [] });
const resetCounter = (counter: Counter) => {
  counter.base = counter.shown;
  counter.sent = [];
  counter.resolved = 0;
  counter.lat = [];
};
const observe = (counter: Counter, value: number, at: number) => {
  counter.shown = value;
  if (counter.base === null) {
    counter.base = value;
    return;
  }
  const base = counter.base;
  for (let k = Math.min(counter.sent.length, counter.resolved + 15); k > counter.resolved; k -= 1) {
    if ((base + k) % 16 !== value) continue;
    for (let j = counter.resolved; j < k; j += 1) counter.lat.push(at - (counter.sent[j] ?? at));
    counter.resolved = k;
    return;
  }
};

type Probe = {
  frames: number;
  bytes: number;
  drawn: number;
  skipped: number;
  decodeMs: number;
  arrivals: number[];
  a: Counter;
  b: Counter;
  width: number;
  height: number;
  posts: number;
  postedEvents: number;
  postMs: number[];
  streamOpen: boolean;
  streamError: string;
  reset: () => void;
};

const probe: Probe = {
  frames: 0,
  bytes: 0,
  drawn: 0,
  skipped: 0,
  decodeMs: 0,
  arrivals: [],
  a: newCounter(),
  b: newCounter(),
  width: 0,
  height: 0,
  posts: 0,
  postedEvents: 0,
  postMs: [],
  streamOpen: false,
  streamError: "",
  reset: () => {
    probe.frames = 0;
    probe.bytes = 0;
    probe.drawn = 0;
    probe.skipped = 0;
    probe.decodeMs = 0;
    probe.arrivals = [];
    resetCounter(probe.a);
    resetCounter(probe.b);
    probe.posts = 0;
    probe.postedEvents = 0;
    probe.postMs = [];
  },
};
Reflect.set(window, "__probe", probe);

// --- drawing ------------------------------------------------------------------------------------------------

let decoding = false;
let next: { header: Header; jpeg: Uint8Array; arrived: number } | null = null;

const isWhite = (x: number, y: number) => {
  const pixel = ctx.getImageData(x, y, 1, 1).data;
  return (pixel[0] ?? 0) > 128;
};

const draw = async (frame: { header: Header; jpeg: Uint8Array; arrived: number }) => {
  const started = performance.now();
  const bitmap = await createImageBitmap(new Blob([frame.jpeg.slice()], { type: "image/jpeg" }));
  if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  probe.drawn += 1;
  probe.width = canvas.width;
  probe.height = canvas.height;
  const shown = performance.now();
  probe.decodeMs += shown - started;
  const readBits = (first: number) => [0, 1, 2, 3].reduce((value, bit) => value | ((isWhite(12 + (first + bit) * 20, 12) ? 1 : 0) << bit), 0);
  observe(probe.a, readBits(0), shown);
  observe(probe.b, readBits(4), shown);
};

const pump = async () => {
  if (decoding) return;
  decoding = true;
  while (next !== null) {
    const frame = next;
    next = null;
    await draw(frame);
  }
  decoding = false;
};

const read = async () => {
  const response = await fetch(`${base}/${viewId}/stream`, { cache: "no-store" });
  if (response.body === null) throw new Error("no body");
  probe.streamOpen = true;
  const reader = response.body.getReader();
  let buffer = new Uint8Array(0);
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const joined = new Uint8Array(buffer.length + value.length);
    joined.set(buffer, 0);
    joined.set(value, buffer.length);
    buffer = joined;
    for (;;) {
      if (buffer.length < 4) break;
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const length = view.getUint32(0);
      if (buffer.length < 4 + length) break;
      const headerLength = view.getUint16(4);
      const headerText = new TextDecoder().decode(buffer.subarray(6, 6 + headerLength));
      const parsed: unknown = JSON.parse(headerText);
      const jpeg = buffer.subarray(6 + headerLength, 4 + length);
      buffer = buffer.subarray(4 + length);
      if (typeof parsed !== "object" || parsed === null) continue;
      const header: Header = {
        seq: Number(Reflect.get(parsed, "seq")),
        at: Number(Reflect.get(parsed, "at")),
        w: Number(Reflect.get(parsed, "w")),
        h: Number(Reflect.get(parsed, "h")),
      };
      const arrived = performance.now();
      probe.frames += 1;
      probe.bytes += jpeg.length;
      probe.arrivals.push(arrived);
      if (next !== null) probe.skipped += 1;
      next = { header, jpeg, arrived };
      void pump();
    }
  }
  probe.streamOpen = false;
};

read().catch((error: unknown) => {
  probe.streamOpen = false;
  probe.streamError = error instanceof Error ? error.message : "failed";
});

// --- input --------------------------------------------------------------------------------------------------

let queue: WireInput[] = [];
let posting = false;

const flush = async () => {
  if (posting || queue.length === 0) return;
  posting = true;
  while (queue.length > 0) {
    const events = queue.slice(0, 200);
    queue = queue.slice(events.length);
    const started = performance.now();
    try {
      await fetch(`${base}/${viewId}/input`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events }) });
    } catch {
      // the next batch tries again
    }
    probe.posts += 1;
    probe.postedEvents += events.length;
    probe.postMs.push(performance.now() - started);
  }
  posting = false;
};

const send = (event: WireInput) => {
  const last = queue.at(-1);
  if (event.t === "mouse" && event.type === "mouseMoved" && last?.t === "mouse" && last.type === "mouseMoved") queue[queue.length - 1] = event;
  else queue.push(event);
  void flush();
};

const modifiersOf = (event: MouseEvent | KeyboardEvent) => (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
const buttonOf = (button: number) => (button === 0 ? "left" : button === 1 ? "middle" : button === 2 ? "right" : "none");
const point = (event: MouseEvent) => {
  const rect = canvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) * canvas.width) / Math.max(rect.width, 1);
  const y = ((event.clientY - rect.top) * canvas.height) / Math.max(rect.height, 1);
  return { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) };
};

canvas.addEventListener("mousedown", (event) => {
  probe.a.sent.push(performance.now());
  canvas.focus();
  const { x, y } = point(event);
  send({ t: "mouse", type: "mousePressed", x, y, button: buttonOf(event.button), buttons: event.buttons, clickCount: Math.min(event.detail, 3) || 1, modifiers: modifiersOf(event) });
  event.preventDefault();
});
canvas.addEventListener("mouseup", (event) => {
  const { x, y } = point(event);
  send({ t: "mouse", type: "mouseReleased", x, y, button: buttonOf(event.button), buttons: event.buttons, clickCount: Math.min(event.detail, 3) || 1, modifiers: modifiersOf(event) });
});
canvas.addEventListener("mousemove", (event) => {
  const { x, y } = point(event);
  send({ t: "mouse", type: "mouseMoved", x, y, button: "none", buttons: event.buttons, clickCount: 0, modifiers: modifiersOf(event) });
});
canvas.addEventListener(
  "wheel",
  (event) => {
    const { x, y } = point(event);
    send({ t: "wheel", x, y, deltaX: event.deltaX, deltaY: event.deltaY, modifiers: modifiersOf(event) });
    event.preventDefault();
  },
  { passive: false },
);
canvas.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

// Windows virtual-key codes, which DevTools wants for keys that type nothing (KeyboardEvent.keyCode is
// deprecated, so it is derived from `code` and `key`).
const namedKeys: Record<string, number> = {
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
  Delete: 46,
};
const virtualKeyCode = (event: KeyboardEvent): number => {
  const named = namedKeys[event.code];
  if (named !== undefined) return named;
  const letter = /^Key([A-Z])$/.exec(event.code)?.[1];
  if (letter !== undefined) return letter.charCodeAt(0);
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(event.code)?.[1];
  if (digit !== undefined) return digit.charCodeAt(0);
  return 0;
};

const keyEvent = (type: "keyDown" | "keyUp", event: KeyboardEvent) => {
  const pasteChord = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v";
  if (pasteChord) return;
  event.preventDefault();
  const text = type === "keyDown" && !event.ctrlKey && !event.metaKey ? (event.key.length === 1 ? event.key : event.key === "Enter" ? "\r" : undefined) : undefined;
  const base: WireInput = { t: "key", type, key: event.key.slice(0, 32), code: event.code.slice(0, 32), keyCode: virtualKeyCode(event), modifiers: modifiersOf(event), repeat: event.repeat };
  send(text === undefined ? base : { ...base, text });
};
canvas.addEventListener("keydown", (event) => {
  probe.b.sent.push(performance.now());
  keyEvent("keyDown", event);
});
canvas.addEventListener("keyup", (event) => {
  keyEvent("keyUp", event);
});
document.addEventListener("paste", (event) => {
  const text = event.clipboardData?.getData("text/plain") ?? "";
  if (text.length > 0) send({ t: "text", text: text.slice(0, 65_536) });
  event.preventDefault();
});
