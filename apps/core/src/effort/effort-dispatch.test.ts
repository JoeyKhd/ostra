import { randomBytes } from "node:crypto";

import { createLogger } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import type { CatalogEntry } from "@ostra/adapter-sdk";
import { mapModel } from "@ostra/db";
import type { Prisma } from "@ostra/db";
import {
  dispatchTask,
  postgresAuditLog,
  postgresChangeNotices,
  postgresCommandOutbox,
  setTaskEffort,
  syncProviderModels,
  systemClock,
} from "@ostra/domain";
import type { DispatchTaskResult, EffortDeps, MemberScope, ReopenDispatchSettings, SessionTimers } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import {
  effortChangeIdSchema,
  leaseEpochSchema,
  memberIdSchema,
  modelIdSchema,
  organizationIdSchema,
  providerIdSchema,
  sessionIdSchema,
  turnIdSchema,
} from "@ostra/protocol";
import type { EffortLevel, ReasoningControls, RunnerId, TaskSpec } from "@ostra/protocol";
import { reasoningControlsFixtures } from "@ostra/protocol/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { agentEffortLevels } from "../agents/effort-levels.ts";
import { buildTaskSpec } from "../dispatch/task-spec.ts";
import type { RunnerRef } from "../gateway/context.ts";
import { createIngest } from "../ingest/ingest.ts";
import type { Ingest } from "../ingest/ingest.ts";
import { createLiveTextWriter } from "../ingest/live-text.ts";
import type { LiveTextWriter } from "../ingest/live-text.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { acceptedTask } from "../testing/turns.ts";
import { dispatchPayload, seedOnlineRunner, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { QueuedTask, World } from "../testing/world.ts";

// Ticket 59 (F-137, ADR 0066): the task's level at dispatch, clamped to its model's levels as the
// agent can send them (core's agent registry, OpenCode's own `effortLevels`), with the model's
// controls and real limits in the spec; a level that isn't `default` only to a minor-3 runner; a
// driver's change refused unless the model offers it, and sent to no runner without a box; and a
// turn's level and reasoning tokens kept as ingest reads them. Against a real database.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let world: World;
let ingest: Ingest;
let liveText: LiveTextWriter;
let driver: MemberScope;
let deps: EffortDeps;
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const logger = createLogger(() => undefined);

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  const timers: SessionTimers = { sessionMaxMs: 120 * 60_000, boxReleaseIdleMs: 14 * 24 * 3_600_000, cancelInTx: (tx, job, payload) => jobs.cancelInTx(tx, job, payload) };
  liveText = createLiveTextWriter({ db: test.db, logger });
  ingest = createIngest({ db: test.db, jobs, notices: postgresChangeNotices, clock: systemClock, liveText, logger, timers, outbox: postgresCommandOutbox });
  driver = { organizationId: organizationIdSchema.parse(fixture.a.organization.id), memberId: memberIdSchema.parse(fixture.a.member.id), role: "member", projectRoles: new Map() };
  deps = { db: test.db, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, effortLevels: agentEffortLevels };
});

