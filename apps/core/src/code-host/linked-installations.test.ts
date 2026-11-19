import { randomBytes, randomUUID } from "node:crypto";

import { createLogger, silentLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { createTestDatabase, seedInstallation, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import {
  checkProjectRepos,
  dispatchTask,
  dispatchWaitFromDb,
  INSTALLATION_NOT_LINKED,
  issueSnapshotCredentials,
  openPullRequests,
  postgresAuditLog,
  postgresChangeNotices,
  postgresCommandOutbox,
  readSnapshotBuildInputs,
  repoAccessFor,
  systemClock,
} from "@ostra/domain";
import { createJobs, jobIdSchema } from "@ostra/jobs";
import type { JobContext, Jobs } from "@ostra/jobs";
import {
  connectionIdSchema,
  leaseEpochSchema,
  projectIdSchema,
  repoFullNameSchema,
  repoIdSchema,
  runnerPaths,
  snapshotIdSchema,
  taskSeqSchema,
  taskSpecSchema,
  webhookDeliveryIdSchema,
} from "@ostra/protocol";
import type { ConnectionId, RunnerId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteHiddenRefs } from "../cleanup/cleanup.ts";
import { buildTaskSpec } from "../dispatch/task-spec.ts";
import { handleTaskEndpoint } from "../dispatch/endpoints.ts";
import { createCoreServer } from "../server.ts";
import type { CoreServer } from "../server.ts";
import { snapshotsOnPush } from "../snapshots/snapshots.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { accessToken, postJson, registerPersonal, startGateway } from "../testing/harness.ts";
import type { GatewayHarness, RegisteredRunner } from "../testing/harness.ts";
import { dispatchPayload, INSTALLATION_ID, seedOnlineRunner, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { QueuedTask, World } from "../testing/world.ts";
import { createWebhookInbox } from "../webhooks/inbox.ts";
import { webhookProcessHandler } from "../webhooks/process.ts";
import { githubWebhookHandler, reconcilePullRequests } from "./pull-requests.ts";

// Ticket 49 (F-136, ADR 0065): ostra acts only through installations an organization admin linked,
// or the App owner's own, linked when seen. A delivery from any other is not stored, nothing is
// minted for one at any call site, and each repo's commits are its own App's bot's. Proved with
// the fake code host; the live run with a second GitHub organization is ticket 55.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let world: World;
let harness: GatewayHarness;
let runner: RegisteredRunner;
let connectionId: ConnectionId;
let inboxBase: string;
const servers: CoreServer[] = [];
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const records: LogRecord[] = [];
const logger = createLogger((record) => records.push(record));

/** Every call the code host got for an installation, by method: a mint, or a call that mints one. */
const reached: { readonly method: string; readonly installationId: string }[] = [];
const installationOf = (arg: unknown): string | null => {
  if (typeof arg !== "object" || arg === null) {
    return null;
  }
  const direct: unknown = Reflect.get(arg, "installationId");
  if (typeof direct === "string") {
    return direct;
  }
  const access: unknown = Reflect.get(arg, "access");
  return typeof access === "object" && access !== null && typeof Reflect.get(access, "installationId") === "string" ? String(Reflect.get(access, "installationId")) : null;
};
const recording = new Proxy(codeHost, {
  get(target, property, receiver) {
    const value: unknown = Reflect.get(target, property, receiver);
    if (typeof value !== "function" || typeof property !== "string") {
      return value;
    }
    return (...args: unknown[]): unknown => {
      for (const [index, arg] of args.entries()) {
        const id = installationOf(arg) ?? (property === "listRepos" && index === 1 && typeof arg === "string" ? arg : null);
        if (id !== null) {
          reached.push({ method: property, installationId: id });
        }
      }
      return Reflect.apply(value, target, args);
    };
  },
});

const deps = () => ({ jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, logger });
const dispatch = (task: QueuedTask, epoch = 1) => test.db.$transaction((tx) => dispatchTask({ tx, ...deps() }, dispatchPayload(task, epoch)));
const prDeps = () => ({ db: test.db, jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, codeHost: recording, secretStore, logger });
const setState = (installationId: string, state: "linked" | "removed") =>
  test.db.codeHostInstallation.updateMany({
    where: { connectionId, installationId },
    data: state === "linked" ? { state, removedAt: null } : { state, removedAt: new Date() },
  });

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  connectionId = connectionIdSchema.parse((await test.db.connection.findFirstOrThrow({ where: { organizationId: world.organizationId, kind: "github" } })).id);
  const webhookRef = await secretStore.put({ organizationId: world.organizationId, purpose: "github-app.webhook-secret" }, codeHost.webhookSecret);
  if (!webhookRef.ok) {
    throw new Error("the fake secret store refused");
  }
  await test.db.connection.update({ where: { id: connectionId }, data: { webhookSecretSecretRef: webhookRef.value } });
  harness = await startGateway(test.db, test.url, {}, (gateway) => [
    handleTaskEndpoint({
      db: test.db,
      tokens: gateway.context.tokens,
      taskTokens: gateway.context.taskTokens,
      adapters: { codeHost: recording, secretStore, modelProvider: new FakeModelProvider() },
      audit: postgresAuditLog,
      clock: systemClock,
      signingKey: randomBytes(32),
      logger,
    }),
  ]);
  runner = await registerPersonal(harness, test.db, fixture.a.member);
  await test.db.runner.update({ where: { id: runner.runnerId }, data: { state: "online", capacity: 50 } });
  await test.db.runnerPresence.create({ data: { runnerId: runner.runnerId, organizationId: world.organizationId, replicaId: "test", connectionEpoch: 1, carrier: "websocket", minor: 3 } });
  const inbox = createWebhookInbox({
    db: test.db,
    jobs,
    secretStore,
    trackerVerifiers: { linear: { verifyWebhook: () => ({ ok: false, reason: "bad-signature" }) } },
    codeHost: recording,
    clock: systemClock,
    logger,
    insertDeadlineMs: 5_000,
    blocked: new Set(),
  });
  const server = createCoreServer({ routes: [inbox.handle], upgrade: () => undefined, logger: silentLogger });
  servers.push(server);
  inboxBase = `http://127.0.0.1:${String(await server.listen(0, "127.0.0.1"))}`;
});

afterAll(async () => {
  for (const server of servers) await server.close();
  await harness.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

const readJson = async (response: Response): Promise<unknown> => {
  const parsed: unknown = await response.json();
  return parsed;
};

const post = async (body: string, headers: Readonly<Record<string, string>>) => {
  const response = await fetch(`${inboxBase}/webhooks/github/${connectionId}`, { method: "POST", headers, body });
  return { status: response.status, body: await readJson(response) };
};

const processContext = (deliveryId: string): JobContext<"webhook.process"> => ({
  job: "webhook.process",
  jobId: jobIdSchema.parse(randomUUID()),
  key: null,
  payload: { organizationId: world.organizationId, connectionId, deliveryId: webhookDeliveryIdSchema.parse(deliveryId) },
  retryCount: 0,
  logger: silentLogger,
});

const installationDelivery = (action: string, installationId: number, account: { readonly id: number; readonly login: string }) => {
  const body = JSON.stringify({ action, installation: { id: installationId, account: { id: account.id, login: account.login, type: "Organization" } } });
  return { body, headers: codeHost.sign(body, "installation") };
};

describe("deliveries from linked installations only", () => {
  it("F-136: a delivery from an unlinked or removed installation stores no WebhookDelivery and changes nothing, and one from a linked installation is processed", async () => {
    const before = await test.db.webhookDelivery.count();
    // A stranger's installation, never linked.
    const stranger = codeHost.pullRequestDelivery("stranger/repo", 1, "opened", { installationId: "990001" });
    records.length = 0;
    expect(await post(stranger.body, stranger.headers)).toEqual({ status: 202, body: { status: "not-linked" } });
    expect(records.some((record) => record.message === "webhook.installation-not-linked" && record.fields["connectionId"] === connectionId && record.fields["installationId"] === "990001")).toBe(true);
    // A delivery that names no installation at all.
    const none = JSON.stringify({ action: "opened", number: 1 });
    expect((await post(none, codeHost.sign(none, "pull_request"))).status).toBe(202);
    // The world's own installation, removed by an admin.
    await setState(INSTALLATION_ID, "removed");
    const removed = codeHost.pullRequestDelivery("ostra-test/test1", 1, "opened", { installationId: INSTALLATION_ID });
    expect((await post(removed.body, removed.headers)).status).toBe(202);
    expect(await test.db.webhookDelivery.count()).toBe(before);
    expect(await test.db.connection.findUniqueOrThrow({ where: { id: connectionId } })).toMatchObject({ lastEventAt: null });

    // Linked again: the same kind of delivery is stored, and `webhook.process` acts on it.
    await setState(INSTALLATION_ID, "linked");
    const linked = codeHost.pullRequestDelivery("ostra-test/test1", 1, "opened", { installationId: INSTALLATION_ID });
    expect(await post(linked.body, linked.headers)).toEqual({ status: 200, body: { status: "accepted" } });
    const deliveryId = linked.headers["x-github-delivery"] ?? "";
    await webhookProcessHandler({ db: test.db, clock: systemClock, handlers: { linear: githubWebhookHandler(prDeps()), github: githubWebhookHandler(prDeps()) } })(processContext(deliveryId));
    const row = await test.db.webhookDelivery.findFirstOrThrow({ where: { connectionId, deliveryId } });
    expect(row.status).not.toBe("received");
    expect(row.processedAt).not.toBeNull();
  });
});

describe("the App owner's own installation", () => {
  it("F-136: the owner's own installation is linked when an installation event shows it, another account's waits, and an uninstall removes a linked one", async () => {
    codeHost.owner = { login: "ostra-test", accountId: "4100" };
    try {
      const run = webhookProcessHandler({ db: test.db, clock: systemClock, handlers: { linear: githubWebhookHandler(prDeps()), github: githubWebhookHandler(prDeps()) } });
      const deliver = async (delivery: { readonly body: string; readonly headers: Readonly<Record<string, string>> }) => {
        expect((await post(delivery.body, delivery.headers)).status).toBe(200);
        await run(processContext(delivery.headers["x-github-delivery"] ?? ""));
      };
      // The owner's account: linked by the system, with its audit entry; the connection learns its owner.
      await deliver(installationDelivery("created", 880001, { id: 4100, login: "ostra-test" }));
      expect(await test.db.codeHostInstallation.findFirst({ where: { connectionId, installationId: "880001" } })).toMatchObject({ state: "linked", linkedByMemberId: null, accountId: "4100" });
      expect(await test.db.connection.findUniqueOrThrow({ where: { id: connectionId } })).toMatchObject({ ownerAccountId: "4100", ownerLogin: "ostra-test" });
      expect(await test.db.auditEntry.count({ where: { action: "installation.linked", entityId: connectionId } })).toBe(1);
      // Another account's: nothing linked, nothing stored for it but the delivery itself.
      await deliver(installationDelivery("created", 880002, { id: 7700, login: "client-b" }));
      expect(await test.db.codeHostInstallation.count({ where: { connectionId, installationId: "880002" } })).toBe(0);
      // A later delivery from it is refused at the inbox.
      const later = codeHost.pullRequestDelivery("client-b/repo", 2, "opened", { installationId: "880002" });
      expect((await post(later.body, later.headers)).status).toBe(202);
      // An uninstall on the owner's account marks the linked one removed.
      await deliver(installationDelivery("deleted", 880001, { id: 4100, login: "ostra-test" }));
      expect(await test.db.codeHostInstallation.findFirst({ where: { connectionId, installationId: "880001" } })).toMatchObject({ state: "removed" });
      expect(await test.db.auditEntry.count({ where: { action: "installation.removed", entityId: connectionId } })).toBe(1);
    } finally {
      codeHost.owner = undefined;
      await test.db.connection.update({ where: { id: connectionId }, data: { ownerAccountId: null, ownerLogin: null } });
    }
  });
});

describe("no mint through an installation that isn't linked", () => {
  it("F-136: nothing is minted for an unlinked or removed installation, at every call site", async () => {
    // A task dispatched while its installation was linked, then the installation is removed.
    const task = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
    expect(await dispatch(task)).toMatchObject({ ok: true });
    await setState(INSTALLATION_ID, "removed");
    reached.length = 0;
    const minted = codeHost.minted.length;
    try {
      // The credentials and the spec.
      const token = (await accessToken(harness, runner)).accessToken;
      const credentials = await postJson(`${harness.url}${runnerPaths.taskCredentials(task.taskId)}`, { taskId: task.taskId, leaseEpoch: 1 }, token);
      expect(credentials.status).toBe(403);
      const spec = await fetch(`${harness.url}${runnerPaths.taskSpec(task.taskId)}?leaseEpoch=1`, { headers: { authorization: `Bearer ${token}` } });
      expect(spec.status).not.toBe(200);
      // A new dispatch waits with the reason.
      const next = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
      expect(await dispatch(next)).toMatchObject({ ok: false, error: "no-runner", message: "installation-not-linked" });
      expect(dispatchWaitFromDb((await test.db.task.findUniqueOrThrow({ where: { id: next.taskId } })).dispatchWait)).toEqual({ code: "installation-not-linked", repo: "ostra-test/test1" });
      // The PR opener.
      await test.db.task.update({ where: { id: task.taskId }, data: { state: "running", subState: null } });
      await test.db.taskRepo.updateMany({ where: { taskId: task.taskId }, data: { ahead: true } });
      const opened = await openPullRequests(
        { db: test.db, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, adapters: { codeHost: recording, secretStore, modelProvider: new FakeModelProvider() }, publicUrl: "https://ostra.example" },
        { organizationId: world.organizationId, taskId: task.taskId, sessionId: task.sessionId, eventSeq: taskSeqSchema.parse(1) },
      );
      expect(opened).toMatchObject({ ok: false, message: INSTALLATION_NOT_LINKED });
      // The PR reconcile.
      await test.db.taskRepo.updateMany({ where: { taskId: task.taskId }, data: { state: "pr_open", prNumber: 7, prUrl: "https://github.example/ostra-test/test1/pull/7" } });
      expect(await reconcilePullRequests(prDeps(), { organizationId: world.organizationId, connectionId })).toMatchObject({ read: 0 });
      // The cleanup of a finished task's hidden ref.
      await test.db.task.update({ where: { id: task.taskId }, data: { state: "merged", subState: null } });
      await test.db.box.updateMany({ where: { taskId: task.taskId }, data: { state: "released" } });
      await test.db.taskRepo.updateMany({ where: { taskId: task.taskId }, data: { hiddenRefSha: "a".repeat(40) } });
      const cleanupDeps = {
        db: test.db,
        jobs,
        outbox: postgresCommandOutbox,
        notices: postgresChangeNotices,
        audit: postgresAuditLog,
        clock: systemClock,
        adapters: { codeHost: recording, secretStore },
        logger,
        retentionDays: null,
        releaseAfterIdleMs: 60_000,
      };
      expect(await deleteHiddenRefs(cleanupDeps, world.organizationId, task.taskId)).toBe(0);
      // The snapshot's inputs, its push trigger and its build credentials.
      await expect(test.db.$transaction((tx) => readSnapshotBuildInputs({ db: tx, adapters: { codeHost: recording, secretStore } }, projectIdSchema.parse(world.projectId)))).rejects.toThrow(
        INSTALLATION_NOT_LINKED,
      );
      const push = await snapshotsOnPush(
        { db: test.db, jobs, codeHost: recording, secretStore },
        {
          organizationId: world.organizationId,
          connectionId,
          event: { kind: "push", installationId: null, hostRepoId: "host-ostra-test/test1", repo: repoFullNameSchema.parse("ostra-test/test1"), ref: "refs/heads/main", before: "b".repeat(40), after: "c".repeat(40), changedPaths: null },
        },
      );
      expect(push).toBe("unreadable");
      const environment = await test.db.environment.findUniqueOrThrow({ where: { projectId: world.projectId } });
      const snapshot = await test.db.snapshot.create({
        data: { organizationId: world.organizationId, projectId: world.projectId, environmentId: environment.id, state: "building", reason: "manual", runnerId: runner.runnerId },
      });
      const snapshotCredentials = await test.db.$transaction((tx) =>
        issueSnapshotCredentials({ tx, audit: postgresAuditLog, adapters: { codeHost: recording, secretStore } }, { snapshotId: snapshotIdSchema.parse(snapshot.id), runnerId: runner.runnerId }),
      );
      expect(snapshotCredentials).toMatchObject({ ok: false, message: INSTALLATION_NOT_LINKED });
      // Milestone 3's compares, drafts and reactions (one access path), and the branch checks.
      const repoId = repoIdSchema.parse((await test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId } })).repoId);
      expect(await repoAccessFor(test.db, secretStore, world.organizationId, repoId)).toEqual({ ok: false, reason: INSTALLATION_NOT_LINKED });
      const checks = await checkProjectRepos(
        { db: test.db, clock: systemClock, adapters: { codeHost: recording, secretStore } },
        { organizationId: world.organizationId, projectId: projectIdSchema.parse(world.projectId), force: true },
      );
      const protectedRule = checks.find((checked) => checked.repoId === repoId)?.rules.protected;
      expect(protectedRule?.result).toBe("unknown");
      expect(protectedRule !== undefined && "reason" in protectedRule ? protectedRule.reason : "").toContain("isn't linked");
      // Not one call reached the installation, and no token was minted.
      expect(reached.filter((call) => call.installationId === INSTALLATION_ID)).toEqual([]);
      expect(codeHost.minted.length).toBe(minted);
    } finally {
      await setState(INSTALLATION_ID, "linked");
    }
  });
});

