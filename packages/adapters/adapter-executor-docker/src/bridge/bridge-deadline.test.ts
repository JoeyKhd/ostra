import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { silentLogger } from "@ostra/adapter-sdk";
import { boxIdSchema } from "@ostra/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { listenForInit } from "./bridge-server.ts";
import type { Bridge } from "./bridge-server.ts";
import { encodeFrame } from "./framing.ts";
import { BRIDGE_VERSION } from "./protocol.ts";

// F-017 (ADR 0029, Q154): every request on the bridge between the sidecar and the agent's container
// has a deadline. The sidecar's real end of the bridge, on a loopback socket, with an init that says
// hello and then never answers: a hung init can't hold a stop.

const boxId = boxIdSchema.parse("0196f1a0-box-bridge");
const nonce = randomBytes(32).toString("base64url");
const sockets: Socket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
});

/** The sidecar's listener, and an init that connects, says hello, reads every request and answers none. */
const hungInit = async (deadlineMs: number): Promise<{ readonly bridge: Bridge; readonly received: () => string }> => {
  const listener = await listenForInit({ boxId, nonce, host: "127.0.0.1", port: 0, logger: silentLogger, requestDeadlineMs: deadlineMs });
  let received = "";
  const socket = connect(listener.port, "127.0.0.1");
  sockets.push(socket);
  socket.on("data", (chunk: Buffer) => {
    received += chunk.toString("utf8");
  });
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  socket.write(encodeFrame({ t: "hello", version: BRIDGE_VERSION, boxId, nonce, initPid: 1, agentUid: 1000, platform: "linux" }));
  const bridge = await listener.connected;
  return { bridge, received: () => received };
};

describe("the bridge's deadlines", () => {
  it("F-017/c6: every request to an init that never answers fails at its deadline, and the sidecar goes on", async () => {
    const deadlineMs = 300;
    const { bridge, received } = await hungInit(deadlineMs);
    const requests: readonly (readonly [string, () => Promise<unknown>])[] = [
      ["kill_tree", () => bridge.killTree(42)],
      ["reap_all", () => bridge.reapAll()],
      ["ps", () => bridge.listProcesses()],
      ["prepare", () => bridge.prepare(["/task/x"], [])],
      ["spawn", () => bridge.spawn({ command: "/bin/true", args: [], cwd: "/task", env: {} })],
    ];
    for (const [name, call] of requests) {
      const started = Date.now();
      await expect(call()).rejects.toThrow("didn't answer in time");
      const took = Date.now() - started;
      expect(took).toBeGreaterThanOrEqual(deadlineMs - 20);
      expect(took).toBeLessThan(deadlineMs + 2_000);
      // The request did reach the init: it was the answer that never came.
      expect(received()).toContain(`"t":"${name}"`);
    }
  });
});
