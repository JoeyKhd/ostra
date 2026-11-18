import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserServer } from "playwright-core";
import { killTree, registerPid, scratchRoot } from "./infra.ts";
import type { HarnessSettings } from "./settings.ts";

// The browser is the user's own Edge or Chrome (no download): playwright-core drives it over CDP.
const candidates = (settings: HarnessSettings): string[] => {
  const list: string[] = settings.OSTRA_SPIKE_BROWSER === undefined ? [] : [settings.OSTRA_SPIKE_BROWSER];
  if (process.platform === "win32") {
    for (const root of [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], "C:\\Program Files (x86)", "C:\\Program Files", process.env["LOCALAPPDATA"]]) {
      if (root === undefined) continue;
      list.push(path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"), path.join(root, "Google", "Chrome", "Application", "chrome.exe"));
    }
  } else if (process.platform === "darwin") {
    list.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    );
  } else {
    list.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge");
  }
  return list;
};

export const findBrowser = async (settings: HarnessSettings): Promise<string | null> => {
  for (const candidate of candidates(settings)) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // not there
    }
  }
  return null;
};

export type LaunchedBrowser = { readonly browser: Browser; readonly executable: string; readonly close: () => Promise<void> };

export const launchBrowser = async (settings: HarnessSettings): Promise<LaunchedBrowser | null> => {
  const executable = await findBrowser(settings);
  if (executable === null) return null;
  // Playwright makes the browser's profile directory under the temp directory, and Edge's command line names
  // it. Pointing the temp directory at the spike's scratch folder for the launch puts the spike's folder in
  // that command line, so the end-of-run process check can see a leaked browser. (A leftover from a harness
  // that was killed is removed at the next start, with the other scratch directories.)
  const profileRoot = path.join(scratchRoot, `edge-${String(process.pid)}`);
  await mkdir(profileRoot, { recursive: true });
  const saved = { TEMP: process.env["TEMP"], TMP: process.env["TMP"], TMPDIR: process.env["TMPDIR"] };
  process.env["TEMP"] = profileRoot;
  process.env["TMP"] = profileRoot;
  process.env["TMPDIR"] = profileRoot;
  let server: BrowserServer;
  try {
    server = await chromium.launchServer({ executablePath: executable, headless: true });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  }
  const pid = server.process().pid ?? 0;
  registerPid(pid);
  const browser = await chromium.connect(server.wsEndpoint());
  return {
    browser,
    executable,
    close: async () => {
      await browser.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      if (pid > 0) await killTree(pid);
      await rm(profileRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
    },
  };
};

