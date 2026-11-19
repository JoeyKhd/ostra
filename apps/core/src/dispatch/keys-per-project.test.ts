import { randomBytes, randomUUID } from "node:crypto";

import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { Prisma } from "@ostra/db";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, SeededMember, TestDatabase } from "@ostra/db/testing";
import {
  createPromptTask,
  dispatchTask,
  dispatchWaitFromDb,
  holdProviderInTx,
  postgresAuditLog,
  postgresChangeNotices,
  postgresCommandOutbox,
  releaseProviderBoxes,
  sendMemberMessageInTx,
  systemClock,
} from "@ostra/domain";
import type { MemberScope, SessionTimers } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { clientMessageIdSchema, modelIdSchema, projectIdSchema, providerIdSchema, runnerPaths, sessionIdSchema, taskCredentialsSchema, taskSpecSchema, turnIdSchema } from "@ostra/protocol";
import type { ModelId, ProjectId, ProviderId, TaskId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RunnerRef } from "../gateway/context.ts";
import { createIngest } from "../ingest/ingest.ts";
import type { Ingest } from "../ingest/ingest.ts";
import { createLiveTextWriter } from "../ingest/live-text.ts";
import type { LiveTextWriter } from "../ingest/live-text.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { accessToken, postJson, registerPersonal, startGateway } from "../testing/harness.ts";
import type { GatewayHarness, RegisteredRunner } from "../testing/harness.ts";
import { acceptedTask } from "../testing/turns.ts";
import type { DrivenTask } from "../testing/turns.ts";
import { dispatchPayload, INSTALLATION_ID, PROVIDER_TOKEN, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { QueuedTask, World } from "../testing/world.ts";
import { handleTaskEndpoint } from "./endpoints.ts";

// Ticket 48 (F-135, ADR 0065): keys per project at the dispatch, the credentials and every turn
// start. Two providers serve one model by name (the same models.dev catalog ID); each project may
// use only the providers on its own list. Proved with the fake adapters and a stub second key: the
// live two-client run is the maintainer's step (ticket 55).

const CATALOG_ID = "anthropic/claude-sonnet-4-5";
const TOKEN_B = `sk-client-b-${randomBytes(12).toString("hex")}`;

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let world: World;
let harness: GatewayHarness;
let runner: RegisteredRunner;
let runnerRef: RunnerRef;
let ingest: Ingest;
let liveText: LiveTextWriter;
let modelA: ModelId;
let providerB: ProviderId;
let modelB: ModelId;
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const records: LogRecord[] = [];
const logger = createLogger((record) => records.push(record));
const turnId = turnIdSchema.parse("turn-1");

const domainDeps = () => ({ jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, logger });
const dispatch = (task: QueuedTask, epoch = 1) => test.db.$transaction((tx) => dispatchTask({ tx, ...domainDeps() }, dispatchPayload(task, epoch)));
const scopeOf = (member: SeededMember): MemberScope => ({ organizationId: member.organizationId, memberId: member.id, role: member.role === "admin" ? "admin" : "member", projectRoles: new Map() });

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  const organizationId = world.organizationId;
  // Provider A's row is the catalog's model; provider B, a client's own key, lists the same model.
  const profile = await test.db.agentProfile.findUniqueOrThrow({ where: { id: world.profileId } });
  modelA = modelIdSchema.parse(profile.modelId);
  await test.db.model.update({ where: { id: modelA }, data: { catalogId: CATALOG_ID, inputPricePerMTok: new Prisma.Decimal(3), outputPricePerMTok: new Prisma.Decimal(15) } });
  const tokenRef = await secretStore.put({ organizationId, purpose: "model-provider.token" }, TOKEN_B);
  if (!tokenRef.ok) {
    throw new Error("the fake secret store refused");
  }
  const b = await test.db.modelProvider.create({
    data: {
      organizationId,
      name: "Client B endpoint",
      baseUrl: "https://client-b.example/v1",
      apiFormat: "openai_compatible",
      authScheme: "bearer",
      tokenSecretRef: tokenRef.value,
      allowOnPersonalRunners: true,
    },
  });
  providerB = providerIdSchema.parse(b.id);
  modelB = modelIdSchema.parse(
    (
      await test.db.model.create({
        data: { organizationId, providerId: b.id, endpointModelId: "claude-sonnet-4-5-b", catalogId: CATALOG_ID, inputPricePerMTok: new Prisma.Decimal(5), outputPricePerMTok: new Prisma.Decimal(25) },
      })
    ).id,
  );
  harness = await startGateway(test.db, test.url, {}, (gateway) => [
    handleTaskEndpoint({
      db: test.db,
      tokens: gateway.context.tokens,
      taskTokens: gateway.context.taskTokens,
      adapters: { codeHost, secretStore, modelProvider: new FakeModelProvider() },
      audit: postgresAuditLog,
      clock: systemClock,
      signingKey: randomBytes(32),
      logger,
    }),
  ]);
  runner = await registerPersonal(harness, test.db, fixture.a.member);
  await test.db.runner.update({ where: { id: runner.runnerId }, data: { state: "online", capacity: 50 } });
  await test.db.runnerPresence.create({ data: { runnerId: runner.runnerId, organizationId, replicaId: "test", connectionEpoch: 1, carrier: "websocket", minor: 2 } });
  runnerRef = { runnerId: runner.runnerId, organizationId };
  const timers: SessionTimers = { sessionMaxMs: 120 * 60_000, boxReleaseIdleMs: 14 * 24 * 3_600_000, cancelInTx: (tx, job, payload) => jobs.cancelInTx(tx, job, payload) };
  liveText = createLiveTextWriter({ db: test.db, logger });
  ingest = createIngest({ db: test.db, jobs, notices: postgresChangeNotices, clock: systemClock, liveText, logger, timers, outbox: postgresCommandOutbox });
});