afterAll(async () => {
  await liveText.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

type ModelInput = {
  readonly catalogReasoning?: ReasoningControls | null;
  readonly adminReasoning?: ReasoningControls | null;
  readonly contextWindow?: number | null;
  readonly maxOutputTokens?: number | null;
  readonly catalogId?: string | null;
};

/** A model's controls as its JSON column takes them: none at all is no field. */
const json = (field: "catalogReasoning" | "adminReasoning", controls: ReasoningControls | null | undefined): Record<string, Prisma.InputJsonValue> =>
  controls === null || controls === undefined ? {} : { [field]: controls satisfies Prisma.InputJsonValue };

/** A model of the world's provider, and a profile on it. */
const modelAndProfile = async (input: ModelInput): Promise<{ readonly modelId: string; readonly profileId: string }> => {
  const model = await test.db.model.create({
    data: {
      organizationId: world.organizationId,
      providerId: world.providerId,
      endpointModelId: `model-${randomBytes(4).toString("hex")}`,
      catalogId: input.catalogId ?? null,
      contextWindow: input.contextWindow ?? null,
      maxOutputTokens: input.maxOutputTokens ?? null,
      ...json("catalogReasoning", input.catalogReasoning),
      ...json("adminReasoning", input.adminReasoning),
    },
  });
  const profile = await test.db.agentProfile.create({ data: { organizationId: world.organizationId, name: `Profile ${model.endpointModelId}`, adapter: "opencode", modelId: model.id } });
  return { modelId: model.id, profileId: profile.id };
};

/** A queued task at `level` whose session runs on `profileId`. */
const queuedAt = async (level: EffortLevel, profileId: string, runnerId: RunnerId | null): Promise<QueuedTask> => {
  const task = await seedQueuedTask(test.db, world, fixture.a.member, runnerId);
  await test.db.task.update({ where: { id: task.taskId }, data: { effort: level, agentProfileId: profileId } });
  await test.db.session.update({ where: { id: task.sessionId }, data: { agentProfileId: profileId } });
  return task;
};

const runnerAt = async (minor: number, capacity = 20): Promise<RunnerRef> => {
  const runner = await seedOnlineRunner(test.db, world.organizationId, { kind: "personal", memberId: fixture.a.member.id }, capacity);
  await test.db.runnerPresence.update({ where: { runnerId: runner.runnerId }, data: { minor } });
  return runner;
};

const dispatch = (task: QueuedTask, epoch = 1, reopen?: ReopenDispatchSettings): Promise<DispatchTaskResult> =>
  test.db.$transaction((tx) =>
    dispatchTask(
      {
        tx,
        jobs,
        outbox: postgresCommandOutbox,
        notices: postgresChangeNotices,
        clock: systemClock,
        effortLevels: agentEffortLevels,
        ...(reopen === undefined ? {} : { reopen }),
      },
      dispatchPayload(task, epoch),
    ),
  );

/** The spec the dispatched task's runner fetches, as core builds it. */
const specOf = async (task: QueuedTask, runnerId: RunnerId): Promise<TaskSpec> => {
  const { leaseEpoch } = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
  const built = await buildTaskSpec({ db: test.db, codeHost, secretStore }, { taskId: task.taskId, runnerId, leaseEpoch: leaseEpochSchema.parse(leaseEpoch) });
  if (!built.ok) {
    throw new Error(`spec: ${built.error}`);
  }
  return built.spec;
};

/** Dispatches a queued task to a minor-3 runner and returns its spec. */
const dispatchedSpec = async (task: QueuedTask, runner: RunnerRef): Promise<TaskSpec> => {
  expect(await dispatch(task)).toMatchObject({ ok: true, runnerId: runner.runnerId });
  return specOf(task, runner.runnerId);
};

describe("the spec", () => {
  it("F-137/c10: the spec of a task on a catalog model with a 1,000,000-token window and a 128,000-token output carries both", async () => {
    const runner = await runnerAt(3);
    const { profileId } = await modelAndProfile({
      catalogId: "openai/gpt-5.5",
      catalogReasoning: reasoningControlsFixtures.effort,
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
    });
    const spec = await dispatchedSpec(await queuedAt("high", profileId, runner.runnerId), runner);
    expect(spec.agent.limits).toEqual({ contextWindow: 1_000_000, maxOutputTokens: 128_000 });
    expect(spec.agent.reasoning).toEqual(reasoningControlsFixtures.effort);
    expect(spec.agent.effort).toBe("high");
  });

  it("F-137/c10: a custom model with no limits carries null for each, and no reasoning", async () => {
    const runner = await runnerAt(3);
    const { profileId } = await modelAndProfile({});
    const spec = await dispatchedSpec(await queuedAt("high", profileId, runner.runnerId), runner);
    expect(spec.agent.limits).toEqual({ contextWindow: null, maxOutputTokens: null });
    expect(spec.agent.reasoning).toEqual({ supported: false });
    // Nobody said it reasons, so it runs at the agent's own default.
    expect(spec.agent.effort).toBe("default");
  });

  it("F-137/c4: an admin's controls win over the catalog's in the spec", async () => {
    const runner = await runnerAt(3);
    const { profileId } = await modelAndProfile({ catalogReasoning: reasoningControlsFixtures.effort, adminReasoning: reasoningControlsFixtures.effortNoLow });
    const spec = await dispatchedSpec(await queuedAt("low", profileId, runner.runnerId), runner);
    expect(spec.agent.reasoning).toEqual(reasoningControlsFixtures.effortNoLow);
    // `low` isn't one of the admin's levels: the nearest is `medium`.
    expect(spec.agent.effort).toBe("medium");
  });

  it("F-137/c9: the spec carries the clamped level after the profile's model moved to one without it", async () => {
    const runner = await runnerAt(3);
    const first = await modelAndProfile({ catalogReasoning: reasoningControlsFixtures.effort });
    const task = await queuedAt("xhigh", first.profileId, runner.runnerId);
    // The profile moves to a model whose levels are low, medium, high and max: no `xhigh`.
    const moved = await modelAndProfile({ catalogReasoning: { supported: true, effort: ["low", "medium", "high", "max"] } });
    await test.db.agentProfile.update({ where: { id: first.profileId }, data: { modelId: moved.modelId } });
    const spec = await dispatchedSpec(task, runner);
    // `high` and `max` are equally near: the higher one.
    expect(spec.agent.effort).toBe("max");
    // The task keeps the level it was given: the clamp is the spec's, so a later model may have it.
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).effort).toBe("xhigh");
  });
});

