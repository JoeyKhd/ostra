import { createHash, randomBytes, randomUUID } from "node:crypto";

import { createLogger } from "@ostra/adapter-sdk";
import { createApiHarness } from "@ostra/api/testing";
import type { ApiHarness } from "@ostra/api/testing";
import type { SeededMember } from "@ostra/db/testing";
import {
  approveRunner,
  createJoinToken,
  createPool,
  dispatchTask,
  ensureDefaultPool,
  postgresAuditLog,
  postgresChangeNotices,
  postgresCommandOutbox,
  registerPoolRunner,
  rejectRunner,
  revokeJoinToken,
  sendRunnerJoinNotice,
  systemClock,
  updatePool,
} from "@ostra/domain";
import type { ChangeNotices, Clock, MemberScope } from "@ostra/domain";
import { createJobs, jobIdSchema } from "@ostra/jobs";
import type { JobContext, Jobs } from "@ostra/jobs";
import { memberIdSchema, organizationIdSchema, projectIdSchema, registerResponseSchema, runnerPaths } from "@ostra/protocol";
import type { OrganizationId, PoolId, RunnerId } from "@ostra/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { notifyDeliverHandler } from "../notifications/deliver.ts";
import type { NotifyDeps } from "../notifications/deliver.ts";
import { runnerJoinNoticeHandler } from "../notifications/runner-notices.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { connectPeer, makeRunnerKey } from "../testing/fake-peer.ts";
import type { FakePeer } from "../testing/fake-peer.ts";
import { fixedEmailChannel, queuedDeliveries, testChannels } from "../testing/notify.ts";
import { accessToken, postJson, registerBody, startGateway } from "../testing/harness.ts";
import type { GatewayHarness, RegisteredRunner } from "../testing/harness.ts";
import { dispatchPayload, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";
import { createConnectionTrackers } from "../tracker/connections.ts";

// Milestone 5's ticket 12 (F-091, Q130, ADR 0029): join tokens made, rotated and revoked through the
// domain's use cases; a join through milestone 1's register endpoint on the real gateway, which
// accepts any live token of the pool by core's clock; and the join's notice, worked by the real job
// queue, that tells the admins and opens the approval, which the approval or the reject answers.

let api: ApiHarness;
let gateway: GatewayHarness;
let jobs: Jobs;
let world: World;
let organizationId: OrganizationId;
const peers: FakePeer[] = [];
/** Core's clock, moved by a test to read a token's expiry. */
let shiftMs = 0;
const clock: Clock = { now: () => Date.now() + shiftMs };
const DAY_MS = 86_400_000;

beforeAll(async () => {
  api = await createApiHarness();
  organizationId = organizationIdSchema.parse(api.fixture.a.organization.id);
  jobs = createJobs({ databaseUrl: api.test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  await jobs.work("runner.join-notice", runnerJoinNoticeHandler({ db: api.test.db, jobs, notices: postgresChangeNotices, clock: systemClock }));
  gateway = await startGateway(api.test.db, api.test.url, { ports: { notices: postgresChangeNotices, audit: postgresAuditLog, clock, jobs } });
  world = await seedWorld(
    api.test.db,
    { codeHost: new FakeCodeHost(), secretStore: new FakeSecretStore() },
    organizationId,
    projectIdSchema.parse(api.fixture.a.openProject.id),
  );
});

afterEach(() => {
  shiftMs = 0;
  for (const peer of peers.splice(0)) {
    peer.close();
  }
});

afterAll(async () => {
  await gateway.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await api.dispose();
});

const scopeOf = (member: SeededMember, role: "admin" | "member" = "admin"): MemberScope => ({
  organizationId: organizationIdSchema.parse(member.organizationId),
  memberId: memberIdSchema.parse(member.id),
  role,
  projectRoles: new Map(),
});

const admin = (): MemberScope => scopeOf(api.fixture.a.admin);

const deps = (overrides: { readonly notices?: ChangeNotices; readonly joinTokenDays?: number } = {}) => ({
  db: api.test.db,
  jobs,
  audit: postgresAuditLog,
  notices: overrides.notices ?? postgresChangeNotices,
  clock: systemClock,
  ...(overrides.joinTokenDays === undefined ? {} : { joinTokenDays: overrides.joinTokenDays }),
});

const newPool = async (name: string, settings: { readonly requiresApproval?: boolean; readonly joinTokenDays?: number | null } = {}) => {
  const made = await createPool(deps(), admin(), {
    name,
    requiresApproval: settings.requiresApproval ?? false,
    maxBoxes: null,
    joinTokenDays: settings.joinTokenDays ?? null,
  });
  if (!made.ok) {
    throw new Error(made.message);
  }
  return made;
};

const tokenFor = async (poolId: PoolId, options: { readonly label?: string; readonly days?: number | null } = {}) => {
  const made = await createJoinToken(deps(), admin(), { poolId, label: options.label ?? null, ...(options.days === undefined ? {} : { days: options.days }) });
  if (!made.ok) {
    throw new Error(made.message);
  }
  return made;
};

const join = async (token: string, name: string) => {
  const key = await makeRunnerKey();
  const response = await postJson(`${gateway.url}${runnerPaths.register}`, registerBody(key, { name, executor: "docker", joinToken: token }));
  return { key, response };
};

const joined = async (token: string, name: string): Promise<RegisteredRunner> => {
  const { key, response } = await join(token, name);
  if (response.status !== 201) {
    throw new Error(`register answered ${String(response.status)}: ${JSON.stringify(response.body)}`);
  }
  const registered = registerResponseSchema.parse(response.body);
  return { key, registered, runnerId: registered.runnerId };
};

const connected = async (runner: RegisteredRunner): Promise<FakePeer> => {
  const token = await accessToken(gateway, runner);
  const peer = await connectPeer(gateway.url, token.accessToken, runner.runnerId);
  peers.push(peer);
  await peer.next("welcome");
  return peer;
};

const errorMessage = (body: unknown): string => JSON.stringify(body);

/** How many `runner.join-notice` jobs the queue holds, done or not. */
const joinNoticeJobs = async (): Promise<number> => {
  const rows = await api.test.db.$queryRaw<readonly { readonly n: number }[]>`SELECT count(*)::int AS "n" FROM pgboss.job WHERE name = 'runner.join-notice'`;
  return rows[0]?.n ?? 0;
};

const joinedEntries = () => api.test.db.auditEntry.count({ where: { organizationId, action: "runner.joined" } });

const waitFor = async (check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> => {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) {
      throw new Error("timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const logger = createLogger(() => undefined);
const dispatch = (payload: ReturnType<typeof dispatchPayload>) =>
  api.test.db.$transaction((tx) => dispatchTask({ tx, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock, logger }, payload));

describe("join tokens", () => {
  it("F-091/c2,c4: a live token joins, and an expired, a revoked and an unknown one are refused with their reason and write nothing", async () => {
    const pool = await newPool("token-states");
    const expiring = await tokenFor(pool.poolId, { days: 1 });
    const revoked = await tokenFor(pool.poolId);
    expect(await revokeJoinToken(deps(), admin(), { joinTokenId: revoked.joinTokenId })).toMatchObject({ ok: true });
    const entries = await joinedEntries();
    const queued = await joinNoticeJobs();

    shiftMs = 2 * DAY_MS;
    const lapsed = await join(expiring.token, "lapsed");
    shiftMs = 0;
    expect(lapsed.response.status).toBe(401);
    expect(errorMessage(lapsed.response.body)).toContain("expired");
    const gone = await join(revoked.token, "gone");
    expect(gone.response.status).toBe(401);
    expect(errorMessage(gone.response.body)).toContain("revoked");
    const unknown = await join(`ostra-join-${randomBytes(32).toString("base64url")}`, "stranger");
    expect(unknown.response.status).toBe(401);
    expect(errorMessage(unknown.response.body)).toContain("not one this server knows");
    // Nothing written: no runner, no use, no audit entry, no notice.
    expect(await api.test.db.runner.count({ where: { poolId: pool.poolId } })).toBe(0);
    expect((await api.test.db.joinToken.findMany({ where: { poolId: pool.poolId } })).map((row) => row.useCount)).toEqual([0, 0, 0]);
    expect(await joinedEntries()).toBe(entries);
    expect(await joinNoticeJobs()).toBe(queued);

    // The pool's live token joins: the runner names it, the token counts the use.
    const runner = await joined(pool.joinToken.token, "live");
    const row = await api.test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } });
    expect(row).toMatchObject({ poolId: pool.poolId, state: "joining", joinTokenId: pool.joinToken.joinTokenId });
    expect(await api.test.db.joinToken.findUniqueOrThrow({ where: { id: pool.joinToken.joinTokenId } })).toMatchObject({ useCount: 1 });
    const audit = await api.test.db.auditEntry.findFirstOrThrow({ where: { action: "runner.joined", entityId: runner.runnerId } });
    expect(audit).toMatchObject({ actorKind: "runner", actorId: runner.runnerId });
    expect(audit.data).toMatchObject({ joinTokenId: pool.joinToken.joinTokenId, poolId: pool.poolId });
    expect(await joinNoticeJobs()).toBe(queued + 1);
  });

  it("F-091/c2,c3: a token's expiry is read from core's clock: accepted until it, refused from it", async () => {
    const pool = await newPool("clocked");
    const token = await tokenFor(pool.poolId, { days: 1 });
    shiftMs = DAY_MS - 60_000;
    expect((await join(token.token, "just-in-time")).response.status).toBe(201);
    shiftMs = DAY_MS + 1_000;
    const late = await join(token.token, "too-late");
    expect(late.response.status).toBe(401);
    expect(errorMessage(late.response.body)).toContain("expired");
    expect(await api.test.db.runner.count({ where: { poolId: pool.poolId } })).toBe(1);
  });

  it("F-091/c3,c4: a join token is stored as its hash and returned once, with its lifetime from the admin, the pool or the setting", async () => {
    const before = Date.now();
    const pool = await newPool("lifetimes", { joinTokenDays: 7 });
    const week = before + 7 * DAY_MS;
    expect(pool.joinToken.expiresAt).toBeGreaterThanOrEqual(week);
    expect(pool.joinToken.expiresAt).toBeLessThan(week + 60_000);
    const poolDays = (await tokenFor(pool.poolId)).expiresAt;
    expect(poolDays).toBeGreaterThanOrEqual(week);
    expect(poolDays).toBeLessThan(week + 60_000);
    expect((await tokenFor(pool.poolId, { days: 2 })).expiresAt).toBeLessThan(before + 2 * DAY_MS + 60_000);
    expect((await tokenFor(pool.poolId, { days: null })).expiresAt).toBeNull();
    expect((await tokenFor(pool.poolId, { days: 0 })).expiresAt).toBeNull();
    // A pool with no lifetime of its own: the setting's, 30 days by default, or none at 0.
    const plain = await newPool("setting-lifetime");
    expect(plain.joinToken.expiresAt).toBeGreaterThanOrEqual(before + 30 * DAY_MS);
    expect(plain.joinToken.expiresAt).toBeLessThan(before + 30 * DAY_MS + 60_000);
    const none = await createJoinToken(deps({ joinTokenDays: 0 }), admin(), { poolId: plain.poolId, label: "forever" });
    expect(none).toMatchObject({ ok: true, expiresAt: null });

    const made = await tokenFor(pool.poolId, { label: "fleet" });
    expect(made.token).toMatch(/^ostra-join-/);
    const row = await api.test.db.joinToken.findUniqueOrThrow({ where: { id: made.joinTokenId } });
    expect(row.tokenHash).toBe(createHash("sha256").update(made.token, "utf8").digest("hex"));
    expect(JSON.stringify(row)).not.toContain(made.token);
    const audit = await api.test.db.auditEntry.findMany({ where: { organizationId, entityId: made.joinTokenId } });
    expect(audit.map((entry) => entry.action)).toEqual(["join-token.created"]);
    expect(JSON.stringify(audit)).not.toContain(made.token);
    // A member makes none, and another organization's admin finds no such pool.
    expect(await createJoinToken(deps(), scopeOf(api.fixture.a.member, "member"), { poolId: pool.poolId, label: null })).toMatchObject({ ok: false, error: "forbidden" });
    expect(await createJoinToken(deps(), scopeOf(api.fixture.b.admin), { poolId: pool.poolId, label: null })).toMatchObject({ ok: false, error: "not-found" });
  });

  it("F-091/c4,c5: a rotation keeps a joined runner connected: the old token is revoked, the runner stays, and the new token joins", async () => {
    const pool = await newPool("rotation");
    const runner = await joined(pool.joinToken.token, "steady");
    const peer = await connected(runner);
    expect(await api.test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } })).toMatchObject({ state: "online" });

    const next = await tokenFor(pool.poolId, { label: "next" });
    const revoked = await revokeJoinToken(deps(), admin(), { joinTokenId: pool.joinToken.joinTokenId });
    expect(revoked).toMatchObject({ ok: true });
    expect(await api.test.db.joinToken.findUniqueOrThrow({ where: { id: pool.joinToken.joinTokenId } })).toMatchObject({ revokedByMemberId: api.fixture.a.admin.id });
    expect(await revokeJoinToken(deps(), admin(), { joinTokenId: pool.joinToken.joinTokenId })).toMatchObject({ ok: false, error: "already-revoked" });

    // The runner that joined with it is untouched: still connected and online, and it trades its key for a token as before.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(peer.frames.some((frame) => frame.type === "evict")).toBe(false);
    expect(await api.test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } })).toMatchObject({ state: "online", revokedAt: null });
    expect((await accessToken(gateway, runner)).accessToken).not.toBe("");

    expect((await join(pool.joinToken.token, "after-rotation")).response.status).toBe(401);
    await joined(next.token, "with-the-new-token");
    expect(await api.test.db.runner.count({ where: { poolId: pool.poolId, revokedAt: null } })).toBe(2);
  });

  it("F-091/c6: a runner in a pool that requires approval is offered no task until it's approved", async () => {
    const poolId = await api.test.db.$transaction((tx) => ensureDefaultPool(tx, organizationId));
    expect(await updatePool(deps(), admin(), { poolId, requiresApproval: true })).toMatchObject({ ok: true });
    const token = await tokenFor(poolId);
    const runner = await joined(token.token, "unapproved");
    await connected(runner);
    expect(await api.test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } })).toMatchObject({ state: "joining" });
    const task = await seedQueuedTask(api.test.db, world, api.fixture.a.admin, null);
    expect(await dispatch(dispatchPayload(task))).toMatchObject({ ok: false, error: "no-runner" });
    expect(await api.test.db.lease.count({ where: { taskId: task.taskId } })).toBe(0);

    expect(
      await api.test.db.$transaction((tx) =>
        approveRunner({ tx, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock }, { organizationId, runnerId: runner.runnerId, memberId: memberIdSchema.parse(api.fixture.a.admin.id) }),
      ),
    ).toEqual({ ok: true, state: "online" });
    expect(await dispatch(dispatchPayload(task))).toMatchObject({ ok: true, runnerId: runner.runnerId });
    // Out of the default pool's offers for the other cases.
    await api.test.db.runner.update({ where: { id: runner.runnerId }, data: { state: "revoked", revokedAt: new Date() } });
    expect(await updatePool(deps(), admin(), { poolId, requiresApproval: false })).toMatchObject({ ok: true });
  });

  it("F-091/c6: turning approval on keeps the pool's working runners taking tasks; only a runner still joining waits", async () => {
    const poolId = await api.test.db.$transaction((tx) => ensureDefaultPool(tx, organizationId));
    const token = await tokenFor(poolId);
    const working = await joined(token.token, "already-working");
    await connected(working);
    const waiting = await joined(token.token, "not-yet-connected");
    expect(await api.test.db.runner.findUniqueOrThrow({ where: { id: working.runnerId } })).toMatchObject({ state: "online", approvedAt: null });

    expect(await updatePool(deps(), admin(), { poolId, requiresApproval: true })).toMatchObject({ ok: true });
    const task = await seedQueuedTask(api.test.db, world, api.fixture.a.admin, null);
    expect(await dispatch(dispatchPayload(task))).toMatchObject({ ok: true, runnerId: working.runnerId });
    expect(await api.test.db.runner.findUniqueOrThrow({ where: { id: working.runnerId } })).toMatchObject({ approvedByMemberId: api.fixture.a.admin.id });
    expect((await api.test.db.runner.findUniqueOrThrow({ where: { id: working.runnerId } })).approvedAt).not.toBeNull();
    expect(await api.test.db.runner.findUniqueOrThrow({ where: { id: waiting.runnerId } })).toMatchObject({ state: "joining", approvedAt: null });
    // Out of the default pool's offers for the other cases.
    await api.test.db.runner.updateMany({ where: { id: { in: [working.runnerId, waiting.runnerId] } }, data: { state: "revoked", revokedAt: new Date() } });
    expect(await updatePool(deps(), admin(), { poolId, requiresApproval: false })).toMatchObject({ ok: true });
  });

  it("F-091/c6: a joining runner hears in its welcome that it waits for approval in its pool, and a resume when an admin approves it", async () => {
    const pool = await newPool("needs-a-yes", { requiresApproval: true });
    const runner = await joined(pool.joinToken.token, "waiting-one");
    const token = await accessToken(gateway, runner);
    const peer = await connectPeer(gateway.url, token.accessToken, runner.runnerId);
    peers.push(peer);
    expect((await peer.next("welcome")).pool).toEqual({ poolId: pool.poolId, name: "needs-a-yes", awaitingApproval: true });
    await api.test.db.$transaction((tx) =>
      approveRunner({ tx, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock }, { organizationId, runnerId: runner.runnerId, memberId: memberIdSchema.parse(api.fixture.a.admin.id) }),
    );
    const resume = await peer.next("command");
    expect(resume).toMatchObject({ kind: "resume", body: {} });
    // Its next connection's welcome says so too.
    const again = await connectPeer(gateway.url, (await accessToken(gateway, runner)).accessToken, runner.runnerId);
    peers.push(again);
    expect((await again.next("welcome")).pool).toEqual({ poolId: pool.poolId, name: "needs-a-yes", awaitingApproval: false });
  });

  it("F-091/c7: the join's audit entry and its notice's job commit with it: a rollback leaves neither", async () => {
    const pool = await newPool("all-or-nothing");
    const entries = await joinedEntries();
    const queued = await joinNoticeJobs();
    const failing: ChangeNotices = {
      emitInTx: () => Promise.reject(new Error("the change notice failed")),
    };
    const key = await makeRunnerKey();
    const input = {
      token: pool.joinToken.token,
      name: "rolled-back",
      publicKey: key.publicKey,
      executor: "docker" as const,
      version: "0.0.0",
      install: null,
      labels: [],
    };
    // The notice is the join's last write: the runner, the token's use, the audit entry and the job came before it.
    await expect(registerPoolRunner(deps({ notices: failing }), input)).rejects.toThrow("the change notice failed");
    expect(await api.test.db.runner.count({ where: { poolId: pool.poolId } })).toBe(0);
    expect(await api.test.db.joinToken.findUniqueOrThrow({ where: { id: pool.joinToken.joinTokenId } })).toMatchObject({ useCount: 0, lastUsedAt: null });
    expect(await joinedEntries()).toBe(entries);
    expect(await joinNoticeJobs()).toBe(queued);

    const done = await registerPoolRunner(deps(), input);
    expect(done).toMatchObject({ ok: true, poolId: pool.poolId, organizationId, awaitsApproval: false });
    expect(await joinedEntries()).toBe(entries + 1);
    expect(await joinNoticeJobs()).toBe(queued + 1);
  });
});

