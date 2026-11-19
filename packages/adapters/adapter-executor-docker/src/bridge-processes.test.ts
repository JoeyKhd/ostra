import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { silentLogger } from "@ostra/adapter-sdk";
import { boxIdSchema } from "@ostra/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { listenForInit } from "./bridge/bridge-server.ts";
import { createLineSplitter, encodeFrame, parseFrame } from "./bridge/framing.ts";
import { BRIDGE_VERSION, sidecarFrameSchema } from "./bridge/protocol.ts";
import type { InitFrame, SidecarFrame } from "./bridge/protocol.ts";
import { bridgeProcesses } from "./bridge-processes.ts";

// A program run through the bridge answers with all of its output (ticket 22), whatever order the
// init's frames come in and however they are read. The sidecar's real end of the bridge, on a
// loopback socket, with a scripted init that answers a spawn with the frames a real one sends.
//
// The real init sends a program's exit as its child exits, usually before the eof of its output
// (its child's `exit` comes before its pipes close), and a loaded sidecar reads the spawn's answer,
// the output and the exit in one chunk. Either way `run` once answered with an empty stdout: git's
// SHA or ref list lost, and a restored hidden ref came back as nothing (the executor contract's
// "replaces the hidden ref with each save" case, flaky in CI).

const boxId = boxIdSchema.parse("0196f1a0-box-run");
const nonce = randomBytes(32).toString("base64url");
const sockets: Socket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
});

type SpawnFrame = Extract<SidecarFrame, { t: "spawn" }>;
/** Each batch is one write on the socket; the next batch is written on a later turn of the loop. */
type Script = (spawn: SpawnFrame, socket: Socket) => readonly (readonly InitFrame[])[];

const out = (spawn: SpawnFrame, stream: "stdout" | "stderr", text: string): InitFrame => ({
  t: "out",
  procId: spawn.procId,
  stream,
  data: Buffer.from(text).toString("base64"),
});
const eof = (spawn: SpawnFrame, stream: "stdout" | "stderr"): InitFrame => ({ t: "eof", procId: spawn.procId, stream });
const spawned = (spawn: SpawnFrame): InitFrame => ({ t: "spawned", reqId: spawn.reqId, procId: spawn.procId, pid: 4242 });
const exited = (spawn: SpawnFrame): InitFrame => ({ t: "exit", procId: spawn.procId, code: 0, signal: null });

/** The sidecar's bridge, connected to an init that answers every spawn with `script`. */
const scriptedInit = async (script: Script) => {
  const listener = await listenForInit({ boxId, nonce, host: "127.0.0.1", port: 0, logger: silentLogger });
  const socket = connect(listener.port, "127.0.0.1");
  sockets.push(socket);
  const splitter = createLineSplitter();
  socket.on("data", (chunk: Buffer) => {
    for (const line of splitter.push(chunk)) {
      const parsed = parseFrame(sidecarFrameSchema, line);
      if (!parsed.ok || parsed.frame.t !== "spawn") continue;
      const batches = script(parsed.frame, socket);
      const writeFrom = (index: number): void => {
        const batch = batches[index];
        if (batch === undefined) return;
        socket.write(batch.map((frame) => encodeFrame(frame)).join(""));
        setImmediate(() => {
          writeFrom(index + 1);
        });
      };
      writeFrom(0);
    }
  });
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  socket.write(encodeFrame({ t: "hello", version: BRIDGE_VERSION, boxId, nonce, initPid: 1, agentUid: 1000, platform: "linux" }));
  return bridgeProcesses(await listener.connected);
};

const runGit = (processes: Awaited<ReturnType<typeof scriptedInit>>) => processes.run("git", ["rev-parse", "HEAD"], { cwd: "/task/workspace/test1", env: {} });

describe("a program run through the bridge", () => {
  it("answers with its output when the spawn's answer, the output and the exit are read in one chunk", async () => {
    const processes = await scriptedInit((spawn) => [
      [spawned(spawn), out(spawn, "stdout", "4b825dc642cb6eb9a060e54bf8d69288fbee4904\n"), out(spawn, "stderr", "a warning\n"), eof(spawn, "stdout"), eof(spawn, "stderr"), exited(spawn)],
    ]);
    expect(await runGit(processes)).toEqual({ code: 0, stdout: "4b825dc642cb6eb9a060e54bf8d69288fbee4904\n", stderr: "a warning\n" });
  });

  it("waits for the output that comes after the exit", async () => {
    const processes = await scriptedInit((spawn) => [
      [spawned(spawn), exited(spawn)],
      [out(spawn, "stdout", "4b825dc642cb6eb9a060e54bf8d69288fbee4904\n"), eof(spawn, "stdout")],
      [out(spawn, "stderr", "a warning\n"), eof(spawn, "stderr")],
    ]);
    expect(await runGit(processes)).toEqual({ code: 0, stdout: "4b825dc642cb6eb9a060e54bf8d69288fbee4904\n", stderr: "a warning\n" });
  });

  it("still answers when the bridge is lost before the output ends", async () => {
    const processes = await scriptedInit((spawn, socket) => {
      setImmediate(() => socket.destroy());
      return [[spawned(spawn), out(spawn, "stdout", "partial")]];
    });
    const result = await runGit(processes);
    expect(result.code).toBeNull();
  });
});
