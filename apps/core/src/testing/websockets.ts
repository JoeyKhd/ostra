import WebSocket from "ws";
import type { RawData } from "ws";

// A test's WebSocket client, for the preview tests that reach the fixture's Vite through a tunnel.
// Each socket keeps its text messages from before its `open`: a server that speaks first (Vite's
// HMR `connected`) can come in the same read as the 101, and `ws` emits it before whoever awaited
// `open` gets to listen. Through a tunnel on Linux CI it does, and a listener added after `open`
// waited for a message already gone ("no message").

type Inbox = { readonly texts: string[]; readonly waiters: (() => void)[] };

const inboxes = new WeakMap<WebSocket, Inbox>();

const textOf = (data: RawData): string => (Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(new Uint8Array(data))).toString("utf8");

/** Opens a WebSocket that keeps each text message it gets, from its first frame on. */
export const openSocket = (url: string, protocol?: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = protocol === undefined ? new WebSocket(url) : new WebSocket(url, protocol);
    const inbox: Inbox = { texts: [], waiters: [] };
    inboxes.set(ws, inbox);
    ws.on("message", (data) => {
      inbox.texts.push(textOf(data));
      for (const waiter of inbox.waiters.splice(0)) waiter();
    });
    ws.once("open", () => {
      resolve(ws);
    });
    ws.once("error", reject);
  });

/** The socket's next message not yet taken, as text, whether it came before the call or after. */
export const nextMessage = async (ws: WebSocket, timeoutMs = 20_000): Promise<string> => {
  const inbox = inboxes.get(ws);
  if (inbox === undefined) {
    throw new Error("not a socket openSocket opened");
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = inbox.texts.shift();
    if (text !== undefined) {
      return text;
    }
    if (Date.now() > deadline) {
      throw new Error("no message");
    }
    await new Promise<void>((resolve) => {
      inbox.waiters.push(resolve);
      setTimeout(resolve, 100);
    });
  }
};

/** Drops the socket's messages not yet taken, so the next one is newer than this call. */
export const skipMessages = (ws: WebSocket): void => {
  inboxes.get(ws)?.texts.splice(0);
};
