import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { SERVER_HOST } from "../certs.ts";
import { runner, waitWelcome, type Ctx } from "../cluster.ts";
import { connectProxy, nginxDefaultsEmulation, realNginx, tlsInspectingProxy, type ProxyStats, type Target, type TcpProxy } from "../net-proxies.ts";
import { num, str } from "../procs.ts";
import { check, skipped, type Check } from "../report.ts";
import { describeVerify, secs, streamOnce } from "./common.ts";

type Setup = {
  readonly serverUrl: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stats: ProxyStats | undefined;
  readonly close: () => Promise<void>;
};

type Case = {
  readonly name: string;
  readonly bar: boolean;
  /** The carrier the runner must end up on, when the network decides it. */
  readonly expectCarrier?: "websocket" | "http";
  /** Undefined when the case can't run here; the string is the missing input. */
  readonly missing?: string;
  readonly setup: () => Promise<Setup>;
};

/** Criterion 1: through each network, the runner connects or falls back to HTTP by itself within 30 s. */
export const networks = async (ctx: Ctx, lb: TcpProxy, tag: string): Promise<Check[]> => {
  const local: Target = { host: "127.0.0.1", port: lb.port };
  const hosts = new Map<string, Target>([[SERVER_HOST, local]]);
  const viaName = `https://${SERVER_HOST}:${String(lb.port)}`;
  const user = `u${randomBytes(3).toString("hex")}`;
  const pass = randomBytes(9).toString("hex");
  const [serverCa, corpLeafCert, corpLeafKey, serverCert, serverKey] = await Promise.all([
    readFile(ctx.certs.serverCa, "utf8"),
    readFile(ctx.certs.corpLeafCert, "utf8"),
    readFile(ctx.certs.corpLeafKey, "utf8"),
    readFile(ctx.certs.serverCert, "utf8"),
    readFile(ctx.certs.serverKey, "utf8"),
  ]);
  const nginxBin = process.env["NGINX_BIN"];

  const cases: Case[] = [
    {
      name: "direct, no proxy (baseline)",
      bar: false,
      setup: () => Promise.resolve({ serverUrl: `https://localhost:${String(lb.port)}`, env: {}, stats: undefined, close: () => Promise.resolve() }),
    },
    {
      name: "CONNECT proxy",
      bar: true,
      setup: async () => {
        const p = await connectProxy(hosts, undefined);
        return { serverUrl: viaName, env: { HTTPS_PROXY: `http://127.0.0.1:${String(p.port)}` }, stats: p.stats, close: p.close };
      },
    },
    {
      name: "CONNECT proxy with Basic auth in HTTPS_PROXY",
      bar: true,
      setup: async () => {
        const p = await connectProxy(hosts, { user, pass });
        return { serverUrl: viaName, env: { HTTPS_PROXY: `http://${user}:${pass}@127.0.0.1:${String(p.port)}` }, stats: p.stats, close: p.close };
      },
    },
    {
      name: "TLS-inspecting proxy that passes WebSockets (own CA via NODE_EXTRA_CA_CERTS)",
      bar: true,
      setup: async () => {
        const p = await tlsInspectingProxy({ hosts, leafCert: corpLeafCert, leafKey: corpLeafKey, upstreamCa: serverCa, blockUpgrades: false, holdFrames: false });
        return { serverUrl: viaName, env: { HTTPS_PROXY: `http://127.0.0.1:${String(p.port)}` }, stats: p.stats, close: p.close };
      },
    },
    {
      name: "TLS-inspecting proxy that blocks WebSockets with an HTML page",
      bar: true,
      expectCarrier: "http",
      setup: async () => {
        const p = await tlsInspectingProxy({ hosts, leafCert: corpLeafCert, leafKey: corpLeafKey, upstreamCa: serverCa, blockUpgrades: true, holdFrames: false });
        return { serverUrl: viaName, env: { HTTPS_PROXY: `http://127.0.0.1:${String(p.port)}` }, stats: p.stats, close: p.close };
      },
    },
    {
      name: "TLS-inspecting proxy that accepts the upgrade and holds frames",
      bar: true,
      expectCarrier: "http",
      setup: async () => {
        const p = await tlsInspectingProxy({ hosts, leafCert: corpLeafCert, leafKey: corpLeafKey, upstreamCa: serverCa, blockUpgrades: false, holdFrames: true });
        return { serverUrl: viaName, env: { HTTPS_PROXY: `http://127.0.0.1:${String(p.port)}` }, stats: p.stats, close: p.close };
      },
    },
    {
      name: "nginx's defaults, emulated (HTTP/1.0 upstream, Upgrade not passed)",
      bar: false,
      expectCarrier: "http",
      setup: async () => {
        const p = await nginxDefaultsEmulation({ upstream: () => local, cert: serverCert, key: serverKey, upstreamCa: serverCa });
        return { serverUrl: `https://localhost:${String(p.port)}`, env: {}, stats: p.stats, close: p.close };
      },
    },
    {
      name: "real nginx with its defaults (proxy_pass only)",
      bar: true,
      ...(nginxBin === undefined || nginxBin.length === 0 ? { missing: "NGINX_BIN (path to an nginx binary)" } : {}),
      setup: async () => {
        const n = await realNginx({
          bin: nginxBin ?? "nginx",
          dir: path.join(ctx.dataDir, "nginx"),
          upstream: local,
          cert: ctx.certs.serverCert,
          key: ctx.certs.serverKey,
        });
        return { serverUrl: `https://localhost:${String(n.port)}`, env: {}, stats: undefined, close: n.close };
      },
    },
  ];

  const checks: Check[] = [];
  let i = 0;
  for (const c of cases) {
    i += 1;
    if (c.missing !== undefined) {
      checks.push(skipped(c.name, `needs ${c.missing}`));
      continue;
    }
    const s = await c.setup();
    const r = runner(ctx, { id: `net-${tag}-${String(i)}`, serverUrl: s.serverUrl, env: s.env, args: ["--events-per-sec=10"] });
    try {
      const startedAt = Date.now();
      const w = await waitWelcome(r.child, 35_000);
      const connectedMs = (num(w, "ts") ?? Number.POSITIVE_INFINITY) - startedAt;
      const carrier = str(w, "carrier") ?? "none";
      const fellBack = r.child.lines.some((l) => l["t"] === "fallback-http");
      const refusedLine = r.child.lines.find((l) => l["t"] === "ws-upgrade-refused");
      const proxyAnswered = refusedLine?.["proxyAnswered"] === true;
      const silent = r.child.lines.some((l) => l["t"] === "ws-silent-after-upgrade");
      const why = refusedLine !== undefined
        ? ` (ws-upgrade-refused: ${String(num(refusedLine, "status") ?? "?")}, ${proxyAnswered ? "a proxy answered" : "the ostra server answered"})`
        : silent
          ? " (the upgrade succeeded, then no welcome came: ws-silent-after-upgrade)"
          : "";
      if (w === undefined) {
        checks.push(check(c.name, false, `no welcome within 35 s`));
        continue;
      }
      const st = await streamOnce(ctx, r, `net-${tag}-${String(i)}`, 3_000);
      const through = s.stats === undefined ? "" : `; proxy saw ${String(s.stats.tunnels)} tunnel(s)${s.stats.inspectedRequests.length > 0 ? `, read ${String(s.stats.inspectedRequests.length)} request(s) in clear` : ""}`;
      const carrierOk = c.expectCarrier === undefined || carrier === c.expectCarrier;
      const held = s.stats !== undefined && s.stats.heldBytes > 0 ? `; proxy swallowed ${String(s.stats.heldBytes)} bytes after the 101` : "";
      const ok =
        carrierOk &&
        connectedMs <= 30_000 &&
        st.verify?.ok === true &&
        st.steerReceived &&
        (s.stats === undefined || s.stats.tunnels > 0 || s.stats.inspectedRequests.length > 0);
      checks.push(
        check(
          c.bar ? c.name : `${c.name} [not the bar]`,
          ok,
          `connected over ${carrier}${c.expectCarrier === undefined ? "" : ` (expected ${c.expectCarrier})`} in ${secs(connectedMs)}${fellBack ? ` after falling back by itself${why}` : ""}; ${describeVerify(st.verify)}; steer ${st.steerReceived ? "received" : "lost"}${through}${held}`,
          { carrier, connectedMs, fellBack, proxyAnswered, verify: st.verify, inspected: s.stats?.inspectedRequests.slice(0, 4) ?? [] },
        ),
      );
    } finally {
      await r.child.kill9();
      await s.close();
    }
  }
  return checks;
};
