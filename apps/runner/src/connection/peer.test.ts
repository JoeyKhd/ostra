import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { silentLogger } from "@ostra/adapter-sdk";
import { leaseEpochSchema, runnerIdSchema, segmentIdSchema, sessionIdSchema, taskIdSchema, turnIdSchema } from "@ostra/protocol";
import type { SessionId, TaskEvent } from "@ostra/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCommand, startFakeGateway } from "../testing/fake-gateway.ts";
import type { FakeGateway, FakeGatewayOptions } from "../testing/fake-gateway.ts";
import { startFakeServer } from "../testing/fake-server.ts";
import type { FakeServer } from "../testing/fake-server.ts";
import { rejectAllHandlers } from "../testing/handlers.ts";
import { startConnection } from "./peer.ts";
import type { CommandHandlers, ConnectionHooks, ConnectionOptions, RunnerConnection, SessionChannel } from "./peer.ts";

// Ticket 16's "done when", against a fake gateway built from the protocol's schemas.

const runnerId = runnerIdSchema.parse("runner-test");
const taskId = taskIdSchema.parse("task-1");
const sessionId = sessionIdSchema.parse("session-1");
const leaseEpoch = leaseEpochSchema.parse(1);
const TOKEN = "ostra-runner-test-access-token";

let dataDir = "";
let server: FakeServer | undefined;
let gateway: FakeGateway | undefined;
const connections: RunnerConnection[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "ostra-runner-peer-"));
});

afterEach(async () => {
  for (const connection of connections.splice(0)) {
    await connection.stop();
  }
  await gateway?.close();
  await server?.close();
  gateway = undefined;
  server = undefined;
  await rm(dataDir, { recursive: true, force: true });
});

const setup = async (gatewayOptions: FakeGatewayOptions = {}): Promise<{ readonly server: FakeServer; readonly gateway: FakeGateway }> => {
  server = await startFakeServer();
  server.accessTokens.set(TOKEN, runnerId);
  gateway = startFakeGateway(server, gatewayOptions);
  return { server, gateway };
};

const connect = async (
  fake: FakeServer,
  extra: Partial<Pick<ConnectionOptions, "handlers" | "now" | "spoolQuotaBytes" | "timers">> & { readonly hooks?: ConnectionHooks } = {},
): Promise<RunnerConnection> => {
  const connection = await startConnection({
    serverUrl: fake.url,
    peer: { kind: "runner", runnerId },
    tokens: { get: () => Promise.resolve({ ok: true, token: TOKEN, expiresAt: Date.now() + 600_000 }), invalidate: () => undefined },
    dataDir,
    handlers: extra.handlers ?? rejectAllHandlers,
    status: () => ({ executor: "host", capacity: 1, freeSlots: 1, labels: [], running: [] }),
    logger: silentLogger,
    timers: { backoffMinMs: 5, backoffMaxMs: 20, checkMs: 10, liveTextIntervalMs: 20, ...extra.timers },
    ...(extra.hooks === undefined ? {} : { hooks: extra.hooks }),
    ...(extra.now === undefined ? {} : { now: extra.now }),
    ...(extra.spoolQuotaBytes === undefined ? {} : { spoolQuotaBytes: extra.spoolQuotaBytes }),
  });
  connections.push(connection);
  return connection;
};

const line = (index: number): TaskEvent => ({ kind: "environment.setup_output", stream: "stdout", text: `line ${String(index)}` });

const emitMany = async (channel: SessionChannel, from: number, count: number): Promise<void> => {
  for (let index = from; index < from + count; index += 1) {
    await channel.emit(line(index));
  }
};

const storedTexts = (fake: FakeGateway, id: SessionId = sessionId): readonly string[] =>
  [...(fake.stored.get(id)?.values() ?? [])]
    .sort((a, b) => a.sessionSeq - b.sessionSeq)
    .map((item) => (item.event.kind === "environment.setup_output" ? item.event.text : item.event.kind));

const spoolFolders = async (): Promise<readonly string[]> => {
  try {
    return await readdir(path.join(dataDir, "spool"));
  } catch {
    return [];
  }
};