afterAll(async () => {
  await harness.stop();
  await liveText.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

let projectCount = 0;

/** A project of organization A with its own provider list and one repo of its own, as `World` describes it. */
const projectWith = async (providerIds: readonly ProviderId[]): Promise<World> => {
  projectCount += 1;
  const organizationId = world.organizationId;
  const project = await test.db.project.create({ data: { organizationId, name: `keys ${String(projectCount)}`, slug: `keys-${String(projectCount)}-${randomUUID().slice(0, 6)}`, access: "open", ownProviders: true } });
  for (const providerId of providerIds) {
    await test.db.providerListEntry.create({ data: { organizationId, projectId: project.id, providerId } });
  }
  const connection = await test.db.connection.findFirstOrThrow({ where: { organizationId, kind: "github" } });
  const fullName = `ostra-test/keys-${String(projectCount)}`;
  codeHost.repos.set(INSTALLATION_ID, [
    ...(codeHost.repos.get(INSTALLATION_ID) ?? []),
    { hostRepoId: `host-${fullName}`, fullName, defaultBranch: "main", private: true, cloneUrl: `https://github.example/${fullName}.git` },
  ]);
  const repo = await test.db.repo.create({
    data: { organizationId, projectId: project.id, connectionId: connection.id, installationId: INSTALLATION_ID, hostRepoId: `host-${fullName}`, fullName, defaultBranch: "main", checkoutDir: `keys-${String(projectCount)}` },
  });
  return { ...world, projectId: projectIdSchema.parse(project.id), repoId: repo.id };
};

const setList = async (projectId: ProjectId, providerIds: readonly ProviderId[]): Promise<void> => {
  await test.db.providerListEntry.deleteMany({ where: { projectId } });
  await test.db.modelChoice.deleteMany({ where: { projectId } });
  for (const providerId of providerIds) {
    await test.db.providerListEntry.create({ data: { organizationId: world.organizationId, projectId, providerId } });
  }
};

const sessionRow = (sessionId: string) => test.db.session.findUniqueOrThrow({ where: { id: sessionId } });

/** A task whose session is going: dispatched, accepted, one turn run and ended, the box idle. */
const goingTask = async (on: World): Promise<DrivenTask> => {
  const task = await acceptedTask({ db: test.db, jobs, ingest, logger }, on, fixture.a.member, runnerRef);
  await task.send({ kind: "turn.started", turnId }, { kind: "turn.ended", turnId, stopReason: "end_turn" });
  await test.db.task.update({ where: { id: task.taskId }, data: { state: "running", subState: null, needsYouReason: null } });
  const session = await sessionRow(task.sessionId);
  if (session.boxId !== null) {
    await test.db.box.update({ where: { id: session.boxId }, data: { state: "idle" } });
  }
  return task;
};

const send = (task: { readonly taskId: TaskId }, text: string) =>
  test.db.$transaction((tx) =>
    sendMemberMessageInTx(domainDeps(), tx, scopeOf(fixture.a.member), {
      taskId: task.taskId,
      clientMessageId: clientMessageIdSchema.parse(randomUUID()),
      text,
      intent: "message",
      sender: "driver",
    }),
  );

describe("keys per project at the dispatch and the credentials", () => {
  it("F-135: a task in one project never gets the token of a provider allowed only in another", async () => {
    const projectA = await projectWith([world.providerId]);
    const projectB = await projectWith([providerB]);
    const taskA = await seedQueuedTask(test.db, projectA, fixture.a.member, runner.runnerId);
    const taskB = await seedQueuedTask(test.db, projectB, fixture.a.member, runner.runnerId);
    expect(await dispatch(taskA)).toMatchObject({ ok: true });
    expect(await dispatch(taskB)).toMatchObject({ ok: true });
    // Each start resolved the model through its own project's list, and recorded it.
    expect(await sessionRow(taskA.sessionId)).toMatchObject({ providerId: world.providerId, modelId: modelA });
    expect(await sessionRow(taskB.sessionId)).toMatchObject({ providerId: providerB, modelId: modelB });

    const token = (await accessToken(harness, runner)).accessToken;
    const spec = async (task: QueuedTask) => fetch(`${harness.url}${runnerPaths.taskSpec(task.taskId)}?leaseEpoch=1`, { headers: { authorization: `Bearer ${token}` } });
    const credentials = (task: QueuedTask) => postJson(`${harness.url}${runnerPaths.taskCredentials(task.taskId)}`, { taskId: task.taskId, leaseEpoch: 1 }, token);
    expect(taskSpecSchema.parse(await (await spec(taskA)).json()).agent).toMatchObject({ providerId: world.providerId, modelId: modelA, endpointModelId: "dev-model-1" });
    expect(taskSpecSchema.parse(await (await spec(taskB)).json()).agent).toMatchObject({ providerId: providerB, modelId: modelB, endpointModelId: "claude-sonnet-4-5-b", apiFormat: "openai-compatible" });
    const issuedA = await credentials(taskA);
    const issuedB = await credentials(taskB);
    expect(issuedA.status).toBe(200);
    expect(issuedB.status).toBe(200);
    expect(taskCredentialsSchema.parse(issuedA.body).model.token).toBe(PROVIDER_TOKEN);
    expect(taskCredentialsSchema.parse(issuedB.body).model.token).toBe(TOKEN_B);
    // Searched by value, never printed.
    expect(JSON.stringify(issuedA.body).includes(TOKEN_B)).toBe(false);
    expect(JSON.stringify(issuedB.body).includes(PROVIDER_TOKEN)).toBe(false);

    // The first task's session row is edited to name the second provider and its model row.
    await test.db.session.update({ where: { id: taskA.sessionId }, data: { providerId: providerB, modelId: modelB } });
    records.length = 0;
    const refused = await credentials(taskA);
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body).includes(TOKEN_B)).toBe(false);
    // The spec isn't built on the forged row either.
    const forgedSpec = await spec(taskA);
    expect(forgedSpec.status).toBe(403);
    expect((await forgedSpec.text()).includes(TOKEN_B)).toBe(false);
    const audit = await test.db.auditEntry.findFirst({ where: { action: "task.credentials-refused", entityId: taskA.taskId } });
    expect(audit).toMatchObject({ organizationId: world.organizationId, projectId: projectA.projectId });
    expect(records.some((record) => record.message === "task.credentials-refused")).toBe(true);
    expect(JSON.stringify(records).includes(TOKEN_B)).toBe(false);

    // A queued task whose session row names the second provider is never sent.
    const forged = await seedQueuedTask(test.db, projectA, fixture.a.member, runner.runnerId);
    await test.db.session.update({ where: { id: forged.sessionId }, data: { providerId: providerB, modelId: modelB } });
    expect(await dispatch(forged)).toMatchObject({ ok: false, error: "no-runner", message: "provider-not-allowed" });
    expect(await test.db.lease.count({ where: { taskId: forged.taskId } })).toBe(0);
    expect(await test.db.command.count({ where: { taskId: forged.taskId } })).toBe(0);
    expect(dispatchWaitFromDb((await test.db.task.findUniqueOrThrow({ where: { id: forged.taskId } })).dispatchWait)).toEqual({ code: "provider-not-allowed" });
  });
});