describe("the dispatch", () => {
  it("F-137/c14: a minor-2 runner is never offered a task with a level; a minor-3 runner is", async () => {
    const old = await runnerAt(2);
    const { profileId } = await modelAndProfile({ catalogReasoning: reasoningControlsFixtures.effort });
    const task = await queuedAt("high", profileId, old.runnerId);
    expect(await dispatch(task)).toMatchObject({ ok: false, error: "no-runner" });
    const waiting = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    expect(waiting).toMatchObject({ state: "queued", leaseEpoch: 0 });
    expect(waiting.dispatchNote).toContain("protocol 3");
    expect(await test.db.command.count({ where: { taskId: task.taskId } })).toBe(0);
    expect(await test.db.lease.count({ where: { taskId: task.taskId } })).toBe(0);

    // The same task with no runner picked, and the old runner beside a minor-3 one in the pool: only the new one.
    const pool = await test.db.runnerPool.create({ data: { organizationId: world.organizationId, name: `pool-${randomBytes(3).toString("hex")}` } });
    await test.db.projectPool.create({ data: { organizationId: world.organizationId, projectId: world.projectId, poolId: pool.id } });
    try {
      const pooledOld = await seedOnlineRunner(test.db, world.organizationId, { kind: "pool", poolId: pool.id }, 20);
      await test.db.runnerPresence.update({ where: { runnerId: pooledOld.runnerId }, data: { minor: 2 } });
      const pooled = await queuedAt("high", profileId, null);
      expect(await dispatch(pooled)).toMatchObject({ ok: false, error: "no-runner" });
      const pooledNew = await seedOnlineRunner(test.db, world.organizationId, { kind: "pool", poolId: pool.id }, 1);
      await test.db.runnerPresence.update({ where: { runnerId: pooledNew.runnerId }, data: { minor: 3 } });
      expect(await dispatch(pooled)).toMatchObject({ ok: true, runnerId: pooledNew.runnerId });
      expect(await test.db.command.count({ where: { runnerId: pooledOld.runnerId } })).toBe(0);
    } finally {
      await test.db.projectPool.deleteMany({ where: { poolId: pool.id } });
    }
  });

  it("F-137/c9: a level the model can't take at all clamps to default, and goes to a minor-2 runner", async () => {
    const old = await runnerAt(2);
    const { profileId } = await modelAndProfile({});
    expect(await dispatch(await queuedAt("high", profileId, old.runnerId))).toMatchObject({ ok: true, runnerId: old.runnerId });
  });
});

