import { createServer as createHttpServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { connect as netConnect, createServer as createNetServer } from "node:net";
import type { AddressInfo, Server } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  CLI_TUNNEL_SUBPROTOCOL,
  cliPreviewTunnelRefusalWords,
  cliSessionIdSchema,
  cliSessionMessages,
  cliStartAppRefusalSchema,
  cliStartAppRefusalWords,
  cliTunnelCloseCodes,
  cliTunnelCloseWords,
  cliTunnelErrorWords,
} from "@ostra/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { RawData } from "ws";
import { fakePreviewTask, startFakePreviewServer } from "../testing/fake-preview-server.ts";
import type { FakePreviewServer } from "../testing/fake-preview-server.ts";
import { exitCodes, runCli } from "./cli.ts";
import { cliSessionPath, saveCliSession } from "./cli-session.ts";
import { createCapturingTerminal } from "./terminal.ts";
import { testPort } from "@ostra/adapter-sdk/testing/net";

// Ticket 24 (F-143, ADR 0068 "`ostra preview`"): the CLI's command against a fake of the web app's
// two routes and core's tunnel (`testing/fake-preview-server.ts`), which bridges each CONNECT to a
// small app on this machine: a page and a WebSocket echo. The command against the real web app
// route, core's real tunnel and the runner's real side, with the fixture's Vite, is
// `apps/core/src/previews/cli-preview.test.ts`.

let root = "";
let env: Record<string, string | undefined> = {};
let fake: FakePreviewServer;
let app: HttpServer;
let appPort = 0;
let token = "";
const held: Server[] = [];
const sockets: WebSocket[] = [];

const portOf = (server: Server | HttpServer): number => {
  const address: AddressInfo | string | null = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
};

const textOf = (data: RawData): string => (Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)).toString("utf8");

/** Holds a port of this machine's IPv4 loopback, as another program would. */
const hold = (port: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      held.push(server);
      resolve();
    });
  });

/** A preview port of the fake's task, bridged to the app. */
const previewPort = async (): Promise<number> => {
  const port = await testPort();
  fake.dial.set(port, appPort);
  return port;
};

type Run = {
  readonly out: () => string;
  readonly stop: () => void;
  readonly done: Promise<number>;
  readonly asked: string[];
};

const start = (args: readonly string[], options: { readonly answer?: string | null; readonly env?: Record<string, string | undefined>; readonly now?: () => number } = {}): Run => {
  const terminal = createCapturingTerminal();
  const controller = new AbortController();
  const asked: string[] = [];
  const done = runCli(["preview", ...args], {
    env: options.env ?? env,
    terminal,
    signal: controller.signal,
    runSignedIn: () => Promise.resolve(exitCodes.ok),
    runSidecar: () => Promise.resolve(exitCodes.ok),
    local: { sleep: () => Promise.resolve(), startWaitMs: 30_000 },
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.answer === undefined
      ? {}
      : {
          ask: (question: string) => {
            asked.push(question);
            return Promise.resolve(options.answer ?? null);
          },
        }),
  });
  return { out: () => terminal.lines().join(""), stop: () => { controller.abort(); }, done, asked };
};

const waitFor = async (what: string, check: () => boolean, timeoutMs = 15_000): Promise<void> => {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) {
      throw new Error(`waited too long for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** The local port from the line `ostra preview` prints once it serves. */
const servedPort = async (run: Run): Promise<number> => {
  await waitFor("the preview's address", () => /is on http:\/\/localhost:\d+/.test(run.out()));
  return Number(/is on http:\/\/localhost:(\d+)/.exec(run.out())?.[1]);
};

const connects = (host: string, port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = netConnect({ host, port, timeout: 2_000 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });

/** This machine's addresses on other interfaces than loopback, which a listener on every interface would answer on. */
const otherInterfaces = (): readonly string[] =>
  Object.values(os.networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => !entry.internal && !(entry.family === "IPv6" && entry.address.toLowerCase().startsWith("fe80")))
    .map((entry) => entry.address);

const echoOnce = (port: number, text: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/echo`);
    sockets.push(ws);
    ws.once("open", () => {
      ws.send(text);
    });
    ws.once("message", (data) => {
      resolve(textOf(data));
    });
    ws.once("error", reject);
  });

