import { connect } from "node:net";
import type { Socket } from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";

import { runnerLimits } from "@ostra/protocol";
import type { BoxBrowser, NoBrowserReason, PortRefusal, ReservedPorts } from "@ostra/protocol";

import type { BoxRef, ProcessExit } from "./base.ts";

// Milestone 8 (ADR 0068, spec section 5.2): what a box offers the running app, on every executor.
//
// - **A process with a log** (F-140): one of the app's long-running processes, started from an
//   argument array in a folder with its variables, as the agent's user and in the task's unit,
//   its stdout and stderr written to `.ostra/app/<name>.log` in the task's folder (never a repo),
//   its exit reported with its code, and stopped with the box.
// - **The browser** (F-121, F-141): a Chromium-family browser beside the app, so its `localhost` is
//   the app's, started with `--remote-debugging-pipe` and a fresh profile in a temporary folder, its
//   DevTools pipe handed to the caller as a channel of its own. Only the caller holds it: no port is
//   opened, so the agent can't attach to it.
// - **Reaching an app's port** (F-141, F-143): where the runner dials a port of the app, through
//   the init's forwarder on `docker` (the agent's container has its own loopback) and at
//   `localhost` on `kubernetes` (the pod's) and `host` (the machine's), IPv6 and IPv4 alike. A port
//   below 1024 or one of the box's own is refused first, the same on every executor.
//
// The executor contract suite proves each on every executor (`testing/executor-suite.ts`).

/** One of the app's processes, as the runner starts it (ticket 12 builds it from the environment's command). */
export type AppProcessLaunch = {
  /** The app process's name in the environment: it names the log, `.ostra/app/<name>.log`. */
  readonly name: string;
  /** The program and its arguments, each one argument: never a shell line ostra built. Never logged. */
  readonly command: string;
  readonly args: readonly string[];
  /** Where it runs: a folder of a repo's checkout, as the box sees it (`CreatedBox.workspaceDir` and below). */
  readonly cwd: string;
  /** Its whole environment. Nothing of the runner's or the init's own is inherited. */
  readonly env: Readonly<Record<string, string>>;
};

export type StartAppProcessInput = { readonly box: BoxRef; readonly launch: AppProcessLaunch };

/** A running app process: where its log is, and its exit. */
export type AppProcessHandle = {
  readonly name: string;
  /** In the executor's own process namespace (the agent container's on `docker` and `kubernetes`). */
  readonly pid: number | null;
  /**
   * Its log, stdout and stderr as they came, as the runner reads it: `.ostra/app/<name>.log` in the
   * task's folder, capped at `APP_LOG_MAX_BYTES` with the oldest lines dropped. Its content is never logged.
   */
  readonly logPath: string;
  /** Resolves when it has exited, with its code, and its log is written out. */
  readonly exited: Promise<ProcessExit>;
};

export type StopAppProcessInput = {
  readonly box: BoxRef;
  readonly name: string;
  /** How long it has to exit after a polite signal before its whole tree is killed. */
  readonly graceMs: number;
};

/**
 * The browser's DevTools pipe, as whole messages: each one JSON text, which the caller's own client
 * parses (Chromium's format, so tolerant of unknown fields). The pipe's bytes cross nothing else of
 * the box's: on `docker` and `kubernetes` they ride a channel of their own on the bridge, so a
 * screenshot never waits behind a kill's reply. Messages are never logged: they carry the page.
 */
export type BrowserChannel = {
  /** Sends one message to the browser. Dropped once the browser is gone. */
  readonly send: (message: string) => void;
  /** Hears every message the browser sends, whole and in order. Returns the unsubscribe. */
  readonly onMessage: (listener: (message: string) => void) => () => void;
  /** Resolves once the browser has exited and its profile folder is gone. */
  readonly closed: Promise<void>;
  /** Ends the browser (DevTools' `Browser.close`, then its tree) and removes its profile folder. */
  readonly close: () => Promise<void>;
};

/** A started browser: its name and version, which every picture names, and its pipe. */
export type StartedBrowser = BoxBrowser & {
  readonly channel: BrowserChannel;
  /** Its fresh profile, as the box sees it: gone once the browser ends, and always after the box ends. */
  readonly profileDir: string;
};

/** The box's browser, or why it has none (`app.browser`'s two shapes). */
export type BrowserStart = { readonly available: true; readonly browser: StartedBrowser } | { readonly available: false; readonly reason: NoBrowserReason };

export type ReachAppPortInput = {
  readonly box: BoxRef;
  /** A port of the app in the box. */
  readonly port: number;
  /** The box's own ports, by name, which no preview reaches (ADR 0068). */
  readonly reserved: ReservedPorts;
};

/**
 * Where the runner dials an app's port: the init's forwarder on `docker`, `localhost` elsewhere.
 * Dial it with `dialApp`, which tries IPv6 and IPv4: a dev server told `localhost` may listen on
 * `::1` only, as Vite and webpack-dev-server did in spike 08 (`research/spike-preview-through-core.md` §4.2).
 */
