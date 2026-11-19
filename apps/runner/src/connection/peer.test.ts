import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { silentLogger } from "@ostra/adapter-sdk";
import { recordingLogger } from "@ostra/adapter-sdk/testing";
import { imageDigestSchema, leaseEpochSchema, runnerIdSchema, segmentIdSchema, sessionIdSchema, snapshotIdSchema, taskIdSchema, turnIdSchema } from "@ostra/protocol";
import type { SessionId, TaskEvent } from "@ostra/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateRunnerKeyPair } from "../identity/key-pair.ts";
import { createAccessTokens, UNKNOWN_KEY_MESSAGE } from "../server/access-token.ts";
import { makeCommand, startFakeGateway } from "../testing/fake-gateway.ts";
import type { FakeGateway, FakeGatewayOptions } from "../testing/fake-gateway.ts";
import { startFakeServer } from "../testing/fake-server.ts";
import type { FakeServer } from "../testing/fake-server.ts";
import { rejectAllHandlers } from "../testing/handlers.ts";
import { startConnection } from "./peer.ts";
import type { CommandHandlers, ConnectionHooks, ConnectionOptions, ConnectionEnd, RefusedReason, RunnerConnection, SessionChannel, TokenSource } from "./peer.ts";

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

/** The runner's real access tokens, signed with a key the fake server knows, on a clock `now`. */
const signedTokens = async (fake: FakeServer, now: () => number = Date.now): Promise<TokenSource> => {
  const keyPair = await generateRunnerKeyPair();
  fake.runners.set(runnerId, {
    runnerId,
    proof: "device-session",
    revoked: false,
    request: {
      publicKey: keyPair.publicKey,
      name: "laptop",
      executor: "host",
      capacity: 1,
      labels: [],
      os: { platform: "win32", arch: "x64", release: "10.0" },
      version: "0.0.0",
    },
  });
  return createAccessTokens({ serverUrl: fake.url, runnerId, keyPair, now });
};

/** A connection with the runner's real access tokens, recording what it logs and how the server refused it. */
const connectSigned = async (
  fake: FakeServer,
  tokens: TokenSource,
): Promise<{ readonly connection: RunnerConnection; readonly log: ReturnType<typeof recordingLogger>; readonly refused: RefusedReason[] }> => {
  const log = recordingLogger();
  const refused: RefusedReason[] = [];
  const connection = await startConnection({
    serverUrl: fake.url,
    peer: { kind: "runner", runnerId },
    tokens,
    dataDir,
    handlers: rejectAllHandlers,
    status: () => ({ executor: "host", capacity: 1, freeSlots: 1, labels: [], running: [] }),
    logger: log,
    timers: { backoffMinMs: 5, backoffMaxMs: 20, checkMs: 10, liveTextIntervalMs: 20 },
    hooks: { onRefused: (reason) => refused.push(reason) },
  });
  connections.push(connection);
  return { connection, log, refused };
};

/** Whether `done` settled within `ms`: a connection that keeps retrying never does. */
const settledWithin = async (done: Promise<ConnectionEnd>, ms: number): Promise<boolean> =>
  Promise.race([
    done.then(() => true),
    new Promise<boolean>((resolve) => {
      setTimeout(() => {
        resolve(false);
      }, ms);
    }),
  ]);

