// `pnpm dev:net-proxies`: spike 6's networks (ticket 06) in front of the dev stack's core, on
// loopback until Ctrl-C, for the runner's HTTP fallback (F-013, ticket 18): a CONNECT proxy, a
// TLS-inspecting proxy whose mode switches while it runs (`pnpm dev:net-proxies mode pass|block|hold`),
// and nginx's default reverse proxy, emulated. Each reaches core at `127.0.0.1:<OSTRA_CORE_PORT>`,
// as `ostra-core.test` through the proxies. The CONNECT proxy asks for Basic auth, as a corporate one
// does, and tunnels to a TLS front of core that passes the upgrade, so a runner of
// `https://ostra-core.test:<port>` reaches core end to end through it; its `HTTPS_PROXY`, with the
// credentials made at start, is written to `.ostra-dev/net-proxies/connect-proxy-url` and never
// printed. The proxies' CAs are written to `.ostra-dev/net-proxies/ca.pem`, for the runner's
// `NODE_EXTRA_CA_CERTS`. Development and test only.

import { randomBytes } from "node:crypto";
import { request } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { connect as connectTcp } from "node:net";
import type { Socket } from "node:net";
import path from "node:path";
import { createServer as createTlsServer } from "node:tls";

import { issueTestCert, makeTestCa, startConnectProxy, startNginxDefaults, startTlsInspectingProxy } from "@ostra/adapter-sdk/testing/net";
import type { InspectionMode, Target } from "@ostra/adapter-sdk/testing/net";
import { z } from "zod";

import { devDataDir, devToolAllowed, portFrom, refuseOutsideDev, say, serveUntilStopped } from "./common.ts";

const modeSchema = z.enum(["pass", "block", "hold"]);