const page = async (port: number): Promise<string> => (await fetch(`http://127.0.0.1:${String(port)}/hello`)).text();

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ostra-cli-preview-"));
  // The member's own config folder, and no proxy: the fake is on this machine.
  const proxies = new Set(["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]);
  env = Object.fromEntries(Object.entries({ ...process.env, APPDATA: path.join(root, "appdata"), XDG_CONFIG_HOME: path.join(root, "xdg") }).filter(([name]) => !proxies.has(name)));
  // The task's app, on this machine: a page and a WebSocket echo.
  app = createHttpServer((request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`hello from the app at ${request.url ?? "/"}`);
  });
  const echo = new WebSocketServer({ server: app, path: "/echo" });
  echo.on("connection", (ws) => {
    ws.on("message", (data) => {
      ws.send(`echo: ${textOf(data)}`);
    });
  });
  await new Promise<void>((resolve) => {
    app.listen(0, "127.0.0.1", resolve);
  });
  appPort = portOf(app);
  fake = await startFakePreviewServer();
  token = fake.addSession();
  await saveCliSession(cliSessionPath(env), { serverUrl: fake.url, sessionId: cliSessionIdSchema.parse("cli-session-1"), token, expiresAt: Date.now() + 86_400_000, username: "demo" });
}, 60_000);

afterEach(() => {
  for (const ws of sockets.splice(0)) {
    ws.terminate();
  }
  for (const server of held.splice(0)) {
    server.close();
  }
  fake.sessions.set(token, "live");
  fake.upgradeRefusals.length = 0;
  fake.boxRefuses.clear();
  fake.coreUrl = fake.url;
});

