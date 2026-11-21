import { execFile } from "node:child_process";
import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { cpus, release } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium, firefox, type Browser, type BrowserContext, type Page } from "playwright-core";
import { WebSocket } from "ws";
import { z } from "zod";
import { get, previewCookie, tryWebSocket } from "./clients.ts";
import { startChild, stopAll, stopChild, type Child } from "./procs.ts";

// The spike's one run: the API, Vite, Next.js and webpack-dev-server as the box's processes; core; the sidecar
// on core's preview connection in tunnel mode; a panel page; and the checks ticket 08 asks, in Node clients and
// in real browsers. Results go to results/<run>/results.json and run.log. Every child is killed at the end.

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../..", import.meta.url));
const quick = process.argv.includes("--quick");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = path.join(root, "results", stamp);
await mkdir(outDir, { recursive: true });
const logFile = path.join(outDir, "run.log");
const log = async (line: string) => {
  process.stdout.write(`${line}\n`);
  await appendFile(logFile, `${line}\n`);
};
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const ports = { api: 3001, vite: 5173, next: 3002, wds: 8080, wdsAuto: 8081, core: 8800, coreTls: 8443, panel: 3410, panelTls: 3443 };
const local = { vite: 15173, next: 13002, wds: 18080, wdsAuto: 18081 };
const core = `http://127.0.0.1:${String(ports.core)}`;
const results: Record<string, unknown> = { stamp, quick };
const checks: { name: string; pass: boolean; detail: unknown }[] = [];
const check = async (name: string, pass: boolean, detail: unknown) => {
  checks.push({ name, pass, detail });
  await log(`${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`);
};

// --- certificates for the TLS listeners (self-signed, made per checkout, never committed) ------------------------

const certDir = path.join(root, ".certs");
await mkdir(certDir, { recursive: true });
const certFile = path.join(certDir, "cert.pem");
const keyFile = path.join(certDir, "key.pem");
try {
  await access(certFile);
} catch {
  const openssl = process.env["SPIKE_OPENSSL"] ?? "openssl";
  await execFileAsync(openssl, [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyFile,
    "-out",
    certFile,
    "-days",
    "7",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,DNS:*.localhost,DNS:*.preview.localhost,DNS:*.preview.ostra.localhost,DNS:ostra.localhost,DNS:*.preview.example.test",
  ]);
}

// --- the box's processes, core and the sidecar ----------------------------------------------------------------

const env = { SPIKE_API_PORT: String(ports.api), SPIKE_VITE_PORT: String(ports.vite), SPIKE_WDS_PORT: String(ports.wds), NEXT_TELEMETRY_DISABLED: "1" };
const api = startChild("api", ["apps/api/main.ts"], { cwd: root, env, log: path.join(outDir, "api.log"), readyText: "api listening" });
const viteChild = startChild("vite", ["node_modules/vite/bin/vite.js", "--config", "apps/vite/vite.config.ts"], { cwd: root, env, log: path.join(outDir, "vite.log") });
const nextChild = startChild("next", ["node_modules/next/dist/bin/next", "dev", "apps/next", "--port", String(ports.next)], { cwd: root, env, log: path.join(outDir, "next.log") });
const wds = startChild("wds", ["src/servers/wds.ts"], { cwd: root, env, log: path.join(outDir, "wds.log"), readyText: "wds listening" });
const wdsAuto = startChild("wds-auto", ["src/servers/wds.ts"], { cwd: root, env: { ...env, SPIKE_WDS_PORT: String(ports.wdsAuto), SPIKE_WDS_AUTO_URL: "1" }, log: path.join(outDir, "wds-auto.log"), readyText: "wds listening" });
// The panel's origins, which a preview may be framed by (frame-ancestors): localhost for the cross-site layout,
// ostra.localhost for the same-site one (previews under preview.ostra.localhost).
const panelOrigins = [`http://localhost:${String(ports.panel)}`, `https://localhost:${String(ports.panelTls)}`, `http://ostra.localhost:${String(ports.panel)}`, `https://ostra.localhost:${String(ports.panelTls)}`];
const coreChild = startChild("core", ["src/tunnel/core.ts", "--port", String(ports.core), "--tls-port", String(ports.coreTls), "--cert", certFile, "--key", keyFile, "--panel", panelOrigins.join(",")], {
  cwd: root,
  log: path.join(outDir, "core.log"),
  readyText: "(tls)",
});
await Promise.all([api.ready, wds.ready, wdsAuto.ready, coreChild.ready]);
await log(`started vite ${String(viteChild.pid)}, next ${String(nextChild.pid)}`);

const waitFor = async (what: string, check: () => Promise<boolean>, timeoutMs = 60_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (await check()) return;
    } catch {
      // not yet
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
};
await waitFor("vite", async () => (await fetch(`http://localhost:${String(ports.vite)}/`)).ok);
await waitFor("next", async () => (await fetch(`http://localhost:${String(ports.next)}/`)).ok, 180_000);