describe("a bot per repo", () => {
  it("F-136: a task across two Apps' repos has each repo's bot in its spec, and a minor-2 runner gets no offer for it", async () => {
    // A client's App, connected beside the organization's own, with its own key, bot and installation.
    const organizationId = world.organizationId;
    const appB = "4242999";
    const keyB = `-----BEGIN KEY B ${randomBytes(6).toString("hex")}-----`;
    const botB = { name: "client-b-app[bot]", email: "2+client-b-app[bot]@users.noreply.github.com" };
    codeHost.apps.set(appB, { privateKey: keyB, bot: botB });
    const keyRef = await secretStore.put({ organizationId, purpose: "github-app.private-key" }, keyB);
    if (!keyRef.ok) {
      throw new Error("the fake secret store refused");
    }
    const connectionB = await test.db.connection.create({ data: { organizationId, kind: "github", appId: appB, slug: "client-b-app", privateKeySecretRef: keyRef.value } });
    await seedInstallation(test.db, { organizationId, connectionId: connectionB.id, installationId: "660001", accountLogin: "client-b" });
    codeHost.repos.set("660001", [{ hostRepoId: "host-client-b/app", fullName: "client-b/app", defaultBranch: "main", private: true, cloneUrl: "https://github.example/client-b/app.git" }]);
    const repoB = await test.db.repo.create({
      data: { organizationId, projectId: world.projectId, connectionId: connectionB.id, installationId: "660001", hostRepoId: "host-client-b/app", fullName: "client-b/app", defaultBranch: "main", checkoutDir: "app", position: 1 },
    });
    const withBoth = async (): Promise<QueuedTask> => {
      const task = await seedQueuedTask(test.db, world, fixture.a.member, null);
      const { branchName } = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
      await test.db.taskRepo.create({ data: { organizationId, projectId: world.projectId, taskId: task.taskId, repoId: repoB.id, branchName, baseBranch: "main" } });
      return task;
    };
    const pool = await test.db.runnerPool.findFirst({ where: { organizationId, isDefault: true } });
    const poolId = pool?.id ?? (await test.db.runnerPool.create({ data: { organizationId, name: "default", isDefault: true } })).id;
    const onlineAt = async (name: string, minor: number): Promise<RunnerId> => {
      const seeded = await seedOnlineRunner(test.db, organizationId, { kind: "pool", poolId }, 5);
      await test.db.runner.update({ where: { id: seeded.runnerId }, data: { name } });
      await test.db.runnerPresence.update({ where: { runnerId: seeded.runnerId }, data: { minor } });
      return seeded.runnerId;
    };
    const older = await onlineAt(`minor-2-${randomUUID().slice(0, 6)}`, 2);
    try {
      // Only a minor-2 runner is online: no offer, and the task says it needs minor 3.
      const waiting = await withBoth();
      expect(await dispatch(waiting)).toMatchObject({ ok: false, error: "no-runner", message: "needs-protocol" });
      expect(dispatchWaitFromDb((await test.db.task.findUniqueOrThrow({ where: { id: waiting.taskId } })).dispatchWait)).toEqual({ code: "needs-protocol", minor: 3 });
      expect(await test.db.lease.count({ where: { taskId: waiting.taskId } })).toBe(0);
      // A task on one App's repo still goes to the minor-2 runner.
      const single = await seedQueuedTask(test.db, world, fixture.a.member, null);
      const offered = await dispatch(single);
      expect(offered).toMatchObject({ ok: true });
      expect((await test.db.lease.findFirstOrThrow({ where: { taskId: single.taskId } })).runnerId).toBe(older);

      // A minor-3 runner comes online: the task goes to it, and its spec names each repo's own bot.
      const newer = await onlineAt(`minor-3-${randomUUID().slice(0, 6)}`, 3);
      expect(await dispatch(waiting)).toMatchObject({ ok: true });
      const lease = await test.db.lease.findFirstOrThrow({ where: { taskId: waiting.taskId, state: "active" } });
      expect(lease.runnerId).toBe(newer);
      const specDeps = { db: test.db, codeHost: recording, secretStore };
      const built = await buildTaskSpec(specDeps, { taskId: waiting.taskId, runnerId: newer, leaseEpoch: leaseEpochSchema.parse(1), minor: 3 });
      if (!built.ok) {
        throw new Error(`the spec failed: ${built.message}`);
      }
      const spec = taskSpecSchema.parse(built.spec);
      expect(spec.gitIdentity).toEqual({ name: "ostra-test[bot]", email: "1+ostra-test[bot]@users.noreply.github.com" });
      expect(spec.repos.map((repo) => [repo.fullName, repo.gitIdentity])).toEqual([
        ["ostra-test/test1", { name: "ostra-test[bot]", email: "1+ostra-test[bot]@users.noreply.github.com" }],
        ["client-b/app", botB],
      ]);
      // A minor-2 runner's spec carries the first repo's bot alone.
      const old = await buildTaskSpec(specDeps, { taskId: waiting.taskId, runnerId: newer, leaseEpoch: leaseEpochSchema.parse(1), minor: 2 });
      expect(old.ok && old.spec.repos.every((repo) => repo.gitIdentity === undefined)).toBe(true);
    } finally {
      await test.db.runner.updateMany({ where: { organizationId, kind: "pool" }, data: { state: "offline" } });
      await test.db.runnerPresence.updateMany({ where: { organizationId, runner: { kind: "pool" } }, data: { disconnectedAt: new Date() } });
    }
  });
});