const HOUR = 3_600_000;

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

  it("drops an event the server refused for good from its spool, and never sends it again", async () => {
    const { server: fake, gateway: gw } = await setup();
    const connection = await connect(fake);
    await gw.waitFor(() => gw.connected());
    gw.holdAcks = true;
    const channel = await connection.openSession({ taskId, sessionId, leaseEpoch });
    await emitMany(channel, 0, 3);
    await gw.waitFor(() => storedTexts(gw).length === 3);
    // The server skipped event 2: its cursor moved past it, and it says so.
    gw.send({ type: "error", code: "event-rejected", message: "refused", sessionId, sessionSeq: 2 });
    await gw.waitFor(() => connection.report().sessions[0]?.ackedUpTo === 2);
    // Only event 3 is left to send, and it's still unacked.
    expect(connection.report().sessions[0]).toMatchObject({ lastSeq: 3, ackedUpTo: 2 });
    gw.drop();
    gw.holdAcks = false;
    await channel.drained();
    expect(gw.connections()).toBe(2);
    expect(gw.received.get(`${sessionId}#1`)).toBe(1);
    expect(gw.received.get(`${sessionId}#2`)).toBe(1);
    expect(gw.received.get(`${sessionId}#3`)).toBe(2);
    expect(gw.protocolErrors).toEqual([]);
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

describe("a runner restarted while a session waits between turns", () => {
  it("still names the session as restored, though every event was acked, and its next event follows on", async () => {
    const { server: fake, gateway: gw } = await setup();
    const first = await connect(fake);
    const channel = await first.openSession({ taskId, sessionId, leaseEpoch });
    await emitMany(channel, 0, 3);
    await channel.drained();
    // The turn is over and every event is acked; the session stays open, idle, until the runner stops.
    expect(first.report().sessions).toEqual([{ sessionId, lastSeq: 3, ackedUpTo: 3, state: "open" }]);
    await first.stop();
    connections.splice(connections.indexOf(first), 1);

    const restarted = await connect(fake);
    // Its agent is gone with the old process: the task host reports it, so the server isn't left
    // with a session that is idle forever.
    expect(restarted.restoredSessions().map((ref) => ref.sessionId)).toEqual([sessionId]);
    const again = await restarted.openSession({ taskId, sessionId, leaseEpoch });
    await again.emit({ kind: "session.crashed", error: "the runner restarted while the session was running" });
    again.close();
    await gw.waitFor(() => restarted.report().sessions.length === 0);
    expect(storedTexts(gw)).toEqual(["line 0", "line 1", "line 2", "session.crashed"]);
    expect(gw.protocolErrors).toEqual([]);
  });
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

describe("a refused access token", () => {
  it("F-013: a clock an hour behind the server's is retried with the backoff and logged with its offset, and the runner connects once the clocks agree", async () => {
    const { server: fake, gateway: gw } = await setup();
    let offsetMs = -HOUR;
    const { connection, log, refused } = await connectSigned(fake, await signedTokens(fake, () => Date.now() + offsetMs));
    await gw.waitFor(() => log.records.filter((record) => record.fields["reason"] === "clock-skew").length >= 3);
    const warned = log.records.find((record) => record.fields["reason"] === "clock-skew");
    expect(warned?.level).toBe("warn");
    expect(warned?.message).toContain("this machine's clock is 3600 s behind the server's");
    expect(Math.round(Number(warned?.fields["offsetMs"]) / 1000)).toBe(3600);
    // Retried, never ended: no connection yet, no refusal for good.
    expect(await settledWithin(connection.done, 50)).toBe(false);
    expect(gw.connections()).toBe(0);
    expect(refused.every((reason) => reason === "clock-skew")).toBe(true);
    // The clocks agree again: the next try gets a token and connects.
    offsetMs = 0;
    await gw.waitFor(() => gw.connected());
    expect(fake.tokensIssued.get(runnerId)).toBe(1);
    expect(log.records.some((record) => record.level === "error")).toBe(false);
  });

  it("F-013: a key the server doesn't know ends the connection for good, with its own message", async () => {
    const { server: fake } = await setup();
    const tokens = await signedTokens(fake);
    fake.runners.clear();
    const { connection, refused } = await connectSigned(fake, tokens);
    expect(await connection.done).toEqual({ kind: "unknown-key", message: UNKNOWN_KEY_MESSAGE });
    expect(refused).toEqual(["unknown-key"]);
    expect(fake.tokenRequests).toHaveLength(1);
  });

  it("F-013: a revoked runner's token request ends the connection for good", async () => {
    const { server: fake } = await setup();
    const tokens = await signedTokens(fake);
    for (const entry of fake.runners.values()) {
      entry.revoked = true;
    }
    const { connection, refused } = await connectSigned(fake, tokens);
    const end = await connection.done;
    expect(end.kind).toBe("revoked");
    expect(end.kind === "stopped" ? "" : end.message).toContain("revoked in the panel");
    expect(refused).toEqual(["revoked"]);
  });

  it("F-013: a replayed nonce is asked again at once with a fresh assertion, and the runner connects", async () => {
    const { server: fake, gateway: gw } = await setup();
    const tokens = await signedTokens(fake);
    fake.tokenRefusals.push({ status: 401, body: { error: { code: "unauthorized", message: "used", reason: "replayed" } } });
    const { log, refused } = await connectSigned(fake, tokens);
    await gw.waitFor(() => gw.connected());
    expect(fake.tokenRequests).toHaveLength(2);
    expect(fake.tokenRequests[0]?.nonce).not.toBe(fake.tokenRequests[1]?.nonce);
    expect(refused).toEqual([]);
    expect(log.records.some((record) => record.level === "warn")).toBe(false);
  });

  it("F-061: against a server before minor 2, a 401 without a reason is retried with the backoff, never the end", async () => {
    const { server: fake, gateway: gw } = await setup();
    const tokens = await signedTokens(fake);
    for (let index = 0; index < 3; index += 1) {
      fake.tokenRefusals.push({ status: 401, body: { error: { code: "unauthorized", message: "the assertion was already used" } } });
    }
    const { connection, log, refused } = await connectSigned(fake, tokens);
    await gw.waitFor(() => gw.connected());
    expect(refused).toEqual(["token-refused", "token-refused", "token-refused"]);
    const warned = log.records.filter((record) => record.fields["reason"] === "token-refused");
    expect(warned).toHaveLength(3);
    expect(warned[0]?.message).toBe("The server refused the access token (401) without a reason. Retrying.");
    expect(await settledWithin(connection.done, 50)).toBe(false);
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

describe("a runner's own events (minor 2)", () => {
  it("F-051: a snapshot's result goes up in a runner-event frame, and goes again on the next connection, with one recorded while it was down", async () => {
    const { server: fake, gateway: gw } = await setup();
    const connection = await connect(fake);
    await gw.waitFor(() => gw.connected());
    const built: TaskEvent = { kind: "snapshot.built", snapshotId: snapshotIdSchema.parse("snapshot-1"), imageDigest: imageDigestSchema.parse(`sha256:${"c".repeat(64)}`), durationMs: 4_200 };
    connection.sendRunnerEvent(built);
    await gw.waitFor(() => gw.runnerEvents.length === 1);
    expect(gw.runnerEvents[0]).toMatchObject({ type: "runner-event", event: built });

    // The server is gone: a socket that died unnoticed may have swallowed the first, and the second waits.
    gw.refuseUpgrades = true;
    gw.drop();
    await gw.waitFor(() => !gw.connected());
    const failed: TaskEvent = { kind: "snapshot.failed", snapshotId: snapshotIdSchema.parse("snapshot-2"), reason: "secret-found", detail: "The setup secret API_TOKEN was found in the image." };
    connection.sendRunnerEvent(failed);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(gw.runnerEvents).toHaveLength(1);
    gw.refuseUpgrades = false;
    await gw.waitFor(() => gw.runnerEvents.length === 3);
    expect(gw.runnerEvents.map((frame) => frame.event)).toEqual([built, built, failed]);
    expect(gw.protocolErrors).toEqual([]);
  });
});
