import { randomBytes } from "node:crypto";

import { RUNNER_REVOKED_END_REASON } from "@ostra/domain";
import { runnerIdSchema } from "@ostra/protocol";
import type { RunnerId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedLease, seedTask } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// Milestone 2's ticket 41 (Q131): `runners.revoke`. An admin revokes any runner of the
// organization, a member a personal runner they own; the revoke ends the runner's leases at once,
// with no grace, and stops their tasks as `runner_lost`. The gateway's half (the 4403, the refused
// token) is core's test (`apps/core/src/gateway/revoke.test.ts`).

let harness: ApiHarness;

beforeAll(async () => {
  harness = await createApiHarness();
});

afterAll(async () => {
  await harness.dispose();
});

type State = "joining" | "online" | "offline" | "draining" | "revoked";

const runnerIn = async (
  organizationId: string,
  owner: { readonly kind: "personal"; readonly memberId: string } | { readonly kind: "pool" },
  state: State,
): Promise<RunnerId> => {
  const pool =
    owner.kind === "pool"
      ? await harness.test.db.runnerPool.create({ data: { organizationId, name: `pool-${randomBytes(3).toString("hex")}` }, select: { id: true } })
      : null;
  const row = await harness.test.db.runner.create({
    data: {
      organizationId,
      kind: owner.kind,
      ...(owner.kind === "personal" ? { ownerMemberId: owner.memberId } : { poolId: pool?.id ?? null }),
      name: `runner-${randomBytes(3).toString("hex")}`,
      publicKey: randomBytes(32).toString("base64url"),
      executor: owner.kind === "personal" ? "host" : "docker",
      capacity: 2,
      version: "0.0.0",
      state,
      ...(state === "revoked" ? { revokedAt: new Date(Date.now() - 60_000) } : {}),
    },
    select: { id: true },
  });
  return runnerIdSchema.parse(row.id);
};

/** A running task leased to the runner, with its box ready and its session running. */
const leasedTo = async (runnerId: RunnerId) => {
  const { a } = harness.fixture;
  const task = await seedTask(harness, { organizationId: a.organization.id, projectId: a.openProject.id, state: "running", sessionState: "running" });
  await seedLease(harness, task, a.organization.id, a.openProject.id, runnerId);
  return task;
};