describe("keys per project at every turn start", () => {
  it("F-135: a turn start after a list change: open steers into the box, moved starts in a fresh box on the new provider, none holds the message with the reason", async () => {
    const project = await projectWith([world.providerId]);
    // open: nothing changed, the message is a steer into the going session.
    const task = await goingTask(project);
    const opened = await send(task, "Carry on with the README");
    expect(opened).toMatchObject({ ok: true, delivery: "steer", sessionId: task.sessionId });
    expect(await test.db.command.count({ where: { taskId: task.taskId, kind: "steer" } })).toBe(1);

    // moved: an admin puts provider B on the list and chooses it for the model.
    await setList(project.projectId, [world.providerId, providerB]);
    await test.db.modelChoice.create({
      data: { organizationId: world.organizationId, projectId: project.projectId, modelKey: `catalog:${CATALOG_ID}`, modelCatalogId: CATALOG_ID, modelId: modelB, reason: "admin" },
    });
    const oldSession = await sessionRow(task.sessionId);
    const moved = await send(task, "Now the CHANGELOG");
    expect(moved).toMatchObject({ ok: true, delivery: "reopen" });
    if (!moved.ok) {
      throw new Error("the send was refused");
    }
    expect(moved.sessionId).not.toBe(task.sessionId);
    expect(await test.db.command.count({ where: { taskId: task.taskId, kind: "steer" } })).toBe(1);
    expect((await sessionRow(task.sessionId)).state).toBe("stopped");
    expect(await sessionRow(moved.sessionId)).toMatchObject({ state: "starting", providerId: providerB, modelId: modelB });
    const queued = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    expect(queued.state).toBe("queued");
    const granted = await dispatch({ ...task, sessionId: sessionIdSchema.parse(moved.sessionId) }, queued.leaseEpoch + 1);
    expect(granted).toMatchObject({ ok: true });
    // A fresh box: the kept one holds provider A's key.
    const lease = await test.db.lease.findFirstOrThrow({ where: { taskId: task.taskId, state: "active" } });
    expect(lease.boxId).not.toBe(oldSession.boxId);
    expect(await test.db.event.count({ where: { sessionId: moved.sessionId, kind: "user.message" } })).toBeGreaterThan(0);

    // none: nothing on another project's list serves the model any more.
    const other = await projectWith([world.providerId]);
    const second = await goingTask(other);
    await setList(other.projectId, []);
    const held = await send(second, "Fix the failing test");
    expect(held).toMatchObject({ ok: true, delivery: "reopen" });
    if (!held.ok) {
      throw new Error("the send was refused");
    }
    expect(await test.db.command.count({ where: { taskId: second.taskId, kind: "steer" } })).toBe(0);
    expect(await sessionRow(held.sessionId)).toMatchObject({ state: "starting", providerId: null, modelId: null });
    const heldRow = await test.db.task.findUniqueOrThrow({ where: { id: second.taskId } });
    expect(await dispatch({ ...second, sessionId: sessionIdSchema.parse(held.sessionId) }, heldRow.leaseEpoch + 1)).toMatchObject({ ok: false, message: "no-provider-for-model" });
    const waiting = await test.db.task.findUniqueOrThrow({ where: { id: second.taskId } });
    expect(waiting.state).toBe("queued");
    expect(dispatchWaitFromDb(waiting.dispatchWait)).toEqual({ code: "no-provider-for-model", modelName: CATALOG_ID });
    expect(await test.db.needsYouItem.findFirst({ where: { taskId: second.taskId, state: "open" } })).toMatchObject({ reason: "no_provider_for_model", audience: "organization_admins" });
    // The message is kept in the new session's thread, for the turn that runs once a provider serves it.
    expect(await test.db.event.count({ where: { sessionId: held.sessionId, kind: "user.message" } })).toBeGreaterThan(0);
  });

  it("F-135: after a list change idle boxes holding the removed key are released at once, and a running turn's box after its turn", async () => {
    const project = await projectWith([world.providerId]);
    const idle = await goingTask(project);
    const busy = await goingTask(project);
    await busy.send({ kind: "turn.started", turnId: turnIdSchema.parse("turn-2") });
    expect((await sessionRow(busy.sessionId)).state).toBe("running");
    // A project that keeps the key keeps its boxes.
    const keeps = await projectWith([world.providerId]);
    const kept = await goingTask(keeps);
    await setList(project.projectId, [providerB]);
    const deps = { db: test.db, outbox: postgresCommandOutbox, jobs, notices: postgresChangeNotices, clock: systemClock };
    expect(await releaseProviderBoxes(deps, { organizationId: world.organizationId, projectId: project.projectId })).toMatchObject({ released: 1, waiting: 1 });
    const boxOf = async (task: DrivenTask) => test.db.box.findUniqueOrThrow({ where: { id: (await sessionRow(task.sessionId)).boxId ?? "" } });
    expect((await boxOf(idle)).state).toBe("released");
    expect(await test.db.command.count({ where: { taskId: idle.taskId, kind: "release" } })).toBe(1);
    expect((await boxOf(busy)).state).not.toBe("released");
    expect(await test.db.command.count({ where: { taskId: busy.taskId, kind: "release" } })).toBe(0);
    // The turn ends: the job's next run releases it.
    await busy.send({ kind: "turn.ended", turnId: turnIdSchema.parse("turn-2"), stopReason: "end_turn" });
    expect(await releaseProviderBoxes(deps, { organizationId: world.organizationId, projectId: project.projectId })).toMatchObject({ released: 1, waiting: 0 });
    expect((await boxOf(busy)).state).toBe("released");
    expect((await boxOf(kept)).state).not.toBe("released");
    expect(await releaseProviderBoxes(deps, { organizationId: world.organizationId, projectId: keeps.projectId })).toMatchObject({ released: 0, waiting: 0 });
  });

  it("F-135: a rate limit, a cap and an endpoint error each leave the task on its provider", async () => {
    const project = await projectWith([world.providerId]);
    // Another project serves the same model from provider B: nothing moves a task there.
    await projectWith([providerB]);
    const held = await seedQueuedTask(test.db, project, fixture.a.member, runner.runnerId);
    await test.db.$transaction((tx) => holdProviderInTx(tx, world.organizationId, world.providerId, new Date(Date.now() + 60_000)));
    try {
      expect(await dispatch(held)).toMatchObject({ ok: false, message: "provider-held" });
      expect(await sessionRow(held.sessionId)).toMatchObject({ providerId: world.providerId, modelId: modelA });
    } finally {
      await test.db.modelProvider.update({ where: { id: world.providerId }, data: { dispatchHeldUntil: null } });
    }
    // The key proxy's rate limit holds the provider the session recorded, not one the event names.
    const going = await goingTask(project);
    await going.send({ kind: "provider.rate_limited", providerId: providerB, retryAfterSeconds: 30 });
    expect((await test.db.modelProvider.findUniqueOrThrow({ where: { id: providerB } })).dispatchHeldUntil).toBeNull();
    await going.send({ kind: "provider.rate_limited", providerId: world.providerId, retryAfterSeconds: 30 });
    expect((await test.db.modelProvider.findUniqueOrThrow({ where: { id: world.providerId } })).dispatchHeldUntil).not.toBeNull();
    await test.db.modelProvider.update({ where: { id: world.providerId }, data: { dispatchHeldUntil: null } });

    await test.db.modelProvider.update({ where: { id: world.providerId }, data: { sessionsAtOnce: 1 } });
    try {
      const capped = await seedQueuedTask(test.db, project, fixture.a.member, runner.runnerId);
      expect(await dispatch(capped)).toMatchObject({ ok: false, message: "provider-cap" });
      expect(await sessionRow(capped.sessionId)).toMatchObject({ providerId: world.providerId, modelId: modelA });
    } finally {
      await test.db.modelProvider.update({ where: { id: world.providerId }, data: { sessionsAtOnce: null } });
    }

    // An endpoint error fails the turn; the next message goes to the same session on the same key.
    await going.send({ kind: "turn.started", turnId: turnIdSchema.parse("turn-3") }, { kind: "turn.failed", turnId: turnIdSchema.parse("turn-3"), error: "the model endpoint answered 502" });
    await test.db.task.update({ where: { id: going.taskId }, data: { state: "running", subState: null, needsYouReason: null } });
    const after = await send(going, "Try again");
    expect(after).toMatchObject({ ok: true, delivery: "steer", sessionId: going.sessionId });
    expect(await sessionRow(going.sessionId)).toMatchObject({ providerId: world.providerId, modelId: modelA });
    expect(await test.db.session.count({ where: { taskId: going.taskId } })).toBe(1);
  });

  it("F-135: a provider's cap counts its sessions in every project, and personal runners are refused in every project", async () => {
    const here = await projectWith([world.providerId]);
    const there = await projectWith([world.providerId]);
    // Earlier cases leave leases: end them, so the count starts at zero.
    await test.db.lease.updateMany({ where: { organizationId: world.organizationId, state: "active" }, data: { state: "ended" } });
    await test.db.modelProvider.update({ where: { id: world.providerId }, data: { sessionsAtOnce: 1 } });
    try {
      const elsewhere = await seedQueuedTask(test.db, there, fixture.a.member, runner.runnerId);
      expect(await dispatch(elsewhere)).toMatchObject({ ok: true });
      const waiting = await seedQueuedTask(test.db, here, fixture.a.member, runner.runnerId);
      // One session on the provider runs in another project: this one waits for the cap.
      expect(await dispatch(waiting)).toMatchObject({ ok: false, message: "provider-cap" });
      await test.db.lease.updateMany({ where: { taskId: elsewhere.taskId, state: "active" }, data: { state: "ended" } });
      expect(await dispatch(waiting)).toMatchObject({ ok: true });
    } finally {
      await test.db.modelProvider.update({ where: { id: world.providerId }, data: { sessionsAtOnce: null } });
    }

    const onB = await projectWith([providerB]);
    await test.db.modelProvider.update({ where: { id: world.providerId }, data: { allowOnPersonalRunners: false } });
    try {
      for (const project of [here, there]) {
        // The prompt task refuses before it makes anything, and the dispatch refuses one already queued.
        const refused = await test.db.$transaction((tx) =>
          createPromptTask({ tx, scope: scopeOf(fixture.a.member), ...domainDeps() }, { projectId: project.projectId, prompt: "Add a CONTRIBUTING.md", runnerId: runner.runnerId }),
        );
        expect(refused).toMatchObject({ ok: false, error: "provider-not-allowed-on-personal-runners" });
        const queued = await seedQueuedTask(test.db, project, fixture.a.member, runner.runnerId);
        expect(await dispatch(queued)).toMatchObject({ ok: false, message: "personal-runner-not-allowed" });
      }
      // The resolved provider is checked: the project on provider B, which allows personal runners, runs there.
      const started = await test.db.$transaction((tx) =>
        createPromptTask({ tx, scope: scopeOf(fixture.a.member), ...domainDeps() }, { projectId: onB.projectId, prompt: "Add a CONTRIBUTING.md", runnerId: runner.runnerId }),
      );
      expect(started).toMatchObject({ ok: true });
      if (started.ok) {
        expect(await sessionRow(started.sessionId)).toMatchObject({ providerId: providerB, modelId: modelB });
      }
    } finally {
      await test.db.modelProvider.update({ where: { id: world.providerId }, data: { allowOnPersonalRunners: true } });
    }
  });
});

