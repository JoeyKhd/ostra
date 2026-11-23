import { randomUUID } from "node:crypto";

import type { Db, Prisma } from "@ostra/db";
import { organizationIdSchema, poolIdSchema, runnerIdSchema, taskIdSchema } from "@ostra/protocol";
import type { ExecutorKind, MemberId, OrganizationId, PoolId, ProjectId, RunnerCapabilities, RunnerId, TaskId } from "@ostra/protocol";

import { seedMember as seedMemberWith } from "../use-cases/seed-member.ts";
import type { SeedMemberInput, SeedMemberResult } from "../use-cases/seed-member.ts";

// @ostra/domain/testing: what tests across packages seed with (spec section 8). Vitest only.

/**
 * A member for a test (spec section 8, Q165): the same code `pnpm dev:seed-member` calls, with a
 * test's hash in place of better-auth's, so it signs in nowhere. A test that signs in passes the
 * real hasher to `seedMember` from `@ostra/domain` instead.
 */
export const seedMember = (db: Db, input: SeedMemberInput): Promise<SeedMemberResult> =>
  seedMemberWith({ db, hashPassword: (password) => Promise.resolve(`test-hash:${String(password.length)}`), env: { NODE_ENV: "test" } }, input);

/** A seeded organization (spec section 8): the second organization of every isolation and access test. */
export type SeededOrganization = { readonly organizationId: OrganizationId; readonly name: string; readonly slug: string };

/**
 * An organization for a test, beside the install's first (spec section 8). One organization per
 * install is v1's product (F-134); a second exists only in fixtures, so isolation stays tested.
 */
export const seedOrganization = async (db: Db, input: { readonly name: string }): Promise<SeededOrganization> => {
  const organizationId = organizationIdSchema.parse(randomUUID());
  const slug = `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "org"}-${organizationId.slice(0, 8)}`;
  await db.organization.create({ data: { id: organizationId, name: input.name, slug, createdAt: new Date() } });
  return { organizationId, name: input.name, slug };
};

// ---------- milestone 5: pools, runners and queued tasks (spec section 8) ----------

/** A seeded pool. */
export type SeededPool = { readonly poolId: PoolId };

/** A pool for a test, linked to `projects` in that order (`ProjectPool.position`), each with its share. */
export const seedPool = async (
  db: Db,
  input: {
    readonly organizationId: OrganizationId;
    readonly name?: string;
    readonly requiresApproval?: boolean;
    readonly maxBoxes?: number | null;
    readonly projects?: readonly { readonly projectId: ProjectId; readonly position?: number; readonly maxBoxes?: number | null }[];
  },
): Promise<SeededPool> => {
  const pool = await db.runnerPool.create({
    data: {
      organizationId: input.organizationId,
      name: input.name ?? `pool-${randomUUID().slice(0, 8)}`,
      requiresApproval: input.requiresApproval ?? false,
      maxBoxes: input.maxBoxes ?? null,
    },
    select: { id: true },
  });
  const poolId = poolIdSchema.parse(pool.id);
  for (const [index, link] of (input.projects ?? []).entries()) {
    await db.projectPool.create({
      data: { organizationId: input.organizationId, projectId: link.projectId, poolId, position: link.position ?? index, maxBoxes: link.maxBoxes ?? null },
    });
  }
  return { poolId };
};

/** A seeded runner. */
export type SeededRunner = { readonly runnerId: RunnerId };

/**
 * A runner for a test: a pool runner when `poolId` is given, else a member's personal runner.
 * Online and approved by default, with what a minor-4 runner reports.
 */