describe("runners.revoke (Q131)", () => {
  it("F-091, F-092: an admin revokes an online runner at once: its leases end, its tasks stop as runner_lost with their epochs raised, in one transaction", async () => {
    const { a } = harness.fixture;
    const runnerId = await runnerIn(a.organization.id, { kind: "pool" }, "online");
    const first = await leasedTo(runnerId);
    const second = await leasedTo(runnerId);
    // A task of another runner is left alone.
    const bystander = await leasedTo(await runnerIn(a.organization.id, { kind: "pool" }, "online"));

    const admin = await harness.as(a.admin);
    expect(await admin.runners.revoke({ runnerId })).toEqual({ runnerId, alreadyRevoked: false, stoppedTasks: 2 });

    const runner = await harness.test.db.runner.findUniqueOrThrow({ where: { id: runnerId } });
    expect(runner.state).toBe("revoked");
    expect(runner.revokedAt).not.toBeNull();
    for (const task of [first, second]) {
      const row = await harness.test.db.task.findUniqueOrThrow({ where: { id: task.taskId }, include: { leases: true, sessions: true, boxes: true } });
      expect(row).toMatchObject({ state: "stopped", stoppedReason: "runner_lost", leaseEpoch: 2 });
      expect(row.leases).toMatchObject([{ epoch: 1, state: "ended", endReason: RUNNER_REVOKED_END_REASON }]);
      expect(row.sessions).toMatchObject([{ state: "stopped" }]);
      expect(row.boxes).toMatchObject([{ state: "stopped" }]);
    }
    expect(await harness.test.db.task.findUniqueOrThrow({ where: { id: bystander.taskId } })).toMatchObject({ state: "running", leaseEpoch: 1 });

    const audit = await harness.test.db.auditEntry.findFirstOrThrow({ where: { action: "runner.revoked", entityId: runnerId } });
    expect(audit).toMatchObject({ organizationId: a.organization.id, actorKind: "member", actorId: a.admin.id });
    expect(audit.data).toMatchObject({ from: "online", stoppedTasks: 2 });
    expect(await harness.test.db.changeNotice.count({ where: { entity: "runner", entityId: runnerId } })).toBeGreaterThan(0);
  });

  it.each(["joining", "offline", "draining"] as const)("F-091: an admin revokes a %s runner the same way", async (state) => {
    const { a } = harness.fixture;
    const runnerId = await runnerIn(a.organization.id, { kind: "pool" }, state);
    const task = await leasedTo(runnerId);
    expect(await (await harness.as(a.admin)).runners.revoke({ runnerId })).toEqual({ runnerId, alreadyRevoked: false, stoppedTasks: 1 });
    expect(await harness.test.db.runner.findUniqueOrThrow({ where: { id: runnerId } })).toMatchObject({ state: "revoked" });
    expect(await harness.test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "stopped", stoppedReason: "runner_lost", leaseEpoch: 2 });
    expect((await harness.test.db.auditEntry.findFirstOrThrow({ where: { action: "runner.revoked", entityId: runnerId } })).data).toMatchObject({ from: state });
  });

  it("F-091: a runner already revoked answers the same and changes nothing", async () => {
    const { a } = harness.fixture;
    const runnerId = await runnerIn(a.organization.id, { kind: "pool" }, "revoked");
    const before = await harness.test.db.runner.findUniqueOrThrow({ where: { id: runnerId } });
    const admin = await harness.as(a.admin);
    expect(await admin.runners.revoke({ runnerId })).toEqual({ runnerId, alreadyRevoked: true, stoppedTasks: 0 });
    expect(await harness.test.db.runner.findUniqueOrThrow({ where: { id: runnerId } })).toEqual(before);
    expect(await harness.test.db.auditEntry.count({ where: { action: "runner.revoked", entityId: runnerId } })).toBe(0);
    // And revoking one twice stops nothing the second time.
    const live = await runnerIn(a.organization.id, { kind: "pool" }, "online");
    await leasedTo(live);
    expect((await admin.runners.revoke({ runnerId: live })).stoppedTasks).toBe(1);
    expect(await admin.runners.revoke({ runnerId: live })).toEqual({ runnerId: live, alreadyRevoked: true, stoppedTasks: 0 });
    expect(await harness.test.db.auditEntry.count({ where: { action: "runner.revoked", entityId: live } })).toBe(1);
  });

  it("F-091: a member revokes their own personal runner, and no one else's", async () => {
    const { a, b } = harness.fixture;
    const own = await runnerIn(a.organization.id, { kind: "personal", memberId: a.member.id }, "online");
    const task = await leasedTo(own);
    const member = await harness.as(a.member);
    expect(await member.runners.revoke({ runnerId: own })).toEqual({ runnerId: own, alreadyRevoked: false, stoppedTasks: 1 });
    expect(await harness.test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ stoppedReason: "runner_lost" });
    expect(await harness.test.db.auditEntry.findFirstOrThrow({ where: { action: "runner.revoked", entityId: own } })).toMatchObject({ actorId: a.member.id });

    // Another member's personal runner, and a pool runner: refused, and nothing changes.
    const admins = await runnerIn(a.organization.id, { kind: "personal", memberId: a.admin.id }, "online");
    const pooled = await runnerIn(a.organization.id, { kind: "pool" }, "online");
    const bystander = await leasedTo(pooled);
    await expect(member.runners.revoke({ runnerId: admins })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(member.runners.revoke({ runnerId: pooled })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await harness.test.db.runner.findUniqueOrThrow({ where: { id: admins } })).toMatchObject({ state: "online", revokedAt: null });
    expect(await harness.test.db.runner.findUniqueOrThrow({ where: { id: pooled } })).toMatchObject({ state: "online", revokedAt: null });
    expect(await harness.test.db.task.findUniqueOrThrow({ where: { id: bystander.taskId } })).toMatchObject({ state: "running", leaseEpoch: 1 });

    // Another organization's admin finds no such runner.
    await expect((await harness.as(b.admin)).runners.revoke({ runnerId: pooled })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await harness.test.db.runner.findUniqueOrThrow({ where: { id: pooled } })).toMatchObject({ state: "online", revokedAt: null });
  });
});
