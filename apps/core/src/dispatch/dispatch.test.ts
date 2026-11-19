import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { createLogger, systemClock as adapterClock } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { GitHubAdapter } from "@ostra/adapter-github";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { dispatchTask, holdProviderInTx, postgresAuditLog, postgresChangeNotices, postgresCommandOutbox, systemClock } from "@ostra/domain";
import { createJobs, jobIdSchema } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { repoFullNameSchema, runnerPaths, taskCredentialsSchema, taskSpecSchema } from "@ostra/protocol";
import type { CommandSeq } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { postJson, registerPersonal, accessToken, startGateway } from "../testing/harness.ts";
import type { GatewayHarness, RegisteredRunner } from "../testing/harness.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { dispatchPayload, ENV_SECRET, PROVIDER_TOKEN, seedOnlineRunner, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";
import { applyOfferResultsInTx, offerTimeoutHandler, requeueQueuedTasks } from "./dispatcher.ts";
import type { DispatcherDeps } from "./dispatcher.ts";
import { handleTaskEndpoint } from "./endpoints.ts";

// Ticket 26's cases, with fake adapters (spec section 8), and a live one gated on github.env.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let world: World;
let otherWorld: World;
let harness: GatewayHarness;
let deps: DispatcherDeps;
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const records: LogRecord[] = [];
const logger = createLogger((record) => records.push(record));

const dispatch = (payload: ReturnType<typeof dispatchPayload>) =>
  test.db.$transaction((tx) => dispatchTask({ tx, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock, logger }, payload));

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  otherWorld = await seedWorld(test.db, { codeHost, secretStore }, fixture.b.organization.id, fixture.b.project.id, { fullName: "other-org/repo" });
  deps = { db: test.db, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock, logger };
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
});

