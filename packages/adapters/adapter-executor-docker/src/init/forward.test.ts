import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { killTree, silentLogger } from "@ostra/adapter-sdk";
import { boxIdSchema } from "@ostra/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { listenForInit } from "../bridge/bridge-server.ts";
import type { Bridge } from "../bridge/bridge-server.ts";
import { BRIDGE_FEATURES } from "../bridge/protocol.ts";

// Milestone 8 (ticket 03, ADR 0068): the init's forwarder on loopback aliases, as spike 08 ran it.
// The bridge listens on 127.0.0.1, so the init sees the sidecar there; a connection from 127.0.0.2
// stands for another container on the box network, which the forwarder refuses. A 2 MiB answer
// comes through whole, which `stream.pipeline` lost the end of (spike 08, §4.1). An init started
// without the sidecar's features is sent none of milestone 8's frames.

const INIT = fileURLToPath(new URL("./main.ts", import.meta.url));
const BIG = 2 * 1024 * 1024 + 123;

const running: { init?: ChildProcess; bridge?: Bridge; app?: Server } = {};

afterEach(async () => {
  running.bridge?.close();
  if (running.init?.pid !== undefined && running.init.exitCode === null) {
    await killTree(running.init.pid);
  }
  await new Promise<void>((resolve) => {
    if (running.app === undefined) resolve();
    else
      running.app.close(() => {
        resolve();
      });
  });
  delete running.init;
  delete running.bridge;
  delete running.app;
});

const startInit = async (features: string | null): Promise<Bridge> => {
  const boxId = boxIdSchema.parse(`forward-box-${randomBytes(4).toString("hex")}`);
  const nonce = randomBytes(32).toString("base64url");
  const listener = await listenForInit({ boxId, nonce, host: "127.0.0.1", port: 0, logger: silentLogger });
  running.init = spawn(process.execPath, [INIT], {
    env: {
      ...process.env,
      OSTRA_BOX_ID: boxId,
      OSTRA_BRIDGE_NONCE: nonce,
      OSTRA_BRIDGE_ADDR: `127.0.0.1:${String(listener.port)}`,
      ...(features === null ? { OSTRA_BRIDGE_FEATURES: "" } : { OSTRA_BRIDGE_FEATURES: features }),
    },
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  running.bridge = await listener.connected;
  return running.bridge;
};

/** The app, on `localhost` as a dev server listens: `/big` answers 2 MiB and a bit, the rest a line. */
const startApp = async (): Promise<number> => {
  const body = Buffer.alloc(BIG, 0x61);
  const app = createServer((request, response) => {
    if (request.url === "/big") {
      response.writeHead(200, { "content-length": String(body.length) });
      response.end(body);
      return;
    }
    response.end("hello from the app");
  });
  running.app = app;
  await new Promise<void>((resolve) => app.listen(0, "localhost", resolve));
  const address: AddressInfo | string | null = app.address();
  if (address === null || typeof address === "string") throw new Error("the app has no port");
  return address.port;
};

/** One request over a fresh connection from `localAddress`, read to its end; the bytes, or `null` when refused before any. */
const get = (host: string, port: number, path: string, localAddress: string): Promise<Buffer | null> =>
  new Promise((resolve) => {
    const socket = connect({ host, port, localAddress });
    const chunks: Buffer[] = [];
    socket.on("connect", () => socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("close", () => {
      resolve(chunks.length === 0 ? null : Buffer.concat(chunks));
    });
    socket.on("error", () => undefined);
  });

describe("the init's forwarder (docker)", () => {
  it("F-143/c2: carries a connection from the sidecar to the app's localhost, a 2 MiB answer whole", async () => {
    const bridge = await startInit(BRIDGE_FEATURES.join(","));
    const port = await startApp();
    const forward = await bridge.openForward(port);
    expect(forward.host).toBe("127.0.0.1");
    const small = await get(forward.host, forward.port, "/", "127.0.0.1");
    expect(small?.toString("utf8")).toContain("hello from the app");
    const big = await get(forward.host, forward.port, "/big", "127.0.0.1");
    const text = big?.toString("latin1") ?? "";
    const bodyStart = text.indexOf("\r\n\r\n") + 4;
    expect(text.length - bodyStart).toBe(BIG);
    await forward.close();
    expect(await get(forward.host, forward.port, "/", "127.0.0.1")).toBeNull();
  });

  it("F-143: takes connections from the sidecar's address only: another one on the box network is refused before the app sees it", async () => {
    const bridge = await startInit(BRIDGE_FEATURES.join(","));
    const port = await startApp();
    let seen = 0;
    running.app?.on("request", () => {
      seen += 1;
    });
    const forward = await bridge.openForward(port);
    expect(await get(forward.host, forward.port, "/from-elsewhere", "127.0.0.2")).toBeNull();
    expect(seen).toBe(0);
    expect((await get(forward.host, forward.port, "/", "127.0.0.1"))?.toString("utf8")).toContain("hello from the app");
    expect(seen).toBe(1);
    await forward.close();
  });

  it("F-143/c3: the init refuses a forward to a port below 1024 itself, whatever the sidecar asks", async () => {
    const bridge = await startInit(BRIDGE_FEATURES.join(","));
    await expect(bridge.openForward(22)).rejects.toThrow("port 22 isn't an app's");
  });

  it("an init started without the sidecar's features is sent no milestone 8 frame, and the bridge stays up", async () => {
    const bridge = await startInit(null);
    expect(bridge.features).toEqual([]);
    await expect(bridge.openForward(5173)).rejects.toThrow("older than its runner");
    await expect(bridge.spawnApp({ command: process.execPath, args: ["-e", ""], cwd: process.cwd(), env: {} })).rejects.toThrow("older than its runner");
    await expect(bridge.startBrowser()).rejects.toThrow("older than its runner");
    // Nothing was sent that it would refuse: it still answers.
    expect((await bridge.listProcesses()).length).toBeGreaterThan(0);
  });
});
