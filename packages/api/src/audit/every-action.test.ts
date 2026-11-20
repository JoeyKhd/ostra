import { randomUUID } from "node:crypto";

import type { Db, Tx } from "@ostra/db";
import type { SeededMember } from "@ostra/db/testing";
import { postgresAuditLog, recordAudit, sweepRetention, SYSTEM_ACTOR_NAME } from "@ostra/domain";
import type { AuditAction } from "@ostra/domain";
import { approvalIdSchema, memberIdSchema, noteIdSchema, organizationIdSchema, poolIdSchema, projectIdSchema, repoFullNameSchema, runnerIdSchema, taskIdSchema, userIdSchema } from "@ostra/protocol";
import type { ProjectId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedConnectionAndModel, seedLease, seedPersonalRunner, seedProject, seedTask } from "../testing/index.ts";
import type { AppCaller, ApiHarness } from "../testing/index.ts";

// Milestone 4, ticket 10 (F-073, ADR 0054): each action is recorded with who and when, through the
// panel's own procedures, in the transaction of its change. Each case runs its change twice: once
// as it is, and its entry is there with the actor, the actor's name and the time; and once on a
// database whose every transaction rolls back at its end, and no entry is left. An entry written
// outside the change's transaction would survive the rollback and fail the case.

let harness: ApiHarness;
let world: Awaited<ReturnType<typeof seedConnectionAndModel>>;
let projectId: ProjectId;

/** Every secret and every piece of content the cases use: none may reach an entry. */
const content: string[] = [];

beforeAll(async () => {
  harness = await createApiHarness();
  world = await seedConnectionAndModel(harness);
  projectId = (await seedProject(harness, world, "audited")).projectId;
});

afterAll(async () => {
  await harness.dispose();
});

/** What ends a rolled-back transaction: an error the wrapper alone throws and catches. */
const ROLLED_BACK = new Error("rolled back on purpose");

/**
 * The same database, except that every interactive transaction runs to its end and then rolls
 * back, while its caller sees it succeed. Counts the rollbacks, so a case can't pass by never
 * reaching its transaction.
 */
const rollingBack = (db: Db): { readonly db: Db; readonly rollbacks: () => number } => {
  let rollbacks = 0;
  const transaction = async (run: (tx: Tx) => Promise<unknown>, options?: { readonly timeout?: number }): Promise<unknown> => {
    let result: unknown = undefined;
    try {
      await db.$transaction(async (tx) => {
        result = await run(tx);
        throw ROLLED_BACK;
      }, options);
    } catch (error) {
      if (error !== ROLLED_BACK) {
        throw error;
      }
      rollbacks += 1;
    }
    return result;
  };
  const proxy = new Proxy(db, {
    get: (target, property): unknown => (property === "$transaction" ? transaction : Reflect.get(target, property, target)),
  });
  return { db: proxy, rollbacks: () => rollbacks };
};

type Actor = () => SeededMember;

type Case = {
  readonly action: AuditAction;
  readonly actor: Actor;
  /** Makes what the change needs, committed; returns what `act` takes. */
  readonly setup: () => Promise<Record<string, string>>;
  readonly act: (caller: AppCaller, made: Record<string, string>) => Promise<unknown>;
};

const admin: Actor = () => harness.fixture.a.admin;
const member: Actor = () => harness.fixture.a.member;
const insider: Actor = () => harness.fixture.a.insider;
const orgA = () => harness.fixture.a.organization.id;
const unique = (label: string) => `${label}-${randomUUID().slice(0, 8)}`;
const need = (made: Record<string, string>, key: string): string => {
  const value = made[key];
  if (value === undefined) {
    throw new Error(`the case's setup made no ${key}`);
  }
  return value;
};

/** A running task with a lease on a personal runner, driven by organization A's member. */
const runningTask = async (): Promise<Record<string, string>> => {
  const runnerId = await seedPersonalRunner(harness, harness.fixture.a.admin.id, unique("runner"));
  const task = await seedTask(harness, { organizationId: orgA(), projectId, state: "running", driverMemberId: harness.fixture.a.member.id });
  await seedLease(harness, task, orgA(), projectId, runnerId);
  return { taskId: task.taskId, runnerId };
};

/** A new member of organization A, with its own account. */
const newMember = async (): Promise<string> => {
  const user = await harness.test.db.user.create({ data: { id: randomUUID(), name: "Someone", email: `${unique("someone")}@example.com`, username: unique("someone") } });
  return (await harness.test.db.member.create({ data: { id: randomUUID(), organizationId: orgA(), userId: user.id, role: "member", createdAt: new Date() } })).id;
};

