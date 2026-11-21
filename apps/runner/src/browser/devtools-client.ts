import { BROWSER_VERSION_CALL_ID } from "@ostra/adapter-sdk";
import type { BrowserChannel } from "@ostra/adapter-sdk";
import { z } from "zod";

// Milestone 8 (ticket 11, F-121, F-141): ostra's own DevTools client, over the box's browser's pipe
// (`BrowserChannel`: whole JSON messages each way, on a channel of its own on the bridge in a box,
// the runner's own child on `host`). No port is opened, so only ostra holds the browser (ADR 0068).
//
// - **A deadline on every call:** a browser that stops answering fails the call, never the task.
// - **Replies it can't parse are refused:** every message is checked with Zod, tolerant of the
//   protocol's unknown fields since the format is Chromium's; a call whose result isn't the shape
//   it asked for fails with `unparsable`.
// - **Nothing of a page reaches a log line:** this client logs nothing, and its errors carry the
//   method and the protocol's error code; Chromium's own words stay in `detail`, which a caller
//   may hand to the agent or the panel but never logs.
//
// Ported from spikes/box-browser-stream/src/cdp/pipe.ts.

/** What a DevTools message can be: a reply (with its `id`) or an event (with its `method`). */
const incomingSchema = z.looseObject({
  id: z.number().int().optional(),
  method: z.string().min(1).optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ code: z.number(), message: z.string() }).optional(),
  sessionId: z.string().min(1).optional(),
});

export type DevToolsEvent = { readonly method: string; readonly params: unknown; readonly sessionId: string | null };

/** Why a call failed: past its deadline, the browser gone, the protocol's error, or a reply of another shape. */
export type DevToolsErrorKind = "deadline" | "closed" | "protocol" | "unparsable";

export type DevToolsError = Error & {
  readonly kind: DevToolsErrorKind;
  readonly method: string;
  /** Chromium's own words for a protocol error, or the navigation's `errorText`: for the agent or the panel, never a log line. */
  readonly detail: string | null;
};

export const devToolsError = (kind: DevToolsErrorKind, method: string, detail: string | null = null, code: number | null = null): DevToolsError =>
  Object.assign(new Error(`${method}: ${kind}${code === null ? "" : ` (${String(code)})`}`), { kind, method, detail });

export const isDevToolsError = (error: unknown): error is DevToolsError =>
  error instanceof Error && typeof Reflect.get(error, "kind") === "string" && typeof Reflect.get(error, "method") === "string";

export type CallOptions = {
  /** The page's flat session, for a command to one target. */
  readonly sessionId?: string;
  /** Overrides the client's deadline for this call. */
  readonly deadlineMs?: number;
};

export type DevToolsClient = {
  /** One command, its result checked against `schema`, within the deadline. */
  readonly call: <T>(method: string, params: Readonly<Record<string, unknown>>, schema: z.ZodType<T>, options?: CallOptions) => Promise<T>;
  /** One command whose answer isn't read: an ack, an input event. Still within the deadline. */
  readonly command: (method: string, params: Readonly<Record<string, unknown>>, options?: CallOptions) => Promise<void>;
  /** Hears every event, in order. Returns the unsubscribe. */
  readonly onEvent: (listener: (event: DevToolsEvent) => void) => () => void;
  /** Messages refused so far: not JSON, or not a DevTools message. */
  readonly refused: () => number;
  /** Resolves once the browser is gone. */
  readonly closed: Promise<void>;
};

export type DevToolsClientOptions = {
  /** Each call's deadline unless it names its own. Default 30 s. */
  readonly deadlineMs?: number;
};

/** The deadline a call gets unless it names one. */
export const DEVTOOLS_DEADLINE_MS = 30_000;

type Waiter = { readonly resolve: (result: unknown) => void; readonly reject: (error: DevToolsError) => void; readonly method: string; readonly timer: NodeJS.Timeout };

/**
 * A client over a box's browser channel. Its IDs stay below `BROWSER_VERSION_CALL_ID`, which the
 * executors' own calls use, and replies to those are left to them.
 */
export const createDevToolsClient = (channel: BrowserChannel, options: DevToolsClientOptions = {}): DevToolsClient => {
  const deadline = options.deadlineMs ?? DEVTOOLS_DEADLINE_MS;
  const waiters = new Map<number, Waiter>();
  const listeners = new Set<(event: DevToolsEvent) => void>();
  let next = 1;
  let refused = 0;
  let gone = false;

  const settle = (id: number): Waiter | undefined => {
    const waiter = waiters.get(id);
    if (waiter !== undefined) {
      waiters.delete(id);
      clearTimeout(waiter.timer);
    }
    return waiter;
  };

  channel.onMessage((text) => {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      refused += 1;
      return;
    }
    const parsed = incomingSchema.safeParse(json);
    if (!parsed.success) {
      refused += 1;
      return;
    }
    const message = parsed.data;
    if (message.id !== undefined) {
      if (message.id >= BROWSER_VERSION_CALL_ID) return;
      const waiter = settle(message.id);
      if (waiter === undefined) return;
      if (message.error !== undefined) waiter.reject(devToolsError("protocol", waiter.method, message.error.message.slice(0, 500), message.error.code));
      else waiter.resolve(message.result ?? {});
      return;
    }
    if (message.method !== undefined) {
      const event: DevToolsEvent = { method: message.method, params: message.params, sessionId: message.sessionId ?? null };
      for (const listener of listeners) listener(event);
      return;
    }
    refused += 1;
  });

  // Every call still waiting when the browser goes is refused, with its own method's name.
  const closed = channel.closed.then(() => {
    gone = true;
    for (const [id, waiter] of [...waiters.entries()]) {
      settle(id);
      waiter.reject(devToolsError("closed", waiter.method));
    }
  });

  const send = (method: string, params: Readonly<Record<string, unknown>>, callOptions: CallOptions): Promise<unknown> =>
    new Promise((resolve, reject: (error: DevToolsError) => void) => {
      if (gone) {
        reject(devToolsError("closed", method));
        return;
      }
      const id = next;
      next = next + 1 >= BROWSER_VERSION_CALL_ID ? 1 : next + 1;
      const timer = setTimeout(() => {
        settle(id);
        reject(devToolsError("deadline", method));
      }, callOptions.deadlineMs ?? deadline);
      timer.unref();
      waiters.set(id, { resolve, reject, method, timer });
      channel.send(JSON.stringify(callOptions.sessionId === undefined ? { id, method, params } : { id, method, params, sessionId: callOptions.sessionId }));
    });

  return {
    call: async (method, params, schema, callOptions = {}) => {
      const result = schema.safeParse(await send(method, params, callOptions));
      if (!result.success) throw devToolsError("unparsable", method);
      return result.data;
    },
    command: async (method, params, callOptions = {}) => {
      await send(method, params, callOptions);
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refused: () => refused,
    closed,
  };
};
