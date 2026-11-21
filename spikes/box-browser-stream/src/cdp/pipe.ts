import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import { z } from "zod";

// A DevTools client over --remote-debugging-pipe, in plain Node: the browser reads commands on its fd 3 and
// writes replies and events on its fd 4, each message one JSON text ended by a NUL byte. No port is opened, so
// nothing else on the machine (or, in a box, the agent) can attach to the browser (ADR 0068).

const execFileAsync = promisify(execFile);

const errorSchema = z.looseObject({ code: z.number(), message: z.string() });
const incomingSchema = z.looseObject({
  id: z.number().optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: errorSchema.optional(),
  sessionId: z.string().optional(),
});

export type CdpEvent = { readonly method: string; readonly params: unknown; readonly sessionId: string | undefined };

export type CdpStats = { bytesIn: number; bytesOut: number; messagesIn: number; messagesOut: number };

export type Cdp = {
  readonly pid: number;
  readonly executable: string;
  readonly stats: CdpStats;
  readonly send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown>;
  readonly onEvent: (listener: (event: CdpEvent) => void) => () => void;
  readonly close: () => Promise<void>;
  readonly exited: Promise<number | null>;
};

export type LaunchOptions = {
  readonly executable: string;
  readonly extraArgs?: readonly string[];
  readonly windowSize?: { readonly width: number; readonly height: number };
  readonly profileRoot?: string;
};

type Pending = { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void; readonly method: string };

export const killTree = async (pid: number): Promise<void> => {
  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"]);
    } catch {
      // already gone
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
};

// The flags a box's browser runs with: a fresh profile in a temporary folder, no first-run work, no
// background traffic, and software rendering (a container has no GPU).
export const boxBrowserArgs = (userDataDir: string, windowSize: { width: number; height: number }): string[] => [
  "--headless",
  "--remote-debugging-pipe",
  `--user-data-dir=${userDataDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-component-update",
  "--disable-background-networking",
  "--disable-sync",
  "--disable-default-apps",
  "--disable-gpu",
  "--disable-breakpad",
  "--disable-crash-reporter",
  "--mute-audio",
  `--window-size=${String(windowSize.width)},${String(windowSize.height)}`,
  "about:blank",
];

export const launchBrowser = async (options: LaunchOptions): Promise<Cdp> => {
  const profileRoot = options.profileRoot ?? tmpdir();
  const userDataDir = await mkdtemp(path.join(profileRoot, "ostra-box-browser-"));
  const windowSize = options.windowSize ?? { width: 1440, height: 900 };
  const child = spawn(options.executable, [...boxBrowserArgs(userDataDir, windowSize), ...(options.extraArgs ?? [])], {
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const toBrowser = child.stdio[3];
  const fromBrowser = child.stdio[4];
  if (!(toBrowser instanceof Writable) || !(fromBrowser instanceof Readable) || child.pid === undefined) {
    child.kill();
    throw new Error("the browser's pipe did not open");
  }
  const pid = child.pid;
  child.stderr?.resume();

  const stats: CdpStats = { bytesIn: 0, bytesOut: 0, messagesIn: 0, messagesOut: 0 };
  const pending = new Map<number, Pending>();
  const listeners = new Set<(event: CdpEvent) => void>();
  let nextId = 1;
  let buffered: Buffer[] = [];
  let closed = false;

  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      closed = true;
      for (const entry of pending.values()) entry.reject(new Error(`the browser exited during ${entry.method}`));
      pending.clear();
      resolve(code);
    });
  });

  const dispatch = (text: string) => {
    stats.messagesIn += 1;
    const message = incomingSchema.parse(JSON.parse(text));
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (entry === undefined) return;
      pending.delete(message.id);
      if (message.error !== undefined) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
      else entry.resolve(message.result);
      return;
    }
    if (message.method !== undefined) {
      const event: CdpEvent = { method: message.method, params: message.params, sessionId: message.sessionId };
      for (const listener of listeners) listener(event);
    }
  };

  fromBrowser.on("data", (chunk: Buffer) => {
    stats.bytesIn += chunk.length;
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(0, start);
      if (end === -1) break;
      buffered.push(chunk.subarray(start, end));
      const text = Buffer.concat(buffered).toString("utf8");
      buffered = [];
      dispatch(text);
      start = end + 1;
    }
    if (start < chunk.length) buffered.push(chunk.subarray(start));
  });

  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> => {
    if (closed) return Promise.reject(new Error(`the browser is closed (${method})`));
    const id = nextId;
    nextId += 1;
    const text = JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId });
    stats.messagesOut += 1;
    stats.bytesOut += Buffer.byteLength(text) + 1;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
      toBrowser.write(`${text}\0`);
    });
  };

  const close = async () => {
    if (!closed) {
      try {
        await Promise.race([send("Browser.close"), new Promise((resolve) => setTimeout(resolve, 3000))]);
      } catch {
        // it may exit before it answers
      }
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
      await killTree(pid);
    }
    await exited;
    // The profile goes with the box (ADR 0068). On Windows the browser's helpers hold its files for a few
    // seconds after it exits, so the removal is retried for up to 15 s.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await rm(userDataDir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  };

  return {
    pid,
    executable: options.executable,
    stats,
    send,
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close,
    exited,
  };
};

const browserVersionSchema = z.looseObject({ product: z.string(), userAgent: z.string(), protocolVersion: z.string() });
export const browserVersion = async (cdp: Cdp) => browserVersionSchema.parse(await cdp.send("Browser.getVersion"));

// The first Chromium-family browser this machine has, as ADR 0068's `host` order says (Chrome, Chromium, then
// Edge), unless SPIKE_BROWSER names one.
export const findBrowser = async (): Promise<string> => {
  const { access } = await import("node:fs/promises");
  const named = process.env["SPIKE_BROWSER"];
  const candidates: string[] = named === undefined ? [] : [named];
  if (process.platform === "win32") {
    for (const root of [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env["LOCALAPPDATA"]]) {
      if (root === undefined) continue;
      candidates.push(path.join(root, "Google", "Chrome", "Application", "chrome.exe"));
      candidates.push(path.join(root, "Chromium", "Application", "chrome.exe"));
    }
    for (const root of [process.env["PROGRAMFILES(X86)"], process.env["PROGRAMFILES"]]) {
      if (root === undefined) continue;
      candidates.push(path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
  } else {
    candidates.push("/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/microsoft-edge");
  }
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // not here
    }
  }
  throw new Error("no Chromium-family browser found");
};
