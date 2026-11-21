import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { noBrowserWords } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processTreeContainment } from "./containment.ts";
import { ensureHeadlessShell, HEADLESS_SHELL_PIN, headlessShellPlatform, headlessShellProgram, headlessShellUrl } from "./headless-shell.ts";
import type { HeadlessShellPin } from "./headless-shell.ts";
import { machineBrowserCandidates, machineBrowserSource, resolveMachineBrowser } from "./machine-browser.ts";
import { localProcesses } from "./task-processes.ts";
import { writeZip } from "./testing/zip-writer.ts";
import { extractZip, safeEntryPath } from "./zip-extract.ts";

// Milestone 8 (ticket 11, F-121/c2): the browser a `host` runner's boxes start, found in ADR 0068's
// order, else Chrome for Testing's headless shell at the pinned version, its SHA-256 checked before
// a byte is unpacked; and with the download off and no browser, the reason a box reports. The
// download runs against a server of this test with a zip of a few bytes: the pin's own sums are
// Chrome for Testing's, checked once by hand when they were taken (`headless-shell.ts`).

const PLATFORM = "linux64";
const SHELL_ZIP = await writeZip([
  { name: "chrome-headless-shell-linux64/ABOUT", content: "Chrome for Testing, a test's stand-in" },
  { name: "chrome-headless-shell-linux64/chrome-headless-shell", content: "#!/bin/sh\necho not a browser\n", mode: 0o755 },
  { name: "chrome-headless-shell-linux64/locales/en-US.pak", content: Buffer.alloc(4096, 7) },
]);
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const pinFor = (sum: string): HeadlessShellPin => ({ version: "1.2.3", sha256: { ...HEADLESS_SHELL_PIN.sha256, [PLATFORM]: sum } });

let root = "";
let server: Server;
let base = "";
let served = 0;
let body = SHELL_ZIP;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ostra-headless-shell-"));
  server = createServer((_request, response) => {
    served += 1;
    response.writeHead(200, { "content-type": "application/zip", "content-length": String(body.length) });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === "string") throw new Error("the server has no port");
  base = `http://127.0.0.1:${String(address.port)}/shell.zip`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  await rm(root, { recursive: true, force: true });
});

const freshDataDir = (): Promise<string> => mkdtemp(path.join(root, "data-"));

