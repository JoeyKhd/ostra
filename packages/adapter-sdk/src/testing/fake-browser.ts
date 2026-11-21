import { fileURLToPath } from "node:url";

import { z } from "zod";

import type { BrowserChannel } from "../executor/app.ts";

// Milestone 8 (ticket 03): the fake box browser (`fake-browser/main.ts`) as a program to start, and a
// small DevTools client over a `BrowserChannel` for the suites. The runner's own client is ticket
// 11's (`apps/runner/src/browser/`); this one is only what a test needs.

/** The fake browser's program: Node, and its script before ostra's flags. */
export const FAKE_BROWSER_MAIN = fileURLToPath(new URL("./fake-browser/main.ts", import.meta.url));

/** What the fake answers to `Browser.getVersion`, so a picture names it `OstraFakeBrowser` and `1.0.0`. */
export const FAKE_BROWSER_PRODUCT = "OstraFakeBrowser/1.0.0";

export const fakeBrowserProgram = (): { readonly command: string; readonly args: readonly string[] } => ({ command: process.execPath, args: [FAKE_BROWSER_MAIN] });

const incomingSchema = z.looseObject({
  id: z.number().optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ message: z.string() }).optional(),
  sessionId: z.string().optional(),
});

export type TestCdpEvent = { readonly method: string; readonly params: unknown; readonly sessionId: string | undefined };

export type TestCdp = {
  /** One call, answered within `timeoutMs` or refused. */
  readonly send: (method: string, params?: Readonly<Record<string, unknown>>, sessionId?: string, timeoutMs?: number) => Promise<Record<string, unknown>>;
  /** The first event of this method (on this session) from now, within `timeoutMs`. */
  readonly waitFor: (method: string, sessionId: string | undefined, timeoutMs: number) => Promise<TestCdpEvent>;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};

/** A DevTools client over a channel, with IDs from 1 (below ostra's own, `BROWSER_VERSION_CALL_ID`). */
export const testCdp = (channel: BrowserChannel): TestCdp => {
  let next = 1;
  const pending = new Map<number, { readonly resolve: (value: Record<string, unknown>) => void; readonly reject: (error: Error) => void }>();
  const listeners = new Set<(event: TestCdpEvent) => void>();
  channel.onMessage((text) => {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }
    const message = incomingSchema.safeParse(json);
    if (!message.success) return;
    const { id, method } = message.data;
    if (id !== undefined) {
      const waiter = pending.get(id);
      pending.delete(id);
      if (message.data.error === undefined) waiter?.resolve(asRecord(message.data.result));
      else waiter?.reject(new Error(message.data.error.message));
      return;
    }
    if (method !== undefined) {
      for (const listener of listeners) listener({ method, params: message.data.params, sessionId: message.data.sessionId });
    }
  });
  return {
    send: (method, params = {}, sessionId, timeoutMs = 20_000) =>
      new Promise((resolve, reject) => {
        const id = next;
        next += 1;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} wasn't answered in time`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        channel.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }));
      }),
    waitFor: (method, sessionId, timeoutMs) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(listener);
          reject(new Error(`no ${method} in time`));
        }, timeoutMs);
        const listener = (event: TestCdpEvent): void => {
          if (event.method === method && (sessionId === undefined || event.sessionId === sessionId)) {
            clearTimeout(timer);
            listeners.delete(listener);
            resolve(event);
          }
        };
        listeners.add(listener);
      }),
  };
};
