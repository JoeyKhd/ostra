import { createLogger } from "@ostra/adapter-sdk";
import { createApiHarness } from "@ostra/api/testing";
import type { ApiHarness } from "@ostra/api/testing";
import { dispatchTask, ensureDefaultPool, postgresChangeNotices, postgresCommandOutbox, systemClock } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { closeCodes, organizationIdSchema, projectIdSchema, registerResponseSchema, runnerPaths } from "@ostra/protocol";
import type { PoolId, RunnerId } from "@ostra/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { FakeCodeHost, FakeSecretStore } from "../testing/fake-adapters.ts";
import { hashJoinToken } from "./bootstrap-join-token.ts";
import { connectPeer, makeRunnerKey, signAssertion } from "../testing/fake-peer.ts";
import type { FakePeer } from "../testing/fake-peer.ts";
import { accessToken, postJson, registerBody, startGateway } from "../testing/harness.ts";
import type { GatewayHarness, RegisteredRunner } from "../testing/harness.ts";
import { dispatchPayload, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";

// Milestone 1's ticket 42 (Q130, F-091): core accepts every join token of a pool that isn't
// revoked or expired, the ones an admin makes in the panel included, and a pool that requires
// approval keeps a joined runner `joining`, with no task, until an admin approves it. The tokens
// are made, and the runners approved and rejected, through the panel's own procedures.

let api: ApiHarness;
let gateway: GatewayHarness;
let jobs: Jobs;
let world: World;
const peers: FakePeer[] = [];

beforeAll(async () => {
  api = await createApiHarness();
  gateway = await startGateway(api.test.db, api.test.url);
  jobs = createJobs({ databaseUrl: api.test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  const { a } = api.fixture;
  world = await seedWorld(
    api.test.db,
    { codeHost: new FakeCodeHost(), secretStore: new FakeSecretStore() },
    organizationIdSchema.parse(a.organization.id),
    projectIdSchema.parse(a.openProject.id),
  );
});

afterEach(() => {
  for (const peer of peers.splice(0)) {
    peer.close();
  }
});

afterAll(async () => {
  await gateway.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await api.dispose();
});

const join = async (token: string, name: string) => {
  const key = await makeRunnerKey();
  const response = await postJson(`${gateway.url}${runnerPaths.register}`, registerBody(key, { name, executor: "docker", joinToken: token }));
  return { key, response };
};

const joined = async (token: string, name: string): Promise<RegisteredRunner> => {
  const { key, response } = await join(token, name);
  if (response.status !== 201) {
    throw new Error(`register answered ${String(response.status)}`);
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

const stateOf = async (runnerId: RunnerId) => (await api.test.db.runner.findUniqueOrThrow({ where: { id: runnerId } })).state;

const logger = createLogger(() => undefined);
const dispatch = (payload: ReturnType<typeof dispatchPayload>) =>
  api.test.db.$transaction((tx) =>
    dispatchTask({ tx, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock, logger }, payload),
  );

/** The organization's default pool, where a task with no picked runner goes, with its approval switch set. */
const defaultPool = async (requiresApproval: boolean): Promise<PoolId> => {
  const { a } = api.fixture;
  const poolId = await api.test.db.$transaction((tx) => ensureDefaultPool(tx, organizationIdSchema.parse(a.organization.id)));
  await (await api.as(a.admin)).pools.update({ poolId, requiresApproval });
  return poolId;
};

describe("join tokens an admin makes", () => {
  it("F-091: a token made through pools.createJoinToken registers a runner, and the join's audit entry names the token", async () => {
    const { a } = api.fixture;
    const admin = await api.as(a.admin);
    const { poolId } = await admin.pools.create({ name: "panel-made" });
    const made = await admin.pools.createJoinToken({ poolId, label: "fleet" });
    const runner = await joined(made.token, "fleet-01");
    expect(runner.registered).toEqual({ runnerId: runner.runnerId, kind: "pool", poolId });
    expect(await api.test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } })).toMatchObject({
      organizationId: a.organization.id,
      poolId,
      kind: "pool",
      state: "joining",
    });
    const audit = await api.test.db.auditEntry.findFirstOrThrow({ where: { action: "runner.registered", entityId: runner.runnerId } });
    expect(audit.data).toMatchObject({ joinTokenId: made.joinTokenId, bootstrap: false });
    expect(JSON.stringify(audit)).not.toContain(made.token);
    expect((await api.test.db.joinToken.findUniqueOrThrow({ where: { id: made.joinTokenId } })).lastUsedAt).not.toBeNull();
  });

  it("F-091: an expired join token and a revoked one register nothing", async () => {
    const { a } = api.fixture;
    const admin = await api.as(a.admin);
    const { poolId } = await admin.pools.create({ name: "lapsed" });
    const expired = await admin.pools.createJoinToken({ poolId, expiresInDays: 1 });
    await api.test.db.joinToken.update({ where: { id: expired.joinTokenId }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    const revoked = await admin.pools.createJoinToken({ poolId, expiresInDays: null });
    await admin.pools.revokeJoinToken({ joinTokenId: revoked.joinTokenId });
    expect((await join(expired.token, "late")).response.status).toBe(401);
    expect((await join(revoked.token, "gone")).response.status).toBe(401);
    expect(await api.test.db.runner.count({ where: { poolId } })).toBe(0);
  });

  it("F-091: a second runner of the same name in the pool is refused", async () => {
    const { a } = api.fixture;
    const admin = await api.as(a.admin);
    const { poolId } = await admin.pools.create({ name: "one-name" });
    const first = await admin.pools.createJoinToken({ poolId });
    const second = await admin.pools.createJoinToken({ poolId });
    await joined(first.token, "box-host");
    expect((await join(second.token, "box-host")).response.status).toBe(409);
    expect(await api.test.db.runner.count({ where: { poolId } })).toBe(1);
  });

  it("F-091: joins that race with one name in a pool make one runner, and the others are refused", async () => {
    const admin = await api.as(api.fixture.a.admin);
    const { poolId } = await admin.pools.create({ name: "racing-names" });
    const made = await admin.pools.createJoinToken({ poolId });
    // The race, made certain: this test holds the join token's row, which a join writes last, so
    // every join reads the pool before any of them commits; then it lets go.
    const locked = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const holder = api.test.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "join_token" WHERE "tokenHash" = ${hashJoinToken(made.token)} FOR UPDATE`;
        locked.resolve(undefined);
        await release.promise;
      },
      { timeout: 60_000 },
    );
    try {
      await locked.promise;
      const joins = [join(made.token, "same-name"), join(made.token, "same-name"), join(made.token, "same-name")];
      const waiting = async (): Promise<number> => {
        const rows = await api.test.db.$queryRaw<readonly { readonly waiting: number }[]>`
          SELECT count(*)::int AS "waiting" FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        return rows[0]?.waiting ?? 0;
      };
      for (let attempt = 0; attempt < 200 && (await waiting()) < joins.length; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(await waiting()).toBe(joins.length);
      release.resolve(undefined);
      await holder;
      expect((await Promise.all(joins)).map((outcome) => outcome.response.status).sort()).toEqual([201, 409, 409]);
      expect(await api.test.db.runner.count({ where: { poolId, name: "same-name" } })).toBe(1);
    } finally {
      release.resolve(undefined);
      await holder.catch(() => undefined);
    }
  });

  it("F-091: a token of another organization registers nothing in this one", async () => {
    const { a, b } = api.fixture;
    const before = await api.test.db.runner.count({ where: { organizationId: a.organization.id } });
    const theirs = await (await api.as(b.admin)).pools.create({ name: "theirs" });
    const made = await (await api.as(b.admin)).pools.createJoinToken({ poolId: theirs.poolId });
    const runner = await joined(made.token, "their-runner");
    expect(await api.test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } })).toMatchObject({
      organizationId: b.organization.id,
      poolId: theirs.poolId,
    });
    expect(await api.test.db.runner.count({ where: { organizationId: a.organization.id } })).toBe(before);
    // And a's admin can't approve or reject it.
    await expect((await api.as(a.admin)).runners.approve({ runnerId: runner.runnerId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect((await api.as(a.admin)).runners.reject({ runnerId: runner.runnerId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("a pool that requires approval", () => {
  it("F-091: keeps a joined runner joining across reconnects with no task, and runners.approve puts it online to take one", async () => {
    const { a } = api.fixture;
    const poolId = await defaultPool(true);
    const made = await (await api.as(a.admin)).pools.createJoinToken({ poolId });
    const runner = await joined(made.token, "awaiting-approval");

    const first = await connected(runner);
    expect(await stateOf(runner.runnerId)).toBe("joining");
    first.close();
    await first.closed;
    const second = await connected(runner);
    expect(await stateOf(runner.runnerId)).toBe("joining");

    const task = await seedQueuedTask(api.test.db, world, a.admin, null);
    expect(await dispatch(dispatchPayload(task))).toMatchObject({ ok: false, error: "no-runner" });
    expect(await api.test.db.lease.count({ where: { taskId: task.taskId } })).toBe(0);

    // A member who isn't an admin can't approve it.
    await expect((await api.as(a.member)).runners.approve({ runnerId: runner.runnerId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await stateOf(runner.runnerId)).toBe("joining");

    expect(await (await api.as(a.admin)).runners.approve({ runnerId: runner.runnerId })).toEqual({ runnerId: runner.runnerId, state: "online" });
    const row = await api.test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } });
    expect(row).toMatchObject({ state: "online", approvedByMemberId: a.admin.id });
    expect(row.approvedAt).not.toBeNull();
    expect(await api.test.db.auditEntry.count({ where: { action: "runner.approved", entityId: runner.runnerId, actorId: a.admin.id } })).toBe(1);

    expect(await dispatch(dispatchPayload(task))).toMatchObject({ ok: true, runnerId: runner.runnerId });
    // It stays online across a reconnect.
    second.close();
    await second.closed;
    await connected(runner);
    expect(await stateOf(runner.runnerId)).toBe("online");
    await api.test.db.runner.update({ where: { id: runner.runnerId }, data: { state: "draining" } });
  });

  it("F-091: a runner approved while it isn't connected goes online at its next hello", async () => {
    const { a } = api.fixture;
    const poolId = await defaultPool(true);
    const made = await (await api.as(a.admin)).pools.createJoinToken({ poolId });
    const runner = await joined(made.token, "approved-offline");
    expect(await (await api.as(a.admin)).runners.approve({ runnerId: runner.runnerId })).toEqual({ runnerId: runner.runnerId, state: "joining" });
    expect(await stateOf(runner.runnerId)).toBe("joining");
    await connected(runner);
    expect(await stateOf(runner.runnerId)).toBe("online");
    await api.test.db.runner.update({ where: { id: runner.runnerId }, data: { state: "draining" } });
  });

  it("F-091: runners.reject revokes a connected joining runner, closes it with 4403, and its next token request fails", async () => {
    const { a, b } = api.fixture;
    const poolId = await defaultPool(true);
    const made = await (await api.as(a.admin)).pools.createJoinToken({ poolId });
    const runner = await joined(made.token, "to-reject");
    const peer = await connected(runner);

    await expect((await api.as(a.member)).runners.reject({ runnerId: runner.runnerId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect((await api.as(b.admin)).runners.reject({ runnerId: runner.runnerId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect((await api.as(b.admin)).runners.approve({ runnerId: runner.runnerId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await stateOf(runner.runnerId)).toBe("joining");

    expect(await (await api.as(a.admin)).runners.reject({ runnerId: runner.runnerId })).toEqual({ runnerId: runner.runnerId, state: "revoked" });
    expect(await peer.next("evict")).toEqual({ type: "evict", reason: "revoked" });
    expect(await peer.closed).toBe(closeCodes.revoked);
    const row = await api.test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } });
    expect(row.state).toBe("revoked");
    expect(row.revokedAt).not.toBeNull();
    expect(await api.test.db.auditEntry.count({ where: { action: "runner.rejected", entityId: runner.runnerId } })).toBe(1);
    const refused = await postJson(`${gateway.url}${runnerPaths.token}`, signAssertion(runner.key, runner.runnerId));
    expect(refused.status).toBe(403);
    // Only a joining runner is approved or rejected.
    await expect((await api.as(a.admin)).runners.approve({ runnerId: runner.runnerId })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("a pool without the switch", () => {
  it("F-091: puts a joined runner online at its first hello, as before", async () => {
    const { a } = api.fixture;
    const poolId = await defaultPool(false);
    const made = await (await api.as(a.admin)).pools.createJoinToken({ poolId });
    const runner = await joined(made.token, "no-approval");
    await connected(runner);
    expect(await stateOf(runner.runnerId)).toBe("online");
    const task = await seedQueuedTask(api.test.db, world, a.admin, null);
    expect(await dispatch(dispatchPayload(task))).toMatchObject({ ok: true, runnerId: runner.runnerId });
  });
});