export const seedRunner = async (
  db: Db,
  input: {
    readonly organizationId: OrganizationId;
    readonly poolId?: PoolId;
    readonly ownerMemberId?: MemberId;
    readonly executor?: ExecutorKind;
    readonly state?: "joining" | "online" | "offline" | "draining" | "revoked";
    readonly slots?: number;
    readonly resources?: { readonly cpuMillis: number; readonly memoryMiB: number } | null;
    readonly labels?: readonly string[];
    readonly capabilities?: RunnerCapabilities;
    readonly minor?: number;
  },
): Promise<SeededRunner> => {
  const slots = input.slots ?? 2;
  const runner = await db.runner.create({
    data: {
      organizationId: input.organizationId,
      kind: input.poolId === undefined ? "personal" : "pool",
      poolId: input.poolId ?? null,
      ownerMemberId: input.poolId === undefined ? (input.ownerMemberId ?? null) : null,
      name: `runner-${randomUUID().slice(0, 8)}`,
      publicKey: randomUUID(),
      executor: input.executor ?? "docker",
      capacity: slots,
      slots,
      cpuMillis: input.resources?.cpuMillis ?? null,
      memoryMiB: input.resources?.memoryMiB ?? null,
      labels: [...(input.labels ?? [])],
      version: "0.5.0",
      minor: input.minor ?? 4,
      state: input.state ?? "online",
      ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
      approvedAt: new Date(),
    },
    select: { id: true },
  });
  return { runnerId: runnerIdSchema.parse(runner.id) };
};

/** A queued prompt task for a test, at its place in the queue's order. */
export const seedQueuedTask = async (
  db: Db,
  input: {
    readonly organizationId: OrganizationId;
    readonly projectId: ProjectId;
    readonly creatorMemberId?: MemberId;
    readonly queuePriority?: number;
    readonly queuedAt?: Date;
    readonly requiredLabels?: readonly string[];
    readonly runnerId?: RunnerId;
  },
): Promise<{ readonly taskId: TaskId }> => {
  const queuedAt = input.queuedAt ?? new Date();
  const task = await db.task.create({
    data: {
      organizationId: input.organizationId,
      projectId: input.projectId,
      kind: "code",
      source: "prompt",
      title: "A queued task",
      prompt: "Add a CONTRIBUTING.md",
      branchName: `ostra/queued-${randomUUID().slice(0, 8)}`,
      state: "queued",
      creatorMemberId: input.creatorMemberId ?? null,
      runnerId: input.runnerId ?? null,
      queuePriority: input.queuePriority ?? 3,
      queuedAt,
      requiredLabels: [...(input.requiredLabels ?? [])],
      createdAt: queuedAt,
    },
    select: { id: true },
  });
  return { taskId: taskIdSchema.parse(task.id) };
};

/**
 * A queued task no member started (ticket 14): what milestone 6's intake rules, schedules and
 * Linear's agent mode make. Its member may be known (`driverMemberId`), and it may even name a
 * personal runner, but it goes to pools only (ADR 0059).
 */
export const seedTaskStartedByNobody = async (
  db: Db,
  input: {
    readonly organizationId: OrganizationId;
    readonly projectId: ProjectId;
    readonly driverMemberId?: MemberId;
    readonly runnerId?: RunnerId;
    readonly queuePriority?: number;
    readonly queuedAt?: Date;
  },
): Promise<{ readonly taskId: TaskId }> => {
  const { taskId } = await seedQueuedTask(db, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    ...(input.runnerId === undefined ? {} : { runnerId: input.runnerId }),
    ...(input.queuePriority === undefined ? {} : { queuePriority: input.queuePriority }),
    ...(input.queuedAt === undefined ? {} : { queuedAt: input.queuedAt }),
  });
  await db.task.update({ where: { id: taskId }, data: { creatorMemberId: null, driverMemberId: input.driverMemberId ?? null } });
  return { taskId };
};

// Milestone 6 (spec section 8).
export * from "./m6.ts";

// ---------- milestone 11: connecting Jira (spec section 9, "The connect kit") ----------

export { createFakeJiraConnectKit, fakeJiraReadBack, FAKE_JIRA_PROJECTS } from "./jira-connect.ts";
export type { FakeJiraConnectCall, FakeJiraConnectKit, FakeJiraSite, FakeJiraTokenProfile } from "./jira-connect.ts";
export { FakeSecretStore } from "./fake-adapters.ts";

/** An audit entry whose time a fixture controls: the e2e thread seed's `budget.set` has its own date. */
export const seedAuditEntry = async (db: Db, entry: Prisma.AuditEntryUncheckedCreateInput): Promise<void> => {
  await db.auditEntry.create({ data: entry });
};
