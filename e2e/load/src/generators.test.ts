import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { silentLogger } from "@ostra/adapter-sdk";
import { startCore } from "@ostra/core";
import { LIVE_TEXT_TABLE, Prisma } from "@ostra/db";
import { createTestDatabase } from "@ostra/db/testing";
import type { TestDatabase } from "@ostra/db/testing";
import { parseServerSettings } from "@ostra/domain";
import { clientMessageIdSchema, runnerIdSchema, taskIdSchema } from "@ostra/protocol";
import type { RunnerId, TaskId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { startHarnessApi } from "./api.ts";
import type { HarnessApi } from "./api.ts";
import type { GeneratorLine } from "./generator-protocol.ts";
import { generatorShares, startGenerator } from "./generators.ts";
import type { GeneratorProcess } from "./generators.ts";
import { partialTextOn } from "./mix.ts";
import { startNetCut } from "./net-cut.ts";
import type { NetCut } from "./net-cut.ts";
import { cpuCores, sampleProcess } from "./process-sampler.ts";
import { seedLoadWorld } from "./seed.ts";
import type { LoadWorld } from "./seed.ts";

// Ticket 34 (F-117/c4, ADR 0061): what the load test does beyond its steady load, on a small fleet
// against a real core (`startCore`) and `packages/api` in this process, as `run.ts` runs a step:
// its generator as several processes (`generator.ts`, each joining its share of simulated runners
// with the pool's join token), partial text on for some tasks, a reconnect storm through the TCP
// forwarders in front of core, and Postgres's CPU read as the postmaster and every backend it
// forked. The Chromium viewers (`browsers.ts`) need the panel built and a browser: they run in the
// launch gate's load run.

const ADMIN = { email: "load-parts-admin@example.com", password: "correct-horse-battery-staple" } as const;

let test: TestDatabase;
let core: Awaited<ReturnType<typeof startCore>>;
let api: HarnessApi;
let world: LoadWorld;
let dataDir: string;
let cut: NetCut;
const generators: GeneratorProcess[] = [];

const waitFor = async <T,>(what: string, read: () => T | undefined | Promise<T | undefined>, timeoutMs = 60_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

beforeAll(async () => {
  test = await createTestDatabase();
  dataDir = await mkdtemp(path.join(tmpdir(), "ostra-load-parts-"));
  const secretsKey = randomBytes(32).toString("base64url");
  const parsed = parseServerSettings({
    NODE_ENV: "test",
    DATABASE_URL: test.url,
    OSTRA_DATA_DIR: path.join(dataDir, "server"),
    OSTRA_CATALOG_FETCH: "false",
    OSTRA_SECRETS_KEY: secretsKey,
    OSTRA_ADMIN_EMAIL: ADMIN.email,
    OSTRA_ADMIN_PASSWORD: ADMIN.password,
    OSTRA_QUEUE_SWEEP_SECONDS: "1",
  });
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  core = await startCore({ ...parsed.settings, corePort: 0 }, silentLogger, { jobIntervals: { pollingIntervalSeconds: 0.5, superviseIntervalSeconds: 1 } });
  api = await startHarnessApi({ settings: parsed.settings, secretsKey, adminEmail: ADMIN.email, adminPassword: ADMIN.password, logger: silentLogger });
  world = await seedLoadWorld(api.db);
  // The runners reach core through a forwarder, as in the load run, so the storm can cut them all.
  cut = await startNetCut(core.port);
}, 180_000);

afterAll(async () => {
  await Promise.all(generators.map((generator) => generator.stop()));
  await cut.close();
  await api.close();
  await core.stop();
  await test.dispose();
  await rm(dataDir, { recursive: true, force: true });
}, 120_000);

/** Each generator's report, asked of all at once. */
const report = async (): Promise<{ readonly connected: number; readonly runners: number }> => {
  const lines = await Promise.all(
    generators.map((generator) => {
      const waiting = generator.next("report", 30_000);
      generator.send({ cmd: "report" });
      return waiting;
    }),
  );
  return { connected: lines.reduce((sum, line) => sum + line.connected, 0), runners: lines.reduce((sum, line) => sum + line.runners, 0) };
};

const liveTextOf = async (taskId: TaskId): Promise<readonly string[]> =>
  z
    .array(z.object({ text: z.string() }))
    .parse(await api.db.$queryRaw`SELECT "text" FROM ${Prisma.raw(LIVE_TEXT_TABLE)} WHERE "taskId" = ${taskId}`)
    .map((row) => row.text);

describe("what the load test does beyond its steady load (F-117)", () => {
  it("F-117/c4: runs its generator as one process per 250 tasks, the runners split across them", () => {
    expect(generatorShares(1_000, 1, 250)).toEqual([250, 250, 250, 250]);
    expect(generatorShares(1_000, 2, 250)).toEqual([125, 125, 125, 125]);
    expect(generatorShares(260, 1, 250)).toEqual([130, 130]);
    expect(generatorShares(100, 1, 250)).toEqual([100]);
    // Every runner is in one share, whatever the split.
    for (const [tasks, slots, perProcess] of [
      [1_000, 1, 250],
      [999, 2, 250],
      [7, 3, 2],
    ] as const) {
      expect(generatorShares(tasks, slots, perProcess).reduce((sum, share) => sum + share, 0)).toBe(Math.ceil(tasks / slots));
    }
  });

  it("F-117/c4: several generator processes join their runners and take tasks, partial text on for some; after the reconnect storm every runner comes back on its own, and no steer or event is lost", async () => {
    const slots = 8;
    const shares = generatorShares(32, slots, 16);
    expect(shares).toEqual([2, 2]);
    const pool = await api.admin.pools.create({ name: "load-parts", requiresApproval: true, projectIds: [world.projectId] });
    const dispatched = new Map<string, { readonly generator: number; readonly partialText: boolean }>();
    const steers = new Set<string>();
    const marked = new Map<string, number | null>();
    for (const [index, runners] of shares.entries()) {
      const generator = startGenerator(
        index,
        {
          serverUrls: [cut.url],
          joinToken: pool.joinToken.token,
          prefix: `g${String(index + 1)}`,
          runners,
          slots,
          dataDir: path.join(dataDir, `g${String(index + 1)}`),
          transport: "websocket",
          registerConcurrency: 2,
        },
        dataDir,
      );
      generator.onLine((line: GeneratorLine) => {
        switch (line.t) {
          case "dispatched":
            dispatched.set(line.taskId, { generator: index, partialText: line.partialText });
            return;
          case "steer":
            steers.add(line.id);
            return;
          case "marked":
            marked.set(line.marker, line.at);
            return;
          case "registered":
          case "report":
          case "acks":
          case "drained":
          case "error":
            return;
          default:
            line satisfies never;
        }
      });
      generators.push(generator);
    }

    // Each generator is a process of its own, apart from the harness's.
    const pids = generators.map((generator) => generator.pid);
    expect(new Set([...pids, process.pid]).size).toBe(generators.length + 1);
    for (const pid of pids) {
      expect((await sampleProcess(pid)).processes).toBeGreaterThanOrEqual(1);
    }
    const registered = await Promise.all(generators.map((generator) => generator.next("registered", 120_000)));
    expect(registered.map((line) => line.runners.length)).toEqual(shares);
    const runnerIds: RunnerId[] = registered.flatMap((line) => line.runners.map((runner) => runnerIdSchema.parse(runner.runnerId)));
    for (const runnerId of runnerIds) {
      await api.admin.runners.approve({ runnerId });
    }
    for (const generator of generators) generator.send({ cmd: "connect" });
    await waitFor("every runner connected", async () => ((await report()).connected === runnerIds.length ? true : undefined), 90_000);

    // Tasks through the API, until the runners of both processes hold some, and partial text is on
    // for some and off for others (one task in four has it on, by its ID).
    // Each waits for its dispatch before the next, so the dispatcher's free-slot counts are current
    // and the tasks spread over the runners.
    const taskIds: TaskId[] = [];
    const enough = (): boolean => {
      const on = taskIds.filter(partialTextOn).length;
      return on > 0 && on < taskIds.length && new Set(taskIds.map((taskId) => dispatched.get(taskId)?.generator)).size === generators.length;
    };
    while (!enough() && taskIds.length < runnerIds.length * slots) {
      const created = await api.admin.tasks.create({ projectId: world.projectId, prompt: `Load task ${String(taskIds.length + 1)}: read the store and keep the cursor` });
      const taskId = taskIdSchema.parse(created.taskId);
      taskIds.push(taskId);
      await waitFor(`task ${String(taskIds.length)}'s dispatch`, () => (dispatched.has(taskId) ? true : undefined), 60_000);
    }
    expect(enough()).toBe(true);
    // Every process agrees which tasks have partial text, by the task's ID.
    for (const taskId of taskIds) {
      expect(dispatched.get(taskId)?.partialText).toBe(partialTextOn(taskId));
    }
    const withText = taskIds.filter(partialTextOn);
    const without = taskIds.filter((taskId) => !partialTextOn(taskId));
    expect(withText.length).toBeGreaterThan(0);
    expect(without.length).toBeGreaterThan(0);

    // A task with partial text on streams it into core's live text, a marked line among it.
    const [watched] = withText;
    if (watched === undefined) throw new Error("no task with partial text");
    const marker = "mk-parts-1";
    generators[dispatched.get(watched)?.generator ?? 0]?.send({ cmd: "mark", taskId: watched, marker });
    expect(await waitFor("the marked line", () => (marked.has(marker) ? marked.get(marker) : undefined), 30_000)).not.toBeNull();
    await waitFor("the marked line in core's live text", async () => ((await liveTextOf(watched)).some((text) => text.includes(marker)) ? true : undefined), 30_000);

    // The reconnect storm: every runner's connection cut at once. Each comes back by itself, on a new connection.
    const epochs = async (): Promise<ReadonlyMap<string, { readonly epoch: number; readonly connected: boolean }>> =>
      new Map(
        (await api.db.runnerPresence.findMany({ where: { runnerId: { in: runnerIds } }, select: { runnerId: true, connectionEpoch: true, disconnectedAt: true } })).map((row) => [
          row.runnerId,
          { epoch: row.connectionEpoch, connected: row.disconnectedAt === null },
        ]),
      );
    const before = await epochs();
    expect(before.size).toBe(runnerIds.length);
    expect(cut.cut()).toBeGreaterThanOrEqual(runnerIds.length);
    await waitFor(
      "every runner back on a new connection",
      async () => {
        const after = await epochs();
        return runnerIds.every((runnerId) => {
          const now = after.get(runnerId);
          return now !== undefined && now.connected && now.epoch > (before.get(runnerId)?.epoch ?? Number.POSITIVE_INFINITY);
        })
          ? true
          : undefined;
      },
      120_000,
    );
    await waitFor("every runner connected after the storm", async () => ((await report()).connected === runnerIds.length ? true : undefined), 60_000);

    // A steer after the storm reaches each process's runners.
    const stormSteers: string[] = [];
    for (const generator of generators) {
      const taskId = taskIds.find((id) => dispatched.get(id)?.generator === generator.index);
      if (taskId === undefined) throw new Error("a generator holds no task");
      const clientMessageId = clientMessageIdSchema.parse(randomUUID());
      stormSteers.push(clientMessageId);
      await api.admin.tasks.send({ taskId, clientMessageId, text: "Keep the cursor where it was" });
    }
    await waitFor("the steers after the storm", () => (stormSteers.every((id) => steers.has(id)) ? true : undefined), 60_000);

    // Drained: every event each process offered is stored exactly once, storm and all.
    const drained = await Promise.all(
      generators.map((generator) => {
        const waiting = generator.next("drained", 120_000);
        generator.send({ cmd: "drain" });
        return waiting;
      }),
    );
    const sessions = drained.flatMap((line) => line.sessions);
    expect(new Set(sessions.map((session) => session.taskId))).toEqual(new Set(taskIds));
    for (const session of sessions) {
      expect(session.offered).toBeGreaterThan(0);
      const rows = await api.db.event.findMany({ where: { sessionId: session.sessionId, sessionSeq: { not: null } }, select: { sessionSeq: true } });
      expect(rows.length).toBe(session.offered);
      expect(new Set(rows.map((row) => row.sessionSeq)).size).toBe(session.offered);
    }
    // And a task with partial text off never streamed any.
    for (const taskId of without) {
      expect(await liveTextOf(taskId)).toEqual([]);
    }
  }, 300_000);

  it("F-117/c4: records Postgres's CPU as the postmaster and the backends it forked: a backend's work shows in the postmaster's sample", async () => {
    // The test's own Postgres, as the load run samples its stack's: the postmaster's PID is the first line of postmaster.pid.
    const [setting] = z.array(z.object({ data_directory: z.string() })).parse(await api.db.$queryRaw`SHOW data_directory`);
    if (setting === undefined) throw new Error("no data directory");
    const postmaster = Number.parseInt((await readFile(path.join(setting.data_directory, "postmaster.pid"), "utf8")).split("\n")[0] ?? "", 10);
    expect(Number.isInteger(postmaster)).toBe(true);
    await api.db.$transaction(
      async (tx) => {
        const [backend] = z.array(z.object({ pid: z.number().int() })).parse(await tx.$queryRaw`SELECT pg_backend_pid() AS pid`);
        if (backend === undefined) throw new Error("no backend");
        const treeBefore = await sampleProcess(postmaster);
        const backendBefore = await sampleProcess(backend.pid);
        // Burn on this one backend until the OS counts a second of its CPU, not for a wall-clock time.
        const giveUpAt = Date.now() + 60_000;
        let backendAfter = backendBefore;
        while (backendAfter.cpuMs - backendBefore.cpuMs < 1_000 && Date.now() < giveUpAt) {
          await tx.$executeRaw`SELECT count(*) FROM generate_series(1, 3000000) AS g WHERE sqrt(g::float8) > 3`;
          backendAfter = await sampleProcess(backend.pid);
        }
        const treeAfter = await sampleProcess(postmaster);
        expect(backendAfter.cpuMs - backendBefore.cpuMs).toBeGreaterThanOrEqual(1_000);
        expect(cpuCores(backendBefore, backendAfter)).toBeGreaterThan(0);
        // The postmaster's sample sums it and the backends it forked, this one's whole count among
        // them. (Other backends come and go between two samples, so the sum is compared whole.)
        expect(treeBefore.processes).toBeGreaterThanOrEqual(2);
        expect(treeAfter.processes).toBeGreaterThanOrEqual(2);
        expect(treeAfter.cpuMs).toBeGreaterThanOrEqual(backendAfter.cpuMs);
        expect(treeAfter.rssBytes).toBeGreaterThan(0);
      },
      { maxWait: 10_000, timeout: 120_000 },
    );
  }, 180_000);
});