/** A project note written by organization A's member, at version 1. */
const newNote = async () => {
  const body = `Deploys go through the pipeline ${unique("note-canary")}`;
  content.push(body);
  return (await harness.as(member())).memory.save({ noteId: null, expectedVersion: null, scope: "project", projectId, title: "Deploys", body, kind: "command", always: false });
};

const newPool = async (): Promise<string> => (await (await harness.as(admin())).pools.create({ name: unique("pool") })).poolId;

const profileInput = (name: string) => ({
  name,
  adapter: "opencode",
  modelId: world.modelId,
  instructions: null,
  approvalRules: [],
  planFirst: false,
  access: { kind: "everyone" as const },
  mcpServers: [],
  skills: [],
});

const cases: readonly Case[] = [
  {
    action: "task.created",
    actor: member,
    setup: () => {
      const prompt = `Rename the helper ${unique("prompt-canary")}`;
      content.push(prompt);
      return Promise.resolve({ prompt });
    },
    act: (caller, made) => caller.tasks.create({ projectId, prompt: need(made, "prompt") }),
  },
  { action: "task.stopped", actor: insider, setup: runningTask, act: (caller, made) => caller.tasks.stop({ taskId: need(made, "taskId") }) },
  { action: "task.driver-changed", actor: insider, setup: runningTask, act: (caller, made) => caller.tasks.takeOver({ taskId: need(made, "taskId") }) },
  {
    action: "approval.answered",
    actor: insider,
    setup: async () => {
      const made = await runningTask();
      const taskId = need(made, "taskId");
      const task = await harness.test.db.task.update({ where: { id: taskId }, data: { state: "needs_you", needsYouReason: "approval" }, include: { sessions: true } });
      const sessionId = task.sessions[0]?.id ?? "";
      await harness.test.db.session.update({ where: { id: sessionId }, data: { state: "waiting" } });
      const approval = await harness.test.db.approval.create({
        data: {
          organizationId: orgA(),
          projectId,
          taskId,
          sessionId,
          toolCallId: unique("tool"),
          options: [
            { optionId: "o-once", label: "Approve once", kind: "allow-once", decision: "allow_once" },
            { optionId: "o-deny", label: "Deny", kind: "reject-once", decision: "deny" },
          ],
        },
      });
      await harness.test.db.needsYouItem.create({ data: { organizationId: orgA(), projectId, taskId, reason: "approval", audience: "project_members", approvalId: approval.id } });
      return { approvalId: approval.id };
    },
    act: (caller, made) => caller.approvals.answer({ approvalId: approvalIdSchema.parse(need(made, "approvalId")), decision: "allow_once" }),
  },
  { action: "organization.renamed", actor: admin, setup: () => Promise.resolve({ name: unique("Org") }), act: (caller, made) => caller.organization.rename({ name: need(made, "name") }) },
  {
    action: "member.role-changed",
    actor: admin,
    setup: async () => {
      const user = await harness.test.db.user.create({ data: { id: randomUUID(), name: "Promoted", email: `${unique("promoted")}@example.com`, username: unique("promoted") } });
      const row = await harness.test.db.member.create({ data: { id: randomUUID(), organizationId: orgA(), userId: user.id, role: "member", createdAt: new Date() } });
      return { memberId: row.id };
    },
    act: (caller, made) => caller.organization.setMemberRole({ memberId: memberIdSchema.parse(need(made, "memberId")), role: "admin" }),
  },
  { action: "pool.created", actor: admin, setup: () => Promise.resolve({ name: unique("pool") }), act: (caller, made) => caller.pools.create({ name: need(made, "name") }) },
  { action: "pool.updated", actor: admin, setup: async () => ({ poolId: await newPool() }), act: (caller, made) => caller.pools.update({ poolId: poolIdSchema.parse(need(made, "poolId")), maxBoxes: 3 }) },
  {
    action: "join-token.created",
    actor: admin,
    // A pool with no token yet: `pools.create` makes its first one, which this case doesn't count.
    setup: async () => ({ poolId: (await harness.test.db.runnerPool.create({ data: { organizationId: orgA(), name: unique("pool") }, select: { id: true } })).id }),
    act: async (caller, made) => {
      const created = await caller.pools.createJoinToken({ poolId: poolIdSchema.parse(need(made, "poolId")) });
      content.push(created.token);
    },
  },
  {
    action: "join-token.revoked",
    actor: admin,
    setup: async () => {
      const created = await (await harness.as(admin())).pools.createJoinToken({ poolId: poolIdSchema.parse(await newPool()) });
      content.push(created.token);
      return { joinTokenId: created.joinTokenId };
    },
    act: (caller, made) => caller.pools.revokeJoinToken({ joinTokenId: need(made, "joinTokenId") }),
  },
  {
    action: "runner.revoked",
    actor: admin,
    setup: async () => ({ runnerId: await seedPersonalRunner(harness, harness.fixture.a.admin.id, unique("revoked")) }),
    act: (caller, made) => caller.runners.revoke({ runnerId: need(made, "runnerId") }),
  },
  {
    action: "project.created",
    actor: admin,
    setup: () => Promise.resolve({ slug: unique("proj") }),
    act: (caller, made) =>
      caller.projects.create({
        name: need(made, "slug"),
        slug: need(made, "slug"),
        access: "open",
        repo: { connectionId: world.connectionId, installationId: world.installationId, fullName: repoFullNameSchema.parse("ostra-test/test1") },
      }),
  },
  {
    action: "provider.added",
    actor: admin,
    setup: () => Promise.resolve({ name: unique("Provider") }),
    act: (caller, made) =>
      caller.providers.create({
        name: need(made, "name"),
        baseUrl: "https://models.example.com/v1",
        apiFormat: "anthropic-messages",
        authScheme: "x-api-key",
        sessionsAtOnce: null,
        allowOnPersonalRunners: false,
        token: "sk-world-model-token-0123456789abcdef",
      }),
  },
  {
    action: "provider.updated",
    actor: admin,
    setup: () => Promise.resolve({ providerId: world.providerId }),
    act: (caller, made) => caller.providers.update({ providerId: need(made, "providerId"), sessionsAtOnce: 4 }),
  },
  { action: "agent-profile.created", actor: admin, setup: () => Promise.resolve({ name: unique("Profile") }), act: (caller, made) => caller.agentProfiles.save(profileInput(need(made, "name"))) },
  {
    action: "agent-profile.updated",
    actor: admin,
    setup: async () => ({ profileId: (await (await harness.as(admin())).agentProfiles.save(profileInput(unique("Profile")))).profileId }),
    act: (caller, made) => caller.agentProfiles.save({ ...profileInput(unique("Renamed")), profileId: need(made, "profileId") }),
  },
  {
    action: "agent-profile.archived",
    actor: admin,
    setup: async () => ({ profileId: (await (await harness.as(admin())).agentProfiles.save(profileInput(unique("Profile")))).profileId }),
    act: (caller, made) => caller.agentProfiles.archive({ profileId: need(made, "profileId") }),
  },
  // ---- milestone 4: budgets and memory notes (tickets 12, 16, 27, 29) ----
  { action: "budget.set", actor: admin, setup: () => Promise.resolve({}), act: (caller) => caller.budgets.set({ projectId, monthlyUsd: 40 }) },
  {
    action: "budget.cleared",
    actor: admin,
    setup: async () => {
      await (await harness.as(admin())).budgets.set({ projectId, monthlyUsd: 40 });
      return {};
    },
    act: (caller) => caller.budgets.clear({ projectId }),
  },
  {
    action: "memory.note-created",
    actor: member,
    setup: () => Promise.resolve({ body: `Run the tests with pnpm ${unique("note-canary")}` }),
    act: (caller, made) => {
      content.push(need(made, "body"));
      return caller.memory.save({ noteId: null, expectedVersion: null, scope: "project", projectId, title: "Run the tests", body: need(made, "body"), kind: "command", always: false });
    },
  },
  {
    action: "memory.note-edited",
    actor: member,
    setup: async () => ({ noteId: (await newNote()).noteId }),
    act: (caller, made) => {
      const body = `Run them with pnpm test --run ${unique("note-canary")}`;
      content.push(body);
      return caller.memory.save({ noteId: noteIdSchema.parse(need(made, "noteId")), expectedVersion: 1, scope: "project", projectId, title: "Run the tests", body, kind: "command", always: false });
    },
  },
  {
    action: "memory.note-archived",
    actor: member,
    setup: async () => ({ noteId: (await newNote()).noteId }),
    act: (caller, made) => caller.memory.archive({ noteId: noteIdSchema.parse(need(made, "noteId")) }),
  },
  // ---- milestone 4: members, invitations, project access and the instance admin (tickets 22, 23, 43) ----
  { action: "invitation.created", actor: admin, setup: () => Promise.resolve({ email: `${unique("invitee")}@example.com` }), act: (caller, made) => caller.members.invite({ email: need(made, "email"), role: "member", projectGrants: [] }) },
  {
    action: "invitation.revoked",
    actor: admin,
    setup: async () => ({ handle: (await (await harness.as(admin())).members.invite({ email: `${unique("invitee")}@example.com`, role: "member", projectGrants: [] })).handle }),
    act: (caller, made) => caller.members.revokeInvitation({ handle: need(made, "handle") }),
  },
  { action: "member.removed", actor: admin, setup: async () => ({ memberId: await newMember() }), act: (caller, made) => caller.members.remove({ memberId: memberIdSchema.parse(need(made, "memberId")) }) },
  {
    action: "project.access-changed",
    actor: admin,
    setup: async () => ({ projectId: (await harness.test.db.project.create({ data: { organizationId: orgA(), name: unique("p"), slug: unique("p"), access: "open" } })).id }),
    act: (caller, made) => caller.projects.setAccess({ projectId: projectIdSchema.parse(need(made, "projectId")), access: "restricted" }),
  },
  {
    action: "project.member-set",
    actor: admin,
    setup: async () => ({ memberId: await newMember() }),
    act: (caller, made) => caller.projects.setMember({ projectId: harness.fixture.a.restrictedProject.id, memberId: memberIdSchema.parse(need(made, "memberId")), role: "member" }),
  },
  {
    action: "project.member-removed",
    actor: admin,
    setup: async () => {
      const memberId = await newMember();
      await harness.test.db.projectMember.create({ data: { organizationId: orgA(), projectId: harness.fixture.a.restrictedProject.id, memberId, role: "member" } });
      return { memberId };
    },
    act: (caller, made) => caller.projects.removeMember({ projectId: harness.fixture.a.restrictedProject.id, memberId: memberIdSchema.parse(need(made, "memberId")) }),
  },
  {
    action: "instance.admin-granted",
    actor: admin,
    setup: async () => {
      await harness.test.db.user.update({ where: { id: harness.fixture.a.admin.userId }, data: { role: "admin" } });
      const memberId = await newMember();
      return { userId: (await harness.test.db.member.findUniqueOrThrow({ where: { id: memberId } })).userId };
    },
    act: (caller, made) => caller.instance.grantAdmin({ userId: userIdSchema.parse(need(made, "userId")) }),
  },
  {
    action: "instance.admin-revoked",
    actor: admin,
    setup: async () => {
      await harness.test.db.user.update({ where: { id: harness.fixture.a.admin.userId }, data: { role: "admin" } });
      const memberId = await newMember();
      const { userId } = await harness.test.db.member.findUniqueOrThrow({ where: { id: memberId } });
      await harness.test.db.user.update({ where: { id: userId }, data: { role: "admin" } });
      return { userId };
    },
    act: (caller, made) => caller.instance.revokeAdmin({ userId: userIdSchema.parse(need(made, "userId")) }),
  },
];

