import { execFile } from "node:child_process";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { cpus, totalmem, release } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { openPage, type Page } from "../cdp/page.ts";
import { browserVersion, findBrowser, launchBrowser, type Cdp } from "../cdp/pipe.ts";
import { startChild, stopAll, stopChild, type Child } from "./procs.ts";
import { startSampler, type GroupUse } from "./sampler.ts";

// The spike's one run: it starts the app (Vite and its API), core, the web hop, the sidecar with the box's
// browser, and a second browser as the member's, then measures everything ticket 07 asks, through the
// relay, and writes results/<run>/results.json and run.log. Every child is killed at the end.

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../..", import.meta.url));
const quick = process.argv.includes("--quick");
const seconds = quick ? 2 : 6;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = path.join(root, "results", stamp);
const profiles = path.join(root, ".profiles");
await mkdir(outDir, { recursive: true });
await mkdir(profiles, { recursive: true });

const ports = { api: 3001, app: 5173, core: 8790, web: 8791, sidecar: 8792 };
const coreUrl = `http://127.0.0.1:${String(ports.core)}`;
const webUrl = `http://127.0.0.1:${String(ports.web)}`;
const sidecarUrl = `http://127.0.0.1:${String(ports.sidecar)}`;
const appUrl = `http://localhost:${String(ports.app)}/`;

const logFile = path.join(outDir, "run.log");
const log = async (line: string) => {
  process.stdout.write(`${line}\n`);
  await appendFile(logFile, `${line}\n`);
};
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const results: Record<string, unknown> = { stamp, quick, seconds };

// --- helpers --------------------------------------------------------------------------------------------------

