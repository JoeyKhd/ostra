import { access } from "node:fs/promises";
import path from "node:path";
import type { NoBrowserReason } from "@ostra/protocol";
import { ensureHeadlessShell, headlessShellPlatform } from "./headless-shell.ts";
import type { EnsureHeadlessShellOptions, FetchZip } from "./headless-shell.ts";
import type { BrowserProgram } from "./task-processes.ts";

// Milestone 8 (ticket 11, F-121, ADR 0068): the browser a `host` runner's boxes start, in the order
// ADR 0068 gives: `OSTRA_RUNNER_BROWSER` when it's set (and nothing else when it names no file, so a
// typo never turns into a download), else the machine's Chrome, Chromium, then Edge, each in its
// system's usual places, else the pinned headless shell (`headless-shell.ts`), unless
// `OSTRA_RUNNER_BROWSER_DOWNLOAD=false`. The machine's browser runs with its own sandbox: a `host`
// box is the machine (ADR 0029), and only a container's browser needs a flag for it (the init's).

/** The machine's browser, or why a box on this runner has none. */
export type BrowserResolution =
  | { readonly available: true; readonly program: BrowserProgram; readonly source: "setting" | "machine" | "download" }
  | { readonly available: false; readonly reason: NoBrowserReason; readonly detail: string };

/** Where each system keeps Chrome, Chromium and Edge, in ADR 0068's order. */
export const machineBrowserCandidates = (platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>): readonly string[] => {
  if (platform === "win32") {
    const roots = [env["ProgramFiles"] ?? env["PROGRAMFILES"], env["ProgramFiles(x86)"] ?? env["PROGRAMFILES(X86)"], env["LOCALAPPDATA"]].filter(
      (root): root is string => root !== undefined && root !== "",
    );
    const under = (...parts: string[]): string[] => roots.map((root) => path.win32.join(root, ...parts));
    return [...under("Google", "Chrome", "Application", "chrome.exe"), ...under("Chromium", "Application", "chrome.exe"), ...under("Microsoft", "Edge", "Application", "msedge.exe")];
  }
  if (platform === "darwin") {
    const home = env["HOME"];
    const apps = ["/Applications", ...(home === undefined || home === "" ? [] : [path.posix.join(home, "Applications")])];
    const app = (bundle: string, program: string): string[] => apps.map((root) => path.posix.join(root, `${bundle}.app`, "Contents", "MacOS", program));
    return [...app("Google Chrome", "Google Chrome"), ...app("Chromium", "Chromium"), ...app("Microsoft Edge", "Microsoft Edge")];
  }
  // Linux, and the other Unixes, where the same packages install to the same places.
  return [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/opt/google/chrome/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge-stable",
    "/usr/bin/microsoft-edge",
    "/opt/microsoft/msedge/msedge",
  ];
};

export type ResolveBrowserOptions = {
  /** `OSTRA_RUNNER_BROWSER`. */
  readonly named: string | undefined;
  /** `OSTRA_RUNNER_BROWSER_DOWNLOAD`. */
  readonly download: boolean;
  /** The runner's data folder, where a downloaded shell is kept. */
  readonly dataDir: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Whether a file is there. Default: this machine's file system. */
  readonly exists?: (file: string) => Promise<boolean>;
  readonly fetch?: FetchZip;
  /** The download's own settings, for a test: its pin and its server. */
  readonly downloadOptions?: Pick<EnsureHeadlessShellOptions, "pin" | "url" | "timeoutMs">;
};

const onDisk = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

/** Finds the machine's browser, else downloads the pinned shell, as ADR 0068 orders them. */
export const resolveMachineBrowser = async (options: ResolveBrowserOptions): Promise<BrowserResolution> => {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? onDisk;
  const named = options.named?.trim();
  if (named !== undefined && named !== "") {
    return (await exists(named))
      ? { available: true, program: { command: named }, source: "setting" }
      : { available: false, reason: "not-found", detail: "OSTRA_RUNNER_BROWSER names no file on this machine" };
  }
  for (const candidate of machineBrowserCandidates(platform, options.env ?? process.env)) {
    if (await exists(candidate)) {
      return { available: true, program: { command: candidate }, source: "machine" };
    }
  }
  if (!options.download) {
    return { available: false, reason: "download-off", detail: "no Chrome, Chromium or Edge on this machine, and OSTRA_RUNNER_BROWSER_DOWNLOAD is false" };
  }
  const shellPlatform = headlessShellPlatform(platform, options.arch ?? process.arch);
  if (shellPlatform === null) {
    return { available: false, reason: "not-found", detail: `no Chrome, Chromium or Edge on this machine, and Chrome for Testing has no headless shell for ${platform}-${options.arch ?? process.arch}` };
  }
  const shell = await ensureHeadlessShell({
    dataDir: options.dataDir,
    platform: shellPlatform,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...options.downloadOptions,
  });
  return shell.ok
    ? { available: true, program: { command: shell.program }, source: "download" }
    : { available: false, reason: "download-failed", detail: `the pinned headless shell couldn't be downloaded: ${shell.detail}` };
};

/**
 * The machine's browser, resolved once a box first asks (so a runner that never takes a screenshot
 * never downloads), then kept. A failed download is tried again by the next box that asks, never by
 * two at once.
 */
export const machineBrowserSource = (resolve: () => Promise<BrowserResolution>): (() => Promise<BrowserResolution>) => {
  let kept: BrowserResolution | null = null;
  let pending: Promise<BrowserResolution> | null = null;
  return async () => {
    if (kept !== null) return kept;
    pending ??= resolve().then((resolution) => {
      pending = null;
      if (resolution.available || resolution.reason !== "download-failed") kept = resolution;
      return resolution;
    });
    return pending;
  };
};