/** The newest entry of an action in organization A, made after `since`. */
const entriesOf = (action: AuditAction, since: Date) =>
  harness.test.db.auditEntry.findMany({ where: { organizationId: orgA(), action, createdAt: { gte: since } }, orderBy: { createdAt: "desc" } });

describe("every action is recorded with who and when, in its change's transaction (F-073)", () => {
  it.each(cases.map((one) => [one.action, one] as const))("F-073/c1: %s is recorded with who and when", async (_action, one) => {
    const actor = one.actor();
    const account = await harness.test.db.user.findUniqueOrThrow({ where: { id: actor.userId } });

    // As it is: the entry, its actor and the actor's name, and the time of the change.
    const made = await one.setup();
    const before = new Date(Date.now() - 1);
    await one.act(await harness.as(actor), made);
    const after = new Date(Date.now() + 1);
    const entries = await entriesOf(one.action, before);
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry).toMatchObject({ organizationId: orgA(), actorKind: "member", actorId: actor.id, actorName: account.name });
    expect(entry?.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());

    // Rolled back: the change's transaction ends without committing, and leaves no entry.
    const again = await one.setup();
    const rolling = rollingBack(harness.test.db);
    const context = await harness.contextOf(actor);
    const since = new Date(Date.now() - 1);
    await one.act(harness.callerFor({ ...context, deps: { ...context.deps, db: rolling.db } }), again).catch(() => undefined);
    expect(rolling.rollbacks()).toBeGreaterThan(0);
    expect(await entriesOf(one.action, since)).toEqual([]);
  });

  it("F-073/c1: an entry keeps the actor's name as it was, so a removed member's entries still read", async () => {
    const before = new Date(Date.now() - 1);
    await (await harness.as(admin())).pools.create({ name: unique("named") });
    const [entry] = await entriesOf("pool.created", before);
    const account = await harness.test.db.user.findUniqueOrThrow({ where: { id: admin().userId } });
    expect(entry?.actorName).toBe(account.name);
    await harness.test.db.user.update({ where: { id: account.id }, data: { name: "Someone else now" } });
    try {
      expect((await harness.test.db.auditEntry.findUniqueOrThrow({ where: { id: entry?.id ?? "" } })).actorName).toBe(account.name);
    } finally {
      await harness.test.db.user.update({ where: { id: account.id }, data: { name: account.name } });
    }
  });

  it("F-073/c1: no entry's data holds content: the prompts, the join tokens and the model token are in none, by value", async () => {
    expect(content.length).toBeGreaterThan(3);
    const all = JSON.stringify(await harness.test.db.auditEntry.findMany());
    for (const value of [...content, "sk-world-model-token-0123456789abcdef", "WORLD-KEY-BODY-0123456789", "whsec-world-0123456789"]) {
      expect(all).not.toContain(value);
    }
  });
});