const startSidecar = async (forwarder: boolean): Promise<Child> => {
  const extra = forwarder ? ["--forwarder", "127.0.0.3", "--forwarder-from", "127.0.0.2"] : [];
  const allow = [ports.vite, ports.next, ports.wds, ports.wdsAuto, ports.api].join(",");
  const child = startChild("sidecar", ["src/tunnel/sidecar.ts", "--core", `ws://127.0.0.1:${String(ports.core)}`, "--allow", allow, ...extra], {
    cwd: root,
    log: path.join(outDir, forwarder ? "sidecar-forwarder.log" : "sidecar.log"),
    readyText: "sidecar tunnel open",
  });
  await child.ready;
  await waitFor("the box session", async () => z.looseObject({ boxes: z.number() }).parse(await (await fetch(`${core}/control/stats`)).json()).boxes > 0);
  return child;
};
let sidecar = await startSidecar(false);

const versions = async () => {
  const read = async (name: string) => z.looseObject({ version: z.string() }).parse(JSON.parse(await readFile(path.join(root, "node_modules", name, "package.json"), "utf8"))).version;
  return { vite: await read("vite"), next: await read("next"), webpack: await read("webpack"), webpackDevServer: await read("webpack-dev-server"), ws: await read("ws"), playwright: await read("playwright-core") };
};
const { stdout: bindings } = await execFileAsync("powershell.exe", [
  "-NoProfile",
  "-Command",
  `Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in ${[ports.api, ports.vite, ports.next, ports.wds].join(",")} } | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort)" }`,
]);
results["machine"] = { cpu: cpus()[0]?.model ?? "unknown", os: `Windows ${release()}`, node: process.version, versions: await versions(), devServerBindings: bindings.trim().split(/\r?\n/) };
await log(`machine ${JSON.stringify(results["machine"])}`);

// The panel's page: a frame of the preview, with the sandbox ADR 0068 names.
const panelPage = (request: IncomingMessage, response: ServerResponse) => {
  const url = new URL(request.url ?? "/", "http://panel");
  const src = url.searchParams.get("src") ?? "about:blank";
  const sandbox = url.searchParams.get("sandbox") ?? "allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads";
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><title>pane</title><iframe id="preview" src="${src.replace(/"/g, "&quot;")}" sandbox="${sandbox}" width="1000" height="700"></iframe>`);
};
const panel = createHttpServer(panelPage).listen(ports.panel, "127.0.0.1");
const panelTls = createHttpsServer({ cert: await readFile(certFile), key: await readFile(keyFile) }, panelPage).listen(ports.panelTls, "127.0.0.1");

const code = async (port: number, previewId: string, layout: "cross-site" | "same-site") =>
  z.strictObject({ code: z.string() }).parse(await (await fetch(`${core}/control/code`, { method: "POST", body: JSON.stringify({ port, previewId, layout }) })).json()).code;
const ticket = async (port: number) => z.strictObject({ ticket: z.string() }).parse(await (await fetch(`${core}/control/ticket`, { method: "POST", body: JSON.stringify({ port }) })).json()).ticket;

const startCli = async (port: number, localPort: number): Promise<Child> => {
  const child = startChild(`cli-${String(port)}`, ["src/tunnel/cli.ts", "--core", `ws://127.0.0.1:${String(ports.core)}`, "--ticket", await ticket(port), "--port", String(port), "--local", String(localPort)], {
    cwd: root,
    log: path.join(outDir, `cli-${String(port)}.log`),
    readyText: "forwarding",
  });
  await child.ready;
  return child;
};

// --- the HMR edit, and the browsers ---------------------------------------------------------------------------

const servers = {
  vite: { port: ports.vite, file: path.join(root, "apps/vite/src/message.ts"), word: "vite" },
  next: { port: ports.next, file: path.join(root, "apps/next/app/message.ts"), word: "next" },
  wds: { port: ports.wds, file: path.join(root, "apps/wds/src/message.js"), word: "wds" },
  // The same app, with client.webSocketURL "auto://0.0.0.0:0/ws".
  wdsAuto: { port: ports.wdsAuto, file: path.join(root, "apps/wds/src/message.js"), word: "wds" },
} as const;
type ServerName = keyof typeof servers;
const messageSource = (server: ServerName, version: string) => `export const message = "${servers[server].word} message ${version}";\n`;
const resetSources = async () => {
  for (const server of ["vite", "next", "wds"] as const) await writeFile(servers[server].file, messageSource(server, "v1"));
};
await resetSources();

const textIs = (page: Page, text: string, timeout = 30_000) =>
  page.waitForFunction((expected) => document.querySelector("#message")?.textContent === expected, text, { timeout });