afterAll(async () => {
  await harness.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

describe("dispatch", () => {
  it("a task for a personal runner goes only to that member's runner, with a lease, a box, the command and the offer timer", async () => {
    const theirs = await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "personal", memberId: fixture.a.insider.id }, 4);
    const ours = await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "personal", memberId: fixture.a.member.id });
    const otherOrg = await seedOnlineRunner(test.db, fixture.b.organization.id, { kind: "personal", memberId: fixture.b.admin.id }, 8);
    const task = await seedQueuedTask(test.db, world, fixture.a.member, ours.runnerId);
    const result = await dispatch(dispatchPayload(task));
    expect(result).toMatchObject({ ok: true, runnerId: ours.runnerId, leaseEpoch: 1 });
    const row = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    expect(row).toMatchObject({ state: "queued", leaseEpoch: 1, dispatchNote: null });
    const lease = await test.db.lease.findFirstOrThrow({ where: { taskId: task.taskId } });
    expect(lease).toMatchObject({ epoch: 1, runnerId: ours.runnerId, state: "active", acceptedAt: null });
    const command = await test.db.command.findFirstOrThrow({ where: { taskId: task.taskId } });
    expect(command).toMatchObject({ runnerId: ours.runnerId, kind: "dispatch" });
    expect(command.body).toMatchObject({ taskId: task.taskId, sessionId: task.sessionId, leaseEpoch: 1, boxId: lease.boxId });
    expect(await test.db.command.count({ where: { runnerId: { in: [theirs.runnerId, otherOrg.runnerId] } } })).toBe(0);
    const timer = await jobs.find("task.offer-timeout", { organizationId: task.organizationId, taskId: task.taskId, leaseEpoch: 1 });
    expect(timer.map((job) => job.state)).toEqual(["created"]);
    // The same job again is stale: the epoch it grants is taken.
    expect(await dispatch(dispatchPayload(task))).toMatchObject({ ok: false, error: "stale" });
  });

  it("a provider not allowed on personal runners blocks it, with the reason on the task", async () => {
    await test.db.modelProvider.update({ where: { id: world.providerId }, data: { allowOnPersonalRunners: false } });
    try {
      const ours = await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "personal", memberId: fixture.a.member.id });
      const task = await seedQueuedTask(test.db, world, fixture.a.member, ours.runnerId);
      expect(await dispatch(dispatchPayload(task))).toMatchObject({ ok: false, error: "no-runner" });
      const row = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
      expect(row.state).toBe("queued");
      expect(row.dispatchNote).toContain("isn't allowed on personal runners");
      expect(await test.db.lease.count({ where: { taskId: task.taskId } })).toBe(0);
    } finally {
      await test.db.modelProvider.update({ where: { id: world.providerId }, data: { allowOnPersonalRunners: true } });
    }
  });

  it("a task with no picked runner goes to a pool runner of the default pool, never to a personal one or another organization's", async () => {
    const pool = await test.db.runnerPool.create({ data: { organizationId: fixture.a.organization.id, name: "default", isDefault: true } });
    const poolRunner = await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "pool", poolId: pool.id }, 2);
    const task = await seedQueuedTask(test.db, world, fixture.a.member, null);
    expect(await dispatch(dispatchPayload(task))).toMatchObject({ ok: true, runnerId: poolRunner.runnerId });
  });

  it("a rate-limit hold delays the next dispatch, and the dispatch goes once it ends", async () => {
    const ours = await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "personal", memberId: fixture.a.member.id });
    const task = await seedQueuedTask(test.db, world, fixture.a.member, ours.runnerId);
    await test.db.$transaction((tx) => holdProviderInTx(tx, world.organizationId, world.providerId, new Date(Date.now() + 60_000)));
    expect(await dispatch(dispatchPayload(task))).toMatchObject({ ok: false, error: "no-runner" });
    expect((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).dispatchNote).toContain("rate limit");
    // Another organization's hold on its own provider doesn't touch ours, nor ours theirs.
    expect((await test.db.modelProvider.findUniqueOrThrow({ where: { id: otherWorld.providerId } })).dispatchHeldUntil).toBeNull();
    await test.db.modelProvider.update({ where: { id: world.providerId }, data: { dispatchHeldUntil: new Date(Date.now() - 1_000) } });
    expect(await dispatch(dispatchPayload(task))).toMatchObject({ ok: true, runnerId: ours.runnerId });
  });

  it("F-088: a provider's sessions-at-once cap holds a dispatch while it is reached, and lets it go once a session stops", async () => {
    // Other cases leave leases on this provider: end them, so the count starts at zero.
    await test.db.lease.updateMany({ where: { organizationId: world.organizationId, state: "active" }, data: { state: "ended" } });
    const runner = await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "personal", memberId: fixture.a.member.id }, 8);
    await test.db.modelProvider.update({ where: { id: world.providerId }, data: { sessionsAtOnce: 2 } });
    try {
      const first = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
      const second = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
      const third = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
      expect(await dispatch(dispatchPayload(first))).toMatchObject({ ok: true });
      expect(await dispatch(dispatchPayload(second))).toMatchObject({ ok: true });
      // Two sessions run on the provider: the third waits, though the runner has room, with the reason on the task.
      expect(await dispatch(dispatchPayload(third))).toMatchObject({ ok: false, error: "no-runner" });
      const waiting = await test.db.task.findUniqueOrThrow({ where: { id: third.taskId } });
      expect(waiting.dispatchNote).toContain("cap of 2 sessions at once");
      expect(await test.db.lease.count({ where: { taskId: third.taskId } })).toBe(0);
      // Another organization's sessions on its own provider don't count against ours.
      const theirs = await seedOnlineRunner(test.db, fixture.b.organization.id, { kind: "personal", memberId: fixture.b.admin.id }, 8);
      const theirTask = await seedQueuedTask(test.db, otherWorld, fixture.b.admin, theirs.runnerId);
      expect(await dispatch(dispatchPayload(theirTask))).toMatchObject({ ok: true });
      // The first session stops: the third goes.
      await test.db.session.update({ where: { id: first.sessionId }, data: { state: "stopped" } });
      expect(await dispatch(dispatchPayload(third))).toMatchObject({ ok: true, runnerId: runner.runnerId });
      // No cap: nothing waits on the provider.
      await test.db.modelProvider.update({ where: { id: world.providerId }, data: { sessionsAtOnce: null } });
      const fourth = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
      expect(await dispatch(dispatchPayload(fourth))).toMatchObject({ ok: true });
    } finally {
      await test.db.modelProvider.update({ where: { id: world.providerId }, data: { sessionsAtOnce: null } });
    }
  });

  it("an offer timeout ends the lease and requeues for the next epoch; the sweep sends dispatches for queued tasks", async () => {
    const ours = await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "personal", memberId: fixture.a.member.id });
    const task = await seedQueuedTask(test.db, world, fixture.a.member, ours.runnerId);
    await dispatch(dispatchPayload(task));
    const handler = offerTimeoutHandler(deps);
    await handler({
      job: "task.offer-timeout",
      jobId: jobIdSchema.parse(randomUUID()),
      key: null,
      retryCount: 0,
      payload: { organizationId: task.organizationId, taskId: task.taskId, leaseEpoch: 1 },
      logger,
    });
    const lease = await test.db.lease.findFirstOrThrow({ where: { taskId: task.taskId, epoch: 1 } });
    expect(lease).toMatchObject({ state: "ended", endReason: "offer-timeout" });
    const next = await jobs.find("task.dispatch", dispatchPayload(task, 2));
    expect(next).toHaveLength(1);
    // The sweep sends nothing twice: the epoch-2 job is already queued.
    await requeueQueuedTasks(deps);
    expect(await jobs.find("task.dispatch", dispatchPayload(task, 2))).toHaveLength(1);
  });

  it("an accepted offer moves the task to preparing; a rejected one requeues it", async () => {
    const ours = await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "personal", memberId: fixture.a.member.id }, 2);
    const accepted = await seedQueuedTask(test.db, world, fixture.a.member, ours.runnerId);
    const rejected = await seedQueuedTask(test.db, world, fixture.a.member, ours.runnerId);
    const a = await dispatch(dispatchPayload(accepted));
    const r = await dispatch(dispatchPayload(rejected));
    if (!a.ok || !r.ok) {
      throw new Error("dispatch failed");
    }
    const seqOf = async (commandId: string): Promise<CommandSeq> => (await test.db.command.findUniqueOrThrow({ where: { id: commandId } })).seq;
    await test.db.$transaction(async (tx) => {
      await applyOfferResultsInTx(deps, tx, ours, [
        { commandId: a.commandId, seq: await seqOf(a.commandId), kind: "dispatch", body: {}, taskId: accepted.taskId, result: "accepted", reason: null },
        { commandId: r.commandId, seq: await seqOf(r.commandId), kind: "dispatch", body: {}, taskId: rejected.taskId, result: "rejected", reason: "no-capacity" },
      ]);
    });
    expect((await test.db.task.findUniqueOrThrow({ where: { id: accepted.taskId } })).state).toBe("preparing");
    expect((await test.db.lease.findFirstOrThrow({ where: { taskId: accepted.taskId } })).acceptedAt).not.toBeNull();
    expect(await test.db.lease.findFirstOrThrow({ where: { taskId: rejected.taskId } })).toMatchObject({ state: "ended", endReason: "rejected" });
    expect(await jobs.find("task.dispatch", dispatchPayload(rejected, 2))).toHaveLength(1);
    // Another organization's runner answering our offer changes nothing.
    const intruder = await seedOnlineRunner(test.db, fixture.b.organization.id, { kind: "personal", memberId: fixture.b.admin.id });
    await test.db.$transaction(async (tx) => {
      await applyOfferResultsInTx(deps, tx, intruder, [
        { commandId: a.commandId, seq: await seqOf(a.commandId), kind: "dispatch", body: {}, taskId: accepted.taskId, result: "rejected", reason: null },
      ]);
    });
    expect((await test.db.lease.findFirstOrThrow({ where: { taskId: accepted.taskId } })).state).toBe("active");
  });
});

