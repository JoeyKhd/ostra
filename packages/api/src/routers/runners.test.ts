import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedPersonalRunner } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// Ticket 33: runners, runner pools and join tokens. Admin only; a join token is shown once and
// kept hashed.

let harness: ApiHarness;

beforeAll(async () => {
  harness = await createApiHarness();
});

afterAll(async () => {
  await harness.dispose();
});

describe("runner pools", () => {
  it("are made and changed by admins, per organization", async () => {
    const { a, b } = harness.fixture;
    const admin = await harness.as(a.admin);
    const { poolId } = await admin.pools.create({ name: "gpu", requiresApproval: true, maxBoxes: 4 });
    expect(await harness.test.db.runnerPool.findUniqueOrThrow({ where: { id: poolId } })).toMatchObject({
      organizationId: a.organization.id,
      name: "gpu",
      isDefault: false,
      requiresApproval: true,
      maxBoxes: 4,
    });
    await expect((await harness.as(a.member)).pools.create({ name: "nope" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(admin.pools.create({ name: "gpu" })).rejects.toMatchObject({ code: "CONFLICT" });
    // The same name in another organization is another pool.
    await expect((await harness.as(b.admin)).pools.create({ name: "gpu" })).resolves.toBeDefined();

    await admin.pools.update({ poolId, maxBoxes: null, requiresApproval: false });
    expect(await harness.test.db.runnerPool.findUniqueOrThrow({ where: { id: poolId } })).toMatchObject({ maxBoxes: null, requiresApproval: false });
    await expect((await harness.as(b.admin)).pools.update({ poolId, name: "stolen" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect((await harness.as(a.member)).pools.update({ poolId, name: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(admin.pools.update({ poolId, name: "" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("list their runners and projects, for admins of that organization only", async () => {
    const { a, b } = harness.fixture;
    const admin = await harness.as(a.admin);
    const { poolId } = await admin.pools.create({ name: "counted" });
    await harness.test.db.runner.createMany({
      data: [
        { organizationId: a.organization.id, kind: "pool", poolId, name: "one", publicKey: "p".repeat(43), executor: "docker", capacity: 2, version: "0.0.0", state: "online" },
        { organizationId: a.organization.id, kind: "pool", poolId, name: "two", publicKey: "q".repeat(43), executor: "docker", capacity: 2, version: "0.0.0", state: "offline" },
        { organizationId: a.organization.id, kind: "pool", poolId, name: "gone", publicKey: "r".repeat(43), executor: "docker", capacity: 2, version: "0.0.0", state: "revoked" },
      ],
    });
    const counted = (await admin.pools.list()).find((pool) => pool.id === poolId);
    expect(counted).toMatchObject({ runnerCount: 2, onlineCount: 1, projectCount: 0, activeJoinTokens: 0, isDefault: false });
    expect((await (await harness.as(b.admin)).pools.list()).map((pool) => pool.id)).not.toContain(poolId);
    await expect((await harness.as(a.member)).pools.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("join tokens (Q48, Q94)", () => {
  it("are shown once and stored hashed, and never listed", async () => {
    const { a } = harness.fixture;
    const admin = await harness.as(a.admin);
    const { poolId } = await admin.pools.create({ name: "joining" });
    const made = await admin.pools.createJoinToken({ poolId, label: "ci" });
    expect(made.token).toMatch(/^ostra-join-[A-Za-z0-9_-]{43}$/);
    expect(made.expiresAt).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);

    const row = await harness.test.db.joinToken.findUniqueOrThrow({ where: { id: made.joinTokenId } });
    // The hash is the one core checks at the runner's registration: SHA-256, hex.
    expect(row.tokenHash).toBe(createHash("sha256").update(made.token).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(made.token);
    expect(row).toMatchObject({ organizationId: a.organization.id, poolId, label: "ci", bootstrap: false, createdByMemberId: a.admin.id, revokedAt: null });

    const listed = await admin.pools.joinTokens({ poolId });
    expect(listed).toMatchObject([{ id: made.joinTokenId, label: "ci", bootstrap: false, revokedAt: null, lastUsedAt: null }]);
    expect(JSON.stringify(listed)).not.toContain(made.token);
    expect(JSON.stringify(listed)).not.toContain(row.tokenHash);
    // Not in the audit trail, the log or the change notices either.
    expect(JSON.stringify(await harness.test.db.auditEntry.findMany())).not.toContain(made.token);
    expect(JSON.stringify(harness.logs)).not.toContain(made.token);
    expect((await admin.pools.list()).find((pool) => pool.id === poolId)?.activeJoinTokens).toBe(1);
  });

  it("can be made without an expiry, and revoked, once", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    const { poolId } = await admin.pools.create({ name: "revocable" });
    const made = await admin.pools.createJoinToken({ poolId, expiresInDays: null });
    expect(made.expiresAt).toBeNull();
    await admin.pools.revokeJoinToken({ joinTokenId: made.joinTokenId });
    const first = (await harness.test.db.joinToken.findUniqueOrThrow({ where: { id: made.joinTokenId } })).revokedAt;
    expect(first).not.toBeNull();
    await admin.pools.revokeJoinToken({ joinTokenId: made.joinTokenId });
    expect((await harness.test.db.joinToken.findUniqueOrThrow({ where: { id: made.joinTokenId } })).revokedAt).toEqual(first);
    expect(await harness.test.db.auditEntry.count({ where: { action: "join-token.revoked", entityId: made.joinTokenId } })).toBe(1);
    expect((await admin.pools.list()).find((pool) => pool.id === poolId)?.activeJoinTokens).toBe(0);
  });

  it("are for admins of the pool's organization: a member is FORBIDDEN, another organization sees NOT_FOUND", async () => {
    const { a, b } = harness.fixture;
    const admin = await harness.as(a.admin);
    const { poolId } = await admin.pools.create({ name: "guarded" });
    const made = await admin.pools.createJoinToken({ poolId });
    await expect((await harness.as(a.member)).pools.createJoinToken({ poolId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect((await harness.as(a.member)).pools.joinTokens({ poolId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect((await harness.as(a.member)).pools.revokeJoinToken({ joinTokenId: made.joinTokenId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const outsider = await harness.as(b.admin);
    await expect(outsider.pools.createJoinToken({ poolId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(outsider.pools.joinTokens({ poolId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(outsider.pools.revokeJoinToken({ joinTokenId: made.joinTokenId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await harness.test.db.joinToken.findUniqueOrThrow({ where: { id: made.joinTokenId } })).revokedAt).toBeNull();
  });
});

describe("runners.list and runners.mine", () => {
  it("show an admin every runner and a member only their own, personal ones marked not isolated", async () => {
    const { a, b } = harness.fixture;
    await seedPersonalRunner(harness, a.member.id, "member laptop");
    await seedPersonalRunner(harness, a.admin.id, "admin laptop");
    const all = await (await harness.as(a.admin)).runners.list();
    expect(all.filter((runner) => runner.kind === "personal").map((runner) => [runner.name, runner.isolated, runner.owner?.memberId])).toEqual(
      expect.arrayContaining([
        ["member laptop", false, a.member.id],
        ["admin laptop", false, a.admin.id],
      ]),
    );
    expect(all.find((runner) => runner.kind === "pool")).toMatchObject({ executor: "docker", isolated: true, pool: { name: "counted" } });
    await expect((await harness.as(a.member)).runners.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await (await harness.as(a.member)).runners.mine()).map((runner) => runner.name)).toEqual(["member laptop"]);
    expect(await (await harness.as(b.admin)).runners.list()).toEqual([]);
    expect(await (await harness.as(b.admin)).runners.mine()).toEqual([]);
  });
});