// Each edit writes a version never written before, so a watcher that merged two quick writes can't leave a
// page showing an older text than the test expects. The sources go back to v1 when the run ends.
let edits = 1;
const hmr = async (page: Page, server: ServerName) => {
  const prefix = `${servers[server].word} message `;
  await page.waitForFunction((start) => (document.querySelector("#message")?.textContent ?? "").startsWith(start), prefix, { timeout: 30_000 });
  await page.evaluate(() => Reflect.set(window, "__kept", "kept"));
  edits += 1;
  const version = `v${String(edits)}`;
  const started = Date.now();
  await writeFile(servers[server].file, messageSource(server, version));
  let updated = true;
  try {
    await textIs(page, `${prefix}${version}`);
  } catch {
    updated = false;
  }
  const ms = Date.now() - started;
  const kept = await page.evaluate(() => Reflect.get(window, "__kept") === "kept");
  await sleep(500);
  return { updated, ms, reloaded: !kept };
};

// Playwright's Firefox turns first-party cookie partitioning and CHIPS off (its playwright.cfg sets
// network.cookie.cookieBehavior 4 and network.cookie.CHIPS.enabled false). "firefox-tcp" puts back release
// Firefox's Total Cookie Protection (cookieBehavior 5) and asks for CHIPS.
const launch = async (kind: "chrome" | "edge" | "firefox" | "firefox-tcp", extraArgs: string[] = []): Promise<Browser> => {
  if (kind === "firefox") return firefox.launch({ headless: true });
  if (kind === "firefox-tcp") return firefox.launch({ headless: true, firefoxUserPrefs: { "network.cookie.cookieBehavior": 5, "network.cookie.CHIPS.enabled": true } });
  if (kind === "edge") return chromium.launch({ channel: "msedge", headless: true, args: extraArgs });
  return chromium.launch({ channel: "chromium", headless: true, args: extraArgs });
};

const openApp = async (context: BrowserContext, url: string, consoleLines: string[], wsHosts: string[] = []) => {
  const page = await context.newPage();
  page.on("console", (message) => consoleLines.push(message.text()));
  page.on("websocket", (socket) => {
    consoleLines.push(`[ws open] ${new URL(socket.url()).host}${new URL(socket.url()).pathname}`);
    wsHosts.push(new URL(socket.url()).host);
    socket.on("framereceived", (frame) => consoleLines.push(`[ws in] ${String(frame.payload).slice(0, 60)}`));
    socket.on("close", () => consoleLines.push("[ws closed]"));
  });
  const response = await page.goto(url, { waitUntil: "load", timeout: 60_000 });
  return { page, status: response?.status() ?? 0 };
};

