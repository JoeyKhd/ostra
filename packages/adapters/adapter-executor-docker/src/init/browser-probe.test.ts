import { fileURLToPath } from "node:url";
import { FAKE_BROWSER_MAIN } from "@ostra/adapter-sdk/testing";
import { describe, expect, it } from "vitest";
import { probeBoxBrowser } from "./browser-probe.ts";

// Milestone 8 (ticket 11): the probe the `live-docker` and `live-kind` jobs run in the base image
// (`browser-probe-main.ts`), here with the real init and the fake box browser over the same pipe,
// so a change to the init, the bridge or the probe that would break those jobs breaks this first.
// The image's Chromium, its fonts and the box's hardening wait for the launch-gate Proof run.

const INIT_WITH_FAKE_BROWSER = fileURLToPath(new URL("../testing/init-with-fake-browser.ts", import.meta.url));

describe("the box's browser probe", () => {
  it("F-121/c2: the init starts the box's browser beside an app process, the page loads at the app's localhost, a PNG is taken and no profile is left", async () => {
    const result = await probeBoxBrowser({
      init: { command: process.execPath, args: [INIT_WITH_FAKE_BROWSER, FAKE_BROWSER_MAIN] },
      env: { PATH: process.env["PATH"] ?? "", ...(process.platform === "win32" ? { SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows" } : {}) },
      stepMs: 30_000,
    });
    expect(result).toMatchObject({ ok: true, browser: { name: "OstraFakeBrowser", version: "1.0.0" }, title: "ostra box browser probe", png: { width: 1280, height: 800 }, profileRemoved: true });
  }, 120_000);

  it("F-121/c2: an image without the browser says so, and the probe names the step", async () => {
    const result = await probeBoxBrowser({
      init: { command: process.execPath, args: [fileURLToPath(new URL("./main.ts", import.meta.url))] },
      env: { PATH: process.env["PATH"] ?? "", OSTRA_BOX_BROWSER: "/nowhere/chromium", ...(process.platform === "win32" ? { SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows" } : {}) },
      stepMs: 30_000,
    });
    expect(result).toEqual({ ok: false, step: "the browser's start", detail: "not-in-image" });
  }, 120_000);

});