describe("the join notice", () => {
  const PUBLIC_URL = "https://ostra.example";
  const secretStore = new FakeSecretStore();
  const taken = new Set<string>();

  const notifyDeps = (channels: ReturnType<typeof testChannels>): NotifyDeps => ({
    db: api.test.db,
    jobs,
    notices: postgresChangeNotices,
    outbox: postgresCommandOutbox,
    audit: postgresAuditLog,
    clock: systemClock,
    adapters: { codeHost: new FakeCodeHost(), modelProvider: new FakeModelProvider(), secretStore },
    logger,
    trackers: createConnectionTrackers({ db: api.test.db, secretStore, clock: systemClock, logger }),
    channels: channels.channels,
    email: fixedEmailChannel({ outcome: "skipped", why: "mail-off" }),
    publicUrl: PUBLIC_URL,
    emailDelaySeconds: 120,
    trackerCoalesceMinutes: 10,
    stallMinutes: 30,
  });

  const deliverContext = (payload: JobContext<"notify.deliver">["payload"]): JobContext<"notify.deliver"> => ({
    job: "notify.deliver",
    jobId: jobIdSchema.parse(randomUUID()),
    key: null,
    retryCount: 0,
    payload,
    logger,
  });

  const deliverAll = async (notify: NotifyDeps): Promise<void> => {
    for (const job of await queuedDeliveries(api.test.db, taken)) {
      await notifyDeliverHandler(notify)(deliverContext({ organizationId: job.organizationId, deliveryId: job.deliveryId }));
    }
  };

  const noticesOf = (runnerId: RunnerId) =>
    api.test.db.notification.findMany({
      where: { organizationId, deliveries: { some: { idempotencyKey: { contains: `:${runnerId}:` } } } },
      include: { deliveries: true },
      orderBy: { id: "asc" },
    });

  const activeAdmins = async (): Promise<readonly string[]> =>
    (await api.test.db.member.findMany({ where: { organizationId, role: "admin", state: "active" }, select: { id: true } })).map((row) => row.id).sort();

  it("F-091/c6,c7: tells the admins, opens the approval for them, and the approval and the reject answer it", async () => {
    const admins = await activeAdmins();
    const pool = await newPool("needs-approval", { requiresApproval: true });
    const token = await tokenFor(pool.poolId, { label: "rack 4" });
    const approved = await joined(token.token, "rack-4-a");

    // The queue works the job the join enqueued: each admin gets both notices, in the panel and by mail.
    await waitFor(async () => (await noticesOf(approved.runnerId)).length === admins.length * 2);
    const notices = await noticesOf(approved.runnerId);
    expect(notices.map((row) => row.memberId).sort()).toEqual([...admins, ...admins].sort());
    expect(notices.filter((row) => row.kind === "runner_joined")).toHaveLength(admins.length);
    expect(notices.filter((row) => row.kind === "runner_awaiting_approval" && row.state === "open")).toHaveLength(admins.length);
    expect(notices.every((row) => row.deliveries.map((delivery) => delivery.channel).sort().join(",") === "email,panel")).toBe(true);

    // The panel's words name the runner, its pool, its executor and the token's label, and link its page: never the token.
    const channels = testChannels();
    await deliverAll(notifyDeps(channels));
    const sent = channels.panel.sent.filter((notification) => notification.idempotencyKey.includes(`:${approved.runnerId}:`));
    expect(sent).toHaveLength(admins.length * 2);
    const waiting = sent.find((notification) => notification.kind === "runner_awaiting_approval");
    expect(waiting?.title).toBe("A runner waits for approval");
    expect(waiting?.body).toContain("rack-4-a");
    expect(waiting?.body).toContain("needs-approval");
    expect(waiting?.body).toContain("rack 4");
    expect(waiting?.url).toContain(approved.runnerId);
    expect(JSON.stringify(sent)).not.toContain(token.token);

    // A replay of the job makes nothing twice.
    expect(await sendRunnerJoinNotice({ db: api.test.db, jobs, notices: postgresChangeNotices, clock: systemClock }, { organizationId, runnerId: approved.runnerId })).toMatchObject({
      kind: "sent",
      notifications: 0,
    });

    // The approval answers the open notice for every admin.
    const adminId = memberIdSchema.parse(api.fixture.a.admin.id);
    await api.test.db.$transaction((tx) =>
      approveRunner({ tx, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock }, { organizationId, runnerId: approved.runnerId, memberId: adminId }),
    );
    expect((await noticesOf(approved.runnerId)).filter((row) => row.kind === "runner_awaiting_approval").map((row) => row.state)).toEqual(admins.map(() => "answered"));

    // The reject answers it too.
    const rejected = await joined(token.token, "rack-4-b");
    await waitFor(async () => (await noticesOf(rejected.runnerId)).length === admins.length * 2);
    await api.test.db.$transaction((tx) =>
      rejectRunner({ tx, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock }, { organizationId, runnerId: rejected.runnerId, memberId: adminId }),
    );
    expect((await noticesOf(rejected.runnerId)).filter((row) => row.kind === "runner_awaiting_approval").map((row) => row.state)).toEqual(admins.map(() => "answered"));
    // An answered approval notice is delivered no more.
    const later = testChannels();
    await deliverAll(notifyDeps(later));
    expect(later.panel.sent.filter((notification) => notification.idempotencyKey.includes(`:${rejected.runnerId}:`) && notification.kind === "runner_awaiting_approval")).toHaveLength(0);
  });

  it("F-091/c7: a pool without approval tells the admins a runner joined, and opens nothing", async () => {
    const admins = await activeAdmins();
    const pool = await newPool("open-door");
    const runner = await joined(pool.joinToken.token, "walk-in");
    await waitFor(async () => (await noticesOf(runner.runnerId)).length === admins.length);
    expect((await noticesOf(runner.runnerId)).map((row) => row.kind)).toEqual(admins.map(() => "runner_joined"));
  });
});