try {
  // A. Node clients through the tunnel: the rewrite, the host checks, X-Forwarded-Host, Location and framing.
  await log("\n== A. headers through the tunnel (Node clients) ==");
  const example = (port: number, id: string) => `${String(port)}-${id}.preview.example.test:${String(ports.core)}`;
  const localhostHost = (port: number, id: string) => `${String(port)}-${id}.preview.localhost:${String(ports.core)}`;
  const viaCore = async (host: string, pathName: string, previewId: string, port: number, headers: Record<string, string> = {}) =>
    get(`${core}${pathName}`, { host, cookie: await previewCookie(core, host, port, previewId), ...headers });

  const viteOn = await viaCore(example(ports.vite, "p1"), "/", "p1", ports.vite);
  const viteOff = await viaCore(example(ports.vite, "p2"), "/", "p2", ports.vite);
  await check("vite: page through the tunnel, rewrite on, non-localhost domain", viteOn.status === 200 && viteOn.body.includes("/@vite/client"), { status: viteOn.status });
  await check("vite: rewrite off on a non-localhost domain is blocked by Vite's host check", viteOff.status === 403 && viteOff.body.includes("Blocked request"), { status: viteOff.status, body: viteOff.body.slice(0, 120) });
  const viteOffLocal = await viaCore(localhostHost(ports.vite, "p2"), "/", "p2", ports.vite);
  await check("vite: rewrite off on *.preview.localhost passes (Vite allows .localhost)", viteOffLocal.status === 200, { status: viteOffLocal.status });

  const wdsOn = await viaCore(example(ports.wds, "p1"), "/", "p1", ports.wds);
  const wdsOff = await viaCore(example(ports.wds, "p2"), "/", "p2", ports.wds);
  await check("webpack-dev-server: page through the tunnel, rewrite on", wdsOn.status === 200 && wdsOn.body.includes("main.js"), { status: wdsOn.status });
  await check("webpack-dev-server: rewrite off on a non-localhost domain is refused", wdsOff.status !== 200, { status: wdsOff.status, body: wdsOff.body.slice(0, 80) });

  const nextOn = await viaCore(example(ports.next, "p1"), "/", "p1", ports.next);
  await check("next: page through the tunnel, rewrite on", nextOn.status === 200 && nextOn.body.includes("next message v1"), { status: nextOn.status });

  const echoOn = await viaCore(example(ports.vite, "p1"), "/__echo", "p1", ports.vite);
  const echoOff = await viaCore(localhostHost(ports.vite, "p2"), "/__echo", "p2", ports.vite);
  const echoSchema = z.looseObject({ headers: z.record(z.string(), z.unknown()) });
  const onHeaders = echoSchema.parse(JSON.parse(echoOn.body)).headers;
  const offHeaders = echoSchema.parse(JSON.parse(echoOff.body)).headers;
  await check("rewrite on: Vite sees Host localhost:5173 and no X-Forwarded-Host", onHeaders["host"] === `localhost:${String(ports.vite)}` && onHeaders["x-forwarded-host"] === undefined, {
    host: onHeaders["host"],
    xfh: onHeaders["x-forwarded-host"],
  });
  await check("rewrite off: X-Forwarded-Host and -Proto reach Vite, Host is the preview host", offHeaders["x-forwarded-host"] === localhostHost(ports.vite, "p2") && offHeaders["host"] === localhostHost(ports.vite, "p2"), {
    host: offHeaders["host"],
    xfh: offHeaders["x-forwarded-host"],
    xfp: offHeaders["x-forwarded-proto"],
  });
  const apiEcho = await viaCore(localhostHost(ports.vite, "p2"), "/api/echo", "p2", ports.vite);
  const apiHeaders = echoSchema.parse(JSON.parse(apiEcho.body)).headers;
  await check("rewrite off: X-Forwarded-Host reaches the API behind Vite's proxy", apiHeaders["x-forwarded-host"] === localhostHost(ports.vite, "p2"), { xfh: apiHeaders["x-forwarded-host"], host: apiHeaders["host"] });
  const nextEcho = await viaCore(example(ports.next, "p2"), "/api/echo", "p2", ports.next);
  const nextHeaders = echoSchema.parse(JSON.parse(nextEcho.body)).headers;
  await check("rewrite off: X-Forwarded-Host reaches a Next.js route handler", nextHeaders["x-forwarded-host"] === example(ports.next, "p2"), { status: nextEcho.status, xfh: nextHeaders["x-forwarded-host"] });
  await check("cookie: core strips its own cookie and the client's X-Forwarded-*", !JSON.stringify(onHeaders["cookie"] ?? "").includes("__Host-ostra-preview"), { cookie: onHeaders["cookie"] ?? null });
  const forged = await viaCore(example(ports.vite, "p1"), "/__echo", "p1", ports.vite, { "x-forwarded-host": "evil.example" });
  await check("cookie: a client's own X-Forwarded-Host never reaches the app", echoSchema.parse(JSON.parse(forged.body)).headers["x-forwarded-host"] === undefined, {});

  const home = await viaCore(example(ports.vite, "p1"), "/go-home", "p1", ports.vite);
  await check("rewrite: a Location of http://localhost:5173 comes back as the preview host", home.headers.location === `http://${example(ports.vite, "p1")}/`, { location: home.headers.location });
  const xfo = await viaCore(example(ports.vite, "p1"), "/xfo", "p1", ports.vite);
  await check("framing: X-Frame-Options removed, frame-ancestors replaced by the panel's origins", xfo.headers["x-frame-options"] === undefined && String(xfo.headers["content-security-policy"]).includes(`frame-ancestors http://localhost:${String(ports.panel)}`), {
    xfo: xfo.headers["x-frame-options"] ?? null,
    csp: xfo.headers["content-security-policy"],
  });
  const noCookie = await get(`${core}/`, { host: example(ports.vite, "p1") });
  await check("cookie: a request without the preview cookie gets nothing of the app", noCookie.status === 401, { status: noCookie.status });
  const firstCode = await code(ports.vite, "p1", "cross-site");
  const used = await get(`${core}/.ostra/enter?code=${firstCode}`, { host: example(ports.vite, "p1") });
  const reused = await get(`${core}/.ostra/enter?code=${firstCode}`, { host: example(ports.vite, "p1") });
  const wrongHost = await get(`${core}/.ostra/enter?code=${await code(ports.vite, "p1", "cross-site")}`, { host: example(ports.next, "p1") });
  await check("cookie: a code works once, and only on its own preview host", used.status === 302 && reused.status === 403 && wrongHost.status === 403, { used: used.status, reused: reused.status, wrongHost: wrongHost.status, setCookie: used.headers["set-cookie"]?.[0]?.replace(/=[^;]+/, "=…") });

  // The WebSocket checks: Vite's HMR token, Next.js's origin checks and the Origin: null case, and core's own.
  await log("\n== A. WebSockets: extended CONNECT, Vite's token, Next.js's origin checks ==");
  const clientJs = await viaCore(example(ports.vite, "p1"), "/@vite/client", "p1", ports.vite);
  const wsToken = /const wsToken = "([^"]+)"/.exec(clientJs.body)?.[1] ?? "";
  const tunnelWs = async (host: string, pathName: string, previewId: string, port: number, origin: string | null, protocols: string[] = []) => {
    const headers: Record<string, string> = { host, cookie: await previewCookie(core, host, port, previewId) };
    if (origin !== null) headers["origin"] = origin;
    return tryWebSocket(`ws://127.0.0.1:${String(ports.core)}${pathName}`, headers, protocols);
  };
  const viteHost = example(ports.vite, "p1");
  await check("vite HMR socket through the tunnel (extended CONNECT), with its token", (await tunnelWs(viteHost, `/?token=${wsToken}`, "p1", ports.vite, `http://${viteHost}`, ["vite-hmr"])).opened, { token: wsToken.length > 0 });
  const viteNoToken = await tunnelWs(viteHost, "/", "p1", ports.vite, `http://${viteHost}`, ["vite-hmr"]);
  await check("vite HMR socket without the token is refused by Vite through the tunnel", !viteNoToken.opened, viteNoToken);
  const echoWs = await tunnelWs(viteHost, "/api/ws", "p1", ports.vite, `http://${viteHost}`);
  await check("a WebSocket behind Vite's proxy (ws: true) through the tunnel", echoWs.opened, echoWs);
  const coreRefusesOrigin = await tunnelWs(viteHost, `/?token=${wsToken}`, "p1", ports.vite, "http://evil.example", ["vite-hmr"]);
  await check("core refuses a WebSocket whose Origin isn't the preview's own host", !coreRefusesOrigin.opened && coreRefusesOrigin.status === 403, coreRefusesOrigin);
  const coreRefusesNull = await tunnelWs(viteHost, `/?token=${wsToken}`, "p1", ports.vite, "null", ["vite-hmr"]);
  await check("core refuses Origin: null on a WebSocket", !coreRefusesNull.opened, coreRefusesNull);

  const nextHost = example(ports.next, "p1");
  const nextHostOff = example(ports.next, "p2");
  await check("next HMR socket /_next/hmr through the tunnel, rewrite on", (await tunnelWs(nextHost, "/_next/hmr", "p1", ports.next, `http://${nextHost}`)).opened, {});
  const nextOff = await tunnelWs(nextHostOff, "/_next/hmr", "p2", ports.next, `http://${nextHostOff}`);
  await check("next HMR socket with the rewrite off, non-localhost origin: blocked by allowedDevOrigins", !nextOff.opened, nextOff);
  const nextDirectNull = await tryWebSocket(`ws://localhost:${String(ports.next)}/_next/hmr`, { origin: "null" });
  const nextDirectLocal = await tryWebSocket(`ws://localhost:${String(ports.next)}/_next/hmr`, { origin: `http://localhost:${String(ports.next)}` });
  const nextDirectPreviewLocalhost = await tryWebSocket(`ws://localhost:${String(ports.next)}/_next/hmr`, { origin: `http://${localhostHost(ports.next, "p2")}` });
  await check("next (direct): Origin: null on the HMR socket is refused", !nextDirectNull.opened, nextDirectNull);
  await check("next (direct): Origin localhost and *.localhost are allowed by default", nextDirectLocal.opened && nextDirectPreviewLocalhost.opened, { localhost: nextDirectLocal, previewLocalhost: nextDirectPreviewLocalhost });
  const nextChunk = /\/_next\/static\/[^"']+\.js/.exec(nextOn.body)?.[0] ?? "/_next/static/chunks/webpack.js";
  const assetNull = await get(`http://localhost:${String(ports.next)}${nextChunk}`, { origin: "null" });
  const assetCrossSite = await get(`http://localhost:${String(ports.next)}${nextChunk}`, { "sec-fetch-mode": "no-cors", "sec-fetch-site": "cross-site", referer: "http://evil.example/" });
  const assetOk = await get(`http://localhost:${String(ports.next)}${nextChunk}`, {});
  await check("next (direct): a dev asset with Origin: null, or a cross-site no-cors load, is refused", assetNull.status === 403 && assetCrossSite.status === 403 && assetOk.status === 200, {
    asset: nextChunk,
    originNull: assetNull.status,
    crossSite: assetCrossSite.status,
    plain: assetOk.status,
  });
  const wdsHost = example(ports.wds, "p1");
  await check("webpack-dev-server HMR socket /ws through the tunnel", (await tunnelWs(wdsHost, "/ws", "p1", ports.wds, `http://${wdsHost}`)).opened, {});

  // C. The local forward (ostra preview): a WebSocket and HTTP at once over one tunnel.
  await log("\n== C. the local forward (CONNECT streams) ==");
  const cliVite = await startCli(ports.vite, local.vite);
  const echoSocket = new WebSocket(`ws://localhost:${String(local.vite)}/api/ws`);
  await new Promise<void>((resolve, reject) => {
    echoSocket.once("open", () => {
      resolve();
    });
    echoSocket.once("error", reject);
  });
  const echoes: string[] = [];
  echoSocket.on("message", (data: Buffer) => echoes.push(data.toString("utf8")));
  const concurrentStarted = Date.now();
  const sends = (async () => {
    for (let index = 0; index < 50; index += 1) {
      echoSocket.send(`m${String(index)}`);
      await sleep(10);
    }
  })();
  const fetches = await Promise.all([
    ...Array.from({ length: 20 }, () => fetch(`http://localhost:${String(local.vite)}/api/hello`).then((response) => response.status)),
    ...Array.from({ length: 3 }, () => fetch(`http://localhost:${String(local.vite)}/api/big`).then(async (response) => (await response.arrayBuffer()).byteLength)),
  ]);
  await sends;
  await waitFor("50 echoes", () => Promise.resolve(echoes.length >= 50), 10_000).catch(() => undefined);
  echoSocket.close();
  const hmrSocket = await tryWebSocket(`ws://localhost:${String(local.vite)}/?token=${wsToken}`, { origin: `http://localhost:${String(local.vite)}` }, ["vite-hmr"]);
  await check("local forward: a WebSocket and HTTP requests at once over one tunnel", echoes.length === 50 && fetches.slice(0, 20).every((status) => status === 200) && fetches.slice(20).every((size) => size === 2 * 1024 * 1024), {
    echoes: echoes.length,
    inOrder: echoes.every((value, index) => value === `m${String(index)}`),
    httpOk: fetches.slice(0, 20).filter((status) => status === 200).length,
    bigBytes: fetches.slice(20),
    ms: Date.now() - concurrentStarted,
  });
  await check("local forward: Vite's HMR socket on the member's localhost", hmrSocket.opened, hmrSocket);
  const reusedTicket = await tryWebSocket(`ws://127.0.0.1:${String(ports.core)}/cli/v1/tunnel?ticket=used-or-made-up`, {});
  await check("CLI tunnel: an unknown or used ticket is refused", !reusedTicket.opened, reusedTicket);
  const cliNext = await startCli(ports.next, local.next);
  const cliWds = await startCli(ports.wds, local.wds);
  const cliWdsAuto = await startCli(ports.wdsAuto, local.wdsAuto);

  // B. Real browsers: each dev server's page and its HMR, direct, through the tunnel and through the forward.
  await log("\n== B. pages and HMR in a browser ==");
  const chrome = await launch("chrome", [`--host-resolver-rules=MAP *.preview.example.test 127.0.0.1`]);
  results["chromeVersion"] = chrome.version();
  const hmrResults: unknown[] = [];
  for (const server of ["vite", "next", "wds", "wdsAuto"] as const) {
    const { port } = servers[server];
    const routes: { route: string; url: string; enter?: string }[] = [
      { route: "direct", url: `http://localhost:${String(port)}/` },
      // A real preview domain is HTTPS (a __Host- cookie needs a secure origin), and isn't under .localhost.
      { route: "tunnel (https, rewrite on, preview.example.test)", url: "", enter: `https://${String(port)}-p1.preview.example.test:${String(ports.coreTls)}/.ostra/enter?code=` },
      { route: "tunnel (http, rewrite on, preview.localhost)", url: "", enter: `http://${localhostHost(port, "p1")}/.ostra/enter?code=` },
      { route: "local forward (ostra preview)", url: `http://localhost:${String(local[server])}/` },
    ];
    for (const route of routes) {
      const context = await chrome.newContext({ ignoreHTTPSErrors: true });
      const lines: string[] = [];
      const wsHosts: string[] = [];
      const name = `${server} via ${route.route}: page loads${server === "vite" ? " and /api answers" : ""}, an edit hot-updates it without a reload`;
      try {
        const target = route.enter === undefined ? route.url : `${route.enter}${await code(port, "p1", "cross-site")}`;
        const { page, status } = await openApp(context, target, lines, wsHosts);
        const api = server === "vite" ? await page.waitForFunction(() => (document.querySelector("#api")?.textContent ?? "").startsWith("api: ok"), undefined, { timeout: 20_000 }).then(() => true, () => false) : null;
        const result = await hmr(page, server);
        // The HMR socket must go where the page came from: one that dials the dev server's own host and port
        // bypasses the tunnel, and only works here because the "box" is this machine.
        const pageHost = new URL(page.url()).host;
        const bypassed = [...new Set(wsHosts.filter((host) => host !== pageHost))];
        hmrResults.push({ server, route: route.route, status, api, pageHost, bypassed, ...result });
        await check(name, status === 200 && api !== false && result.updated && !result.reloaded && bypassed.length === 0, { status, api, pageHost, bypassed, ...result, ...(result.updated ? {} : { console: lines.slice(-12) }) });
      } catch (error) {
        const pages = context.pages();
        const body = pages[0] === undefined ? "" : await pages[0].content().catch(() => "");
        await check(name, false, { error: error instanceof Error ? (error.message.split("\n")[0] ?? "") : "failed", body: body.slice(0, 200), console: lines.slice(-5) });
      }
      await context.close();
    }
  }
  results["hmr"] = hmrResults;

  // G. The cost: a cold load of the Vite app direct, through the tunnel, and through the local forward.
  await log("\n== G. a cold page load of the Vite app ==");
  const loads: Record<string, { loadMs: number[]; readyMs: number[]; requests: number[]; kb: number[] }> = {};
  const rounds = quick ? 2 : 9;
  const routes = [
    { name: "direct", url: `http://localhost:${String(ports.vite)}/`, tunnel: false },
    { name: "tunnel", url: `http://${localhostHost(ports.vite, "p1")}/`, tunnel: true },
    { name: "local forward", url: `http://localhost:${String(local.vite)}/`, tunnel: false },
  ];
  for (let round = 0; round < rounds; round += 1) {
    for (const route of routes) {
      const context = await chrome.newContext();
      if (route.tunnel) {
        const warm = await context.newPage();
        await warm.goto(`http://${localhostHost(ports.vite, "p1")}/.ostra/enter?code=${await code(ports.vite, "p1", "cross-site")}&next=/.ostra/ok`);
        await warm.close();
      }
      const page = await context.newPage();
      let requests = 0;
      let bytes = 0;
      page.on("requestfinished", (request) => {
        requests += 1;
        void request
          .sizes()
          .then((sizes) => {
            bytes += sizes.responseBodySize + sizes.responseHeadersSize;
          })
          .catch(() => undefined);
      });
      const started = Date.now();
      await page.goto(route.url, { waitUntil: "load" });
      const loadMs = Date.now() - started;
      await page.waitForFunction(() => (document.querySelector("#api")?.textContent ?? "").startsWith("api: ok"));
      const readyMs = Date.now() - started;
      await sleep(300);
      const entry = (loads[route.name] ??= { loadMs: [], readyMs: [], requests: [], kb: [] });
      if (round > 0) {
        entry.loadMs.push(loadMs);
        entry.readyMs.push(readyMs);
        entry.requests.push(requests);
        entry.kb.push(Math.round(bytes / 1024));
      }
      await context.close();
    }
  }
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  };
  const loadSummary = Object.fromEntries(
    Object.entries(loads).map(([name, entry]) => [name, { loadMsMedian: median(entry.loadMs), readyMsMedian: median(entry.readyMs), loadMs: entry.loadMs, requests: median(entry.requests), kb: median(entry.kb) }]),
  );
  results["pageLoad"] = loadSummary;
  await log(`page load ${JSON.stringify(loadSummary)}`);
  await chrome.close();

  // E and F. The preview cookie in a cross-site frame and top-level, and *.localhost, in each browser.
  await log("\n== E, F. the partitioned cookie and *.localhost in each browser ==");
  const cookieResults: unknown[] = [];
  for (const kind of ["chrome", "edge", "firefox", "firefox-tcp"] as const) {
    let browser: Browser;
    try {
      browser = await launch(kind);
    } catch (error) {
      await check(`${kind}: launch`, false, { error: error instanceof Error ? error.message.slice(0, 200) : "failed" });
      continue;
    }
    const version = browser.version();
    for (const scheme of ["http", "https"] as const) {
      const corePort = scheme === "http" ? ports.core : ports.coreTls;
      const panelPort = scheme === "http" ? ports.panel : ports.panelTls;
      for (const layout of ["cross-site", "same-site"] as const) {
        const previewHost = layout === "cross-site" ? `5173-p1.preview.localhost:${String(corePort)}` : `5173-p1.preview.ostra.localhost:${String(corePort)}`;
        const panelOrigin = layout === "cross-site" ? `${scheme}://localhost:${String(panelPort)}` : `${scheme}://ostra.localhost:${String(panelPort)}`;
        const context = await browser.newContext({ ignoreHTTPSErrors: true });
        const lines: string[] = [];
        const enter = `${scheme}://${previewHost}/.ostra/enter?code=${await code(ports.vite, "p1", layout)}`;
        const pane = await context.newPage();
        pane.on("console", (message) => lines.push(message.text()));
        let resolved = true;
        try {
          await pane.goto(`${panelOrigin}/pane?src=${encodeURIComponent(enter)}`, { waitUntil: "load", timeout: 30_000 });
        } catch {
          resolved = false;
        }
        const frame = pane.frames().find((candidate) => candidate.url().includes(previewHost));
        let inFrame = "no frame";
        if (frame !== undefined) {
          inFrame = await frame
            .waitForSelector("#message, #no-cookie, #bad-code", { timeout: 20_000 })
            .then(async (handle) => ((await handle.getAttribute("id")) === "message" ? "app" : ((await handle.getAttribute("id")) ?? "unknown")))
            .catch(() => "timeout");
        }
        await sleep(1500);
        const hmrConnected = lines.some((line) => line.includes("[vite] connected"));
        const frameApi = frame === undefined ? false : await frame.waitForFunction(() => (document.querySelector("#api")?.textContent ?? "").startsWith("api: ok"), undefined, { timeout: 10_000 }).then(() => true, () => false);
        const stored = (await context.cookies()).filter((cookie) => cookie.name === "__Host-ostra-preview").map((cookie) => ({ sameSite: cookie.sameSite, secure: cookie.secure, partitionKey: Reflect.get(cookie, "partitionKey") ?? null }));
        // The same host top-level, in a new tab: the frame's partitioned cookie shouldn't apply there.
        const tab = await context.newPage();
        const topBefore = await tab
          .goto(`${scheme}://${previewHost}/`, { timeout: 20_000 })
          .then(async () => ((await tab.$("#message")) !== null ? "app" : (await tab.$("#no-cookie")) !== null ? "no-cookie" : "other"))
          .catch((error: unknown) => `error: ${error instanceof Error ? error.message.split("\n")[0] ?? "" : ""}`);
        const topAfter = await tab
          .goto(`${scheme}://${previewHost}/.ostra/enter?code=${await code(ports.vite, "p1", layout)}`, { timeout: 20_000 })
          .then(() => tab.waitForSelector("#message, #no-cookie", { timeout: 15_000 }))
          .then(async (handle) => ((await handle.getAttribute("id")) === "message" ? "app" : "no-cookie"))
          .catch((error: unknown) => `error: ${error instanceof Error ? error.message.split("\n")[0] ?? "" : ""}`);
        const result = { browser: kind, version, scheme, layout, panelOrigin, previewHost, resolved, inFrame, frameApi, hmrConnected, stored, topLevelBeforeHandshake: topBefore, topLevelAfterHandshake: topAfter };
        cookieResults.push(result);
        await check(
          `${kind} ${scheme} ${layout}: cookie holds in the frame (app, /api, HMR), and a new tab needs its own handshake`,
          inFrame === "app" && frameApi && hmrConnected && topAfter === "app" && (layout === "same-site" || topBefore === "no-cookie"),
          result,
        );
        await context.close();
      }
    }
    await browser.close();
  }
  results["cookies"] = cookieResults;

  // frame-ancestors: a page on an origin that isn't the panel's can't frame the preview.
  {
    const browser = await launch("chrome");
    const context = await browser.newContext();
    const pane = await context.newPage();
    const enter = `http://${localhostHost(ports.vite, "p1")}/.ostra/enter?code=${await code(ports.vite, "p1", "cross-site")}`;
    await pane.goto(`http://127.0.0.1:${String(ports.panel)}/pane?src=${encodeURIComponent(enter)}`, { waitUntil: "load" });
    await sleep(3000);
    const shown = await Promise.all(pane.frames().map(async (frame) => (await frame.$("#message").catch(() => null)) !== null));
    await check("framing: an origin outside frame-ancestors (127.0.0.1) gets no app in its frame", !shown.some(Boolean), { frames: pane.frames().map((frame) => frame.url().slice(0, 60)) });
    await browser.close();
  }
  results["enterRequests"] = z.looseObject({}).parse(await (await fetch(`${core}/control/stats`)).json());

  // D. The docker forwarder's logic on loopback aliases: the sidecar reaches the app only through it.
  await log("\n== D. the forwarder (logic only: loopback aliases, no container) ==");
  await stopChild(sidecar);
  await sleep(1000);
  const forwarder = startChild("forwarder", ["src/tunnel/forwarder.ts", "--ports", [ports.vite, ports.next, ports.wds, ports.wdsAuto, ports.api].join(",")], { cwd: root, log: path.join(outDir, "forwarder.log"), readyText: "forwarder" });
  await forwarder.ready;
  await sleep(500);
  sidecar = await startSidecar(true);
  const viaForwarder = await viaCore(example(ports.vite, "p1"), "/", "p1", ports.vite);
  const hmrViaForwarder = await tunnelWs(viteHost, `/?token=${wsToken}`, "p1", ports.vite, `http://${viteHost}`, ["vite-hmr"]);
  const fromOther = await new Promise<string>((resolve) => {
    import("node:net")
      .then(({ connect }) => {
        const socket = connect({ host: "127.0.0.3", port: ports.vite + 10000, localAddress: "127.0.0.4" });
        socket.on("data", () => {
          resolve("data");
        });
        socket.on("close", () => {
          resolve("closed by the forwarder");
        });
        socket.on("error", (error) => {
          resolve(`error: ${error.message}`);
        });
        socket.on("connect", () => {
          socket.write("GET / HTTP/1.1\r\nhost: localhost:5173\r\n\r\n");
        });
      })
      .catch(() => {
        resolve("failed");
      });
  });
  await check("forwarder: the page and Vite's HMR socket reach the app through it", viaForwarder.status === 200 && hmrViaForwarder.opened, { page: viaForwarder.status, hmr: hmrViaForwarder });
  const forwarderLog = await readFile(path.join(outDir, "forwarder.log"), "utf8");
  await check("forwarder: a connection from another address is refused", (fromOther === "closed by the forwarder" || fromOther.includes("ECONNRESET")) && forwarderLog.includes("refused 127.0.0.4"), { fromOther, logged: forwarderLog.includes("refused 127.0.0.4") });
  await stopChild(cliVite);
  await stopChild(cliNext);
  await stopChild(cliWds);
  await stopChild(cliWdsAuto);
} catch (error) {
  results["error"] = error instanceof Error ? (error.stack ?? error.message) : String(error);
  await log(`ERROR ${String(results["error"])}`);
} finally {
  results["checks"] = checks;
  results["passed"] = checks.filter((entry) => entry.pass).length;
  results["failed"] = checks.filter((entry) => !entry.pass).length;
  await writeFile(path.join(outDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  await resetSources();
  panel.close();
  panelTls.close();
  await stopAll();
  await log(`\n${String(results["passed"])} passed, ${String(results["failed"])} failed; results in ${outDir}`);
  process.exit(0);
}