describe("a driver's change", () => {
  const changeId = () => effortChangeIdSchema.parse(`change-${randomBytes(6).toString("hex")}`);

  /** A task whose session ran on `profileId`, idle between turns, its box released and its lease ended. */
  const idleWithoutBox = async (profileId: string) => {
    const runner = await runnerAt(3);
    const task = await queuedAt("default", profileId, runner.runnerId);
    expect(await dispatch(task)).toMatchObject({ ok: true });
    await test.db.task.update({ where: { id: task.taskId }, data: { state: "running" } });
    await test.db.session.update({ where: { id: task.sessionId }, data: { state: "idle" } });
    await test.db.lease.updateMany({ where: { taskId: task.taskId }, data: { state: "ended", endedAt: new Date(), endReason: "released" } });
    await test.db.box.updateMany({ where: { taskId: task.taskId }, data: { state: "released" } });
    return { task, runner };
  };

  it("F-137/c7: setTaskEffort refuses a level the session's model doesn't offer, naming the levels", async () => {
    const { profileId } = await modelAndProfile({ catalogReasoning: reasoningControlsFixtures.effortNoLow });
    const { task } = await idleWithoutBox(profileId);
    const refused = await setTaskEffort(deps, driver, { taskId: task.taskId, level: "low", changeId: changeId() });
    expect(refused).toEqual({ ok: false, error: "level-not-offered", message: "This model offers these levels: default, medium, high, xhigh" });
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).effort).toBe("default");
    expect(await test.db.event.count({ where: { taskId: task.taskId, kind: "effort.changed" } })).toBe(0);
    expect(await test.db.auditEntry.count({ where: { entityId: task.taskId, action: "task.effort-changed" } })).toBe(0);
  });

  it("F-137/c8: nothing is sent to a runner when the session is idle with no box; the next session's spec carries the level", async () => {
    const { profileId } = await modelAndProfile({ catalogReasoning: reasoningControlsFixtures.effortNoLow });
    const { task, runner } = await idleWithoutBox(profileId);
    expect(await setTaskEffort(deps, driver, { taskId: task.taskId, level: "xhigh", changeId: changeId() })).toMatchObject({
      ok: true,
      changed: true,
      sentToRunner: false,
    });
    expect(await test.db.command.count({ where: { taskId: task.taskId, kind: "set_effort" } })).toBe(0);
    expect(await test.db.command.count({ where: { runnerId: runner.runnerId, kind: "set_effort" } })).toBe(0);
    // The change is in the thread and the audit log all the same.
    expect(await test.db.event.count({ where: { taskId: task.taskId, kind: "effort.changed" } })).toBe(1);
    expect(await test.db.auditEntry.count({ where: { entityId: task.taskId, action: "task.effort-changed" } })).toBe(1);
  });

  it("F-137/c8: a reopen in a fresh box and a rebuild-template session start at the task's level", async () => {
    const { profileId } = await modelAndProfile({ catalogReasoning: reasoningControlsFixtures.effortNoLow });
    const { task } = await idleWithoutBox(profileId);
    expect(await setTaskEffort(deps, driver, { taskId: task.taskId, level: "xhigh", changeId: changeId() })).toMatchObject({ ok: true, sentToRunner: false });
    // The session's work was saved with an archive, then the session ended and its box went.
    const archive = await test.db.blob.create({
      data: {
        organizationId: world.organizationId,
        projectId: world.projectId,
        taskId: task.taskId,
        store: "postgres",
        key: `postgres:${randomBytes(8).toString("hex")}`,
        purpose: "session-archive",
        contentType: "application/gzip",
        size: 1234,
        sha256: randomBytes(32).toString("hex"),
      },
    });
    await test.db.session.update({ where: { id: task.sessionId }, data: { state: "stopped", endedAt: new Date(), archiveBlobId: archive.id } });

    /** A reopen's next session, dispatched to a fresh box on a minor-3 runner: its origin and its spec. */
    const reopenOnce = async () => {
      const runner = await runnerAt(3);
      const session = await test.db.session.create({
        data: { organizationId: world.organizationId, projectId: world.projectId, taskId: task.taskId, agentProfileId: profileId, origin: "new", state: "starting" },
      });
      const { leaseEpoch } = await test.db.task.update({ where: { id: task.taskId }, data: { state: "queued", runnerId: runner.runnerId } });
      const next: QueuedTask = { taskId: task.taskId, organizationId: task.organizationId, sessionId: sessionIdSchema.parse(session.id) };
      const offered = await dispatch(next, leaseEpoch + 1, { agentImportsArchives: (adapter) => adapter === "opencode", archiveMaxBytes: 64 * 1024 * 1024 });
      expect(offered).toMatchObject({ ok: true, runnerId: runner.runnerId });
      const spec = await specOf(next, runner.runnerId);
      // The session ends and its box goes, so the next reopen can't resume in it either.
      await test.db.session.update({ where: { id: session.id }, data: { state: "stopped", endedAt: new Date() } });
      await test.db.lease.updateMany({ where: { taskId: task.taskId }, data: { state: "ended", endedAt: new Date(), endReason: "released" } });
      await test.db.box.updateMany({ where: { taskId: task.taskId }, data: { state: "released" } });
      return { origin: (await test.db.session.findUniqueOrThrow({ where: { id: session.id } })).origin, spec };
    };

    const restored = await reopenOnce();
    expect(restored.origin).toBe("restored");
    expect(restored.spec.restore?.origin).toBe("restored");
    expect(restored.spec.agent.effort).toBe("xhigh");

    // With no archive left, the next reopen rebuilds from the template: the same level.
    await test.db.session.updateMany({ where: { taskId: task.taskId }, data: { archiveBlobId: null } });
    const rebuilt = await reopenOnce();
    expect(rebuilt.origin).toBe("rebuilt");
    expect(rebuilt.spec.restore?.origin).toBe("rebuilt");
    expect(rebuilt.spec.agent.effort).toBe("xhigh");
  });
});

