import { createHash, randomBytes } from "node:crypto";

import type { OrganizationId, PoolId, ProjectId, RunnerId } from "@ostra/protocol";
import { organizationIdSchema, poolIdSchema, projectIdSchema, runnerIdSchema } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedTask } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// Milestone 5, tickets 30 and 31 (F-092, F-091): what the pool's page and the runner's page read
// beyond ticket 26. A project's busy boxes on a pool, counted from seeded `Box` rows; and the key's
// fingerprint and the join token's maker on a runner's page, which an admin checks before approving.

let harness: ApiHarness;
let organizationId: OrganizationId;

beforeAll(async () => {
  harness = await createApiHarness();
  organizationId = organizationIdSchema.parse(harness.fixture.a.organization.id);
});

afterAll(async () => {
  await harness.dispose();
});

const seedPool = async (name: string): Promise<PoolId> => {
  const row = await harness.test.db.runnerPool.create({ data: { organizationId, name }, select: { id: true } });
  return poolIdSchema.parse(row.id);
};

const seedRunner = async (poolId: PoolId, name: string, publicKey = randomBytes(32).toString("base64url")): Promise<RunnerId> => {
  const row = await harness.test.db.runner.create({
    data: { organizationId, kind: "pool", poolId, name, publicKey, executor: "docker", capacity: 4, slots: 4, labels: [], version: "0.5.0", state: "online" },
    select: { id: true },
  });
  return runnerIdSchema.parse(row.id);
};

const seedProjectOn = async (poolId: PoolId, name: string, maxBoxes: number | null): Promise<ProjectId> => {
  const project = await harness.test.db.project.create({ data: { organizationId, name, slug: `${name}-${randomBytes(3).toString("hex")}`, access: "open" }, select: { id: true } });
  await harness.test.db.projectPool.create({ data: { organizationId, projectId: project.id, poolId, position: 0, maxBoxes } });
  return projectIdSchema.parse(project.id);
};

const seedBox = async (projectId: ProjectId, runnerId: RunnerId, state: "creating" | "preparing" | "ready" | "idle" | "stopped" | "released" | "failed") => {
  const task = await seedTask(harness, { organizationId, projectId, state: "running" });
  await harness.test.db.box.create({ data: { organizationId, projectId, taskId: task.taskId, runnerId, executor: "docker", state } });
};

describe("a pool's projects against their shares (F-092)", () => {
  it("F-092: pools.get counts each project's boxes that hold a slot on the pool's runners, and no other pool's or stopped box", async () => {
    const poolId = await seedPool("shared-boxes");
    const other = await seedPool("other-boxes");
    const runner = await seedRunner(poolId, "shared-01");
    const elsewhere = await seedRunner(other, "other-01");
    const calc = await seedProjectOn(poolId, "share-calc", 2);
    const shop = await seedProjectOn(poolId, "share-shop", null);
    await harness.test.db.projectPool.create({ data: { organizationId, projectId: shop, poolId: other, position: 1 } });
    await seedBox(calc, runner, "creating");
    await seedBox(calc, runner, "ready");
    await seedBox(calc, runner, "stopped");
    await seedBox(shop, runner, "idle");
    await seedBox(shop, runner, "released");
    await seedBox(shop, elsewhere, "ready");

    const admin = await harness.as(harness.fixture.a.admin);
    const pool = await admin.pools.get({ poolId });
    expect(pool.projects.map((project) => ({ name: project.name, busy: project.busy, maxBoxes: project.maxBoxes }))).toEqual([
      { name: "share-calc", busy: 2, maxBoxes: 2 },
      { name: "share-shop", busy: 1, maxBoxes: null },
    ]);
  });
});

describe("a runner's page, for the admin who approves it (F-091)", () => {
  it("F-091: runners.get names the key by its SHA-256 fingerprint, never the key, and who made the token it joined with", async () => {
    const a = harness.fixture.a;
    const admin = await harness.as(a.admin);
    const made = await admin.pools.create({ name: "keyed-fleet", requiresApproval: true });
    const poolId = made.poolId;
    const publicKey = randomBytes(32).toString("base64url");
    const runnerId = await seedRunner(poolId, "keyed-01", publicKey);
    await harness.test.db.runner.update({ where: { id: runnerId }, data: { state: "joining", joinTokenId: made.joinToken.joinTokenId } });

    const page = await admin.runners.get({ runnerId });
    const expected = `SHA256:${createHash("sha256").update(publicKey).digest("base64").replace(/=+$/, "")}`;
    expect(page.keyFingerprint).toBe(expected);
    expect(page.keyFingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(JSON.stringify(page)).not.toContain(publicKey);
    expect(page.joinToken).toMatchObject({ id: made.joinToken.joinTokenId, revoked: false, createdBy: { memberId: a.admin.id } });
    expect(page.awaitingApproval).toBe(true);
  });
});