const call = async (url: string, body?: unknown): Promise<unknown> => {
  const response = await fetch(url, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${url}: ${String(response.status)} ${text}`);
  return text.length === 0 ? null : JSON.parse(text);
};
const sidecar = (route: string, body?: unknown) => call(`${sidecarUrl}${route}`, body);
const appEval = async (expression: string) => z.looseObject({ value: z.unknown().optional() }).parse(await sidecar("/eval", { expression })).value;

const waitFor = async (what: string, check: () => Promise<boolean>, timeoutMs = 15_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (await check()) return;
    } catch {
      // not yet
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const percentile = (values: readonly number[], p: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index] ?? 0);
};
const summarise = (values: readonly number[]) => ({ n: values.length, p50: percentile(values, 50), p95: percentile(values, 95), max: percentile(values, 100) });

// --- start everything -----------------------------------------------------------------------------------------

const executable = await findBrowser();
const api = startChild("api", ["src/api/main.ts"], { cwd: root, env: { SPIKE_API_PORT: String(ports.api) }, log: path.join(outDir, "api.log"), readyText: "api listening" });
const vite = startChild("vite", ["node_modules/vite/bin/vite.js", "--config", "app/vite.config.ts"], {
  cwd: root,
  env: { SPIKE_API_PORT: String(ports.api), SPIKE_APP_PORT: String(ports.app) },
  log: path.join(outDir, "vite.log"),
});
const core = startChild("core", ["src/relay/core.ts", "--port", String(ports.core)], { cwd: root, log: path.join(outDir, "core.log"), readyText: "core listening" });
const web = startChild("web", ["src/relay/web.ts", "--port", String(ports.web), "--core", coreUrl], { cwd: root, log: path.join(outDir, "web.log"), readyText: "web listening" });
await Promise.all([api.ready, core.ready, web.ready]);
await waitFor("vite", async () => (await fetch(appUrl)).ok, 60_000);

const startSidecar = async (carrier: "ws" | "http"): Promise<Child> => {
  const child = startChild("sidecar", ["src/sidecar/main.ts", "--carrier", carrier, "--core", coreUrl, "--control", String(ports.sidecar), "--app", appUrl, "--profiles", profiles], {
    cwd: root,
    log: path.join(outDir, `sidecar-${carrier}.log`),
    readyText: "sidecar ready",
  });
  await child.ready;
  return child;
};

let sidecarChild = await startSidecar("ws");
const info = z.looseObject({ browserPid: z.number(), product: z.string(), userAgent: z.string(), executable: z.string(), sidecarPid: z.number() }).parse(await sidecar("/info"));

const viewerCdp: Cdp = await launchBrowser({ executable, profileRoot: profiles, windowSize: { width: 1600, height: 1000 } });
const viewerVersion = await browserVersion(viewerCdp);
const viewer: Page = await openPage(viewerCdp, { width: 1600, height: 1000, mobile: false });
const openViewer = async (url = `${webUrl}/viewer?view=v1`) => {
  await viewer.navigate(url);
  await waitFor("the viewer's stream", async () => (await viewer.evaluate("window.__probe?.streamOpen === true")) === true);
};
await openViewer();

const startBoxSampler = (browserPid: number, sidecarPid: number) =>
  startSampler({
    browser: String(browserPid),
    vite: String(vite.pid),
    api: String(api.pid),
    sidecar: `!${String(sidecarPid)}`,
    core: String(core.pid),
    web: String(web.pid),
    viewer: String(viewerCdp.pid),
  });
let sampler = startBoxSampler(info.browserPid, info.sidecarPid);

const cpuList = cpus();
results["machine"] = {
  cpu: cpuList[0]?.model ?? "unknown",
  logicalProcessors: cpuList.length,
  memoryGB: Math.round(totalmem() / 1_073_741_824),
  os: `Windows ${release()}`,
  node: process.version,
  boxBrowser: { product: info.product, executable: info.executable, userAgent: info.userAgent },
  memberBrowser: { product: viewerVersion.product },
};
await log(`machine ${JSON.stringify(results["machine"])}`);

// --- the member's input, through the viewer page ---------------------------------------------------------------

const vMouse = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) => viewer.send("Input.dispatchMouseEvent", { type, x, y, ...extra });
const vClick = async (x: number, y: number) => {
  await vMouse("mousePressed", x, y, { button: "left", buttons: 1, clickCount: 1 });
  await vMouse("mouseReleased", x, y, { button: "left", buttons: 0, clickCount: 1 });
};
const keyInfo = (char: string) => {
  if (char === " ") return { code: "Space", keyCode: 32 };
  if (char === ",") return { code: "Comma", keyCode: 188 };
  if (char === ".") return { code: "Period", keyCode: 190 };
  const upper = char.toUpperCase();
  if (/[A-Z]/.test(upper)) return { code: `Key${upper}`, keyCode: upper.charCodeAt(0) };
  if (/[0-9]/.test(char)) return { code: `Digit${char}`, keyCode: char.charCodeAt(0) };
  return { code: "", keyCode: 0 };
};
const vKey = async (char: string) => {
  const { code, keyCode } = keyInfo(char);
  await viewer.send("Input.dispatchKeyEvent", { type: "keyDown", key: char, code, text: char, unmodifiedText: char, windowsVirtualKeyCode: keyCode });
  await viewer.send("Input.dispatchKeyEvent", { type: "keyUp", key: char, code, windowsVirtualKeyCode: keyCode });
};

const counterSchema = z.strictObject({ lat: z.array(z.number()), sent: z.number(), unmatched: z.number() });
const probeSchema = z.looseObject({
  frames: z.number(),
  bytes: z.number(),
  drawn: z.number(),
  skipped: z.number(),
  decodeMs: z.number(),
  a: counterSchema,
  b: counterSchema,
  width: z.number(),
  height: z.number(),
  posts: z.number(),
  postedEvents: z.number(),
  postMs: z.array(z.number()),
});
const readProbe = async () =>
  probeSchema.parse(
    await viewer.evaluate(
      "(() => { const { reset, arrivals, a, b, ...rest } = window.__probe; const c = (x) => ({ lat: x.lat, sent: x.sent.length, unmatched: x.sent.length - x.resolved }); return { ...rest, a: c(a), b: c(b) }; })()",
    ),
  );
const resetProbe = () => viewer.evaluate("window.__probe.reset()");

const centre = async (selector: string) =>
  z.strictObject({ x: z.number(), y: z.number() }).parse(await appEval(`(() => { const r = document.querySelector('${selector}').getBoundingClientRect(); return { x: Math.round(r.x + Math.min(r.width / 2, 40)), y: Math.round(r.y + r.height / 2) }; })()`));

const resetApp = () =>
  appEval(
    "(() => { window.scrollTo(0, 0); const el = document.querySelector('#field'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); el.blur(); return true; })()",
  );
const nudge = () => appEval("(() => { document.body.style.background = '#f4f5f8'; setTimeout(() => { document.body.style.background = ''; }, 50); return true; })()");

type Config = { width: number; height: number; mobile: boolean; quality: number; fpsCap: number; capMode: "ack" | "drop"; inflight: number; sendLastFrame: boolean };
let current: Config = { width: 1440, height: 900, mobile: false, quality: 60, fpsCap: 15, capMode: "ack", inflight: 3, sendLastFrame: true };
const configure = async (config: Config) => {
  current = config;
  await sidecar("/config", config);
  await resetApp();
  await waitFor(`a ${String(config.width)}x${String(config.height)} frame`, async () => {
    await nudge();
    const probe = await readProbe();
    return probe.width === config.width && probe.height === config.height;
  });
  await sleep(400);
};

const coreStatsSchema = z.looseObject({ framesIn: z.number(), bytesIn: z.number(), framesOut: z.number(), bytesOut: z.number(), ackWaitMs: z.number(), inputBatches: z.number(), inputEvents: z.number(), httpPosts: z.number(), polls: z.number() });
const sidecarStatsSchema = z.looseObject({ produced: z.number(), producedBytes: z.number(), forwarded: z.number(), forwardedBytes: z.number(), dropped: z.number(), decodeMs: z.number() });

type Scenario = "idle" | "typing" | "scrolling" | "animating";
const text = "the quick brown fox jumps over the lazy dog, ";

const drive = async (scenario: Scenario, durationMs: number, keysPerSecond = 15) => {
  const started = Date.now();
  switch (scenario) {
    case "idle":
    case "animating":
      await sleep(durationMs);
      return;
    case "typing": {
      let index = 0;
      while (Date.now() - started < durationMs) {
        await vKey(text[index % text.length] ?? " ");
        index += 1;
        const due = started + (index * 1000) / keysPerSecond;
        await sleep(Math.max(0, due - Date.now()));
      }
      return;
    }
    case "scrolling": {
      let index = 0;
      // A trackpad's pace: about 60 wheel events a second, 40 px each.
      while (Date.now() - started < durationMs) {
        await vMouse("mouseWheel", Math.round(current.width / 2), Math.round(current.height / 2), { deltaX: 0, deltaY: 40 });
        index += 1;
        const due = started + index * 16;
        await sleep(Math.max(0, due - Date.now()));
      }
      return;
    }
    default:
      scenario satisfies never;
  }
};

const prepare = async (scenario: Scenario) => {
  await resetApp();
  if (scenario === "typing") {
    const field = await centre("#field");
    await vClick(field.x, field.y);
  }
  if (scenario === "scrolling") await vMouse("mouseMoved", Math.round(current.width / 2), Math.round(current.height / 2), { button: "none", buttons: 0 });
  if (scenario === "animating") await appEval("window.__animate(true)");
  await sleep(500);
};

type Measured = {
  name: string;
  scenario: Scenario;
  config: Config;
  seconds: number;
  memberFps: number;
  memberDrawnFps: number;
  memberKBps: number;
  avgFrameKB: number;
  decodeMsAvg: number;
  browserFps: number;
  forwardedFps: number;
  droppedBySidecar: number;
  coreKBps: number;
  use: Record<string, GroupUse>;
};

const measure = async (name: string, scenario: Scenario, config: Config, options: { keysPerSecond?: number } = {}): Promise<Measured> => {
  await prepare(scenario);
  await resetProbe();
  await call(`${coreUrl}/stats/reset`, {});
  await sidecar("/stats/reset", {});
  const from = Date.now();
  await drive(scenario, seconds * 1000, options.keysPerSecond);
  const to = Date.now();
  // Counted at the window's end, so frames still arriving after it don't inflate the rate.
  const [probe, coreRaw, scRaw] = await Promise.all([readProbe(), call(`${coreUrl}/stats`), sidecar("/stats")]);
  const coreStats = coreStatsSchema.parse(coreRaw);
  const scStats = sidecarStatsSchema.parse(scRaw);
  if (scenario === "animating") await appEval("window.__animate(false)");
  await waitFor("a CPU sample after the window", () => Promise.resolve(sampler.latest() >= to), 10_000);
  const use = sampler.use(from, to);
  const elapsed = (to - from) / 1000;
  const result: Measured = {
    name,
    scenario,
    config,
    seconds: Number(elapsed.toFixed(2)),
    memberFps: Number((probe.frames / elapsed).toFixed(1)),
    memberDrawnFps: Number((probe.drawn / elapsed).toFixed(1)),
    memberKBps: Math.round(probe.bytes / 1024 / elapsed),
    avgFrameKB: probe.frames === 0 ? 0 : Number((probe.bytes / 1024 / probe.frames).toFixed(1)),
    decodeMsAvg: probe.drawn === 0 ? 0 : Number((probe.decodeMs / probe.drawn).toFixed(1)),
    browserFps: Number((scStats.produced / elapsed).toFixed(1)),
    forwardedFps: Number((scStats.forwarded / elapsed).toFixed(1)),
    droppedBySidecar: scStats.dropped,
    coreKBps: Math.round(coreStats.bytesIn / 1024 / elapsed),
    use,
  };
  const b = use["browser"];
  await log(
    `${name.padEnd(44)} member ${String(result.memberFps).padStart(5)} fps ${String(result.memberKBps).padStart(5)} KB/s (${String(result.avgFrameKB)} KB/frame)  browser ${String(result.browserFps)} fps  box-browser ${String(b?.vcpu ?? 0)} vCPU ${String(b?.privMaxMB ?? 0)} MB priv  sidecar ${String(use["sidecar"]?.vcpu ?? 0)} vCPU`,
  );
  return result;
};

const latency = async (name: string, kind: "click" | "key", count: number, spacingMs: number) => {
  await resetApp();
  await sleep(300);
  if (kind === "key") {
    const field = await centre("#field");
    await vClick(field.x, field.y);
    await sleep(500);
  }
  const counter = await centre("#counter");
  await resetProbe();
  for (let index = 0; index < count; index += 1) {
    if (kind === "click") await vClick(counter.x, counter.y);
    else await vKey("abcdefghij"[index % 10] ?? "a");
    await sleep(spacingMs);
  }
  await sleep(1500);
  const probe = await readProbe();
  const seen = kind === "click" ? probe.a : probe.b;
  const result = { name, kind, sent: count, spacingMs, ...summarise(seen.lat), unmatched: seen.unmatched, postMsP50: percentile(probe.postMs, 50) };
  await log(`${name.padEnd(44)} ${kind} latency n=${String(result.n)}/${String(count)} p50 ${String(result.p50)} ms p95 ${String(result.p95)} ms max ${String(result.max)} ms`);
  return result;
};

// Key latency while typing without a pause, which the 4-bit counter can time key by key.
const typingLatency = async (name: string, keysPerSecond: number) => {
  await prepare("typing");
  await resetProbe();
  await sidecar("/stats/reset", {});
  const from = Date.now();
  await drive("typing", seconds * 1000, keysPerSecond);
  const to = Date.now();
  await sleep(1500);
  const probe = await readProbe();
  await waitFor("a CPU sample after the window", () => Promise.resolve(sampler.latest() >= to), 10_000);
  const use = sampler.use(from, to);
  const result = {
    name,
    kind: "key-while-typing",
    keysPerSecond,
    sent: probe.b.sent,
    ...summarise(probe.b.lat),
    unmatched: probe.b.unmatched,
    memberFps: Number((probe.frames / ((to - from) / 1000)).toFixed(1)),
    boxBrowserVcpu: use["browser"]?.vcpu ?? 0,
  };
  await log(`${name.padEnd(44)} typing ${String(keysPerSecond)} keys/s: latency n=${String(result.n)}/${String(result.sent)} p50 ${String(result.p50)} ms p95 ${String(result.p95)} ms max ${String(result.max)} ms, ${String(result.memberFps)} fps`);
  return result;
};

const uncapped = (width: number, height: number, mobile: boolean, quality: number): Config => ({ width, height, mobile, quality, fpsCap: 0, capMode: "ack", inflight: 3, sendLastFrame: false });

try {
  // 1. Frame rate and bytes: three sizes, three qualities, three scenarios, uncapped (acks only).
  await log("\n== 1. frame rate and bytes, uncapped (back-pressure by acks only, maxFramesInFlight 3) ==");
  const grid: Measured[] = [];
  const sizes = [
    { width: 1440, height: 900, mobile: false },
    { width: 1280, height: 800, mobile: false },
    { width: 390, height: 844, mobile: true },
  ];
  for (const size of sizes) {
    for (const quality of quick ? [60] : [50, 60, 70]) {
      const config = uncapped(size.width, size.height, size.mobile, quality);
      await configure(config);
      const scenarios: readonly Scenario[] = quality === 60 ? ["idle", "typing", "scrolling", "animating"] : ["idle", "typing", "scrolling"];
      for (const scenario of scenarios) {
        grid.push(await measure(`${String(size.width)}x${String(size.height)} q${String(quality)} ${scenario}`, scenario, config));
      }
    }
  }
  results["grid"] = grid;

  // The working defaults (15 fps cap at 1440x900 q60), the two ways to cap, and the fallback defaults.
  await log("\n== capped: ADR 0068's working defaults and its fallback ==");
  const capped: Measured[] = [];
  const defaults: Config = { width: 1440, height: 900, mobile: false, quality: 60, fpsCap: 15, capMode: "ack", inflight: 1, sendLastFrame: true };
  const fallback: Config = { width: 1280, height: 800, mobile: false, quality: 50, fpsCap: 8, capMode: "ack", inflight: 1, sendLastFrame: true };
  const capped1280: Config = { width: 1280, height: 800, mobile: false, quality: 60, fpsCap: 15, capMode: "ack", inflight: 1, sendLastFrame: true };
  for (const [label, config] of [
    ["defaults 1440x900 q60 cap15 (ack)", defaults],
    ["1440x900 q60 cap15 (drop)", { ...defaults, capMode: "drop", inflight: 3 }],
    ["1280x800 q60 cap15 (ack)", capped1280],
    ["fallback 1280x800 q50 cap8 (ack)", fallback],
  ] as const) {
    await configure(config);
    for (const scenario of ["typing", "scrolling", "animating"] as const) capped.push(await measure(`${label} ${scenario}`, scenario, config));
  }
  results["capped"] = capped;

  // Typing at a human pace, for the bar's "while typing" at the working defaults.
  await configure(capped1280);
  results["typingPace"] = [await measure("1280x800 q60 cap15 typing at 8 keys/s", "typing", capped1280, { keysPerSecond: 8 }), await measure("1280x800 q60 cap15 typing at 25 keys/s", "typing", capped1280, { keysPerSecond: 25 })];

  // 3. Input latency, through core and the web hop.
  await log("\n== 3. input latency: a click or a key in the member's page to the frame that shows it ==");
  const latencies: unknown[] = [];
  const n = quick ? 10 : 40;
  for (const [label, config] of [
    ["1280x800 q60 uncapped", uncapped(1280, 800, false, 60)],
    ["1280x800 q60 cap15", capped1280],
    ["defaults 1440x900 q60 cap15", defaults],
    ["fallback 1280x800 q50 cap8", fallback],
  ] as const) {
    await configure(config);
    latencies.push(await latency(`${label} (2 hops)`, "click", n, 450));
    latencies.push(await latency(`${label} (2 hops)`, "key", n, 300));
    latencies.push(await typingLatency(`${label} (2 hops)`, 8));
    latencies.push(await typingLatency(`${label} (2 hops)`, 15));
  }
  // The same through core alone, to see what the web hop adds.
  await openViewer(`${coreUrl}/viewer?view=v1&base=/panel/v1/previews`);
  await configure(capped1280);
  latencies.push(await latency("1280x800 q60 cap15 (core only, 1 hop)", "click", n, 450));
  await openViewer();
  results["latency"] = latencies;

  // 4 and 5. The counter, typing, pasting, and the frontend's /api call, all through the stream.
  await log("\n== 4, 5. the counter, the field, a paste and /api, through the stream ==");
  await configure(capped1280);
  await sidecar("/navigate", { url: appUrl });
  await waitFor("the app", async () => (await appEval("document.querySelector('#api')?.className")) === "ok");
  await configure(capped1280);
  const counter = await centre("#counter");
  for (let index = 0; index < 5; index += 1) {
    await vClick(counter.x, counter.y);
    await sleep(250);
  }
  await sleep(500);
  const count = await appEval("document.querySelector('#count').textContent");
  const field = await centre("#field");
  await vClick(field.x, field.y);
  await sleep(300);
  for (const char of "hello ostra") {
    await vKey(char);
    await sleep(60);
  }
  await sleep(500);
  const typed = await appEval("document.querySelector('#field').value");
  const pasteText = " pasted: été ✓ 2026";
  await viewer.evaluate(
    `(() => { const data = new DataTransfer(); data.setData('text/plain', ${JSON.stringify(pasteText)}); document.querySelector('#screen').focus(); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); return true; })()`,
  );
  await sleep(700);
  const afterPaste = await appEval("document.querySelector('#field').value");
  const apiText = await appEval("document.querySelector('#api').textContent");
  const shot = await viewer.screenshot("png");
  await writeFile(path.join(outDir, "member-view-1280x800.png"), shot);
  const functional = {
    counter: { clicks: 5, shown: count, pass: count === "5" },
    typing: { typed: "hello ostra", value: typed, pass: typed === "hello ostra" },
    paste: { pasted: pasteText, value: afterPaste, pass: afterPaste === `hello ostra${pasteText}` },
    api: { text: apiText, pass: apiText === `api: ok, hello from the API on ${String(ports.api)}` },
    memberView: "member-view-1280x800.png",
  };
  results["functional"] = functional;
  await log(`functional ${JSON.stringify(functional)}`);

  // No one watching: the screencast stops and the browser idles.
  await log("\n== the box's browser with no view open ==");
  await viewer.navigate("about:blank");
  await sleep(2000);
  await call(`${coreUrl}/stats/reset`, {});
  const idleFrom = Date.now();
  await sleep(seconds * 1000);
  const idleUse = sampler.use(idleFrom, Date.now());
  results["noView"] = { use: idleUse, framesIn: coreStatsSchema.parse(await call(`${coreUrl}/stats`)).framesIn };
  await log(`no view: box-browser ${String(idleUse["browser"]?.vcpu ?? 0)} vCPU ${String(idleUse["browser"]?.privMaxMB ?? 0)} MB priv, vite ${String(idleUse["vite"]?.privMaxMB ?? 0)} MB, api ${String(idleUse["api"]?.privMaxMB ?? 0)} MB`);
  await openViewer();

  // 2. An approximation of the 2 vCPU cap: the browser, Vite and the API pinned to two logical processors
  // (one P-core's two hyperthreads). No memory cap; no container.
  await log("\n== 2. pinned to 2 logical processors (affinity 0xC): a CPU cap only, not a container ==");
  const pin = async (mask: number) => {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(root, "src", "harness", "affinity.ps1"),
      "-Pids",
      `${String(info.browserPid)},${String(vite.pid)},${String(api.pid)}`,
      "-Mask",
      String(mask),
    ]);
    await log(stdout.trim());
  };
  await pin(0xc);
  const pinned: unknown[] = [];
  await configure(uncapped(1280, 800, false, 60));
  pinned.push(await measure("pinned 1280x800 q60 uncapped typing", "typing", uncapped(1280, 800, false, 60)));
  pinned.push(await measure("pinned 1280x800 q60 uncapped scrolling", "scrolling", uncapped(1280, 800, false, 60)));
  await configure(capped1280);
  pinned.push(await measure("pinned 1280x800 q60 cap15 typing", "typing", capped1280));
  pinned.push(await measure("pinned 1280x800 q60 cap15 scrolling", "scrolling", capped1280));
  pinned.push(await latency("pinned 1280x800 q60 cap15", "click", n, 450));
  pinned.push(await latency("pinned 1280x800 q60 cap15", "key", n, 300));
  pinned.push(await typingLatency("pinned 1280x800 q60 cap15", 15));
  await configure(fallback);
  pinned.push(await measure("pinned fallback 1280x800 q50 cap8 typing", "typing", fallback));
  pinned.push(await typingLatency("pinned fallback 1280x800 q50 cap8", 15));
  await configure(defaults);
  pinned.push(await measure("pinned defaults 1440x900 q60 cap15 typing", "typing", defaults));
  pinned.push(await measure("pinned defaults 1440x900 q60 cap15 scrolling", "scrolling", defaults));
  pinned.push(await measure("pinned defaults 1440x900 q60 cap15 animating", "animating", defaults));
  pinned.push(await typingLatency("pinned defaults 1440x900 q60 cap15", 15));
  await pin(0xffffffff);
  results["pinned"] = pinned;

  // 7. What a screenshot and a 10-second recording at 10 frames a second weigh.
  await log("\n== 7. a screenshot and a 10 s recording at 10 fps, each in a page of its own ==");
  const weights: Record<string, unknown> = {};
  weights["screenshotDesktop"] = await sidecar("/screenshot", { width: 1440, height: 900, mobile: false, save: path.join(outDir, "screenshot-desktop.png") });
  weights["screenshotPhone"] = await sidecar("/screenshot", { width: 390, height: 844, mobile: true, save: path.join(outDir, "screenshot-phone.png") });
  const recordSeconds = quick ? 3 : 10;
  for (const [label, format, quality, steps] of [
    ["reelJpeg60Interact", "jpeg", 60, "interact"],
    ["reelJpeg50Interact", "jpeg", 50, "interact"],
    ["reelJpeg60Scroll", "jpeg", 60, "scroll"],
    ["reelPngInteract", "png", 60, "interact"],
    ["reelPngScroll", "png", 60, "scroll"],
  ] as const) {
    weights[label] = await sidecar("/record", { seconds: recordSeconds, fps: 10, format, quality, steps, capMode: "ack", width: 1440, height: 900 });
    await log(`${label}: ${JSON.stringify(weights[label])}`);
  }
  await log(`screenshots: desktop ${JSON.stringify(weights["screenshotDesktop"])}, phone ${JSON.stringify(weights["screenshotPhone"])}`);
  results["weights"] = weights;

  // 6. The HTTP carrier: frames up in POSTs at 2 a second, input down a 25 s long poll.
  await log("\n== 6. the HTTP carrier ==");
  // The sidecar closes its browser and removes the profile itself; the kill after it is only a backstop.
  await sidecar("/quit", {}).catch(() => undefined);
  await new Promise<void>((resolve) => {
    if (sidecarChild.process.exitCode !== null) resolve();
    sidecarChild.process.once("exit", () => {
      resolve();
    });
    setTimeout(resolve, 20_000);
  });
  await stopChild(sidecarChild);
  sidecarChild = await startSidecar("http");
  const httpInfo = z.looseObject({ browserPid: z.number(), sidecarPid: z.number() }).parse(await sidecar("/info"));
  results["samplerTickMs"] = sampler.tickMs();
  await sampler.stop();
  sampler = startBoxSampler(httpInfo.browserPid, httpInfo.sidecarPid);
  await openViewer();
  const httpConfig: Config = { width: 1280, height: 800, mobile: false, quality: 60, fpsCap: 2, capMode: "ack", inflight: 1, sendLastFrame: true };
  await configure(httpConfig);
  const http: unknown[] = [];
  http.push(await measure("http 1280x800 q60 cap2 typing", "typing", httpConfig));
  http.push(await measure("http 1280x800 q60 cap2 scrolling", "scrolling", httpConfig));
  http.push(await latency("http 1280x800 q60 cap2", "click", quick ? 6 : 20, 1300));
  http.push(await latency("http 1280x800 q60 cap2", "key", quick ? 6 : 20, 900));
  http.push(await typingLatency("http 1280x800 q60 cap2", 8));
  const before = Number(await appEval("Number(document.querySelector('#count').textContent)"));
  const httpCounter = await centre("#counter");
  for (let index = 0; index < 3; index += 1) {
    await vClick(httpCounter.x, httpCounter.y);
    await sleep(400);
  }
  await sleep(1500);
  const after = Number(await appEval("Number(document.querySelector('#count').textContent)"));
  http.push({ name: "http counter", clicks: 3, before, after, pass: after - before === 3 });
  results["http"] = http;
  await log(`http counter: ${String(before)} -> ${String(after)}`);
} finally {
  results["samples"] = sampler.count();
  results["samplerTickMsHttp"] = sampler.tickMs();
  await writeFile(path.join(outDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  await sampler.stop();
  await viewerCdp.close().catch(() => undefined);
  await sidecar("/quit", {}).catch(() => undefined);
  await new Promise<void>((resolve) => {
    if (sidecarChild.process.exitCode !== null) resolve();
    sidecarChild.process.once("exit", () => {
      resolve();
    });
    setTimeout(resolve, 20_000);
  });
  await stopAll();
  await log(`\nresults in ${outDir}`);
}