describe("events: spooled, sent, acked, stored once", () => {
  it("sends a session's events in order and deletes its spool once they're acked", async () => {
    const { server: fake, gateway: gw } = await setup();
    const connection = await connect(fake);
    const channel = await connection.openSession({ taskId, sessionId, leaseEpoch });
    await emitMany(channel, 0, 5);
    channel.close();
    await channel.drained();
    expect(storedTexts(gw)).toEqual(["line 0", "line 1", "line 2", "line 3", "line 4"]);
    await gw.waitFor(() => connection.report().sessions.length === 0);
    expect(await spoolFolders()).toEqual([]);
    expect(gw.protocolErrors).toEqual([]);
  });

  it("resends a batch after a dropped connection, and the server stores it once", async () => {
    const { server: fake, gateway: gw } = await setup();
    const connection = await connect(fake);
    await gw.waitFor(() => gw.connected());
    gw.holdAcks = true;
    const channel = await connection.openSession({ taskId, sessionId, leaseEpoch });
    await emitMany(channel, 0, 3);
    await gw.waitFor(() => storedTexts(gw).length === 3);
    gw.drop();
    gw.holdAcks = false;
    await channel.drained();
    expect(gw.connections()).toBe(2);
    expect(storedTexts(gw)).toEqual(["line 0", "line 1", "line 2"]);
    expect([...gw.received.values()].every((count) => count === 2)).toBe(true);
    expect(gw.hellos.at(-1)?.sessions).toEqual([{ taskId, sessionId, leaseEpoch, nextSessionSeq: 4 }]);
  });

  it("answers a gap's resendFrom by resending from there", async () => {
    const { server: fake, gateway: gw } = await setup();
    const connection = await connect(fake);
    await gw.waitFor(() => gw.connected());
    const channel = await connection.openSession({ taskId, sessionId, leaseEpoch });
    gw.loseNextFrame = true;
    await channel.emit(line(0));
    await emitMany(channel, 1, 2);
    await channel.drained();
    expect(storedTexts(gw)).toEqual(["line 0", "line 1", "line 2"]);
    expect(gw.connections()).toBe(1);
  });

  it("keeps at most the credit window's frames in flight, counting frames", async () => {
    const { server: fake, gateway: gw } = await setup({ creditFrames: 2 });
    const connection = await connect(fake);
    await gw.waitFor(() => gw.connected());
    gw.holdAcks = true;
    const channel = await connection.openSession({ taskId, sessionId, leaseEpoch });
    await emitMany(channel, 0, 10);
    await gw.waitFor(() => storedTexts(gw).length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(gw.maxUnackedFrames()).toBe(2);
    expect(storedTexts(gw).length).toBeLessThan(10);
    gw.holdAcks = false;
    gw.ackStored(sessionId);
    await channel.drained();
    expect(storedTexts(gw)).toHaveLength(10);
  });

  it("keeps at most the credit window's bytes in flight, counting bytes", async () => {
    const { server: fake, gateway: gw } = await setup({ creditBytes: 200 });
    const connection = await connect(fake);
    await gw.waitFor(() => gw.connected());
    gw.holdAcks = true;
    const channel = await connection.openSession({ taskId, sessionId, leaseEpoch });
    await emitMany(channel, 0, 5);
    await gw.waitFor(() => storedTexts(gw).length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(gw.maxUnackedFrames()).toBe(1);
    gw.holdAcks = false;
    gw.ackStored(sessionId);
    await channel.drained();
    expect(storedTexts(gw)).toHaveLength(5);
  });

  it("stops taking events while the spool is over its quota, and never drops one", async () => {
    const { server: fake, gateway: gw } = await setup();
    const connection = await connect(fake, { spoolQuotaBytes: 400 });
    await gw.waitFor(() => gw.connected());
    gw.holdAcks = true;
    const channel = await connection.openSession({ taskId, sessionId, leaseEpoch });
    await emitMany(channel, 0, 3);
    let fourth = false;
    const pending = channel.emit(line(3)).then(() => {
      fourth = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fourth).toBe(false);
    gw.holdAcks = false;
    gw.ackStored(sessionId);
    await pending;
    await channel.drained();
    expect(storedTexts(gw)).toEqual(["line 0", "line 1", "line 2", "line 3"]);
  });

  it("discards a session's spool when the server refuses its lease, and tells the task host", async () => {
    const { server: fake, gateway: gw } = await setup();
    const stale: SessionId[] = [];
    const connection = await connect(fake, { hooks: { onStaleLease: (id) => stale.push(id) } });
    await gw.waitFor(() => gw.connected());
    gw.staleSessions.add(sessionId);
    const channel = await connection.openSession({ taskId, sessionId, leaseEpoch });
    await channel.emit(line(0));
    await gw.waitFor(() => stale.length === 1);
    expect(stale).toEqual([sessionId]);
    expect(connection.report().sessions).toEqual([]);
    expect(await spoolFolders()).toEqual([]);
    await expect(channel.emit(line(1))).rejects.toThrow(/lease/);
  });
});

describe("a runner killed between spool write and ack", () => {
  it("resends after a restart, and every event is acked once", async () => {
    const { server: fake, gateway: gw } = await setup();
    await gw.waitFor(() => true);
    gw.holdAcks = true;
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../testing/peer-child.ts", import.meta.url)), fake.url, dataDir, "20"],
      { env: { ...process.env, OSTRA_TEST_ACCESS_TOKEN: TOKEN }, stdio: ["ignore", "pipe", "pipe"] },
    );
    const spooled = new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString("utf8").includes("spooled")) {
          resolve();
        }
      });
      child.on("exit", (code) => {
        reject(new Error(`the child exited early with ${String(code)}`));
      });
    });
    await spooled;
    const childSession = sessionIdSchema.parse("session-child");
    await gw.waitFor(() => storedTexts(gw, childSession).length > 0);
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    expect(storedTexts(gw, childSession).length).toBeGreaterThan(0);

    gw.holdAcks = false;
    const restarted = await connect(fake);
    expect(restarted.restoredSessions().map((ref) => ref.sessionId)).toEqual([childSession]);
    await gw.waitFor(() => restarted.report().sessions.length === 0);
    expect(storedTexts(gw, childSession)).toEqual(Array.from({ length: 20 }, (_, index) => `line ${String(index)}`));
    expect(await spoolFolders()).toEqual([]);
    expect(gw.protocolErrors).toEqual([]);
  }, 30_000);
});