describe("the catalog sync", () => {
  it("F-137/c4: a refresh writes each model's catalog controls from its entry, and never an admin's", async () => {
    const tokenRef = await secretStore.put({ organizationId: world.organizationId, purpose: "model-provider.token" }, "sk-sync");
    if (!tokenRef.ok) {
      throw new Error("the fake secret store refused");
    }
    const baseUrl = `https://sync-${randomBytes(3).toString("hex")}.example/v1`;
    const provider = await test.db.modelProvider.create({
      data: { organizationId: world.organizationId, name: "Sync", baseUrl, apiFormat: "openai_compatible", authScheme: "bearer", tokenSecretRef: tokenRef.value },
    });
    const modelProvider = new FakeModelProvider();
    modelProvider.endpoints.set(baseUrl, {
      token: "sk-sync",
      models: [
        { endpointModelId: "gpt-5.5", displayName: null, contextWindow: null },
        { endpointModelId: "gpt-5.2-pro", displayName: null, contextWindow: null },
      ],
    });
    const entry = (catalogId: string, reasoning: ReasoningControls): CatalogEntry => ({
      catalogId,
      name: catalogId,
      aliases: [catalogId.split("/")[1] ?? catalogId],
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      inputPricePerMTok: 1,
      outputPricePerMTok: 10,
      cacheReadPricePerMTok: null,
      cacheWritePricePerMTok: null,
      logoPath: null,
      reasoning,
      reasoningPriceDiffers: false,
    });
    let catalog = [entry("openai/gpt-5.5", reasoningControlsFixtures.effort), entry("openai/gpt-5.2-pro", reasoningControlsFixtures.effortNoLow)];
    const sync = () =>
      syncProviderModels(
        { db: test.db, notices: postgresChangeNotices, clock: systemClock, adapters: { codeHost, secretStore, modelProvider }, catalog: () => Promise.resolve(catalog) },
        { organizationId: world.organizationId, providerId: providerIdSchema.parse(provider.id) },
      );
    expect(await sync()).toMatchObject({ ok: true, matched: 2 });
    const rows = async () =>
      (await test.db.model.findMany({ where: { providerId: provider.id }, orderBy: { endpointModelId: "asc" } })).map((row) => {
        const model = mapModel(row);
        return { endpointModelId: model.endpointModelId, catalogReasoning: model.catalogReasoning, adminReasoning: model.adminReasoning };
      });
    expect(await rows()).toEqual([
      { endpointModelId: "gpt-5.2-pro", catalogReasoning: reasoningControlsFixtures.effortNoLow, adminReasoning: null },
      { endpointModelId: "gpt-5.5", catalogReasoning: reasoningControlsFixtures.effort, adminReasoning: null },
    ]);
    // An admin sets one model's controls; the catalog then changes, and a refresh writes only its own.
    await test.db.model.updateMany({ where: { providerId: provider.id, endpointModelId: "gpt-5.5" }, data: { adminReasoning: reasoningControlsFixtures.toggle } });
    catalog = [entry("openai/gpt-5.5", reasoningControlsFixtures.budget), entry("openai/gpt-5.2-pro", { supported: false })];
    expect(await sync()).toMatchObject({ ok: true, matched: 2 });
    expect(await rows()).toEqual([
      { endpointModelId: "gpt-5.2-pro", catalogReasoning: { supported: false }, adminReasoning: null },
      { endpointModelId: "gpt-5.5", catalogReasoning: reasoningControlsFixtures.budget, adminReasoning: reasoningControlsFixtures.toggle },
    ]);
  });
});