describe("the spec and the credentials", () => {
  let runner: RegisteredRunner;
  let task: Awaited<ReturnType<typeof seedQueuedTask>>;

  beforeAll(async () => {
    runner = await registerPersonal(harness, test.db, fixture.a.member);
    await test.db.runner.update({ where: { id: runner.runnerId }, data: { state: "online" } });
    await test.db.runnerPresence.create({
      data: { runnerId: runner.runnerId, organizationId: fixture.a.organization.id, replicaId: "test", connectionEpoch: 1, carrier: "websocket", minor: 0 },
    });
    task = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
    expect(await dispatch(dispatchPayload(task))).toMatchObject({ ok: true });
  });

  const specUrl = (epoch: number) => `${harness.url}${runnerPaths.taskSpec(task.taskId)}?leaseEpoch=${String(epoch)}`;

  it("hands the lease holder the spec: bot, co-author, template, LFS hosts, branch, variables and files, no secret", async () => {
    const token = await accessToken(harness, runner);
    const response = await fetch(specUrl(1), { headers: { authorization: `Bearer ${token.accessToken}` } });
    expect(response.status).toBe(200);
    const text = await response.text();
    const spec = taskSpecSchema.parse(JSON.parse(text));
    expect(spec.gitIdentity).toEqual({ name: "ostra-test[bot]", email: "1+ostra-test[bot]@users.noreply.github.com" });
    expect(spec.coAuthors).toEqual([{ name: "Ada Admin", email: "ada@example.com" }]);
    expect(spec.repos).toEqual([
      expect.objectContaining({
        fullName: "ostra-test/test1",
        cloneUrl: "https://github.example/ostra-test/test1.git",
        prTemplate: "## What\n\n## Why\n",
        lfsActionHosts: ["lfs.example.test"],
        checkoutDir: "test1",
      }),
    ]);
    expect(spec.branchName).toMatch(/^ostra\/[0-9a-f]{8}-add-a-short-contributing-md$/);
    expect(spec.agent).toMatchObject({ adapter: "opencode", endpointModelId: "dev-model-1", apiFormat: "anthropic-messages" });
    expect(spec.environment.repos[0]).toMatchObject({ variables: [{ name: "NODE_ENV", value: "test", availableDuringSetup: true }], files: [{ path: "config/dev.json", content: "{}" }] });
    expect(text).not.toContain(ENV_SECRET);
    expect(text).not.toContain(PROVIDER_TOKEN);
    // Another epoch is refused with the current one.
    const stale = await fetch(specUrl(2), { headers: { authorization: `Bearer ${token.accessToken}` } });
    expect(stale.status).toBe(409);
  });

  it("F-090: issues the credentials after the lease check, with a token narrowed to the one repo, and logs none of them", async () => {
    records.length = 0;
    const token = await accessToken(harness, runner);
    const response = await postJson(`${harness.url}${runnerPaths.taskCredentials(task.taskId)}`, { taskId: task.taskId, leaseEpoch: 1 }, token.accessToken);
    expect(response.status).toBe(200);
    const credentials = taskCredentialsSchema.parse(response.body);
    expect(credentials.model).toEqual({ baseUrl: "https://models.example/v1", apiFormat: "anthropic-messages", authScheme: "x-api-key", token: PROVIDER_TOKEN });
    expect(credentials.repos).toHaveLength(1);
    expect(credentials.secrets).toEqual([{ repoId: world.repoId, entries: [{ kind: "variable", name: "API_SECRET", value: ENV_SECRET, availableDuringSetup: false }] }]);
    const minted = codeHost.minted.at(-1);
    expect(minted).toMatchObject({ repo: "ostra-test/test1", installationId: "777" });
    // Exactly what a push needs: no other permission rides along.
    expect(minted?.permissions).toEqual({ contents: "write", metadata: "read" });
    expect(credentials.repos[0]?.gitToken).toBe(minted?.token);
    // No log line holds any of it.
    const logged = JSON.stringify(records);
    for (const secret of [PROVIDER_TOKEN, ENV_SECRET, credentials.mcpToken, credentials.repos[0]?.gitToken ?? "-"]) {
      expect(logged).not.toContain(secret);
    }
    expect(records.some((record) => record.message === "task.credentials-issued")).toBe(true);
    expect(await test.db.auditEntry.findFirst({ where: { action: "task.credentials-issued", entityId: task.taskId } })).not.toBeNull();
  });

  it("a stale epoch gets no credentials, and another runner or organization gets nothing", async () => {
    const token = await accessToken(harness, runner);
    const stale = await postJson(`${harness.url}${runnerPaths.taskCredentials(task.taskId)}`, { taskId: task.taskId, leaseEpoch: 2 }, token.accessToken);
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: { code: "stale-lease", currentEpoch: 1 } });
    const other = await registerPersonal(harness, test.db, fixture.b.admin);
    const otherToken = await accessToken(harness, other);
    const refused = await postJson(`${harness.url}${runnerPaths.taskCredentials(task.taskId)}`, { taskId: task.taskId, leaseEpoch: 1 }, otherToken.accessToken);
    expect(refused.status).toBe(404);
    const spec = await fetch(specUrl(1), { headers: { authorization: `Bearer ${otherToken.accessToken}` } });
    expect(spec.status).toBe(404);
    // Without a token at all.
    expect((await postJson(`${harness.url}${runnerPaths.taskCredentials(task.taskId)}`, { taskId: task.taskId, leaseEpoch: 1 })).status).toBe(401);
  });
});