describe("commands", () => {
  const countingHandlers = (calls: string[]): CommandHandlers => ({
    ...rejectAllHandlers,
    interrupt: (command) => {
      calls.push(command.id);
      return Promise.resolve({ result: "done" });
    },
  });

  it("applies a command once across a reconnect and acks the highest contiguous seq", async () => {
    const { server: fake, gateway: gw } = await setup();
    const calls: string[] = [];
    await connect(fake, { handlers: countingHandlers(calls) });
    await gw.waitFor(() => gw.connected());
    const command = makeCommand({ seq: 1, id: "cmd-1", notAfter: Date.now() + 60_000, kind: "interrupt", body: { sessionId } });
    gw.sendCommand(command);
    await gw.waitFor(() => gw.acks.some((ack) => ack.results.some((item) => item.id === command.id)));
    expect(gw.acks.at(-1)).toMatchObject({ upTo: 1, results: [{ id: "cmd-1", seq: 1, result: "done" }] });

    gw.drop();
    await gw.waitFor(() => gw.connections() === 2 && gw.connected());
    expect(gw.hellos.at(-1)?.lastCommandSeq).toBe(1);
    gw.sendCommand(command);
    await gw.waitFor(() => gw.acks.length >= 2);
    expect(calls).toEqual(["cmd-1"]);
    expect(gw.acks.at(-1)).toMatchObject({ upTo: 1, results: [{ id: "cmd-1", result: "done" }] });
  });

  it("judges notAfter by the server's clock, and never applies a late command", async () => {
    const skew = 60 * 60 * 1000;
    const { server: fake, gateway: gw } = await setup();
    const calls: string[] = [];
    await connect(fake, { handlers: countingHandlers(calls), now: () => Date.now() + skew });
    await gw.waitFor(() => gw.connected());
    gw.sendCommand(makeCommand({ seq: 1, id: "fresh", notAfter: Date.now() + 60_000, kind: "interrupt", body: { sessionId } }));
    gw.sendCommand(makeCommand({ seq: 2, id: "late", notAfter: Date.now() - 1_000, kind: "interrupt", body: { sessionId } }));
    await gw.waitFor(() => gw.acks.some((ack) => ack.upTo === 2));
    expect(calls).toEqual(["fresh"]);
    const late = gw.acks.flatMap((ack) => ack.results).find((item) => item.id === "late");
    expect(late).toMatchObject({ result: "rejected", reason: "past-not-after" });
  });

  it("reports outcome-unknown for a command a crash cut off", async () => {
    await writeFile(
      path.join(dataDir, "state.json"),
      JSON.stringify({ lastContiguousSeq: 2, appliedAbove: [], applied: [], inflight: { id: "cmd-3", seq: 3, kind: "steer" }, sessions: [] }),
    );
    const { server: fake, gateway: gw } = await setup();
    await connect(fake);
    await gw.waitFor(() => gw.acks.length > 0);
    expect(gw.acks[0]).toMatchObject({ upTo: 3, results: [{ id: "cmd-3", seq: 3, result: "outcome-unknown" }] });
  });
});

