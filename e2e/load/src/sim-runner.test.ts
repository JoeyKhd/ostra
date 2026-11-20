import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { silentLogger } from "@ostra/adapter-sdk";
import { startCore } from "@ostra/core";
import { createTestDatabase } from "@ostra/db/testing";
import type { TestDatabase } from "@ostra/db/testing";
import { parseServerSettings } from "@ostra/domain";
import { clientMessageIdSchema, sessionIdSchema } from "@ostra/protocol";
import type { TaskId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startHarnessApi } from "./api.ts";
import type { HarnessApi } from "./api.ts";
import { seedLoadWorld } from "./seed.ts";
import type { LoadWorld } from "./seed.ts";
import { registerSimRunner, startSimRunner } from "./sim-runner.ts";
import type { SimRunner } from "./sim-runner.ts";
import { createSteerTimer } from "./stats.ts";

// Ticket 34 (F-117): one simulated runner, as the load test runs hundreds, against a real core
// (`startCore`, as `apps/core/src/main.ts` runs it) on a migrated database, with `packages/api` in
// this process: the pool and its join token, the runner's join and its approval, the task, its
// admission by the real queue and its dispatch, the scripted agent's events stored exactly once, and
// a steer from the API's call to the runner's receipt. Nothing in the path is a stand-in for ostra's own.

const ADMIN = { email: "load-admin@example.com", password: "correct-horse-battery-staple" } as const;

let test: TestDatabase;
let core: Awaited<ReturnType<typeof startCore>>;
let api: HarnessApi;
let world: LoadWorld;
let dataDir: string;
let runner: SimRunner | undefined;

const waitFor = async <T,>(what: string, read: () => T | undefined | Promise<T | undefined>, timeoutMs = 30_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

beforeAll(async () => {
  test = await createTestDatabase();
  dataDir = await mkdtemp(path.join(tmpdir(), "ostra-load-e2e-"));
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
}, 180_000);

afterAll(async () => {
  await runner?.stop();
  await api.close();
  await core.stop();
  await test.dispose();
  await rm(dataDir, { recursive: true, force: true });
});

describe("a simulated runner", () => {
  it("F-117/c2: speaks the real protocol against a real core, one task end to end", async () => {
    const serverUrl = `http://127.0.0.1:${String(core.port)}`;
    const pool = await api.admin.pools.create({ name: "load", requiresApproval: true, projectIds: [world.projectId] });
    const registered = await registerSimRunner({ serverUrl, joinToken: pool.joinToken.token, name: "load-0", slots: 2 });
    // The pool asks for approval: the runner waits until an admin gives it.
    expect((await api.db.runner.findUniqueOrThrow({ where: { id: registered.runnerId } })).approvedAt).toBeNull();
    await api.admin.runners.approve({ runnerId: registered.runnerId });

    const dispatched: { taskId: TaskId; sessionId: string }[] = [];
    const steers = createSteerTimer();
    const ackLatencies: number[] = [];
    runner = await startSimRunner({
      serverUrl,
      runner: registered,
      slots: 2,
      dataDir: path.join(dataDir, "runner"),
      logger: silentLogger,
      // Quick, so the test has plenty of events in a few seconds.
      ratePerMinute: 6_000,
      hooks: {
        onDispatched: (task) => dispatched.push(task),
        onSteer: (id, at) => {
          steers.received(id, at);
        },
        onAckLatency: (ms) => ackLatencies.push(ms),
      },
    });
    await waitFor("the runner's connection", () => (runner?.connected() === true ? true : undefined));

    const task = await api.admin.tasks.create({ projectId: world.projectId, prompt: "Load the store and keep the cursor" });
    const got = await waitFor("the dispatch", () => dispatched.find((item) => item.taskId === task.taskId));
    expect(got.sessionId).toBe(task.sessionId);

    // The agent writes; the task runs.
    await waitFor("events stored", async () => ((await api.db.event.count({ where: { sessionId: task.sessionId, sessionSeq: { not: null } } })) >= 50 ? true : undefined));
    await waitFor("the task running", async () => ((await api.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state === "running" ? true : undefined));

    const clientMessageId = clientMessageIdSchema.parse(randomUUID());
    steers.sent(clientMessageId, Date.now());
    await api.admin.tasks.send({ taskId: task.taskId, clientMessageId, text: "Keep the cursor where it was" });
    await waitFor("the steer at the runner", () => (steers.result().received === 1 ? true : undefined));
    const steer = steers.result();
    expect(steer.lost).toEqual([]);
    expect(steer.latencyMs.p99).not.toBeNull();

    runner.pause();
    const drained = await runner.drained();
    const offered = drained.find((item) => item.sessionId === sessionIdSchema.parse(task.sessionId))?.offered ?? 0;
    expect(offered).toBeGreaterThanOrEqual(50);
    // Exactly once: every number the runner offered is stored, and none twice.
    const rows = await api.db.event.findMany({ where: { sessionId: task.sessionId, sessionSeq: { not: null } }, select: { sessionSeq: true } });
    const seqs = rows.map((row) => row.sessionSeq);
    expect(seqs.length).toBe(offered);
    expect(new Set(seqs).size).toBe(offered);
    expect(Math.max(...seqs.map((seq) => seq ?? 0))).toBe(offered);
    expect(ackLatencies.length).toBeGreaterThanOrEqual(offered - 1);
  });
});
