import { createServer } from "node:net";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HostExecutor, machineBrowserSource, resolveMachineBrowser } from "@ostra/adapter-executor-host";
import type { BrowserResolution } from "@ostra/adapter-executor-host";
import { fakeBrowserProgram, recordingLogger, startGitUpstream } from "@ostra/adapter-sdk/testing";
import type { GitUpstream } from "@ostra/adapter-sdk/testing";
import { boxIdSchema, taskIdSchema } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { boxBrowser } from "./box-browser.ts";
import type { BoxBrowserReport } from "./box-browser.ts";
import { openPage } from "./page.ts";

// Milestone 8 (ticket 11, F-121/c2), live on `host`: the runner finds the machine's browser as ADR
// 0068 orders it (Edge here, which every Windows machine has; OSTRA_RUNNER_BROWSER when it's set),
// a task's box starts it in the task's containment unit, ostra's DevTools client takes a screenshot
// of the fixture app (milestone 8's `test-web`: Vite and React, its `/api` through Vite's proxy to
// its API), and after the task ends no profile folder is left. On a Linux CI machine without
// OSTRA_RUNNER_BROWSER, whose browser's sandbox may need what its user lacks, the fake box browser
// stands in over the same pipe, as the executor suite does (ticket 03); the pixels wait for the
// Linux jobs there.

const FIXTURE = fileURLToPath(new URL("../../../../e2e/m8-previews-and-library/fixtures/test-web/", import.meta.url));
const VITE = path.join(FIXTURE, "node_modules", "vite", "bin", "vite.js");
const live = process.platform !== "linux" || (process.env["OSTRA_RUNNER_BROWSER"] ?? "") !== "";

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "localhost", () => {
      const address = server.address();
      const port = address === null || typeof address === "string" ? 0 : address.port;
      server.close(() => {
        resolve(port);
      });
    });
  });

const nodeEnv = (extra: Readonly<Record<string, string>>): Record<string, string> => ({
  PATH: process.env["PATH"] ?? "",
  ...(process.platform === "win32" ? { SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows" } : {}),
  ...extra,
});

let root = "";
let upstream: GitUpstream;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ostra-box-browser-host-"));
  upstream = await startGitUpstream(path.join(root, "upstream"), { requireToken: false });
  await upstream.createRepo("ostra-test/test1", { "README.md": "# test1\n" });
});

