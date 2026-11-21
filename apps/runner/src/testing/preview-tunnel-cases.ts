import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect as connectTcp, createServer } from "node:net";
import type { Server } from "node:net";
import type { ClientHttp2Stream } from "node:http2";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { baseEnv, localShellProbe, resolveSetupShell } from "@ostra/adapter-executor-host";
import type { AdapterResult, AppPortReach, ReachAppPortInput } from "@ostra/adapter-sdk";
import { fakeMarker } from "@ostra/adapter-sdk/testing";
import { previewSubprotocols, previewViewIdSchema, repoFullNameSchema, repoIdSchema } from "@ostra/protocol";
import type { PreviewViewId, RepoId, TaskEvent, TaskSpec, TaskSpecAppProcess } from "@ostra/protocol";
import { expect } from "vitest";
import WebSocket from "ws";
import { z } from "zod";
import type { AppTiming } from "../task-host/app-processes.ts";
import { attachFakePreviewCore } from "./fake-preview-core.ts";
import type { FakePreviewCore } from "./fake-preview-core.ts";
import { ACCESS_TOKEN, manualTimers, startHarness, startShared } from "./task-host-harness.ts";
import type { Harness, HarnessOptions, ManualTimers, Shared } from "./task-host-harness.ts";

// Milestone 8's ticket 22 (F-143, F-144, ADR 0068 "The preview connection"): a view in `tunnel`
// mode through the whole task host, on one executor. The fake server plays core: it takes the
// box's preview connection as core does (the subprotocol, the link's token, the lease epoch) and is
// the HTTP/2 client on it, as core's `createTunnelHub` is (`fake-preview-core.ts`). The app is the
// milestone's `test-web` fixture (Vite and React, `/api` behind Vite's proxy to its Node API, the
// API's WebSocket echo), started by the view's open. The same cases run on `host` live, and on
// `docker` and `kubernetes` as their box's sidecar drives them: `DockerExecutor` through the real
// bridge to a local init, reaching the app through the init's forwarder on `docker` (opened on the
// first stream to a port, closed with the view) and at the pod's `localhost` on `kubernetes`.
// Core's own tunnel code against the runner's is `apps/core/src/previews/runner-tunnel.test.ts`.

export type PreviewTunnelMode = {
  readonly name: "host" | "docker" | "kubernetes";
  readonly makeExecutor?: HarnessOptions["makeExecutor"];
};

const FIXTURE = path.resolve(fileURLToPath(new URL("../../../../e2e/m8-previews-and-library/fixtures/test-web/", import.meta.url)));
const fixturePath = (...parts: readonly string[]): string => `"${path.join(FIXTURE, ...parts).replaceAll("\\", "/")}"`;
const APP_REPO = "ostra-test/tunnel-app";
const APP_REPO_ID: RepoId = repoIdSchema.parse("repo-tunnel-app");

/** A Vite HMR message, and the API's hello: their kind and words are all a test reads. */
const hmrMessageSchema = z.looseObject({ type: z.string() });
const helloSchema = z.looseObject({ message: z.string() });

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "localhost", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });

const textOf = (data: WebSocket.RawData): string =>
  Buffer.isBuffer(data) ? data.toString("utf8") : Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(new Uint8Array(data)).toString("utf8");

/** Texts in the order they came, each taken once: `next` waits for one, `has` says one is in, `clear` drops those not taken. */
type Inbox = {
  readonly push: (text: string) => void;
  readonly next: (timeoutMs?: number) => Promise<string>;
  readonly has: () => boolean;
  readonly clear: () => void;
};

const inbox = (nothing: string): Inbox => {
  const texts: string[] = [];
  const waiters: (() => void)[] = [];
  return {
    push: (text) => {
      texts.push(text);
      for (const waiter of waiters.splice(0)) waiter();
    },
    next: async (timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs;
      while (texts.length === 0) {
        if (Date.now() > deadline) throw new Error(nothing);
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 100);
        });
      }
      return texts.shift() ?? "";
    },
    has: () => texts.length > 0,
    clear: () => {
      texts.splice(0);
    },
  };
};