describe("ingest", () => {
  it("F-137/c8,c11,c12: a turn stores its level and its reasoning tokens, and the session sums them; spend prices all output at the output price", async () => {
    const runner = await runnerAt(3);
    const { modelId, profileId } = await modelAndProfile({ catalogReasoning: reasoningControlsFixtures.effortNoLow });
    await test.db.model.update({ where: { id: modelId }, data: { inputPricePerMTok: 1, outputPricePerMTok: 10 } });
    const queued = await queuedAt("high", profileId, runner.runnerId);
    const task = await acceptedTask({ db: test.db, jobs, ingest, logger }, world, fixture.a.member, runner, queued);
    const usage = (outputTokens: number, reasoningTokens: number) =>
      ({
        kind: "usage.recorded",
        providerId: providerIdSchema.parse(world.providerId),
        modelId: modelIdSchema.parse(modelId),
        inputTokens: 1_000,
        outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimated: false,
        reasoningTokens,
      }) as const;
    const first = turnIdSchema.parse("turn-1");
    const second = turnIdSchema.parse("turn-2");
    await task.send(
      { kind: "turn.started", turnId: first, effort: "xhigh", adjustedFrom: "max" },
      usage(2_000, 1_500),
      usage(1_000, 600),
      { kind: "turn.ended", turnId: first, stopReason: "end_turn" },
      { kind: "turn.started", turnId: second, effort: "medium" },
      usage(500, 0),
      { kind: "turn.ended", turnId: second, stopReason: "end_turn" },
    );
    const turns = await test.db.turn.findMany({
      where: { sessionId: task.sessionId },
      orderBy: { ordinal: "asc" },
      select: { effort: true, effortAdjustedFrom: true, outputTokens: true, reasoningTokens: true, spentMicroUsd: true },
    });
    // Each kilotoken of input costs 1,000 µ$ and of output 10,000 µ$: reasoning is priced as output, within it.
    expect(turns).toEqual([
      { effort: "xhigh", effortAdjustedFrom: "max", outputTokens: 3_000, reasoningTokens: 2_100, spentMicroUsd: 2 * 1_000 + 30_000 },
      { effort: "medium", effortAdjustedFrom: null, outputTokens: 500, reasoningTokens: 0, spentMicroUsd: 1_000 + 5_000 },
    ]);
    const session = await test.db.session.findUniqueOrThrow({ where: { id: task.sessionId }, select: { outputTokens: true, reasoningTokens: true, spentMicroUsd: true } });
    expect(session).toEqual({ outputTokens: 3_500, reasoningTokens: 2_100, spentMicroUsd: 38_000 });
  });
});