afterAll(async () => {
  await upstream.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe(`the box's browser on host, live (${live ? "the machine's browser" : "the fake browser: a Linux CI machine"})`, () => {
  it("F-121/c2: the runner finds the machine's browser, a box starts it in the task's unit, it takes a screenshot of the fixture app, and no profile folder is left after the task ends", async (context) => {
    const dataDir = path.join(root, "runner");
    const found = await resolveMachineBrowser({ named: process.env["OSTRA_RUNNER_BROWSER"], download: false, dataDir });
    if (live) {
      expect(found.available, found.available ? "" : found.detail).toBe(true);
      if (process.platform === "win32" && (process.env["OSTRA_RUNNER_BROWSER"] ?? "") === "" && found.available) {
        // Chrome or Chromium first when the machine has one; Edge, which every Windows machine has, otherwise.
        expect(found.program.command).toMatch(/(?:chrome|msedge)\.exe$/i);
      }
    }
    const resolution: BrowserResolution = live ? found : { available: true, program: fakeBrowserProgram(), source: "setting" };
    const logger = recordingLogger();
    const executor = await HostExecutor.start({ dataDir, browser: machineBrowserSource(() => Promise.resolve(resolution)) }, { logger, clock: { now: () => Date.now() } });
    const spec = { ...taskSpecFixture, environment: { ...taskSpecFixture.environment, setupScript: "echo ready\n" } };
    const box = { taskId: taskIdSchema.parse("task-box-browser"), boxId: boxIdSchema.parse("box-browser-1") };
    const proxies = { gitBaseUrl: upstream.origin, modelBaseUrl: "http://127.0.0.1:9/v1", mcpUrl: "http://127.0.0.1:9/mcp" };
    const created = await executor.create({ ...box, spec, proxies });
    if (!created.ok) throw new Error(created.error.message);
    const prepared = await executor.prepare({ box, spec, secrets: [], onSetupOutput: () => undefined });
    if (!prepared.ok) throw new Error(prepared.error.message);
    const reports: BoxBrowserReport[] = [];
    const holder = boxBrowser({ start: () => executor.startBrowser(box), report: (browser) => reports.push(browser), client: { deadlineMs: 30_000 } });
    let profileDir = "";
    try {
      // The fixture app, as two of the task's app processes: its API, and Vite with `/api` behind its proxy.
      const [webPort, apiPort] = [await freePort(), await freePort()];
      const ports = { TEST_WEB_PORT: String(webPort), TEST_WEB_API_PORT: String(apiPort) };
      for (const [name, args] of [
        ["api", [path.join(FIXTURE, "api", "server.js")]],
        ["web", [VITE, "--port", String(webPort), "--strictPort"]],
      ] as const) {
        const started = await executor.startAppProcess({ box, launch: { name, command: process.execPath, args: [...args], cwd: FIXTURE, env: nodeEnv(ports) } });
        if (!started.ok) throw new Error(`${name}: ${started.error.message}`);
      }

      const opened = await holder.open();
      if (!opened.available) throw new Error(`no browser in the box: ${opened.reason}`);
      await context.annotate(`the box's browser: ${opened.browser.name} ${opened.browser.version}`);
      expect(reports).toEqual([{ available: true, ...opened.browser }]);
      if (live && process.platform === "win32" && found.available && /msedge\.exe$/i.test(found.program.command)) expect(opened.browser.name).toBe("Edge");
      // Its profile is a fresh folder of its own, and the browser is one of the task's processes.
      const startedBrowser = [...logger.records].find((record) => record.message === "browser started");
      expect(startedBrowser, "the executor logged the start").toBeDefined();
      const page = await openPage(opened.client, { width: 1440, height: 900, mobile: false });
      // Vite takes a moment to answer at first: the page is loaded once it does.
      for (let attempt = 0; ; attempt += 1) {
        try {
          await page.navigate(`http://localhost:${String(webPort)}/`, 20_000);
          break;
        } catch (error) {
          if (attempt >= 20) throw error;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      if (live) {
        // React rendered, and the frontend's `/api` call came back through Vite's proxy.
        let apiLine = "";
        for (let waited = 0; !apiLine.startsWith("api: ok") && waited < 20_000; waited += 250) {
          apiLine = await page.evaluate("document.querySelector('#api')?.textContent ?? ''", z.string());
          if (!apiLine.startsWith("api: ok")) await new Promise((resolve) => setTimeout(resolve, 250));
        }
        expect(apiLine).toBe(`api: ok, hello from the API on ${String(apiPort)}`);
      }
      const png = await page.screenshot({ format: "png" });
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1440, 900]);
      expect(png.length).toBeGreaterThan(live ? 5_000 : 50);
      await page.close();
      const browserProfile = await executor.startBrowser(box);
      // A second browser of the same box (the executor's own) has its own fresh profile too.
      if (browserProfile.ok && browserProfile.value.available) {
        profileDir = browserProfile.value.browser.profileDir;
        expect((await stat(profileDir)).isDirectory()).toBe(true);
        expect(path.basename(profileDir).startsWith("ostra-box-browser-")).toBe(true);
      }
    } finally {
      // The task ends: its browsers and app processes stop with the box, and the box is released.
      await holder.close();
      await executor.stop({ box, graceMs: 1_000 });
      await executor.release(box, "requested");
    }
    expect(profileDir).not.toBe("");
    let gone = false;
    for (let waited = 0; !gone && waited < 20_000; waited += 250) {
      gone = await stat(profileDir).then(
        () => false,
        () => true,
      );
      if (!gone) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(gone, "no profile folder is left after the task ends").toBe(true);
    // Nothing of the page reached a log line: its title, its API's answer, its text.
    const logged = JSON.stringify(logger.records);
    for (const text of ["test-web", "hello from the API", "Count: 0"]) expect(logged).not.toContain(text);
  }, 180_000);
});