describe("the connection's lifecycle", () => {
  it("sends its status on connect", async () => {
    const { server: fake, gateway: gw } = await setup();
    await connect(fake);
    await gw.waitFor(() => gw.statuses.length > 0);
    expect(gw.statuses[0]).toMatchObject({ type: "status", executor: "host", capacity: 1, freeSlots: 1, spoolBytes: 0 });
  });

  it("self-fences after 9.5 minutes without the server, on a fake clock", async () => {
    let clock = Date.now();
    const fencedSessions: SessionId[][] = [];
    const { server: fake, gateway: gw } = await setup();
    const connection = await connect(fake, { now: () => clock, hooks: { onSelfFence: (ids) => fencedSessions.push([...ids]) } });
    await gw.waitFor(() => gw.connected());
    await connection.openSession({ taskId, sessionId, leaseEpoch });
    gw.refuseUpgrades = true;
    gw.drop();
    clock += 9 * 60 * 1000;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fencedSessions).toEqual([]);
    clock += 31 * 1000;
    await gw.waitFor(() => fencedSessions.length === 1);
    expect(fencedSessions).toEqual([[sessionId]]);
    expect(connection.report().fenced).toBe(true);
  });

  it("stops for good when the server revokes the runner (4403)", async () => {
    const { server: fake, gateway: gw } = await setup();
    const refused: string[] = [];
    const connection = await connect(fake, { hooks: { onRefused: (reason) => refused.push(reason) } });
    await gw.waitFor(() => gw.connected());
    gw.closeWith(4403);
    expect(await connection.done).toMatchObject({ kind: "revoked" });
    expect(refused).toEqual(["revoked"]);
    expect(gw.connections()).toBe(1);
  });

  it("stops for good on an evict frame", async () => {
    const { server: fake, gateway: gw } = await setup();
    const connection = await connect(fake);
    await gw.waitFor(() => gw.connected());
    gw.send({ type: "evict", reason: "revoked" });
    expect(await connection.done).toMatchObject({ kind: "revoked" });
  });
});

describe("live text", () => {
  it("sends partial text as appends from the last offset, and a snapshot after a reconnect", async () => {
    const { server: fake, gateway: gw } = await setup();
    const connection = await connect(fake);
    await gw.waitFor(() => gw.connected());
    const channel = await connection.openSession({ taskId, sessionId, leaseEpoch });
    const segment = { turnId: turnIdSchema.parse("turn-1"), segmentId: segmentIdSchema.parse("seg-1"), kind: "message" as const };
    channel.appendLiveText(segment, "Hel");
    channel.appendLiveText(segment, "lo");
    await gw.waitFor(() => gw.liveText.length > 0);
    expect(gw.liveText[0]).toMatchObject({ offset: 0, text: "Hello", taskId, sessionId });
    channel.appendLiveText(segment, ", world");
    await gw.waitFor(() => gw.liveText.length > 1);
    expect(gw.liveText[1]).toMatchObject({ offset: 5, text: ", world" });

    gw.drop();
    await gw.waitFor(() => gw.liveText.length > 2);
    expect(gw.liveText[2]).toMatchObject({ offset: 0, text: "Hello, world" });
    channel.appendLiveText(segment, "!");
    await gw.waitFor(() => gw.liveText.length > 3);
    expect(gw.liveText[3]).toMatchObject({ offset: 12, text: "!" });

    channel.endLiveText(segment.segmentId);
    channel.appendLiveText({ ...segment, segmentId: segmentIdSchema.parse("seg-2") }, "x");
    await gw.waitFor(() => gw.liveText.length > 4);
    expect(gw.liveText.slice(4).every((frame) => frame.segmentId === "seg-2")).toBe(true);
    expect(await spoolFolders()).not.toContain("live");
  });
});
