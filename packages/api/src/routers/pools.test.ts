import { createHash, randomBytes } from "node:crypto";

import { registerPoolRunner } from "@ostra/domain";
import type { PoolAdminDeps } from "@ostra/domain";
import type { PoolId, RunnerId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// Milestone 5, ticket 25 (F-091): pools, join tokens and approval through the panel's API. Admins
// of the pool's organization only; a member is FORBIDDEN, another organization's admin NOT_FOUND.
// A token is in the answer that makes it and nowhere else. A runner joins through the domain's
// `registerPoolRunner`, the use case core's register endpoint calls.

let harness: ApiHarness;

beforeAll(async () => {
  harness = await createApiHarness();
});

afterAll(async () => {
  await harness.dispose();
});

const joinDeps = (): PoolAdminDeps => ({
  db: harness.test.db,
  audit: harness.deps.ports.audit,
  notices: harness.deps.ports.notices,
  clock: harness.deps.ports.clock,
  jobs: harness.deps.ports.jobs,
});

/** A runner joins with a token, as core's register endpoint has it join. */
const join = (token: string, name: string) =>
  registerPoolRunner(joinDeps(), {
    token,
    name,
    publicKey: randomBytes(32).toString("base64url"),
    executor: "docker",
    version: "0.5.0",
    install: "npm",
    labels: [],
  });

const joined = async (token: string, name: string): Promise<RunnerId> => {
  const result = await join(token, name);
  if (!result.ok) {
    throw new Error(`the join was refused: ${result.error}`);
  }
  return result.runnerId;
};

const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex");

describe("pools (F-091)", () => {
  it("F-091: pools.create, update, list and get as an admin; a member is FORBIDDEN and another organization's admin NOT_FOUND", async () => {
    const { a, b } = harness.fixture;
    const admin = await harness.as(a.admin);
    const made = await admin.pools.create({
      name: "build-fleet",
      requiresApproval: true,
      maxBoxes: 3,
      joinTokenDays: 30,
      projectIds: [a.openProject.id],
    });
    expect(made.pool).toEqual({
      id: made.poolId,
      name: "build-fleet",
      requiresApproval: true,
      maxBoxes: 3,
      joinTokenDays: 30,
    });
    expect(made.joinToken.token).toMatch(/^ostra-join-[A-Za-z0-9_-]{43}$/);
    expect(made.joinToken.expiresAt).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    // The pool and its first token, one audit entry each.
    expect(
      await harness.test.db.auditEntry.count({
        where: { action: "pool.created", entityId: made.poolId },
      }),
    ).toBe(1);
    expect(
      await harness.test.db.auditEntry.count({
        where: { action: "join-token.created", entityId: made.joinToken.joinTokenId },
      }),
    ).toBe(1);

    await admin.pools.update({ poolId: made.poolId, maxBoxes: 5, joinTokenDays: 0 });
    expect(
      await harness.test.db.runnerPool.findUniqueOrThrow({ where: { id: made.poolId } }),
    ).toMatchObject({ maxBoxes: 5, joinTokenDays: 0, updatedByMemberId: a.admin.id });
    const page = await admin.pools.get({ poolId: made.poolId });
    expect(page).toMatchObject({
      id: made.poolId,
      name: "build-fleet",
      requiresApproval: true,
      maxBoxes: 5,
      joinTokenDays: 0,
      runners: [],
    });
    expect(page.tokens.map((token) => token.id)).toEqual([made.joinToken.joinTokenId]);
    expect(page.projects).toEqual([
      expect.objectContaining({ projectId: a.openProject.id, maxBoxes: null }),
    ]);
    expect((await admin.pools.list()).map((pool) => pool.id)).toContain(made.poolId);

    const member = await harness.as(a.member);
    await expect(member.pools.create({ name: "nope" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(member.pools.update({ poolId: made.poolId, maxBoxes: 1 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(member.pools.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(member.pools.get({ poolId: made.poolId })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    const outsider = await harness.as(b.admin);
    await expect(
      outsider.pools.update({ poolId: made.poolId, name: "stolen" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(outsider.pools.get({ poolId: made.poolId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await outsider.pools.list()).map((pool) => pool.id)).not.toContain(made.poolId);
    // Another organization's project is refused, and nothing of the pool is left.
    await expect(
      outsider.pools.create({ name: "with-theirs", projectIds: [a.openProject.id] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await harness.test.db.runnerPool.count({ where: { name: "with-theirs" } })).toBe(0);
    // The same name in another organization is another pool; twice in one is refused.
    await expect(outsider.pools.create({ name: "build-fleet" })).resolves.toBeDefined();
    await expect(admin.pools.create({ name: "build-fleet" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("F-091, F-086: a pool made for projects goes at the end of each one's list, after the default pool", async () => {
    const { a } = harness.fixture;
    const admin = await harness.as(a.admin);
    const { poolId } = await admin.pools.create({
      name: "for-restricted",
      projectIds: [a.restrictedProject.id],
    });
    const links = await harness.test.db.projectPool.findMany({
      where: { projectId: a.restrictedProject.id },
      orderBy: { position: "asc" },
      include: { pool: { select: { isDefault: true } } },
    });
    expect(links.map((link) => [link.pool.isDefault, link.position])).toEqual([
      [true, 0],
      [false, 1],
    ]);
    expect(links[1]?.poolId).toBe(poolId);
  });
});

describe("join tokens (F-091)", () => {
  it("F-091: the token is returned once, by the call that makes it, and never by list, get, an audit entry or a log line", async () => {
    const { a } = harness.fixture;
    const admin = await harness.as(a.admin);
    const pool = await admin.pools.create({ name: "shown-once" });
    const second = await admin.joinTokens.create({ poolId: pool.poolId, label: "ci", days: 7 });
    expect(second.expiresAt).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect(second.expiresAt).toBeLessThan(Date.now() + 8 * 86_400_000);
    const forever = await admin.joinTokens.create({ poolId: pool.poolId, days: null });
    expect(forever.expiresAt).toBeNull();

    const tokens = [pool.joinToken.token, second.token, forever.token];
    const secrets = [...tokens, ...tokens.map(hashOf)];
    const answers = JSON.stringify([
      await admin.pools.list(),
      await admin.pools.get({ poolId: pool.poolId }),
      await admin.joinTokens.list({ poolId: pool.poolId }),
      await admin.pools.joinTokens({ poolId: pool.poolId }),
    ]);
    for (const secret of secrets) {
      expect(answers).not.toContain(secret);
    }
    const listed = await admin.joinTokens.list({ poolId: pool.poolId });
    expect(listed.find((token) => token.id === second.joinTokenId)).toMatchObject({
      label: "ci",
      state: "active",
      uses: 0,
      lastUsedAt: null,
      revokedAt: null,
      createdBy: { memberId: a.admin.id },
    });
    expect(JSON.stringify(await harness.test.db.auditEntry.findMany())).not.toContain(second.token);
    expect(JSON.stringify(harness.logs)).not.toContain(second.token);
    // Stored as its hash only.
    expect(
      (await harness.test.db.joinToken.findUniqueOrThrow({ where: { id: second.joinTokenId } }))
        .tokenHash,
    ).toBe(hashOf(second.token));
  });

  it("F-091: joinTokens.create, revoke and list as an admin; a member is FORBIDDEN and another organization's admin NOT_FOUND", async () => {
    const { a, b } = harness.fixture;
    const admin = await harness.as(a.admin);
    const { poolId } = await admin.pools.create({ name: "guarded-tokens" });
    const made = await admin.joinTokens.create({ poolId, label: "fleet" });
    for (const caller of [await harness.as(a.member), await harness.as(a.insider)]) {
      await expect(caller.joinTokens.create({ poolId })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(caller.joinTokens.list({ poolId })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(caller.joinTokens.revoke({ tokenId: made.joinTokenId })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }
    const outsider = await harness.as(b.admin);
    await expect(outsider.joinTokens.create({ poolId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(outsider.joinTokens.list({ poolId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(outsider.joinTokens.revoke({ tokenId: made.joinTokenId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(
      (await harness.test.db.joinToken.findUniqueOrThrow({ where: { id: made.joinTokenId } }))
        .revokedAt,
    ).toBeNull();

    const revoked = await admin.joinTokens.revoke({ tokenId: made.joinTokenId });
    expect(revoked).toMatchObject({ revoked: true, changed: true });
    // A repeat answers the same and changes nothing.
    expect(await admin.joinTokens.revoke({ tokenId: made.joinTokenId })).toEqual({
      ...revoked,
      changed: false,
    });
    expect(
      await harness.test.db.auditEntry.count({
        where: { action: "join-token.revoked", entityId: made.joinTokenId },
      }),
    ).toBe(1);
    expect(
      (await admin.joinTokens.list({ poolId })).find((token) => token.id === made.joinTokenId),
    ).toMatchObject({ state: "revoked", revokedBy: { memberId: a.admin.id } });
  });

  it("F-091: in a rotation both tokens work until the first is revoked, and the runner that joined with it stays", async () => {
    const { a } = harness.fixture;
    const admin = await harness.as(a.admin);
    const pool = await admin.pools.create({ name: "rotating" });
    const second = await admin.joinTokens.create({ poolId: pool.poolId, label: "next" });
    const first = await joined(pool.joinToken.token, "rot-01");
    const both = await joined(second.token, "rot-02");
    await admin.joinTokens.revoke({ tokenId: pool.joinToken.joinTokenId });
    expect(await join(pool.joinToken.token, "rot-03")).toMatchObject({
      ok: false,
      error: "token-revoked",
    });
    await expect(joined(second.token, "rot-04")).resolves.toBeDefined();
    // The runner that joined with the revoked token is still there, unrevoked.
    expect(await harness.test.db.runner.findUniqueOrThrow({ where: { id: first } })).toMatchObject({
      state: "joining",
      revokedAt: null,
    });
    expect(
      (await harness.test.db.runner.findUniqueOrThrow({ where: { id: both } })).revokedAt,
    ).toBeNull();
    const listed = await admin.joinTokens.list({ poolId: pool.poolId });
    expect(listed.find((token) => token.id === second.joinTokenId)?.uses).toBe(2);
    expect(listed.find((token) => token.id === pool.joinToken.joinTokenId)).toMatchObject({
      state: "revoked",
      uses: 1,
    });
  });
});

describe("approval (F-091)", () => {
  const approvalPool = async (
    name: string,
  ): Promise<{ readonly poolId: PoolId; readonly token: string }> => {
    const admin = await harness.as(harness.fixture.a.admin);
    const made = await admin.pools.create({ name, requiresApproval: true });
    return { poolId: made.poolId, token: made.joinToken.token };
  };

  it("F-091: an admin approves a joining runner; a repeat answers the same and changes nothing", async () => {
    const { a, b } = harness.fixture;
    const { token } = await approvalPool("approving");
    const runnerId = await joined(token, "wants-in");
    expect(
      (await harness.test.db.runner.findUniqueOrThrow({ where: { id: runnerId } })).state,
    ).toBe("joining");
    await expect((await harness.as(a.member)).runners.approve({ runnerId })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect((await harness.as(b.admin)).runners.approve({ runnerId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(
      (await harness.test.db.runner.findUniqueOrThrow({ where: { id: runnerId } })).approvedAt,
    ).toBeNull();

    const admin = await harness.as(a.admin);
    // Not connected: approved, and online at its next hello.
    expect(await admin.runners.approve({ runnerId })).toEqual({
      runnerId,
      state: "joining",
      changed: true,
    });
    const approved = await harness.test.db.runner.findUniqueOrThrow({ where: { id: runnerId } });
    expect(approved).toMatchObject({ approvedByMemberId: a.admin.id });
    expect(approved.approvedAt).not.toBeNull();
    // Online now (its hello came): approving again answers its state and changes nothing.
    await harness.test.db.runner.update({ where: { id: runnerId }, data: { state: "online" } });
    expect(await admin.runners.approve({ runnerId })).toEqual({
      runnerId,
      state: "online",
      changed: false,
    });
    expect(
      (await harness.test.db.runner.findUniqueOrThrow({ where: { id: runnerId } })).approvedAt,
    ).toEqual(approved.approvedAt);
    expect(
      await harness.test.db.auditEntry.count({
        where: { action: "runner.approved", entityId: runnerId },
      }),
    ).toBe(1);
    // A reject of a runner already approved answers the same, and doesn't revoke it.
    expect(await admin.runners.reject({ runnerId })).toEqual({
      runnerId,
      state: "online",
      changed: false,
    });
    expect(
      (await harness.test.db.runner.findUniqueOrThrow({ where: { id: runnerId } })).revokedAt,
    ).toBeNull();
  });

  it("F-091: an admin rejects a joining runner; a repeat, or an approve after, answers the same and changes nothing", async () => {
    const { a, b } = harness.fixture;
    const { token } = await approvalPool("rejecting");
    const runnerId = await joined(token, "turned-away");
    await expect((await harness.as(a.member)).runners.reject({ runnerId })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect((await harness.as(b.admin)).runners.reject({ runnerId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const admin = await harness.as(a.admin);
    expect(await admin.runners.reject({ runnerId })).toEqual({
      runnerId,
      state: "revoked",
      changed: true,
    });
    const rejected = await harness.test.db.runner.findUniqueOrThrow({ where: { id: runnerId } });
    expect(rejected.revokedAt).not.toBeNull();
    expect(await admin.runners.reject({ runnerId })).toEqual({
      runnerId,
      state: "revoked",
      changed: false,
    });
    expect(await admin.runners.approve({ runnerId })).toEqual({
      runnerId,
      state: "revoked",
      changed: false,
    });
    const after = await harness.test.db.runner.findUniqueOrThrow({ where: { id: runnerId } });
    expect(after).toMatchObject({
      state: "revoked",
      revokedAt: rejected.revokedAt,
      approvedAt: null,
    });
    expect(
      await harness.test.db.auditEntry.count({
        where: { action: "runner.rejected", entityId: runnerId },
      }),
    ).toBe(1);
    expect(
      await harness.test.db.auditEntry.count({
        where: { action: "runner.approved", entityId: runnerId },
      }),
    ).toBe(0);
  });
});