export type AppPortReach = {
  readonly host: string;
  readonly port: number;
  /** Closes the forwarder, when there is one. Connections it carries end with it. */
  readonly close: () => Promise<void>;
};

/** Dials an app's port at a host, trying every address it resolves to, IPv6 and IPv4 (Node's `autoSelectFamily`). */
export const dialApp = (host: string, port: number): Socket => connect({ host, port, autoSelectFamily: true });

/**
 * Joins a tunnel's two ends both ways (spike 08, §4.1): each side's end ends the other gracefully,
 * and only an error tears both down. Never `stream.pipeline`, which destroys the other side on a
 * close and drops what is still queued on it: the end of a response is lost.
 */
export const spliceStreams = (a: Duplex, b: Duplex): void => {
  a.pipe(b);
  b.pipe(a);
  a.on("close", () => {
    if (!b.writableEnded) b.end();
  });
  b.on("close", () => {
    if (!a.writableEnded) a.end();
  });
  a.on("error", () => {
    b.destroy();
  });
  b.on("error", () => {
    a.destroy();
  });
};

/** An app process's log is capped at this, with the oldest lines dropped (ticket 12's working value). */
export const APP_LOG_MAX_BYTES = 4 * 1024 * 1024;

/** The words for a refused port, for the runner's and the tools' answers. Names and numbers only. */
export const portRefusalWords = (port: number, refusal: PortRefusal): string =>
  refusal.reason === "below-min"
    ? `port ${String(port)} isn't an app's: a preview reaches ports from ${String(runnerLimits.appPortMin)} up`
    : `port ${String(port)} is the box's own (${refusal.name}): no preview reaches it`;

// ---------- the browser's launch, the same on every executor ----------

/**
 * The flags a box's browser runs with (spike 07's `boxBrowserArgs`, ADR 0068): headless, the
 * DevTools pipe and no port, a fresh profile, no first run, sync, extensions, crash reporter or
 * background traffic, and software rendering (a container has no GPU). Ticket 11 adds what
 * Chromium's own sandbox needs in a container.
 */
export const boxBrowserFlags = (profileDir: string): readonly string[] => [
  "--headless=new",
  "--remote-debugging-pipe",
  `--user-data-dir=${profileDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-sync",
  "--disable-extensions",
  "--disable-component-update",
  "--disable-background-networking",
  "--disable-default-apps",
  "--disable-gpu",
  "--disable-breakpad",
  "--disable-crash-reporter",
  "--mute-audio",
  "about:blank",
];

/** A temporary profile folder's name: `ostra-box-browser-` and random letters, made by `mkdtemp`. */
export const BOX_BROWSER_PROFILE_PREFIX = "ostra-box-browser-";

/** The DevTools pipe's framing: each message one JSON text ended by a NUL byte. */
export const createPipeMessageSplitter = (onMessage: (message: string) => void, maxBytes = 64 * 1024 * 1024): ((chunk: Buffer) => void) => {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  return (chunk) => {
    let start = 0;
    for (let end = chunk.indexOf(0, start); end !== -1; end = chunk.indexOf(0, start)) {
      pending.push(chunk.subarray(start, end));
      const message = Buffer.concat(pending).toString("utf8");
      pending = [];
      pendingBytes = 0;
      start = end + 1;
      if (message.length > 0) {
        onMessage(message);
      }
    }
    if (start < chunk.length) {
      pendingBytes += chunk.length - start;
      if (pendingBytes > maxBytes) {
        throw new Error(`a DevTools message longer than ${String(maxBytes)} bytes`);
      }
      pending.push(chunk.subarray(start));
    }
  };
};

/** The browser's name, as a picture names it: from its program when it's a known one, else from DevTools' `product`. */
export const browserIdentity = (executable: string, product: string): BoxBrowser => {
  const slash = product.indexOf("/");
  const version = slash === -1 ? product : product.slice(slash + 1);
  const program = path.basename(executable.replaceAll("\\", "/")).toLowerCase().replace(/\.exe$/, "");
  const known: Readonly<Record<string, string>> = {
    chromium: "Chromium",
    "chromium-browser": "Chromium",
    chrome: "Chrome",
    "google-chrome": "Chrome",
    "google-chrome-stable": "Chrome",
    "chrome-headless-shell": "Chrome Headless Shell",
    msedge: "Edge",
    "microsoft-edge": "Edge",
    "microsoft-edge-stable": "Edge",
  };
  const fromProduct = (slash === -1 ? "" : product.slice(0, slash)).replace(/^Headless/, "");
  const name = known[program] ?? (fromProduct === "Edg" ? "Edge" : fromProduct);
  return { name: (name === "" ? "Chromium" : name).slice(0, 100), version: (version === "" ? "unknown" : version).slice(0, 100) };
};