// Gated on github.env and github-test.env: the minted token works for test1 and not for test2.
const live = {
  appId: process.env["GITHUB_APP_ID"],
  keyPath: process.env["GITHUB_APP_PRIVATE_KEY_PATH"],
  installationId: process.env["GITHUB_APP_INSTALLATION_ID"],
  org: process.env["GITHUB_TEST_ORG"],
  repo: process.env["GITHUB_TEST_REPO"],
  other: process.env["GITHUB_TEST_OTHER_REPO"],
};

describe.skipIf(Object.values(live).some((value) => value === undefined || value === ""))("live: a token for one repo", () => {
  it("reads test1 and not test2", async () => {
    const github = new GitHubAdapter({ userAgent: "ostra-core-test" }, { logger, clock: adapterClock });
    const privateKey = await readFile(live.keyPath ?? "", "utf8");
    const minted = await github.mintRepoToken(
      { app: { appId: live.appId ?? "", privateKey }, installationId: live.installationId ?? "", repo: repoFullNameSchema.parse(`${live.org ?? ""}/${live.repo ?? ""}`) },
      { contents: "write", metadata: "read" },
    );
    if (!minted.ok) {
      throw new Error(`minting failed: ${minted.error.code}`);
    }
    const read = (name: string) =>
      fetch(`https://api.github.com/repos/${live.org ?? ""}/${name}`, {
        headers: { authorization: `Bearer ${minted.value.token}`, "user-agent": "ostra-core-test", accept: "application/vnd.github+json" },
      });
    expect((await read(live.repo ?? "")).status).toBe(200);
    expect([403, 404]).toContain((await read(live.other ?? "")).status);
  });
});