afterAll(async () => {
  await fake.close();
  app.closeAllConnections();
  app.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("ostra preview (F-143)", () => {
  it("F-143/c2: it carries a local HTTP request and a WebSocket at once through core's tunnel, each as its own CONNECT, and ends cleanly on Ctrl+C", async () => {
    const port = await previewPort();
    fake.tasks.set("OST-12", fakePreviewTask([{ port, label: "Web" }]));
    const run = start(["OST-12"]);
    const local = await servedPort(run);
    expect(run.out()).toContain(`Web (the task's port ${String(port)}) is on http://localhost:${String(local)}`);
    // A WebSocket open while a request goes: each is one local connection, one CONNECT.
    const [echoed, text] = await Promise.all([echoOnce(local, "through the tunnel"), page(local)]);
    expect(echoed).toBe("echo: through the tunnel");
    expect(text).toBe("hello from the app at /hello");
    expect(fake.counts.connects).toBeGreaterThanOrEqual(3);
    // core's tunnel, as the CLI opened it: its subprotocol, and no Origin.
    expect(fake.upgrades.at(-1)).toEqual({ origin: undefined, protocol: CLI_TUNNEL_SUBPROTOCOL, status: 101 });
    // The ticket is a secret: never printed.
    expect(run.out()).not.toContain(fake.tickets.at(-1)?.ticket ?? "no ticket");
    run.stop();
    expect(await run.done).toBe(exitCodes.ok);
    expect(run.out()).toContain("Stopped.");
    await waitFor("the tunnel's close", () => fake.openTunnels() === 0);
    expect(fake.closes.at(-1)).toBe(1000);
    expect(await connects("127.0.0.1", local)).toBe(false);
  }, 30_000);

  it("F-143/c1: it listens on 127.0.0.1 only, on the preview's own port when that's free here, else the next free one, or --local's", async () => {
    const port = await previewPort();
    fake.tasks.set("OST-13", fakePreviewTask([{ port, label: "Web" }]));
    // The preview's own port, free on this machine.
    const own = start(["OST-13"]);
    expect(await servedPort(own)).toBe(port);
    // Loopback only: this machine's other interfaces don't reach it.
    expect(await connects("127.0.0.1", port)).toBe(true);
    for (const address of otherInterfaces()) {
      expect(await connects(address, port), `${address}:${String(port)}`).toBe(false);
    }
    expect(own.out()).toMatch(/cli\.preview-listening address=127\.0\.0\.1 port=\d+/);
    own.stop();
    expect(await own.done).toBe(exitCodes.ok);

    // The preview's port taken on this machine: the next free one, and it says so.
    await hold(port);
    const next = start(["OST-13"]);
    const moved = await servedPort(next);
    expect(moved).not.toBe(port);
    expect(next.out()).toContain(`Port ${String(port)} is taken on this machine, so the preview is on ${String(moved)}.`);
    expect(await page(moved)).toBe("hello from the app at /hello");
    next.stop();
    expect(await next.done).toBe(exitCodes.ok);

    // --local names the port: used when free, refused when taken.
    const chosen = await testPort();
    const named = start(["OST-13", "--local", String(chosen)]);
    expect(await servedPort(named)).toBe(chosen);
    named.stop();
    expect(await named.done).toBe(exitCodes.ok);
    const taken = start(["OST-13", "--local", String(port)]);
    expect(await taken.done).toBe(exitCodes.failed);
    expect(taken.out()).toContain(`ostra preview: port ${String(port)} is in use on this machine. Pick another with --local <port>.`);
  }, 60_000);

  it("F-143/c1: a task the session can't open, and a signed-out or revoked CLI, are refused in the CLI's words", async () => {
    const unknown = start(["OST-404"]);
    expect(await unknown.done).toBe(exitCodes.failed);
    expect(unknown.out()).toContain(`ostra preview: ${cliPreviewTunnelRefusalWords({ code: "not-found" }, null)}`);

    const signedOut = start(["OST-12"], { env: { ...env, APPDATA: path.join(root, "nobody"), XDG_CONFIG_HOME: path.join(root, "nobody") } });
    expect(await signedOut.done).toBe(exitCodes.failed);
    expect(signedOut.out()).toContain(cliSessionMessages["session-missing"]);

    fake.sessions.set(token, "revoked");
    const revoked = start(["OST-12"]);
    expect(await revoked.done).toBe(exitCodes.failed);
    expect(revoked.out()).toContain(`ostra preview: ${cliSessionMessages["session-revoked"]}`);
  });

  it("F-143/c3: a port that isn't one of the task's previews is refused in the CLI's words, at the ticket and by the box", async () => {
    const port = await previewPort();
    fake.tasks.set("OST-14", fakePreviewTask([{ port, label: "Web" }]));
    const ssh = start(["OST-14", "22"]);
    expect(await ssh.done).toBe(exitCodes.failed);
    expect(ssh.out()).toContain("ostra preview: port 22 isn't one of this task's previews");
    expect(fake.tickets.some((ticket) => ticket.port === 22)).toBe(false);
    // The box's list changed while it serves: its 403 closes the connection, and the CLI says why.
    const run = start(["OST-14", String(port)]);
    const local = await servedPort(run);
    fake.boxRefuses.add(port);
    await expect(fetch(`http://127.0.0.1:${String(local)}/`)).rejects.toThrow();
    await waitFor("the box's refusal", () => run.out().includes("the box refused a connection"));
    expect(run.out()).toContain(`ostra preview: the box refused a connection: port ${String(port)} isn't one of this task's previews.`);
    run.stop();
    expect(await run.done).toBe(exitCodes.ok);
  }, 30_000);

  it("F-143/c6: a runner on the HTTP fallback carrier, or below protocol minor 7, is refused in the CLI's words, at the ticket and at core's upgrade", async () => {
    const port = await previewPort();
    fake.tasks.set("OST-15", fakePreviewTask([{ port, label: "Web" }], { refusal: "runner-cannot-tunnel" }));
    const words = cliPreviewTunnelRefusalWords({ code: "runner-cannot-tunnel" }, null);
    expect(words).toContain("over a WebSocket");
    const atTicket = start(["OST-15"]);
    expect(await atTicket.done).toBe(exitCodes.failed);
    expect(atTicket.out()).toContain(`ostra preview: ${words}`);
    // Its runner fell back to HTTP between the ticket and the upgrade: core refuses the tunnel.
    fake.tasks.set("OST-15", fakePreviewTask([{ port, label: "Web" }]));
    fake.upgradeRefusals.push("runner-cannot-tunnel");
    const atUpgrade = start(["OST-15"]);
    expect(await atUpgrade.done).toBe(exitCodes.failed);
    expect(atUpgrade.out()).toContain(`ostra preview: ${cliTunnelErrorWords("runner-cannot-tunnel")}`);
  });

  it("F-143/c4: a used or expired ticket is refused in the CLI's words, and a tunnel its CLI session ended (4401) isn't opened again", async () => {
    const port = await previewPort();
    fake.tasks.set("OST-16", fakePreviewTask([{ port, label: "Web" }]));
    fake.upgradeRefusals.push("ticket-refused");
    const spent = start(["OST-16"]);
    expect(await spent.done).toBe(exitCodes.failed);
    expect(spent.out()).toContain(`ostra preview: ${cliTunnelErrorWords("ticket-refused")}`);

    const run = start(["OST-16"]);
    await servedPort(run);
    const issued = fake.tickets.length;
    fake.endTunnels(cliTunnelCloseCodes["session-ended"]);
    expect(await run.done).toBe(exitCodes.failed);
    expect(run.out()).toContain(`ostra preview: ${cliTunnelCloseWords("session-ended")}`);
    expect(run.out()).not.toContain("Reconnecting");
    expect(fake.tickets.length).toBe(issued);
  }, 30_000);

  it("F-143/c2: a tunnel that drops is opened again with a new ticket, up to three times, and it says so; one whose view closed (4410) isn't", async () => {
    const port = await previewPort();
    fake.tasks.set("OST-17", fakePreviewTask([{ port, label: "Web" }]));
    let clock = Date.now();
    const run = start(["OST-17"], { now: () => clock });
    const local = await servedPort(run);
    // The box's connection dropped (4404): a new ticket, the same local port.
    fake.endTunnels(cliTunnelCloseCodes["box-gone"]);
    await waitFor("the reconnect", () => run.out().includes("Reconnected"));
    expect(run.out()).toContain(cliTunnelCloseWords("box-gone"));
    expect(run.out()).toContain("Reconnecting with a new ticket (1 of 3)...");
    expect(run.out()).toContain(`Reconnected: Web is on http://localhost:${String(local)} again.`);
    expect(await page(local)).toBe("hello from the app at /hello");
    // The network dropped (no close frame), a minute later: three tries again.
    clock += 60_000;
    fake.endTunnels(1006);
    await waitFor("the second reconnect", () => run.out().split("Reconnected:").length === 3);
    expect(run.out()).toContain("The connection to the server dropped.");
    expect(await echoOnce(local, "again")).toBe("echo: again");
    // The server restarts (1001), and core can't reach the box three times running: it gives up.
    clock += 60_000;
    fake.upgradeRefusals.push("not-connected", "not-connected", "not-connected");
    const issued = fake.tickets.length;
    fake.endTunnels(1001);
    expect(await run.done).toBe(exitCodes.failed);
    expect(run.out()).toContain("The server is restarting.");
    expect(run.out()).toContain("Reconnecting with a new ticket (3 of 3)...");
    expect(run.out()).not.toContain("(4 of 3)");
    expect(run.out()).toContain(`ostra preview: couldn't reconnect after 3 tries: ${cliTunnelErrorWords("not-connected")}`);
    expect(fake.tickets.length).toBe(issued + 3);
    expect(await connects("127.0.0.1", local)).toBe(false);

    // The view closed (its box idled out or stopped): its words, and no new ticket.
    const closed = start(["OST-17"]);
    await servedPort(closed);
    const before = fake.tickets.length;
    fake.endTunnels(cliTunnelCloseCodes["view-closed"]);
    expect(await closed.done).toBe(exitCodes.failed);
    expect(closed.out()).toContain(`ostra preview: ${cliTunnelCloseWords("view-closed")}`);
    expect(fake.tickets.length).toBe(before);
  }, 60_000);

  it("F-143/c5: with no box running it offers to start the app, starts it on yes and serves once the box is up; otherwise nothing starts", async () => {
    const port = await previewPort();
    const question = "This task's box isn't running. Start the app? [y/N] ";
    fake.tasks.set("OST-18", fakePreviewTask([{ port, label: "Web" }], { box: "none", bootPolls: 2 }));
    const yes = start(["OST-18"], { answer: "y" });
    const local = await servedPort(yes);
    expect(yes.asked).toEqual([question]);
    expect(yes.out()).toContain("Starting the app. Waiting for its box...");
    expect(fake.requests.filter((request) => request.endsWith("/app/start"))).toEqual(["POST /api/cli/v1/tasks/OST-18/app/start"]);
    expect(await page(local)).toBe("hello from the app at /hello");
    yes.stop();
    expect(await yes.done).toBe(exitCodes.ok);

    // "N", or nobody at the terminal to ask: nothing starts.
    fake.tasks.set("OST-19", fakePreviewTask([{ port, label: "Web" }], { box: "none" }));
    for (const run of [start(["OST-19"], { answer: "n" }), start(["OST-19"], { answer: null }), start(["OST-19"])]) {
      expect(await run.done).toBe(exitCodes.failed);
      expect(run.out()).toContain(`ostra preview: ${cliPreviewTunnelRefusalWords({ code: "no-box" }, null)}`);
    }
    expect(fake.requests.filter((request) => request.includes("OST-19/app/start"))).toEqual([]);

    // Each refusal of the start, in the CLI's words: core out of reach among them.
    for (const code of cliStartAppRefusalSchema.shape.code.options) {
      fake.tasks.set("OST-20", fakePreviewTask([{ port, label: "Web" }], { box: "none", start: { code } }));
      const refused = start(["OST-20"], { answer: "yes" });
      expect(await refused.done).toBe(exitCodes.failed);
      expect(refused.out(), code).toContain(`ostra preview: ${cliStartAppRefusalWords({ code })}`);
    }
  }, 60_000);

  it("refuses a malformed command as a usage error", async () => {
    for (const args of [[], ["OST-12", "web"], ["OST-12", "5173", "5174"], ["OST-12", "--local", "x"]]) {
      const run = start(args);
      expect(await run.done, args.join(" ")).toBe(exitCodes.usage);
    }
  });
});
