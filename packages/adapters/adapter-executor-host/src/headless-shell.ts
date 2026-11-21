import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extractZip } from "./zip-extract.ts";

// Milestone 8 (ticket 11, F-121, ADR 0068, Q311): the browser a `host` runner downloads when the
// machine has no Chromium-family browser of its own: Chrome for Testing's `chrome-headless-shell`,
// at the version this release pins, each platform's zip checked against the SHA-256 pinned here
// before a byte of it is unpacked. It's a public download with no sign-in and no usage data. It's
// kept in the runner's data folder, `browser/chrome-headless-shell-<version>-<platform>/`, so it's
// fetched once per version. `OSTRA_RUNNER_BROWSER_DOWNLOAD=false` never fetches it.
//
// The sums were taken on 2026-11-21 from the zips Chrome for Testing's
// `last-known-good-versions-with-downloads.json` names for Stable 158.0.8127.36 (r1727472), each
// download's MD5 matching the `x-goog-hash` its bucket served with it. Bumping the version means
// downloading each zip again and pinning its new sum here: nothing is ever trusted from the download.

/** Chrome for Testing's name for a platform it builds the headless shell for. */
export type HeadlessShellPlatform = "linux64" | "linux-arm64" | "mac-arm64" | "mac-x64" | "win64";

export type HeadlessShellPin = { readonly version: string; readonly sha256: Readonly<Record<HeadlessShellPlatform, string>> };

export const HEADLESS_SHELL_PIN: HeadlessShellPin = {
  version: "158.0.8127.36",
  sha256: {
    linux64: "2d3a23017323c54fd457a678e4351f895c4076d8050e39d5aa6247f93448b73a",
    "linux-arm64": "176ee5c55486c22de43128871189061365ea28e881fc96016fd18e7cb59437c8",
    "mac-arm64": "c24d40a3786322ff3a5e3ac6eed162226cbaf07ebe468715407827226b0f8897",
    "mac-x64": "e0c5d07d8f5bcc5bdd5ef370e7daf3770856b585fcc9eecf441c7e3bb2e3d1cf",
    win64: "9655950dfeddf565561cd64cfe8ee716ccd6482fa3798503b632219efc65a71e",
  },
};

/** The largest zip the runner accepts: the pinned ones are 105 to 133 MB. */
export const HEADLESS_SHELL_MAX_BYTES = 512 * 1024 * 1024;

/** The platform's build, or `null` where Chrome for Testing has none (Windows on Arm has Edge). */
export const headlessShellPlatform = (platform: NodeJS.Platform, arch: string): HeadlessShellPlatform | null => {
  const builds: Readonly<Partial<Record<string, HeadlessShellPlatform>>> = {
    "linux-x64": "linux64",
    "linux-arm64": "linux-arm64",
    "darwin-arm64": "mac-arm64",
    "darwin-x64": "mac-x64",
    "win32-x64": "win64",
  };
  return builds[`${platform}-${arch}`] ?? null;
};

/** Where Chrome for Testing serves a version's headless shell for a platform. */
export const headlessShellUrl = (version: string, platform: HeadlessShellPlatform): string =>
  `https://storage.googleapis.com/chrome-for-testing-public/${version}/${platform}/chrome-headless-shell-${platform}.zip`;

/** The unpacked program, inside its folder: `chrome-headless-shell-<platform>/chrome-headless-shell[.exe]`. */
export const headlessShellProgram = (folder: string, platform: HeadlessShellPlatform): string =>
  path.join(folder, `chrome-headless-shell-${platform}`, platform === "win64" ? "chrome-headless-shell.exe" : "chrome-headless-shell");

/** A fetch of the zip: Node's own, or a test's. Only `ok`, `status` and `body` are read. */
export type FetchZip = (url: string, init: { readonly signal: AbortSignal }) => Promise<{ readonly ok: boolean; readonly status: number; readonly body: ReadableStream<Uint8Array> | null }>;

export type EnsureHeadlessShellOptions = {
  /** The runner's data folder: the shell is kept in its `browser` folder. */
  readonly dataDir: string;
  readonly platform: HeadlessShellPlatform;
  readonly pin?: HeadlessShellPin;
  readonly fetch?: FetchZip;
  /** Where the zip is fetched from, for a test's server. Default: Chrome for Testing's. */
  readonly url?: string;
  /** The whole download's deadline. Default 10 minutes. */
  readonly timeoutMs?: number;
};

export type EnsureHeadlessShellResult =
  | { readonly ok: true; readonly program: string; readonly downloaded: boolean }
  /** Why there's no shell, in words for the runner's own output: never a file's content. */
  | { readonly ok: false; readonly detail: string };

const there = (target: string): Promise<boolean> =>
  access(target).then(
    () => true,
    () => false,
  );

/** The marker a verified unpacking leaves, holding the sum its zip had. */
const MARKER = ".ostra-sha256";

/**
 * The pinned headless shell in the runner's data folder: the one unpacked before when its marker
 * names the pinned sum, else downloaded, checked against the pin (a mismatch is refused and
 * nothing of it is kept), and unpacked beside it before it's moved into place, so a half-done
 * unpacking is never taken for a whole one.
 */
export const ensureHeadlessShell = async (options: EnsureHeadlessShellOptions): Promise<EnsureHeadlessShellResult> => {
  const pin = options.pin ?? HEADLESS_SHELL_PIN;
  const expected = pin.sha256[options.platform];
  const root = path.join(options.dataDir, "browser");
  const folder = path.join(root, `chrome-headless-shell-${pin.version}-${options.platform}`);
  const program = headlessShellProgram(folder, options.platform);
  const marker = await readFile(path.join(folder, MARKER), "utf8").catch(() => null);
  if (marker?.trim() === expected && (await there(program))) {
    return { ok: true, program, downloaded: false };
  }
  await mkdir(root, { recursive: true });
  const token = randomBytes(6).toString("hex");
  const zip = path.join(root, `.download-${token}.zip`);
  const staging = path.join(root, `.unpack-${token}`);
  const cleanUp = async (): Promise<void> => {
    await rm(zip, { force: true }).catch(() => undefined);
    await rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  };
  try {
    const fetchZip: FetchZip = options.fetch ?? ((url, init) => fetch(url, { signal: init.signal, redirect: "follow" }));
    const url = options.url ?? headlessShellUrl(pin.version, options.platform);
    const response = await fetchZip(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 10 * 60_000) });
    if (!response.ok || response.body === null) {
      return { ok: false, detail: `the download answered ${String(response.status)}` };
    }
    const hash = createHash("sha256");
    let bytes = 0;
    const source = Readable.fromWeb(response.body);
    source.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > HEADLESS_SHELL_MAX_BYTES) {
        source.destroy(new Error(`the download is larger than ${String(HEADLESS_SHELL_MAX_BYTES)} bytes`));
        return;
      }
      hash.update(chunk);
    });
    await pipeline(source, createWriteStream(zip));
    const actual = hash.digest("hex");
    if (actual !== expected) {
      return { ok: false, detail: `the download's SHA-256 isn't the one this release pins for ${options.platform}, so it was refused and removed` };
    }
    await extractZip(zip, staging);
    if (!(await there(headlessShellProgram(staging, options.platform)))) {
      return { ok: false, detail: "the download holds no chrome-headless-shell" };
    }
    await writeFile(path.join(staging, MARKER), `${expected}\n`);
    await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await rename(staging, folder);
    return { ok: true, program, downloaded: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "the download failed" };
  } finally {
    await cleanUp();
  }
};