/**
 * Edits a probe module the fixture's Vite has served until `heard()` holds, new content every
 * 500 ms, for at most `timeoutMs`. One edit can go unheard: Vite's watcher (its chokidar 3) drops
 * a file's change within 50 ms of the file's last one, and a probe's creation can give a change of
 * its own (`writeFile`'s open and write, both seen), handled before the probe is in Vite's graph.
 * The test's edit, milliseconds later, was then dropped too. Core's `testing/websockets.ts` has the
 * same helper and the longer account.
 */
const editUntil = async (file: string, heard: () => boolean, timeoutMs = 30_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (let edit = 2; ; edit += 1) {
    await writeFile(file, `export const probe = ${String(edit)};\n`);
    const next = Math.min(Date.now() + 500, deadline);
    while (!heard() && Date.now() < next) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
    }
    if (heard()) return;
    if (Date.now() >= deadline) throw new Error("no HMR message after the edits");
  }
};

/**
 * A WebSocket and its messages, kept from before its `open`: a server that speaks first (Vite's HMR
 * `connected`) can come in the same read as the 101, and `ws` emits it before whoever awaited
 * `open` gets to listen. Over the box's direct dial on Linux, it does.
 */
type TestSocket = { readonly ws: WebSocket; readonly messages: Inbox };

const openSocket = (url: string, protocol?: string): Promise<TestSocket> =>
  new Promise((resolve, reject) => {
    const ws = protocol === undefined ? new WebSocket(url) : new WebSocket(url, protocol);
    const messages = inbox("no message");
    ws.on("message", (data) => {
      messages.push(textOf(data));
    });
    ws.once("open", () => {
      resolve({ ws, messages });
    });
    ws.once("error", reject);
  });

/**
 * The text frames a WebSocket's server sends on an extended CONNECT's stream (RFC 6455's framing,
 * unmasked from a server): what a browser reads through core's answer to its upgrade.
 */
const serverTextFrames = (stream: ClientHttp2Stream): Inbox => {
  let held = Buffer.alloc(0);
  const frames = inbox("no frame");
  stream.on("data", (chunk: Buffer) => {
    held = Buffer.concat([held, chunk]);
    for (;;) {
      if (held.length < 2) return;
      const opcode = (held[0] ?? 0) & 0x0f;
      let length = (held[1] ?? 0) & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (held.length < 4) return;
        length = held.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (held.length < 10) return;
        length = Number(held.readBigUInt64BE(2));
        offset = 10;
      }
      if (held.length < offset + length) return;
      const payload = held.subarray(offset, offset + length);
      held = held.subarray(offset + length);
      if (opcode === 1) {
        frames.push(payload.toString("utf8"));
      }
    }
  });
  return frames;
};

/** Whether something takes a connection on `host:port`. */
const answersAt = (host: string, port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connectTcp({ host, port, autoSelectFamily: true });
    const done = (answer: boolean): void => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(3_000, () => {
      done(false);
    });
    socket.once("connect", () => {
      done(true);
    });
    socket.once("error", () => {
      done(false);
    });
  });

const appProcess = (input: Omit<TaskSpecAppProcess, "repoId" | "folder" | "primary" | "hostRewrite"> & Partial<Pick<TaskSpecAppProcess, "primary" | "hostRewrite">>): TaskSpecAppProcess => ({
  repoId: APP_REPO_ID,
  folder: ".",
  primary: false,
  hostRewrite: true,
  ...input,
});