describe("finding the machine's browser (ADR 0068's order)", () => {
  it("F-121/c2: takes OSTRA_RUNNER_BROWSER first, then Chrome, Chromium and Edge in each system's usual places", async () => {
    const windows = machineBrowserCandidates("win32", { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" });
    const firstOf = (needle: string): number => windows.findIndex((candidate) => candidate.includes(needle));
    expect(firstOf("chrome.exe")).toBe(0);
    expect(firstOf("Chromium")).toBeGreaterThan(firstOf("Google"));
    expect(firstOf("msedge.exe")).toBeGreaterThan(firstOf("Chromium"));
    expect(windows).toContain("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe");
    expect(machineBrowserCandidates("darwin", { HOME: "/Users/me" })[0]).toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    expect(machineBrowserCandidates("linux", {})).toEqual(expect.arrayContaining(["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/microsoft-edge"]));

    const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
    const onlyEdge = async (file: string): Promise<boolean> => Promise.resolve(file === edge || file === "D:\\browsers\\chromium.exe");
    const common = { download: true, dataDir: root, platform: "win32" as const, arch: "x64", env: { "ProgramFiles(x86)": "C:\\Program Files (x86)" }, exists: onlyEdge };
    expect(await resolveMachineBrowser({ ...common, named: undefined })).toEqual({ available: true, program: { command: edge }, source: "machine" });
    expect(await resolveMachineBrowser({ ...common, named: "D:\\browsers\\chromium.exe" })).toEqual({ available: true, program: { command: "D:\\browsers\\chromium.exe" }, source: "setting" });
    // A setting that names no file is no browser, never the machine's or a download in its place.
    expect(await resolveMachineBrowser({ ...common, named: "D:\\typo.exe" })).toMatchObject({ available: false, reason: "not-found" });
    expect(served).toBe(0);
  });

  it("F-121/c2: with the download off and no browser on the machine, a box reports download-off, and the words name the fix", async () => {
    const before = served;
    const resolution = await resolveMachineBrowser({ named: undefined, download: false, dataDir: root, platform: "linux", arch: "x64", env: {}, exists: () => Promise.resolve(false), downloadOptions: { url: base } });
    expect(resolution).toMatchObject({ available: false, reason: "download-off" });
    expect(served, "nothing was downloaded").toBe(before);
    // The box's own answer, through the processes seam: no browser, and why.
    const processes = localProcesses(processTreeContainment, () => Promise.resolve(resolution));
    const unit = await processTreeContainment().create("no-browser-box");
    try {
      expect(await processes.startBrowser(unit, {})).toEqual({ available: false, reason: "download-off" });
    } finally {
      await unit.dispose();
    }
    const words = noBrowserWords("download-off");
    expect(words).toContain("OSTRA_RUNNER_BROWSER_DOWNLOAD");
    expect(words).toContain("OSTRA_RUNNER_BROWSER");
  });

  it("F-121/c2: Chrome for Testing has a pinned build for each runner platform ostra ships, and none where it builds none", () => {
    expect(headlessShellPlatform("linux", "x64")).toBe("linux64");
    expect(headlessShellPlatform("linux", "arm64")).toBe("linux-arm64");
    expect(headlessShellPlatform("darwin", "arm64")).toBe("mac-arm64");
    expect(headlessShellPlatform("darwin", "x64")).toBe("mac-x64");
    expect(headlessShellPlatform("win32", "x64")).toBe("win64");
    expect(headlessShellPlatform("win32", "arm64")).toBeNull();
    for (const sum of Object.values(HEADLESS_SHELL_PIN.sha256)) expect(sum).toMatch(/^[0-9a-f]{64}$/);
    expect(headlessShellUrl(HEADLESS_SHELL_PIN.version, "win64")).toBe(
      `https://storage.googleapis.com/chrome-for-testing-public/${HEADLESS_SHELL_PIN.version}/win64/chrome-headless-shell-win64.zip`,
    );
  });
});

describe("the pinned headless shell (Q311)", () => {
  it("F-121/c2: downloads the pinned shell when the machine has none, checks its SHA-256, keeps it in the data folder and reuses it", async () => {
    const dataDir = await freshDataDir();
    body = SHELL_ZIP;
    const before = served;
    const options = {
      named: undefined,
      download: true,
      dataDir,
      platform: "linux" as const,
      arch: "x64",
      env: {},
      exists: (file: string) => stat(file).then(() => true, () => false),
      downloadOptions: { url: base, pin: pinFor(sha256(SHELL_ZIP)) },
    };
    // `exists` is the real file system here: no browser at the Linux places on this machine's paths
    // is assumed, so the machine's candidates are left out by naming none of them as there.
    const resolution = await resolveMachineBrowser({ ...options, exists: (file) => (file.includes("chrome-headless-shell") ? options.exists(file) : Promise.resolve(false)) });
    const folder = path.join(dataDir, "browser", `chrome-headless-shell-1.2.3-${PLATFORM}`);
    expect(resolution).toEqual({ available: true, program: { command: headlessShellProgram(folder, PLATFORM) }, source: "download" });
    expect(served - before).toBe(1);
    expect(await readFile(headlessShellProgram(folder, PLATFORM), "utf8")).toContain("not a browser");
    expect((await stat(path.join(folder, "chrome-headless-shell-linux64", "locales", "en-US.pak"))).size).toBe(4096);
    if (process.platform !== "win32") expect((await stat(headlessShellProgram(folder, PLATFORM))).mode & 0o111).not.toBe(0);
    // Nothing of the download is left beside it.
    expect((await readdir(path.join(dataDir, "browser"))).sort()).toEqual([`chrome-headless-shell-1.2.3-${PLATFORM}`]);
    // A second runner start reuses it: no second download.
    const again = await ensureHeadlessShell({ dataDir, platform: PLATFORM, url: base, pin: pinFor(sha256(SHELL_ZIP)) });
    expect(again).toEqual({ ok: true, program: headlessShellProgram(folder, PLATFORM), downloaded: false });
    expect(served - before).toBe(1);
  });

  it("F-121/c2: a download whose SHA-256 isn't the pinned one is refused, and nothing of it is kept or unpacked", async () => {
    const dataDir = await freshDataDir();
    // The server hands out a different zip than the one the release pinned.
    body = await writeZip([{ name: "chrome-headless-shell-linux64/chrome-headless-shell", content: "#!/bin/sh\necho swapped\n", mode: 0o755 }]);
    try {
      const shell = await ensureHeadlessShell({ dataDir, platform: PLATFORM, url: base, pin: pinFor(sha256(SHELL_ZIP)) });
      expect(shell.ok).toBe(false);
      if (!shell.ok) expect(shell.detail).toContain("SHA-256");
      expect(await readdir(path.join(dataDir, "browser"))).toEqual([]);
      // The box's reason, through the resolution.
      const resolution = await resolveMachineBrowser({
        named: undefined,
        download: true,
        dataDir,
        platform: "linux",
        arch: "x64",
        env: {},
        exists: () => Promise.resolve(false),
        downloadOptions: { url: base, pin: pinFor(sha256(SHELL_ZIP)) },
      });
      expect(resolution).toMatchObject({ available: false, reason: "download-failed" });
      expect(await readdir(path.join(dataDir, "browser"))).toEqual([]);
    } finally {
      body = SHELL_ZIP;
    }
  });

  it("F-121/c2: a failed download is tried again by the next box that asks, and a found browser is kept", async () => {
    let calls = 0;
    const flaky = machineBrowserSource(() => {
      calls += 1;
      return Promise.resolve(calls === 1 ? { available: false, reason: "download-failed", detail: "the download answered 503" } : { available: true, program: { command: "/opt/shell" }, source: "download" });
    });
    expect(await flaky()).toMatchObject({ available: false, reason: "download-failed" });
    const [first, second] = await Promise.all([flaky(), flaky()]);
    expect(first).toMatchObject({ available: true });
    expect(second).toBe(first);
    expect(await flaky()).toBe(first);
    expect(calls).toBe(2);
  });

  it("refuses an archive whose entry would land outside its folder", async () => {
    expect(safeEntryPath("chrome-headless-shell-linux64/chrome-headless-shell")).toBe("chrome-headless-shell-linux64/chrome-headless-shell");
    for (const name of ["../escape", "a/../../escape", "/etc/passwd", "C:/Windows/evil.dll", "..\\escape"]) expect(safeEntryPath(name)).toBeNull();
    const dir = await freshDataDir();
    const zip = path.join(dir, "evil.zip");
    await writeFile(zip, await writeZip([{ name: "ok.txt", content: "fine" }, { name: "../outside.txt", content: "escaped" }]));
    await expect(extractZip(zip, path.join(dir, "out"))).rejects.toThrow(/outside its folder/);
    await expect(stat(path.join(dir, "outside.txt"))).rejects.toThrow();
  });
});