const sendMode = async (controlPort: number, mode: InspectionMode): Promise<number> => {
  const payload = JSON.stringify({ mode });
  const status = await new Promise<number>((resolve) => {
    const call = request(
      { host: "127.0.0.1", port: controlPort, method: "POST", path: "/mode", headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    call.on("error", () => {
      resolve(0);
    });
    call.end(payload);
  });
  if (status !== 200) {
    process.stderr.write("The proxies didn't answer: is pnpm dev:net-proxies running?\n");
    return 1;
  }
  say(`TLS-inspecting proxy: mode ${mode}`);
  return 0;
};

/** core behind TLS, as a load balancer in front of it would be: bytes passed both ways, the upgrade with them. */
const startTlsFront = async (core: Target, cert: string, key: string): Promise<{ readonly port: number; readonly close: () => Promise<void> }> => {
  const sockets = new Set<Socket>();
  const server = createTlsServer({ cert, key }, (client) => {
    const upstream = connectTcp(core.port, core.host);
    sockets.add(upstream);
    client.pipe(upstream).pipe(client);
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    upstream.on("close", () => {
      sockets.delete(upstream);
      client.destroy();
    });
    client.on("close", () => upstream.destroy());
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
};

const readJson = async (incoming: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value;
  } catch {
    return null;
  }
};

const main = async (): Promise<number> => {
  if (!devToolAllowed(process.env)) return refuseOutsideDev("The network proxies");
  const base = portFrom(process.env, "OSTRA_DEV_NET_PROXIES_PORT", 13_128);
  const corePort = portFrom(process.env, "OSTRA_CORE_PORT", 8787);
  if (base === null || corePort === null || (base !== 0 && base > 65_531)) {
    process.stderr.write("OSTRA_DEV_NET_PROXIES_PORT and OSTRA_CORE_PORT are port numbers.\n");
    return 2;
  }
  // 0 lets each listener take any free port, for the tests; otherwise four in a row.
  const at = (offset: number): number => (base === 0 ? 0 : base + offset);
  const controlPort = at(3);
  const [command, value] = process.argv.slice(2);
  if (command === "mode") {
    const mode = modeSchema.safeParse(value);
    if (!mode.success) {
      process.stderr.write("Usage: pnpm dev:net-proxies mode pass|block|hold\n");
      return 2;
    }
    return sendMode(controlPort, mode.data);
  }
  if (command !== undefined) {
    process.stderr.write("Usage: pnpm dev:net-proxies [mode pass|block|hold]\n");
    return 2;
  }

  const core: Target = { host: "127.0.0.1", port: corePort };
  const hosts = new Map<string, Target>([
    ["ostra-core.test", core],
    ["localhost", core],
    ["127.0.0.1", core],
  ]);
  const corpCa = await makeTestCa("ostra-dev corporate proxy CA");
  const corpLeaf = await issueTestCert(corpCa, ["ostra-core.test", "localhost", "127.0.0.1"]);
  const nginxCa = await makeTestCa("ostra-dev nginx CA");
  const nginxLeaf = await issueTestCert(nginxCa, ["localhost", "127.0.0.1"]);
  const frontLeaf = await issueTestCert(nginxCa, ["ostra-core.test"]);
  const dir = path.join(devDataDir(process.env), "net-proxies");
  await mkdir(dir, { recursive: true });
  const caFile = path.join(dir, "ca.pem");
  await writeFile(caFile, `${corpCa.cert}${nginxCa.cert}`);

  const front = await startTlsFront(core, frontLeaf.cert, frontLeaf.key);
  const auth = { user: "ostra-dev", pass: randomBytes(18).toString("base64url") };
  const connectUrlFile = path.join(dir, "connect-proxy-url");
  const connect = await startConnectProxy(new Map([["ostra-core.test", { host: "127.0.0.1", port: front.port }]]), auth, { port: at(0) });
  await writeFile(connectUrlFile, `http://${auth.user}:${auth.pass}@127.0.0.1:${String(connect.port)}\n`, { mode: 0o600 });
  await chmod(connectUrlFile, 0o600);
  const inspecting = await startTlsInspectingProxy({ hosts, leafCert: corpLeaf.cert, leafKey: corpLeaf.key, upstreamCa: null, mode: "pass", port: at(1) });
  const nginx = await startNginxDefaults({ upstream: () => core, cert: nginxLeaf.cert, key: nginxLeaf.key, upstreamCa: null, port: at(2) });
  const state = (): Readonly<Record<string, unknown>> => ({ connect: connect.port, inspecting: inspecting.port, nginx: nginx.port, mode: inspecting.mode(), core: corePort });
  const control = createServer((incoming: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      if (incoming.method === "POST" && incoming.url === "/mode") {
        const body = z.looseObject({ mode: modeSchema }).safeParse(await readJson(incoming));
        if (!body.success) {
          response.writeHead(400).end();
          return;
        }
        inspecting.setMode(body.data.mode);
        say(`TLS-inspecting proxy: mode ${body.data.mode}`);
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(state()));
    })();
  });
  const controlAt = await new Promise<number>((resolve) => {
    control.listen(controlPort, "127.0.0.1", () => {
      const address = control.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });

  say(`CONNECT proxy:          http://127.0.0.1:${String(connect.port)}   (Basic auth: HTTPS_PROXY=$(cat ${connectUrlFile}) for a runner of https://ostra-core.test:${String(corePort)})`);
  say(`TLS-inspecting proxy:   http://127.0.0.1:${String(inspecting.port)}   (mode pass; pnpm dev:net-proxies mode block|hold switches it)`);
  say(`nginx's defaults:       https://127.0.0.1:${String(nginx.port)}  (in front of core, the upgrade stripped)`);
  say(`Their CAs:              NODE_EXTRA_CA_CERTS=${caFile}`);
  say(`Control:                http://127.0.0.1:${String(controlAt)}/healthz`);
  return serveUntilStopped({ ...state(), control: controlAt, ca: caFile, connectUrlFile }, async () => {
    await Promise.all([connect.close(), inspecting.close(), nginx.close(), front.close()]);
    control.closeAllConnections();
    await new Promise<void>((resolve) => {
      control.close(() => {
        resolve();
      });
    });
  });
};

process.exitCode = await main();
