import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import type { Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { baseEnv, localShellProbe, machineBrowserSource, resolveMachineBrowser, resolveSetupShell } from "@ostra/adapter-executor-host";
import { fakeBrowserProgram, fakeMarker } from "@ostra/adapter-sdk/testing";
import { previewKeySchema, previewSubprotocols, previewViewIdSchema, repoFullNameSchema, repoIdSchema, runnerLimits, viewportPresetSizes } from "@ostra/protocol";
import type { CommandBody, PreviewInputEvent, PreviewViewId, PreviewViewport, RepoId, TaskEvent, TaskSpec, TaskSpecAppProcess } from "@ostra/protocol";
import { expect } from "vitest";
import { z } from "zod";
import type { AppTiming } from "../task-host/app-processes.ts";
import { liveBrowser } from "./app-pictures-cases.ts";
import { attachFakePreviewCore } from "./fake-preview-core.ts";
import type { FakePreviewCore, FakeStreamView } from "./fake-preview-core.ts";
import { makeCommand } from "./fake-gateway.ts";
import { ACCESS_TOKEN, startHarness, startShared } from "./task-host-harness.ts";
import type { Harness, HarnessOptions, Shared } from "./task-host-harness.ts";
import { testPort } from "@ostra/adapter-sdk/testing/net";

// Milestone 8's ticket 18 (F-141, ADR 0068 "The browser view"): a view in `stream` mode through the
// whole task host, on one executor. The fake server plays core: it takes the box's preview
// connection with the stream's subprotocol, keeps each frame and acks it (or holds the acks), sends
// core's controls and its close, and reads the HTTP carrier's posted frames as core does
// (`fake-preview-core.ts`). The app is the milestone's `test-web` fixture (Vite and React, `/api`
// behind Vite's proxy to its Node API), started by the view's open.
//
// On `host` the box's browser is this machine's (Edge here), so a click on the counter counts and
// typing lands in the field, read back from the page; on a Linux CI machine without
// OSTRA_RUNNER_BROWSER, and on `docker` and `kubernetes` (`DockerExecutor` through the real bridge
// to a local init), the fake box browser over the same DevTools pipe, whose frames name how many
// input events reached its page. Core's own preview code against the runner's is
// `apps/core/src/previews/runner-stream.test.ts`.

export type PreviewStreamMode = {
  readonly name: "host" | "docker" | "kubernetes";
  /** The box with a browser: the init's fake one in a box. Absent on `host`: the machine's, or the fake one on Linux CI. */
  readonly makeExecutor?: HarnessOptions["makeExecutor"];
  /** The box with no browser: the init with none. Absent on `host`, where the executor is given none. */
  readonly makeExecutorWithoutBrowser?: HarnessOptions["makeExecutor"];
};

const FIXTURE = path.resolve(fileURLToPath(new URL("../../../../e2e/m8-previews-and-library/fixtures/test-web/", import.meta.url)));
const fixturePath = (...parts: readonly string[]): string => `"${path.join(FIXTURE, ...parts).replaceAll("\\", "/")}"`;
const APP_REPO = "ostra-test/stream-app";
const APP_REPO_ID: RepoId = repoIdSchema.parse("repo-stream-app");

const DESKTOP: PreviewViewport = viewportPresetSizes.desktop;
/** The primary's preview, the fixture's Vite. */
const WEB = previewKeySchema.parse("app-web");
const PHONE: PreviewViewport = viewportPresetSizes.phone;
/** The tablet's preset as it is (Q326): taller than 900, within 1440×900's pixels. */
const TABLET: PreviewViewport = viewportPresetSizes.tablet;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const appProcess = (input: Omit<TaskSpecAppProcess, "repoId" | "folder" | "primary" | "hostRewrite"> & Partial<Pick<TaskSpecAppProcess, "primary">>): TaskSpecAppProcess => ({
  repoId: APP_REPO_ID,
  folder: ".",
  primary: false,
  hostRewrite: true,
  ...input,
});

/** The most frames in any one second of `frames`' arrivals. */
const mostInOneSecond = (times: readonly number[]): number => {
  let most = 0;
  for (const [index, start] of times.entries()) {
    most = Math.max(most, times.slice(index).filter((time) => time - start < 1_000).length);
  }
  return most;
};

/** A key's DOM name and code, as the member's page sends them. */
const keyOf = (char: string): { readonly key: string; readonly code: string } =>
  char === " " ? { key: " ", code: "Space" } : { key: char, code: /[a-z]/i.test(char) ? `Key${char.toUpperCase()}` : "" };

/** A click at a point: the move there, the press and the release, as the pane sends them. */
const clickAt = (point: { readonly x: number; readonly y: number }): PreviewInputEvent[] => [
  { kind: "mouse", action: "move", x: point.x, y: point.y, button: "none", clickCount: 0, modifiers: 0 },
  { kind: "mouse", action: "down", x: point.x, y: point.y, button: "left", clickCount: 1, modifiers: 0 },
  { kind: "mouse", action: "up", x: point.x, y: point.y, button: "left", clickCount: 1, modifiers: 0 },
];

/** Typing `text` key by key: each key down and up. */
const typing = (text: string): PreviewInputEvent[] =>
  Array.from(text).flatMap((char): PreviewInputEvent[] => {
    const { key, code } = keyOf(char);
    return [
      { kind: "key", action: "down", key, code, modifiers: 0 },
      { kind: "key", action: "up", key, code, modifiers: 0 },
    ];
  });

/** Where an element's middle is on the page, in CSS pixels: what a member clicks on. */
const pointSchema = z.object({ x: z.number(), y: z.number() });
const middleOf = (selector: string): string =>
  `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`;

/** A page that changes every frame, so the screencast sends as fast as its acks let it. */
const ANIMATE = "(() => { const tick = document.createElement('div'); tick.id = 'ostra-tick'; document.body.appendChild(tick); let n = 0; window.ostraTick = setInterval(() => { tick.textContent = String(n++); }, 8); return true; })()";
const STILL = "(() => { clearInterval(window.ostraTick); return true; })()";

/**
 * A frame's picture's size, from its JPEG's frame header (SOF): the machine's browser's, or the
 * fake one's, which writes one. `null` for bytes with none.
 */
const pictureSize = (jpeg: Uint8Array | undefined): { readonly width: number; readonly height: number } | null => {
  if (jpeg === undefined) return null;
  const bytes = Buffer.from(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength);
  for (let at = 2; at + 9 <= bytes.length && bytes.readUInt8(at) === 0xff; at += 2 + bytes.readUInt16BE(at + 2)) {
    const marker = bytes.readUInt8(at + 1);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
    }
  }
  return null;
};