export const previewTunnelCases = (mode: PreviewTunnelMode) => {
  let shared: Shared | undefined;
  let scratch = "";
  let shell = "bash";
  const harnesses: Harness[] = [];
  const cores: FakePreviewCore[] = [];
  const holders: Server[] = [];
  const probes: string[] = [];
  const sockets: WebSocket[] = [];
  let views = 0;
  const sharedNow = (): Shared => {
    if (shared === undefined) throw new Error("setup didn't run");
    return shared;
  };
  const timing: Partial<AppTiming> = { readyIntervalMs: 200, readyTimeoutMs: 90_000, stopGraceMs: 1_000 };

  /** A runner on the executor, the fake core on its server, and each reach the executor opened. */
  const runner = async (timers?: ManualTimers): Promise<{ readonly h: Harness; readonly core: FakePreviewCore; readonly reaches: AppPortReach[] }> => {
    const h = await startHarness(sharedNow(), {
      host: { appShell: shell, appTiming: timing, ...(timers === undefined ? {} : { timers }) },
      ...(mode.makeExecutor === undefined ? {} : { makeExecutor: mode.makeExecutor }),
    });
    harnesses.push(h);
    const core = attachFakePreviewCore(h.server);
    cores.push(core);
    const reaches: AppPortReach[] = [];
    const reachAppPort = h.executor.reachAppPort.bind(h.executor);
    h.executor.reachAppPort = async (input: ReachAppPortInput): Promise<AdapterResult<AppPortReach>> => {
      const reached = await reachAppPort(input);
      if (reached.ok) reaches.push(reached.value);
      return reached;
    };
    return { h, core, reaches };
  };

  /** The fixture's API and its Vite frontend (the primary), on free ports, as the environment declares them. */
  const webTask = async (h: Harness): Promise<{ readonly spec: TaskSpec; readonly api: number; readonly web: number }> => {
    const [api, web] = await Promise.all([freePort(), freePort()]);
    const made = h.taskFor(fakeMarker("say"));
    const [base] = made.spec.repos;
    const [baseEnvironment] = made.spec.environment.repos;
    if (base === undefined || baseEnvironment === undefined) throw new Error("the fixture has a repo");
    const variables = {
      TEST_WEB_PORT: String(web),
      TEST_WEB_API_PORT: String(api),
      TEST_WEB_CACHE_DIR: path.join(scratch, `vite-${String(web)}`).replaceAll("\\", "/"),
    };
    const spec: TaskSpec = {
      ...made.spec,
      repos: [{ ...base, repoId: APP_REPO_ID, fullName: repoFullNameSchema.parse(APP_REPO), cloneUrl: `https://github.com/${APP_REPO}.git`, checkoutDir: "tunnel-app" }],
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

  const statesOf = (h: Harness, spec: TaskSpec): readonly string[] => h.ofKind(spec, "app.process").map((event) => `${event.name}:${event.state}`);

  /** A task whose box is ready and waits between turns, and a view of its primary opened in `tunnel` mode. */
  const openedView = async (
    h: Harness,
    core: FakePreviewCore,
    key = "app-web",
    waiting: () => Promise<void> = () => Promise.resolve(),
  ): Promise<{ readonly spec: TaskSpec; readonly api: number; readonly web: number; readonly viewId: PreviewViewId }> => {
    const task = await webTask(h);
    h.dispatch(task.spec);
    await waitFor(h, task.spec, "session.saved");
    await waiting();
    views += 1;
    const viewId = previewViewIdSchema.parse(`view-${mode.name}-${String(views)}-${randomBytes(3).toString("hex")}`);
    core.openView(viewId, task.spec.leaseEpoch);
    const opened = h.command("preview.open", { sessionId: task.spec.sessionId, viewId, key, mode: "tunnel", viewport: null });
    expect(await h.waitForAck(opened)).toMatchObject({ result: "accepted" });
    return { ...task, viewId };
  };

  /** The box's run of the task: its views. */
  const viewsOf = (h: Harness) => {
    const [run] = h.host.running();
    if (run === undefined) throw new Error("no run");
    return run.views();
  };

  return {
    setup: async (): Promise<void> => {
      shared = await startShared(`tunnel-${mode.name}`);
      await shared.upstream.createRepo(APP_REPO, { "README.md": "# tunnel-app\n" });
      scratch = await mkdtemp(path.join(os.tmpdir(), `ostra-tunnel-${mode.name}-`));
      const resolved = await resolveSetupShell("bash", localShellProbe(baseEnv(), scratch));
      shell = resolved.kind === "found" ? resolved.command : "bash";
    },
    teardown: async (): Promise<void> => {
      await shared?.close();
      await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
    cleanup: async (): Promise<void> => {
      for (const ws of sockets.splice(0)) ws.terminate();
      for (const core of cores.splice(0)) core.close();
      for (const h of harnesses.splice(0)) await h.close();
      for (const holder of holders.splice(0)) {
        await new Promise<void>((resolve) => {
          holder.close(() => {
            resolve();
          });
        });
      }
      for (const probe of probes.splice(0)) await rm(probe, { force: true });
    },

    /**
     * F-143/c2, F-144/c1,c5: the view's open starts the app, and core's streams reach it once it's
     * ready. `ostra preview`'s plain CONNECTs carry the page, `/api` through Vite's proxy, the API's
     * WebSocket and Vite's HMR socket, an HTTP request and a WebSocket at once on one tunnel. The
     * native preview's plain requests and its extended CONNECT reach Vite too, and an edit's HMR
     * message arrives on that socket. The connection is the tunnel's subprotocol, with the link's
     * token and the lease epoch.
     */
    carries: async (): Promise<void> => {
      const { h, core } = await runner();
      const { spec, api, web, viewId } = await openedView(h, core);
      const connection = await core.connection(viewId);
      expect(connection).toMatchObject({ protocol: previewSubprotocols.tunnel, bearer: ACCESS_TOKEN, leaseEpoch: spec.leaseEpoch });
      // `ostra preview`'s local port: each connection to it is one plain CONNECT through the tunnel.
      const local = await core.listen(viewId, web);
      const base = `http://127.0.0.1:${String(local)}`;
      // The first request waits for the app the open started: the API, then Vite, each ready.
      const page = await fetch(`${base}/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("/@vite/client");
      await h.gateway.waitFor(() => statesOf(h, spec).includes("web:ready"), 10_000);
      expect(statesOf(h, spec)).toEqual(["api:starting", "api:ready", "web:starting", "web:ready"]);
      // A WebSocket and HTTP requests at once, each its own CONNECT on the one tunnel.
      const echo = await openSocket(`ws://127.0.0.1:${String(local)}/api/ws`);
      sockets.push(echo.ws);
      const echoed = echo.messages.next();
      const [hello, again] = await Promise.all([fetch(`${base}/api/hello`), fetch(`${base}/src/main.jsx`)]);
      echo.ws.send("through the tunnel");
      expect(await echoed).toBe("echo: through the tunnel");
      expect(helloSchema.parse(await hello.json()).message).toBe(`hello from the API on ${String(api)}`);
      expect(again.status).toBe(200);
      const client = await (await fetch(`${base}/@vite/client`)).text();
      const token = /const wsToken = "([^"]+)"/.exec(client)?.[1] ?? "";
      expect(token).not.toBe("");
      const hmr = await openSocket(`ws://127.0.0.1:${String(local)}/?token=${encodeURIComponent(token)}`, "vite-hmr");
      sockets.push(hmr.ws);
      expect(hmrMessageSchema.parse(JSON.parse(await hmr.messages.next())).type).toBe("connected");
      echo.ws.close();

      // The native preview's plain requests, as core's proxy sends them: `:authority` localhost:<port>.
      const index = await core.request(viewId, web, "/");
      expect(index.status).toBe(200);
      expect(index.body.toString("utf8")).toContain("/@vite/client");
      const proxied = await core.request(viewId, web, "/api/hello");
      expect(helloSchema.parse(JSON.parse(proxied.body.toString("utf8"))).message).toBe(`hello from the API on ${String(api)}`);
      // An app with `hostRewrite` off: the preview's own host as `Host`, the port in core's header.
      const hostUrl = await core.request(viewId, web, "/host-url", { authority: `${String(web)}-p1.preview.localhost` });
      expect(hostUrl.status).toBe(200);
      expect(hostUrl.body.toString("utf8")).toContain(`http://${String(web)}-p1.preview.localhost/auth/callback`);

      // A browser's WebSocket as an extended CONNECT (RFC 8441): Vite's HMR socket, and an edit's message on it.
      const upgraded = await core.websocket(viewId, web, `/?token=${encodeURIComponent(token)}`, { "sec-websocket-protocol": "vite-hmr" });
      expect(upgraded.status).toBe(200);
      expect(upgraded.headers["sec-websocket-protocol"]).toBe("vite-hmr");
      const frames = serverTextFrames(upgraded.stream);
      expect(hmrMessageSchema.parse(JSON.parse(await frames.next())).type).toBe("connected");
      const probe = `__tunnel-probe-${mode.name}-${randomBytes(4).toString("hex")}.js`;
      const probePath = path.join(FIXTURE, "src", probe);
      probes.push(probePath);
      await writeFile(probePath, "export const probe = 1;\n");
      expect((await core.request(viewId, web, `/src/${probe}`)).status).toBe(200);
      // The edit's message on both sockets, not one from before it.
      hmr.messages.clear();
      frames.clear();
      await editUntil(probePath, () => frames.has() && hmr.messages.has());
      expect(["update", "full-reload"]).toContain(hmrMessageSchema.parse(JSON.parse(await frames.next())).type);
      expect(["update", "full-reload"]).toContain(hmrMessageSchema.parse(JSON.parse(await hmr.messages.next())).type);
      upgraded.stream.close();
      hmr.ws.close();

      const tunnel = viewsOf(h).tunnel(viewId);
      // The local fetches share their kept-alive connections, each one CONNECT; the two sockets are one each.
      expect(tunnel?.counts.connects).toBeGreaterThanOrEqual(3);
      expect(tunnel?.counts.websockets).toBe(1);
      expect(tunnel?.counts.requests).toBeGreaterThanOrEqual(4);
      expect(tunnel?.counts.refused).toBe(0);
      // Ports and counts in the log; never a path, a header or the token.
      const lines = JSON.stringify(h.logs);
      expect(lines).not.toContain(token);
      expect(lines).not.toContain("/@vite/client");
      expect(lines).not.toContain(ACCESS_TOKEN);
    },

    /**
     * F-143/c3: the reach rule on every stream. A port no preview serves (something listens there),
     * the key proxy's, ports below 1024: each refused 403 before anything is dialled, as a CONNECT,
     * a request or an extended CONNECT. A view of a key that isn't one of the task's previews is
     * refused at its open.
     */
    refuses: async (): Promise<void> => {
      const { h, core } = await runner();
      const { spec, web, viewId } = await openedView(h, core);
      // Something listens on a port that isn't one of the task's previews: it never sees a connection.
      let reachedHolder = 0;
      const holder = createServer((socket) => {
        reachedHolder += 1;
        socket.end();
      });
      holders.push(holder);
      const unlisted = await freePort();
      await new Promise<void>((resolve) => holder.listen(unlisted, "localhost", resolve));
      const keyProxyPort = Number(new URL(h.launches[0]?.env["FAKE_AGENT_BASE_URL"] ?? "http://localhost:1").port);
      expect(keyProxyPort).toBeGreaterThan(1023);
      for (const port of [unlisted, keyProxyPort, 22, 80, 1023]) {
        expect((await core.connect(viewId, port)).status, `CONNECT ${String(port)}`).toBe(403);
        expect((await core.request(viewId, port, "/")).status, `GET ${String(port)}`).toBe(403);
        expect((await core.websocket(viewId, port, "/")).status, `extended CONNECT ${String(port)}`).toBe(403);
      }
      expect(reachedHolder).toBe(0);
      // The preview's own port is carried on the same tunnel.
      const own = await core.request(viewId, web, "/");
      expect(own.status).toBe(200);
      const refusals = h.logs.filter((record) => record.message === "preview.tunnel-refused").map((record) => record.fields["reason"]);
      expect(refusals).toContain("not-a-preview");
      expect(refusals).toContain("reserved");
      expect(refusals).toContain("below-min");
      expect(viewsOf(h).tunnel(viewId)?.counts.refused).toBe(15);
      // A view of anything but one of the task's previews doesn't open.
      const stray = previewViewIdSchema.parse(`view-stray-${randomBytes(3).toString("hex")}`);
      core.openView(stray, spec.leaseEpoch);
      const refused = h.command("preview.open", { sessionId: spec.sessionId, viewId: stray, key: `port-${String(unlisted)}`, mode: "tunnel", viewport: null });
      expect(await h.waitForAck(refused)).toMatchObject({ result: "rejected", reason: "not-a-preview" });
      expect(core.upgrades.filter((upgrade) => upgrade.viewId === stray)).toEqual([]);
    },

    /**
     * F-141/c5: the box stays past its idle timer while one of its views is open (ADR 0068, "How
     * core holds them"), whatever the clock says; once the last view closes, a box past its time
     * ends at once. A view whose connection core closed holds nothing.
     */
    idleHold: async (): Promise<void> => {
      const timers = manualTimers();
      const { h, core } = await runner(timers);
      const MINUTE = 60_000;
      const { spec, web, viewId } = await openedView(h, core, "app-web", () => h.gateway.waitFor(() => timers.pending() > 0, 60_000));
      expect((await core.request(viewId, web, "/")).status).toBe(200);
      // The idle time (60 minutes here) and more: the session waits on, its box and its view with it.
      timers.advance(90 * MINUTE);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(h.kinds(spec)).not.toContain("session.ended");
      expect(h.host.running()).toHaveLength(1);
      expect((await core.request(viewId, web, "/")).status).toBe(200);
      expect(h.logs.some((record) => record.message.startsWith("the idle timer came due while a preview is open"))).toBe(true);
      // A second view, which core closes: the first still holds the box.
      const second = previewViewIdSchema.parse(`view-held-${randomBytes(3).toString("hex")}`);
      core.openView(second, spec.leaseEpoch);
      expect(await h.waitForAck(h.command("preview.open", { sessionId: spec.sessionId, viewId: second, key: "app-web", mode: "tunnel", viewport: null }))).toMatchObject({ result: "accepted" });
      await core.connection(second);
      core.drop(second);
      await h.gateway.waitFor(() => viewsOf(h).watching() === 1, 10_000);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(h.kinds(spec)).not.toContain("session.ended");
      // The last view closes: the box is past its time, and ends now, as the idle timer would have.
      const connection = await core.connection(viewId);
      expect(await h.waitForAck(h.command("preview.close", { sessionId: spec.sessionId, viewId }))).toMatchObject({ result: "done" });
      await waitFor(h, spec, "session.ended", 1, 60_000);
      expect(await connection.closed).toBe(1000);
      await h.idle();
      // Its app stopped with the box.
      expect(statesOf(h, spec).slice(-2)).toEqual(expect.arrayContaining(["web:stopped", "api:stopped"]));
    },

    /**
     * `preview.close` ends the view's connection with 1000, and the box's way to the port with it:
     * on `docker` the init's forwarder, opened on the view's first stream to the port, is closed.
     * A connection core closes ends the view on the box's side too.
     */
    closes: async (): Promise<void> => {
      const { h, core, reaches } = await runner();
      const { spec, web, viewId } = await openedView(h, core);
      expect((await core.request(viewId, web, "/")).status).toBe(200);
      const before = reaches.length;
      // More streams to the same port reuse the view's way to it: no new forwarder per stream.
      for (let index = 0; index < 3; index += 1) {
        expect((await core.request(viewId, web, "/src/main.jsx")).status).toBe(200);
      }
      expect(reaches.length).toBe(before);
      const forwarders = mode.name === "docker" ? reaches.filter((reach) => reach.host !== "localhost") : [];
      if (mode.name === "docker") {
        // The app's start closed its ready checks' forwards; the view's one is open.
        const open = await Promise.all(forwarders.map((reach) => answersAt(reach.host, reach.port)));
        expect(open.filter(Boolean)).toHaveLength(1);
      } else {
        // The pod's `localhost`, or the machine's: nothing to open or close.
        expect(reaches.every((reach) => reach.host === "localhost")).toBe(true);
      }
      expect(viewsOf(h).watching()).toBe(1);
      const connection = await core.connection(viewId);
      const closed = h.command("preview.close", { sessionId: spec.sessionId, viewId });
      expect(await h.waitForAck(closed)).toMatchObject({ result: "done" });
      expect(await connection.closed).toBe(1000);
      expect(viewsOf(h).watching()).toBe(0);
      if (mode.name === "docker") {
        // The view's forwarder goes with it: nothing in the box takes a connection there now.
        const deadline = Date.now() + 10_000;
        let open = await Promise.all(forwarders.map((reach) => answersAt(reach.host, reach.port)));
        while (open.some(Boolean) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          open = await Promise.all(forwarders.map((reach) => answersAt(reach.host, reach.port)));
        }
        expect(open.filter(Boolean)).toEqual([]);
      }
      // Closed again: nothing to close, and that's done too.
      expect(await h.waitForAck(h.command("preview.close", { sessionId: spec.sessionId, viewId }))).toMatchObject({ result: "done", reason: "unknown-view" });

      // A second view, whose connection core closes: the box forgets it.
      const second = previewViewIdSchema.parse(`view-second-${randomBytes(3).toString("hex")}`);
      core.openView(second, spec.leaseEpoch);
      expect(await h.waitForAck(h.command("preview.open", { sessionId: spec.sessionId, viewId: second, key: "app-web", mode: "tunnel", viewport: null }))).toMatchObject({ result: "accepted" });
      expect((await core.request(second, web, "/")).status).toBe(200);
      core.drop(second);
      await h.gateway.waitFor(() => viewsOf(h).watching() === 0, 10_000);
    },
  };
};