describe("who acted (F-073)", () => {
  it("F-073/c1: a runner's entry carries the runner's name, and the system's carries ostra's", async () => {
    const name = unique("named-runner");
    const runnerId = await seedPersonalRunner(harness, harness.fixture.a.admin.id, name);
    const organizationId = organizationIdSchema.parse(orgA());
    const since = new Date(Date.now() - 1);
    await harness.test.db.$transaction(async (tx) => {
      await recordAudit(tx, { organizationId, projectId: null, actor: { kind: "runner", id: runnerId }, action: "runner.registered", entity: "runner", entityId: runnerIdSchema.parse(runnerId) });
      await postgresAuditLog.recordInTx(tx, { organizationId, projectId: null, actor: { kind: "system", id: null }, action: "retention.swept", entity: null, entityId: null });
    });
    expect(await entriesOf("runner.registered", since)).toMatchObject([{ actorKind: "runner", actorId: runnerId, actorName: name }]);
    expect(await entriesOf("retention.swept", since)).toMatchObject([{ actorKind: "system", actorId: null, actorName: SYSTEM_ACTOR_NAME }]);
  });
});

describe("append-only (F-073, ADR 0054)", () => {
  it("F-073/c1: milestone 2's retention sweep deletes a finished task's history and leaves every audit entry, however old", async () => {
    const organizationId = organizationIdSchema.parse(orgA());
    const old = new Date(Date.now() - 400 * 86_400_000);
    const task = await seedTask(harness, { organizationId: orgA(), projectId, state: "stopped" });
    await harness.test.db.event.create({
      data: { organizationId: orgA(), projectId, taskId: task.taskId, seq: 1, sessionId: task.sessionId, leaseEpoch: 1, kind: "user.message", payload: { kind: "user.message" }, occurredAt: old },
    });
    await harness.test.db.task.update({ where: { id: task.taskId }, data: { updatedAt: old } });
    const ancient = await harness.test.db.auditEntry.create({
      data: { organizationId: orgA(), projectId, actorKind: "system", action: "task.stopped", entity: "task", entityId: task.taskId, createdAt: old },
    });
    const before = await harness.test.db.auditEntry.count();
    const swept = await sweepRetention({ db: harness.test.db, audit: postgresAuditLog, clock: { now: () => Date.now() } }, { now: Date.now(), retentionDays: 30 });
    expect(swept).toMatchObject({ ok: true });
    expect(await harness.test.db.event.count({ where: { taskId: task.taskId } })).toBe(0);
    expect(await harness.test.db.auditEntry.findUnique({ where: { id: ancient.id } })).not.toBeNull();
    // Nothing went, and the sweep recorded itself.
    expect(await harness.test.db.auditEntry.count()).toBeGreaterThan(before);
    expect(await harness.test.db.auditEntry.count({ where: { organizationId, action: "task.history_removed", entityId: taskIdSchema.parse(task.taskId) } })).toBe(1);
  });
});