/** The fake browser's frames name how many input events reached its page. */
const inputsInFrame = (frame: FakeStreamView["frames"][number] | undefined): number => Number(/after (\d+) inputs/.exec(Buffer.from(frame?.jpeg ?? new Uint8Array()).toString("latin1"))?.[1] ?? "-1");

export const previewStreamCases = (mode: PreviewStreamMode) => {
  let shared: Shared | undefined;
  let scratch = "";
  let shell = "bash";
  const harnesses: Harness[] = [];
  const cores: FakePreviewCore[] = [];
  const holders: Server[] = [];
  let views = 0;
  let runners = 0;
  /** A real browser behind the box: on `host` here, the machine's. Elsewhere the fake one. */
  const live = mode.makeExecutor === undefined && liveBrowser;
  const sharedNow = (): Shared => {
    if (shared === undefined) throw new Error("setup didn't run");
    return shared;
  };
  const timing: Partial<AppTiming> = { readyIntervalMs: 200, readyTimeoutMs: 90_000, stopGraceMs: 1_000 };

  /** A runner on the executor, its box's browser the machine's on `host` (the fake one on Linux CI), and the fake core on its server. */
  const runner = async (options: { readonly previewCarrier?: "http"; readonly browser?: false } = {}): Promise<{ readonly h: Harness; readonly core: FakePreviewCore }> => {
    const root = sharedNow().root;
    runners += 1;
    // Each runner a data folder of its own, across the file's tests: a spool is never shared.
    const dataDir = path.join(root, `runner-stream-${mode.name}-${String(runners)}`);
    const withBrowser = options.browser ?? true;
    const browser = !withBrowser ? null : live ? machineBrowserSource(() => resolveMachineBrowser({ named: process.env["OSTRA_RUNNER_BROWSER"], download: false, dataDir })) : fakeBrowserProgram();
    const makeExecutor = withBrowser ? mode.makeExecutor : mode.makeExecutorWithoutBrowser;
    const h = await startHarness(sharedNow(), {
      dataDir,
      host: { appShell: shell, appTiming: timing },
      ...(makeExecutor === undefined ? { executor: { browser } } : { makeExecutor }),
      ...(options.previewCarrier === undefined ? {} : { previewCarrier: options.previewCarrier }),
    });
    harnesses.push(h);
    const core = attachFakePreviewCore(h.server);
    cores.push(core);
    return { h, core };
  };

  /** The fixture's API and its Vite frontend (the primary), on free ports, as the environment declares them. */
  const webTask = async (h: Harness): Promise<{ readonly spec: TaskSpec; readonly api: number; readonly web: number }> => {
    const [api, web] = await Promise.all([testPort(), testPort()]);
    const made = h.taskFor(fakeMarker("say"));
    const [base] = made.spec.repos;
    const [baseEnvironment] = made.spec.environment.repos;
    if (base === undefined || baseEnvironment === undefined) throw new Error("the fixture has a repo");
    const variables = { TEST_WEB_PORT: String(web), TEST_WEB_API_PORT: String(api), TEST_WEB_CACHE_DIR: path.join(scratch, `vite-${String(web)}`).replaceAll("\\", "/") };
    const spec: TaskSpec = {
      ...made.spec,
      repos: [{ ...base, repoId: APP_REPO_ID, fullName: repoFullNameSchema.parse(APP_REPO), cloneUrl: `https://github.com/${APP_REPO}.git`, checkoutDir: "stream-app" }],
      environment: {
        ...made.spec.environment,
        setupScript: null,
        repos: [{ ...baseEnvironment, repoId: APP_REPO_ID, variables: Object.entries(variables).map(([name, value]) => ({ name, value, availableDuringSetup: true })) }],
        appProcesses: [
          appProcess({ name: "api", command: `node ${fixturePath("api", "server.js")}`, port: api, ready: { kind: "http", path: "/api/hello" }, label: "API" }),
          appProcess({
            name: "web",
            command: `node ${fixturePath("node_modules", "vite", "bin", "vite.js")} --config ${fixturePath("vite.config.js")}`,
            port: web,
            ready: { kind: "http", path: "/" },
            label: "Web",
            primary: true,
          }),
        ],
      },
      tools: ["pr-text", "app"],
    };
    const credentials = { ...made.credentials, repos: [{ repoId: APP_REPO_ID, gitToken: made.credentials.repos[0]?.gitToken ?? "", expiresAt: Date.now() + 3_600_000 }] };
    h.server.tasks.set(spec.taskId, { spec, credentials });
    return { spec, api, web };
  };

  const waitFor = async (h: Harness, spec: TaskSpec, kind: TaskEvent["kind"], count = 1, timeoutMs = 120_000): Promise<void> => {
    try {
      await h.waitForKind(spec, kind, count, timeoutMs);
    } catch {
      throw new Error(`no ${kind} (${String(count)}): ${h.kinds(spec).join(", ")} ${h.ofKind(spec, "session.crashed")[0]?.error ?? ""}`);
    }
  };

  const newViewId = (): PreviewViewId => {
    views += 1;
    return previewViewIdSchema.parse(`view-stream-${mode.name}-${String(views)}-${randomBytes(3).toString("hex")}`);
  };

  /** Opens a browser view of `key` at `viewport`, as core sends it; the box's ack. */
  const openStream = async (h: Harness, core: FakePreviewCore, spec: TaskSpec, viewId: PreviewViewId, viewport: PreviewViewport = DESKTOP, key: string = WEB) => {
    core.openView(viewId, spec.leaseEpoch, "stream");
    return h.waitForAck(h.command("preview.open", { sessionId: spec.sessionId, viewId, key, mode: "stream", viewport }));
  };

  /** A task whose box is ready and waits between turns, and a browser view of its primary that streams. */
  const streamingTask = async (h: Harness, core: FakePreviewCore, viewport: PreviewViewport = DESKTOP) => {
    const task = await webTask(h);
    h.dispatch(task.spec);
    await waitFor(h, task.spec, "session.saved");
    const viewId = newViewId();
    expect(await openStream(h, core, task.spec, viewId, viewport)).toMatchObject({ result: "accepted" });
    const view = await core.stream(viewId, 120_000);
    await h.gateway.waitFor(() => view.frames.length > 0, 60_000);
    return { ...task, viewId, view };
  };

  const runOf = (h: Harness) => {
    const [run] = h.host.running();
    if (run === undefined) throw new Error("no run");
    return run;
  };

  /** The page's `expression`, live: the machine's browser computes it. */
  const evaluate = <T,>(h: Harness, expression: string, schema: z.ZodType<T>): Promise<T> => runOf(h).pages().evaluate(WEB, expression, schema);

  /** Waits until the page's `expression` gives `want`, live. */
  const pageSays = async (h: Harness, expression: string, want: string, timeoutMs = 15_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    let said = "";
    while (Date.now() < deadline) {
      said = await evaluate(h, expression, z.string());
      if (said === want) return;
      await sleep(100);
    }
    expect(said).toBe(want);
  };

  /** The fixture's page is up: React rendered the counter. */
  const appRendered = (h: Harness): Promise<void> => pageSays(h, "document.querySelector('#counter')?.textContent ?? ''", "Count: 0", 30_000);

  return {
    setup: async (): Promise<void> => {
      shared = await startShared(`stream-${mode.name}`);
      await shared.upstream.createRepo(APP_REPO, { "README.md": "# stream-app\n" });
      scratch = await mkdtemp(path.join(os.tmpdir(), `ostra-stream-${mode.name}-`));
      const resolved = await resolveSetupShell("bash", localShellProbe(baseEnv(), scratch));
      shell = resolved.kind === "found" ? resolved.command : "bash";
    },
    teardown: async (): Promise<void> => {
      await shared?.close();
      await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
    cleanup: async (): Promise<void> => {
      for (const core of cores.splice(0)) core.close();
      for (const h of harnesses.splice(0)) await h.close();
      for (const holder of holders.splice(0)) {
        await new Promise<void>((resolve) => {
          holder.close(() => {
            resolve();
          });
        });
      }
    },

    /**
     * F-141/c2, c9: a view streams the box's browser as JPEG frames on a connection of its own (the
     * stream's subprotocol, the link's token, the lease epoch), at most 15 a second however fast the
     * page changes; the screencast waits on core's acks, so a core that holds them gets no more
     * frames; and the view stops when it closes: the connection ends with 1000 and the page goes.
     */
    streams: async (): Promise<void> => {
      const { h, core } = await runner();
      const { spec, viewId, view } = await streamingTask(h, core);
      expect(view).toMatchObject({ protocol: previewSubprotocols.stream, bearer: ACCESS_TOKEN, leaseEpoch: spec.leaseEpoch });
      const [first] = view.frames;
      expect(first?.carrier).toBe("websocket");
      expect([first?.jpeg[0], first?.jpeg[1]]).toEqual([0xff, 0xd8]);
      expect(first?.header).toMatchObject({ width: DESKTOP.width, height: DESKTOP.height });
      expect(runOf(h).views().streaming(viewId)).toBe("websocket");
      if (live) {
        await appRendered(h);
        await evaluate(h, ANIMATE, z.boolean());
      }
      // As fast as the page changes, but no faster than the cap: frames numbered in order.
      const from = view.frames.length;
      // Three seconds of the stream at least, and as long as a loaded machine takes to send that many.
      await sleep(3_000);
      await h.gateway.waitFor(() => view.frames.length - from >= (live ? 20 : 15), 30_000);
      const times = view.frames.slice(from).map((frame) => frame.receivedAt);
      expect(times.length).toBeGreaterThanOrEqual(live ? 20 : 15);
      // The cap holds the browser's acks 1/15 s apart; the network's jitter may bunch one or two arrivals.
      expect(mostInOneSecond(times)).toBeLessThanOrEqual(runnerLimits.browserViewFramesPerSecond + 2);
      const seqs = view.frames.map((frame) => frame.header.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      // Core holds its acks: the box's browser sends at most the one frame in flight, and nothing after.
      core.holdAcks(viewId, true);
      await sleep(500);
      const holding = view.frames.length;
      await sleep(1_500);
      expect(view.frames.length).toBe(holding);
      // The ack comes: the newest frame at once (`sendLastFrame`), and the stream goes on.
      core.holdAcks(viewId, false);
      await h.gateway.waitFor(() => view.frames.length >= holding + 3, 10_000);
      if (live) await evaluate(h, STILL, z.boolean());
      // The view closes: its connection ends, the page with it, and no frame comes after.
      expect(runOf(h).pages().hasPage(WEB)).toBe(true);
      expect(await h.waitForAck(h.command("preview.close", { sessionId: spec.sessionId, viewId }))).toMatchObject({ result: "done" });
      expect(await view.closed).toBe(1000);
      expect(view.closeReason).toBe("closed");
      await h.gateway.waitFor(() => !runOf(h).pages().hasPage(WEB), 10_000);
      const after = view.frames.length;
      await sleep(500);
      expect(view.frames.length).toBe(after);
      expect(runOf(h).views().watching()).toBe(0);
      // IDs and counts in the log; never the token or a path.
      const lines = JSON.stringify(h.logs);
      expect(lines).not.toContain(ACCESS_TOKEN);
      expect(lines).not.toContain("/@vite/client");
      expect(lines).not.toContain("test-web");
    },

    /**
     * F-141/c3, c1: everyone watching a preview shares one page: a second view of it joins the same
     * page and gets its newest frame at once; the width preset applies to the shared page, the last
     * one chosen, on every view; one view's close leaves the other streaming, and the page goes with
     * the last.
     */
    shares: async (): Promise<void> => {
      const { h, core } = await runner();
      const { spec, viewId: first, view: one } = await streamingTask(h, core);
      if (live) await appRendered(h);
      const second = newViewId();
      expect(await openStream(h, core, spec, second, PHONE)).toMatchObject({ result: "accepted" });
      const two = await core.stream(second, 60_000);
      await h.gateway.waitFor(() => two.frames.length > 0, 30_000);
      const pages = runOf(h).pages();
      expect(pages.pages()).toBe(1);
      expect(pages.counts(WEB)?.views).toBe(2);
      // The phone's width is the last chosen: both views' frames come at it.
      await h.gateway.waitFor(() => one.frames.at(-1)?.header.width === PHONE.width && two.frames.at(-1)?.header.width === PHONE.width, 20_000);
      expect(one.frames.at(-1)?.header).toMatchObject({ width: PHONE.width, height: PHONE.height });
      if (live) await pageSays(h, "String(window.innerWidth)", String(PHONE.width));
      // The tablet's preset as it is, 834×1112 (Q326): its pictures come at its own size, not scaled down to 900 high.
      core.control(first, { kind: "viewport", viewport: TABLET });
      const atTablet = (frame: FakeStreamView["frames"][number]): boolean => frame.header.width === TABLET.width && frame.header.height === TABLET.height;
      await h.gateway.waitFor(() => one.frames.some(atTablet) && two.frames.some(atTablet), 20_000);
      await h.gateway.waitFor(() => one.frames.some((frame) => atTablet(frame) && pictureSize(frame.jpeg)?.height === TABLET.height), 20_000);
      expect(pictureSize(one.frames.findLast(atTablet)?.jpeg)).toEqual(TABLET);
      if (live) await pageSays(h, "String(window.innerHeight)", String(TABLET.height));
      // The width preset from core, on the shared page: back to the desktop's, on both.
      core.control(first, { kind: "viewport", viewport: DESKTOP });
      await h.gateway.waitFor(() => one.frames.at(-1)?.header.width === DESKTOP.width && two.frames.at(-1)?.header.width === DESKTOP.width, 20_000);
      if (live) await pageSays(h, "String(window.innerWidth)", String(DESKTOP.width));
      await h.gateway.waitFor(() => one.controlAcks.length === 2, 10_000);
      // The first view goes; the second streams on from the same page.
      expect(await h.waitForAck(h.command("preview.close", { sessionId: spec.sessionId, viewId: first }))).toMatchObject({ result: "done" });
      expect(await one.closed).toBe(1000);
      expect(pages.counts(WEB)?.views).toBe(1);
      const from = two.frames.length;
      if (live) {
        await evaluate(h, ANIMATE, z.boolean());
      }
      await h.gateway.waitFor(() => two.frames.length > from + 2, 20_000);
      expect(await h.waitForAck(h.command("preview.close", { sessionId: spec.sessionId, viewId: second }))).toMatchObject({ result: "done" });
      expect(await two.closed).toBe(1000);
      await h.gateway.waitFor(() => !pages.hasPage(WEB), 10_000);
      expect(pages.pages()).toBe(0);
    },

    /**
     * F-141/c2: a member's input reaches the page, in order: a click on the counter counts it, typed
     * keys land in the field, and pasted text lands with its accents; each control is acked once
     * applied. Typed text reaches no log line.
     */
    input: async (): Promise<void> => {
      const { h, core } = await runner();
      const { viewId, view } = await streamingTask(h, core);
      const typed = "hi ostra";
      const pasted = " été ✓";
      if (live) {
        await appRendered(h);
        const counter = await evaluate(h, middleOf("#counter"), pointSchema);
        const before = view.frames.length;
        core.control(viewId, { kind: "input", events: clickAt(counter) });
        await pageSays(h, "document.querySelector('#counter')?.textContent ?? ''", "Count: 1");
        // The page changed, and its new frame came.
        await h.gateway.waitFor(() => view.frames.length > before, 10_000);
        core.control(viewId, { kind: "input", events: clickAt(counter) });
        await pageSays(h, "document.querySelector('#counter')?.textContent ?? ''", "Count: 2");
        const field = await evaluate(h, middleOf("#field"), pointSchema);
        core.control(viewId, { kind: "input", events: [...clickAt(field), ...typing(typed), { kind: "text", text: pasted }] });
        await pageSays(h, "document.querySelector('#typed')?.textContent ?? ''", `${typed}${pasted}`);
      } else {
        // The fake browser counts each event its page got, and says so in its next frames.
        core.control(viewId, { kind: "input", events: clickAt({ x: 40, y: 40 }) });
        core.control(viewId, { kind: "input", events: [...typing(typed), { kind: "text", text: pasted }] });
        const events = 3 + typed.length * 2 + 1;
        await h.gateway.waitFor(() => inputsInFrame(view.frames.at(-1)) === events, 20_000);
      }
      await h.gateway.waitFor(() => view.controlAcks.length >= (live ? 3 : 2), 10_000);
      expect(view.controlAcks).toEqual([...view.controlAcks].sort((a, b) => a - b));
      expect(runOf(h).pages().counts(WEB)).toMatchObject({ inputsFailed: 0 });
      const lines = JSON.stringify(h.logs);
      expect(lines).not.toContain(typed);
      expect(lines).not.toContain("été");
    },

    /**
     * F-141/c4, c9: a view of anything but one of the task's previews is refused at its open, with
     * nothing connected; a view whose lease epoch is stale is refused by core and holds nothing; and
     * the shared page itself never loads a box port no preview may reach (live).
     */
    refuses: async (): Promise<void> => {
      const { h, core } = await runner();
      const { spec, viewId, view } = await streamingTask(h, core);
      // Something listens on a port that isn't one of the task's previews. A browser may open a
      // socket ahead of a navigation (a preconnect); what counts is a request sent on one.
      let reached = 0;
      const holder = createServer((socket) => {
        socket.once("data", () => {
          reached += 1;
          socket.end();
        });
        socket.on("error", () => undefined);
      });
      holders.push(holder);
      const unlisted = await testPort();
      await new Promise<void>((resolve) => holder.listen(unlisted, "localhost", resolve));
      const stray = newViewId();
      core.openView(stray, spec.leaseEpoch, "stream");
      const refused = await h.waitForAck(h.command("preview.open", { sessionId: spec.sessionId, viewId: stray, key: `port-${String(unlisted)}`, mode: "stream", viewport: DESKTOP }));
      expect(refused).toMatchObject({ result: "rejected", reason: "not-a-preview" });
      expect(core.upgrades.filter((upgrade) => upgrade.viewId === stray)).toEqual([]);
      if (live) {
        // A link on the page to that port, or to the key proxy's, is a document the page never loads.
        await appRendered(h);
        const keyProxyPort = Number(new URL(h.launches[0]?.env["FAKE_AGENT_BASE_URL"] ?? "http://localhost:1").port);
        for (const port of [unlisted, keyProxyPort]) {
          await evaluate(h, `(() => { location.href = 'http://localhost:${String(port)}/'; return true; })()`, z.boolean());
          await h.gateway.waitFor(() => (runOf(h).pages().counts(WEB)?.blocked ?? 0) > (port === unlisted ? 0 : 1), 10_000);
        }
        expect(reached).toBe(0);
        // The page's own path still loads through a navigation from core.
        core.control(viewId, { kind: "navigate", path: "/" });
        await appRendered(h);
      }
      // A stale epoch: core refuses the box's connection, and the view holds nothing.
      const stale = newViewId();
      core.openView(stale, spec.leaseEpoch + 1, "stream");
      expect(await h.waitForAck(h.command("preview.open", { sessionId: spec.sessionId, viewId: stale, key: WEB, mode: "stream", viewport: DESKTOP }))).toMatchObject({ result: "accepted" });
      await h.gateway.waitFor(() => core.upgrades.some((upgrade) => upgrade.viewId === stale && upgrade.status === 409), 60_000);
      await h.gateway.waitFor(() => !runOf(h).views().has(stale), 10_000);
      expect(runOf(h).views().watching()).toBe(1);
      expect(runOf(h).pages().counts(WEB)?.views).toBe(1);
      expect(view.frames.length).toBeGreaterThan(0);
    },

    /**
     * F-141/c8: on the HTTP carrier a view's frames are posted, never more than 2 in any second, and
     * core never has to refuse one as too fast; a member's input, and the pane's width preset, come
     * as `preview.input` and must name one of the box's open views; a view core closed ends at its
     * next frames.
     */
    http: async (): Promise<void> => {
      const { h, core } = await runner({ previewCarrier: "http" });
      const { spec, viewId, view } = await streamingTask(h, core);
      expect(view.frames[0]?.carrier).toBe("http");
      expect(runOf(h).views().streaming(viewId)).toBe("http");
      if (live) {
        await appRendered(h);
        await evaluate(h, ANIMATE, z.boolean());
      }
      const from = view.frames.length;
      // Four seconds of the stream at least, and as long as a loaded machine takes to post that many.
      await sleep(4_000);
      await h.gateway.waitFor(() => view.frames.length - from >= 5, 30_000);
      const times = view.frames.slice(from).map((frame) => frame.receivedAt);
      expect(times.length).toBeGreaterThanOrEqual(5);
      expect(mostInOneSecond(times)).toBeLessThanOrEqual(runnerLimits.httpCarrierFramesPerSecond);
      expect(core.frameAnswers(viewId).every((status) => status === 200)).toBe(true);
      if (live) await evaluate(h, STILL, z.boolean());
      // Input down the long poll, as `preview.input` (the WebSocket's codec refuses it, so it's handed to the host here).
      const send = (body: CommandBody<"preview.input">) => {
        const command = makeCommand({ seq: 1, id: `input-${randomBytes(3).toString("hex")}`, notAfter: Date.now() + 60_000, kind: "preview.input", body });
        if (command.kind !== "preview.input") throw new Error("not an input command");
        return h.host.handlers["preview.input"](command);
      };
      const input = (target: PreviewViewId, events: PreviewInputEvent[]) => send({ sessionId: spec.sessionId, viewId: target, events });
      if (live) {
        const counter = await evaluate(h, middleOf("#counter"), pointSchema);
        expect(await input(viewId, clickAt(counter))).toMatchObject({ result: "accepted" });
        await pageSays(h, "document.querySelector('#counter')?.textContent ?? ''", "Count: 1");
      } else {
        expect(await input(viewId, clickAt({ x: 10, y: 10 }))).toMatchObject({ result: "accepted" });
        await h.gateway.waitFor(() => inputsInFrame(view.frames.at(-1)) === 3, 20_000);
      }
      expect(await input(newViewId(), clickAt({ x: 10, y: 10 }))).toMatchObject({ result: "rejected", reason: "unknown-view" });
      // The pane's width preset comes the same way, and moves the shared page: its frames come at the phone's size.
      expect(await send({ sessionId: spec.sessionId, viewId, control: { kind: "viewport", viewport: PHONE } })).toMatchObject({ result: "accepted" });
      await h.gateway.waitFor(() => view.frames.at(-1)?.header.width === PHONE.width, 20_000);
      expect(view.frames.at(-1)?.header).toMatchObject({ width: PHONE.width, height: PHONE.height });
      expect(await send({ sessionId: spec.sessionId, viewId: newViewId(), control: { kind: "reload" } })).toMatchObject({ result: "rejected", reason: "unknown-view" });
      // Core closed the view: its next frames are refused, and the view ends on the box's side.
      if (live) await evaluate(h, ANIMATE, z.boolean());
      core.closeStream(viewId, "closed");
      await h.gateway.waitFor(() => !runOf(h).views().has(viewId), 20_000);
      expect(core.frameAnswers(viewId)).toContain(410);
      await h.gateway.waitFor(() => !runOf(h).pages().hasPage(WEB), 10_000);
    },

    /**
     * F-141/c1: a view the box takes and then drops before it connects is told to core with why,
     * so core closes it at once instead of leaving it to the sweep: a box with no browser takes a
     * browser view's open, then gives the view up with `preview.dropped` and `no-browser` on the
     * task's session, never opening its connection or a page.
     */
    drops: async (): Promise<void> => {
      const { h, core } = await runner({ browser: false });
      const { spec } = await webTask(h);
      h.dispatch(spec);
      await waitFor(h, spec, "session.saved");
      const viewId = newViewId();
      expect(await openStream(h, core, spec, viewId)).toMatchObject({ result: "accepted" });
      await waitFor(h, spec, "preview.dropped");
      expect(h.ofKind(spec, "preview.dropped")).toEqual([{ kind: "preview.dropped", viewId, refusal: "no-browser" }]);
      // `app.browser` said why there's none; the view never connected, and the box holds nothing of it.
      expect(h.ofKind(spec, "app.browser").map((event) => event.browser.available)).toEqual([false]);
      expect(core.upgrades.filter((upgrade) => upgrade.viewId === viewId)).toEqual([]);
      expect(runOf(h).views().has(viewId)).toBe(false);
      expect(runOf(h).views().watching()).toBe(0);
      expect(runOf(h).pages().pages()).toBe(0);
      // Its close is core's now: a `preview.close` for it finds nothing to close.
      expect(await h.waitForAck(h.command("preview.close", { sessionId: spec.sessionId, viewId }))).toMatchObject({ result: "done", reason: "unknown-view" });
      // IDs and the reason in the log; never the token or a path.
      expect(h.logs.some((record) => record.message === "preview.view-dropped" && record.fields["viewId"] === viewId && record.fields["refusal"] === "no-browser")).toBe(true);
      expect(JSON.stringify(h.logs)).not.toContain(ACCESS_TOKEN);
    },
  };
};
