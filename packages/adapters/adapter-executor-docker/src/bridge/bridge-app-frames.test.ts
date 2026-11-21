import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { silentLogger } from "@ostra/adapter-sdk";
import { boxIdSchema } from "@ostra/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { listenForInit } from "./bridge-server.ts";
import type { Bridge } from "./bridge-server.ts";
import { createLineSplitter, encodeFrame } from "./framing.ts";
import { BRIDGE_VERSION } from "./protocol.ts";
import { procIdSchema } from "./protocol.ts";
import type { InitFrame, ProcId } from "./protocol.ts";

// Milestone 8 (ticket 12): an app process's frames in whatever order the init sends them. Node can
// report a child's exit before its output ends, so an `exit` frame may reach the sidecar before the
// app's last `out` and its `eof`s. The sidecar's real end of the bridge, on a loopback socket, with
// a scripted init that answers `app_spawn` and then sends the process's frames in the order a test
// gives: the app's whole output reaches its streams, they end, and its exit is reported, whatever
// came first.

const boxId = boxIdSchema.parse("0196f1a0-box-app-frames");
const nonce = randomBytes(32).toString("base64url");
const sockets: Socket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
});

/** The sidecar's listener, and an init with the `app` feature that answers `app_spawn`, then sends what `play` sends. */
const scriptedInit = async (): Promise<{ readonly bridge: Bridge; readonly play: (frames: readonly InitFrame[], pauseMs?: number) => Promise<void>; readonly spawned: Promise<ProcId> }> => {
  const listener = await listenForInit({ boxId, nonce, host: "127.0.0.1", port: 0, logger: silentLogger });
  const socket = connect(listener.port, "127.0.0.1");
  sockets.push(socket);
  const splitter = createLineSplitter();
  let resolveSpawned: (procId: ProcId) => void = () => undefined;
  const spawned = new Promise<ProcId>((resolve) => {
    resolveSpawned = resolve;
  });
  socket.on("data", (chunk: Buffer) => {
    for (const line of splitter.push(chunk)) {
      const frame: unknown = JSON.parse(line);
      if (typeof frame === "object" && frame !== null && Reflect.get(frame, "t") === "app_spawn") {
        const reqId = Number(Reflect.get(frame, "reqId"));
        const procId = procIdSchema.parse(Reflect.get(frame, "procId"));
        socket.write(encodeFrame({ t: "spawned", reqId, procId, pid: 4242 }));
        resolveSpawned(procId);
      }
    }
  });
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  socket.write(encodeFrame({ t: "hello", version: BRIDGE_VERSION, boxId, nonce, initPid: 1, agentUid: 1000, platform: "linux", features: ["app"] }));
  const bridge = await listener.connected;
  // Each frame in a write of its own, a pause between them, so none share a chunk with the next.
  const play = async (frames: readonly InitFrame[], pauseMs = 30): Promise<void> => {
    for (const frame of frames) {
      socket.write(encodeFrame(frame));
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  };
  return { bridge, play, spawned };
};

const read = (stream: NodeJS.ReadableStream): Promise<string> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.once("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });

const base64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

describe("an app process's frames on the bridge", () => {
  it("F-140/c5: an exit that comes before the app's last output and its eofs drops nothing: its output is whole, its streams end, and its exit is reported", async () => {
    const { bridge, play, spawned } = await scriptedInit();
    const app = await bridge.spawnApp({ command: "/bin/sh", args: ["-lc", "the project's own line"], cwd: "/task/workspace/app", env: {} });
    const procId = await spawned;
    const out = read(app.stdout);
    const err = read(app.stderr);
    await play([
      { t: "out", procId, stream: "stdout", data: base64("first line\n") },
      // The exit, before the rest of its output.
      { t: "exit", procId, code: 7, signal: null },
      { t: "out", procId, stream: "stdout", data: base64("last line\n") },
      { t: "out", procId, stream: "stderr", data: base64("its last words\n") },
      { t: "eof", procId, stream: "stdout" },
      { t: "eof", procId, stream: "stderr" },
    ]);
    expect(await app.exited).toEqual({ code: 7, signal: null });
    expect(await out).toBe("first line\nlast line\n");
    expect(await err).toBe("its last words\n");
    // Over: a stop asks nothing more of the init and resolves with its exit.
    await expect(app.stop(100)).resolves.toBeUndefined();
  });

  it("F-140/c5: in the order the init usually sends them, eofs and then the exit, the same holds; and frames after an app is over reach nothing", async () => {
    const { bridge, play, spawned } = await scriptedInit();
    const app = await bridge.spawnApp({ command: "/bin/sh", args: ["-lc", "the project's own line"], cwd: "/task/workspace/app", env: {} });
    const procId = await spawned;
    const out = read(app.stdout);
    const err = read(app.stderr);
    await play([
      { t: "out", procId, stream: "stdout", data: base64("only line\n") },
      { t: "eof", procId, stream: "stdout" },
      { t: "eof", procId, stream: "stderr" },
      { t: "exit", procId, code: 0, signal: null },
      // A stray frame for a proc that's over is dropped, never an error.
      { t: "out", procId, stream: "stdout", data: base64("too late\n") },
    ]);
    expect(await app.exited).toEqual({ code: 0, signal: null });
    expect(await out).toBe("only line\n");
    expect(await err).toBe("");
  });
});