describe("spend per provider", () => {
  it("F-135: usage is priced from each session's own model row and counted against its provider, and a mismatched usage event is logged and counted as the session's", async () => {
    const onA = await projectWith([world.providerId]);
    const onB = await projectWith([providerB]);
    const taskA = await goingTask(onA);
    const taskB = await goingTask(onB);
    const usage = (providerId: ProviderId, modelId: ModelId) =>
      ({ kind: "usage.recorded", providerId, modelId, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimated: false }) as const;
    await taskA.send(usage(world.providerId, modelA));
    await taskB.send(usage(providerB, modelB));
    // 1M input tokens: $3 on provider A's row, $5 on provider B's.
    expect((await sessionRow(taskA.sessionId)).spentMicroUsd).toBe(3_000_000);
    expect((await sessionRow(taskB.sessionId)).spentMicroUsd).toBe(5_000_000);
    // A's runner names B's provider and row: logged, and priced and counted as A's own.
    records.length = 0;
    await taskA.send(usage(providerB, modelB));
    expect(records.filter((record) => record.message === "usage.provider-mismatch")).toHaveLength(1);
    expect((await sessionRow(taskA.sessionId)).spentMicroUsd).toBe(6_000_000);
    expect((await sessionRow(taskB.sessionId)).spentMicroUsd).toBe(5_000_000);
    const byProvider = await test.db.session.groupBy({
      by: ["providerId"],
      where: { id: { in: [taskA.sessionId, taskB.sessionId] } },
      _sum: { spentMicroUsd: true },
      orderBy: { providerId: "asc" },
    });
    expect(Object.fromEntries(byProvider.map((row) => [row.providerId, row._sum.spentMicroUsd]))).toEqual({ [world.providerId]: 6_000_000, [providerB]: 5_000_000 });
    // The day's rollup (ticket 12) is keyed by each session's own model row: B's row has none of A's spend.
    const rollup = async (projectId: ProjectId, modelId: ModelId) =>
      (await test.db.spendDaily.findMany({ where: { projectId, modelId } })).reduce((sum, row) => sum + Number(row.spentMicroUsd), 0);
    expect(await rollup(onA.projectId, modelA)).toBe(6_000_000);
    expect(await rollup(onA.projectId, modelB)).toBe(0);
    expect(await rollup(onB.projectId, modelB)).toBe(5_000_000);
    // A matching event logs nothing.
    records.length = 0;
    await taskB.send(usage(providerB, modelB));
    expect(records.some((record) => record.message === "usage.provider-mismatch")).toBe(false);
    expect((await sessionRow(taskB.sessionId)).spentMicroUsd).toBe(10_000_000);
  });
});
