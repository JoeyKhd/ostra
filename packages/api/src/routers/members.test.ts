import { randomUUID } from "node:crypto";

import { mapMember } from "@ostra/db";
import type { SeededMember } from "@ostra/db/testing";
import { hashCliToken } from "@ostra/domain";
import { memberIdSchema, projectIdSchema } from "@ostra/protocol";
import type { MemberId, OrganizationId, ProjectId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openStream } from "../stream/subscribe.ts";
import { createApiHarness, seedConnectionAndModel, seedPersonalRunner, seedProject, seedTask, trpcFailure } from "../testing/index.ts";
import type { ApiHarness, AppCaller } from "../testing/index.ts";

// F-003, F-087 and F-002's removal (ADR 0053, ADR 0026, ticket 23): members, roles and project access,
// through the panel's procedures on a real database. The matrix below is every new procedure of
// milestone 4's organization tickets (22, 23, 25 and 43), called as each role, each expecting its
// answer; another organization's records are `NOT_FOUND`, never `FORBIDDEN`.

let harness: ApiHarness;
let orgA: OrganizationId;
/** A member listed as an admin of the restricted project. */
let projectAdmin: SeededMember;
/** The organization's GitHub App and installation, for projects with a repo (once per harness). */
let world: Awaited<ReturnType<typeof seedConnectionAndModel>>;

let unique = 0;
const label = (prefix: string) => {
  unique += 1;
  return `${prefix}-${String(unique)}-${randomUUID().slice(0, 6)}`;
};

/** A new account and membership in an organization. */
const seedMember = async (organizationId: string, role: "admin" | "member", name = label("person")): Promise<SeededMember> => {
  const user = await harness.test.db.user.create({ data: { id: randomUUID(), name, email: `${name}@example.com`, username: name } });
  return mapMember(await harness.test.db.member.create({ data: { id: randomUUID(), organizationId, userId: user.id, role, createdAt: new Date() } }));
};

const listOn = async (projectId: string, memberId: string, role: "admin" | "member") => {
  await harness.test.db.projectMember.create({ data: { organizationId: orgA, projectId, memberId, role } });
};

beforeAll(async () => {
  harness = await createApiHarness();
  orgA = harness.fixture.a.organization.id;
  // The fixture's admin of A is the instance admin too, as the seeded first admin is.
  await harness.test.db.user.update({ where: { id: harness.fixture.a.admin.userId }, data: { role: "admin" } });
  projectAdmin = await seedMember(orgA, "member", label("project-admin"));
  await listOn(harness.fixture.a.restrictedProject.id, projectAdmin.id, "admin");
  world = await seedConnectionAndModel(harness);
  await harness.hub.start();
});

afterAll(async () => {
  await harness.dispose();
});

type Who = "admin" | "member" | "insider" | "projectAdmin" | "otherOrganization";
type Expected = "ok" | "FORBIDDEN" | "NOT_FOUND" | "-";

const whoOf = (who: Who): SeededMember => {
  const { a, b } = harness.fixture;
  switch (who) {
    case "admin":
      return a.admin;
    case "member":
      return a.member;
    case "insider":
      return a.insider;
    case "projectAdmin":
      return projectAdmin;
    case "otherOrganization":
      return b.admin;
    default:
      return who satisfies never;
  }
};

const outcomeOf = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;
    return "ok";
  } catch (error) {
    if (error instanceof TRPCError) {
      return error.code === "NOT_FOUND" || error.code === "FORBIDDEN" ? error.code : `unexpected ${error.code}`;
    }
    throw error;
  }
};

describe("the access matrix (ADR 0026, ADR 0053)", () => {
  it("F-003/c1,c2,c3: every new procedure answers each role as the matrix says; another organization's records are NOT_FOUND", async () => {
    const { a } = harness.fixture;
    const restricted = a.restrictedProject.id;
    const restrictedTask = await seedTask(harness, { organizationId: orgA, projectId: restricted });
    // Columns: admin, member, insider (a project member of the restricted project), projectAdmin, another organization's admin.
    const matrix: readonly (readonly [string, (caller: AppCaller) => Promise<unknown>, readonly [Expected, Expected, Expected, Expected, Expected]])[] = [
      ["members.list", (c) => c.members.list(), ["ok", "ok", "ok", "ok", "ok"]],
      ["members.invitations", (c) => c.members.invitations(), ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "-"]],
      ["members.invite", (c) => c.members.invite({ email: `${label("invitee")}@example.com`, role: "member", projectGrants: [] }), ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "-"]],
      ["members.setRole", (c) => c.members.setRole({ memberId: a.member.id, role: "member" }), ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "NOT_FOUND"]],
      [
        "members.remove",
        async (c) => c.members.remove({ memberId: (await seedMember(orgA, "member")).id }),
        ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "NOT_FOUND"],
      ],
      ["projects.access", (c) => c.projects.access({ projectId: restricted }), ["ok", "NOT_FOUND", "ok", "ok", "NOT_FOUND"]],
      ["projects.setAccess", (c) => c.projects.setAccess({ projectId: restricted, access: "restricted" }), ["ok", "NOT_FOUND", "FORBIDDEN", "ok", "NOT_FOUND"]],
      ["projects.setMember", (c) => c.projects.setMember({ projectId: restricted, memberId: a.insider.id, role: "member" }), ["ok", "NOT_FOUND", "FORBIDDEN", "ok", "NOT_FOUND"]],
      ["projects.removeMember", (c) => c.projects.removeMember({ projectId: restricted, memberId: a.member.id }), ["ok", "NOT_FOUND", "FORBIDDEN", "ok", "NOT_FOUND"]],
      ["audit.list (the whole log)", (c) => c.audit.list({}), ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "-"]],
      ["audit.list (a project's)", (c) => c.audit.list({ projectId: restricted }), ["ok", "NOT_FOUND", "FORBIDDEN", "ok", "NOT_FOUND"]],
      ["tasks.eventLog", (c) => c.tasks.eventLog({ taskId: restrictedTask.taskId }), ["ok", "NOT_FOUND", "ok", "ok", "NOT_FOUND"]],
      ["instance.accounts.search", (c) => c.instance.accounts.search({ query: "" }), ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"]],
      ["instance.grantAdmin", (c) => c.instance.grantAdmin({ userId: a.admin.userId }), ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"]],
      ["instance.revokeAdmin", (c) => c.instance.revokeAdmin({ userId: a.member.userId }), ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"]],
      ["accounts.createResetLink", (c) => c.accounts.createResetLink({ userId: a.member.userId }), ["ok", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN", "FORBIDDEN"]],
    ];
    const roles: readonly Who[] = ["admin", "member", "insider", "projectAdmin", "otherOrganization"];
    const seen: string[] = [];
    const wanted: string[] = [];
    for (const [name, call, expected] of matrix) {
      for (const [index, who] of roles.entries()) {
        const want = expected[index];
        if (want === undefined || want === "-") continue;
        const caller = await harness.as(whoOf(who));
        seen.push(`${name} as ${who}: ${await outcomeOf(call(caller))}`);
        wanted.push(`${name} as ${who}: ${want}`);
      }
    }
    expect(seen).toEqual(wanted);
  });
});

describe("roles and the last admin", () => {
  it("F-003/c1: two admins removing each other at once leave one admin, and so do two demotions", async () => {
    const organization = await harness.test.db.organization.create({ data: { id: randomUUID(), name: "race", slug: label("race"), createdAt: new Date() } });
    for (const kind of ["remove", "demote"] as const) {
      const first = await seedMember(organization.id, "admin");
      const second = await seedMember(organization.id, "admin");
      const [one, two] = [await harness.as(first), await harness.as(second)];
      const act = (caller: AppCaller, target: MemberId) =>
        kind === "remove" ? caller.members.remove({ memberId: target }) : caller.members.setRole({ memberId: target, role: "member" });
      const results = await Promise.allSettled([act(one, second.id), act(two, first.id)]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(
        await harness.test.db.member.count({ where: { organizationId: organization.id, id: { in: [first.id, second.id] }, role: "admin", state: "active" } }),
      ).toBe(1);
      // The one left can't be removed or demoted by anyone: it's the last admin.
      await harness.test.db.member.updateMany({ where: { organizationId: organization.id, id: { in: [first.id, second.id] } }, data: { state: "removed", removedAt: new Date() } });
    }
  });

  it("F-003/c1: the last admin can't be demoted or removed, and an admin can't remove themselves", async () => {
    const organization = await harness.test.db.organization.create({ data: { id: randomUUID(), name: "alone", slug: label("alone"), createdAt: new Date() } });
    const only = await seedMember(organization.id, "admin");
    const other = await seedMember(organization.id, "member");
    const caller = await harness.as(only);
    expect(await trpcFailure(caller.members.setRole({ memberId: only.id, role: "member" }))).toMatchObject({ code: "CONFLICT" });
    expect(await trpcFailure(caller.members.remove({ memberId: only.id }))).toMatchObject({ code: "BAD_REQUEST" });
    // Promoted, the other can't remove the last admin either once they're demoted again.
    await caller.members.setRole({ memberId: other.id, role: "admin" });
    await caller.members.setRole({ memberId: other.id, role: "member" });
    expect(await harness.test.db.member.findUniqueOrThrow({ where: { id: only.id } })).toMatchObject({ role: "admin", state: "active" });
    // The milestone 1 route is the same use case.
    expect(await trpcFailure(caller.organization.setMemberRole({ memberId: only.id, role: "member" }))).toMatchObject({ code: "CONFLICT" });
  });
});

describe("project access (F-087)", () => {
  it("F-087/c2: a project member can't edit the environment and a project admin can", async () => {
    const { projectId } = await seedProject(harness, world, label("env"));
    const admin = await harness.as(harness.fixture.a.admin);
    await admin.projects.setAccess({ projectId, access: "restricted" });
    const listedMember = await seedMember(orgA, "member");
    const listedAdmin = await seedMember(orgA, "member");
    await admin.projects.setMember({ projectId, memberId: listedMember.id, role: "member" });
    await admin.projects.setMember({ projectId, memberId: listedAdmin.id, role: "admin" });
    const asMember = await harness.as(listedMember);
    const asProjectAdmin = await harness.as(listedAdmin);
    const current = await asMember.environments.get({ projectId });
    const edited = { baseImage: null, setupScript: "corepack enable\n", envFiles: [], entries: [] };
    expect(await trpcFailure(asMember.environments.save({ projectId, environment: edited }))).toMatchObject({ code: "FORBIDDEN" });
    expect((await asMember.environments.get({ projectId })).setupScript).toBe(current.setupScript);
    await asProjectAdmin.environments.save({ projectId, environment: edited });
    expect(await asMember.environments.get({ projectId })).toMatchObject({ status: "saved", setupScript: "corepack enable\n" });
    // A project admin manages the list, and never invites: the address of a stranger isn't a member.
    expect(await trpcFailure(asProjectAdmin.projects.setMember({ projectId, memberId: memberIdSchema.parse(randomUUID()), role: "member" }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await trpcFailure(asProjectAdmin.members.invite({ email: `${label("x")}@example.com`, role: "member", projectGrants: [] }))).toMatchObject({ code: "FORBIDDEN" });
  });

  it("F-087/c1,c4: restricting a project hides its records from an unlisted member at once, keeps its admins listed and lists who restricted it", async () => {
    const { projectId } = await seedProject(harness, world, label("hide"));
    const task = await seedTask(harness, { organizationId: orgA, projectId });
    const lister = await seedMember(orgA, "member");
    await listOn(projectId, lister.id, "admin");
    const unlisted = await harness.as(harness.fixture.a.member);
    expect((await unlisted.projects.list()).map((project) => project.id)).toContain(projectId);
    expect(await unlisted.tasks.get({ taskId: task.taskId })).toMatchObject({ id: task.taskId });

    // The unlisted member's stream is open on the task, on the default 30 s timer.
    const context = await harness.contextOf(harness.fixture.a.member);
    const scope = context.member?.scope;
    if (scope === undefined) throw new Error("no scope");
    const controller = new AbortController();
    let failure: unknown = null;
    const streaming = (async () => {
      try {
        for await (const value of openStream({ ...context, scope }, { taskId: task.taskId }, controller.signal)) {
          expect(value).toBeDefined();
        }
      } catch (error) {
        failure = error;
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(failure).toBeNull();

    // The project admin restricts it.
    await (await harness.as(lister)).projects.setAccess({ projectId, access: "restricted" });
    expect(await trpcFailure(unlisted.tasks.get({ taskId: task.taskId }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await trpcFailure(unlisted.projects.get({ projectId }))).toMatchObject({ code: "NOT_FOUND" });
    expect((await unlisted.projects.list()).map((project) => project.id)).not.toContain(projectId);
    await Promise.race([streaming, new Promise((resolve) => setTimeout(resolve, 5000))]);
    expect(failure).toMatchObject({ code: "FORBIDDEN" });
    controller.abort();

    const listed = await (await harness.as(lister)).projects.access({ projectId });
    expect(listed.access).toBe("restricted");
    expect(listed.members).toEqual([expect.objectContaining({ memberId: lister.id, role: "admin" })]);
    // An organization admin who restricts a project is listed on it as an admin.
    const { projectId: second } = await seedProject(harness, world, label("hide-two"));
    await (await harness.as(harness.fixture.a.admin)).projects.setAccess({ projectId: second, access: "restricted" });
    expect((await (await harness.as(harness.fixture.a.admin)).projects.access({ projectId: second })).members).toEqual([
      expect.objectContaining({ memberId: harness.fixture.a.admin.id, role: "admin" }),
    ]);
    expect(await harness.test.db.auditEntry.count({ where: { organizationId: orgA, action: "project.access-changed", entityId: projectId } })).toBe(1);
  });
});

describe("removing a member (F-002, ADR 0053)", () => {
  /** A member with one of everything removal ends. */
  const seedLeaver = async () => {
    const { a } = harness.fixture;
    const leaver = await seedMember(orgA, "member", label("leaver"));
    await listOn(a.restrictedProject.id, leaver.id, "member");
    const runnerId = await seedPersonalRunner(harness, leaver.id, label("laptop"));
    const cli = await harness.test.db.cliSession.create({
      data: { organizationId: orgA, memberId: leaver.id, userId: leaver.userId, tokenHash: hashCliToken(randomUUID()), name: "laptop", expiresAt: new Date(Date.now() + 86_400_000) },
    });
    const projectId: ProjectId = projectIdSchema.parse(a.openProject.id);
    const task = await seedTask(harness, { organizationId: orgA, projectId, driverMemberId: leaver.id, creatorMemberId: leaver.id });
    const item = await harness.test.db.needsYouItem.create({ data: { organizationId: orgA, projectId, taskId: task.taskId, reason: "question", audience: "driver" } });
    const repo = await harness.test.db.repo.findFirst({ where: { organizationId: orgA }, select: { id: true, projectId: true } });
    let draftId: string | null = null;
    if (repo !== null) {
      const repoTask = await seedTask(harness, { organizationId: orgA, projectId: projectIdSchema.parse(repo.projectId) });
      const taskRepo = await harness.test.db.taskRepo.create({
        data: { organizationId: orgA, projectId: repo.projectId, taskId: repoTask.taskId, repoId: repo.id, branchName: `ostra/${label("b")}`, baseBranch: "main", state: "no_branch" },
        select: { id: true },
      });
      draftId = (
        await harness.test.db.diffComment.create({
          data: { organizationId: orgA, projectId: repo.projectId, taskId: repoTask.taskId, taskRepoId: taskRepo.id, memberId: leaver.id, path: "a.ts", side: "new", line: 1, headSha: "a".repeat(40), body: "draft" },
          select: { id: true },
        })
      ).id;
    }
    const invitation = await harness.test.db.invitation.create({
      data: { id: randomUUID(), organizationId: orgA, email: `${label("invited")}@example.com`, role: "member", status: "pending", expiresAt: new Date(Date.now() + 86_400_000), inviterId: leaver.userId },
    });
    return { leaver, runnerId, cliId: cli.id, task, itemId: item.id, draftId, invitationId: invitation.id };
  };

  it("F-002/c3: a removal ends each effect in one transaction: membership, project roles, runners, CLI sessions, driving, drafts, invitations, with its entry", async () => {
    await seedProject(harness, world, label("drafts"));
    const seeded = await seedLeaver();
    const admin = await harness.as(harness.fixture.a.admin);
    const removed = await admin.members.remove({ memberId: seeded.leaver.id });
    expect(removed.counts).toEqual({ projectRoles: 1, runnersRevoked: 1, cliSessionsRevoked: 1, tasksUndriven: 1, draftsDeleted: 1, invitationsRevoked: 1 });

    const db = harness.test.db;
    expect(await db.member.findUniqueOrThrow({ where: { id: seeded.leaver.id } })).toMatchObject({ state: "removed", removedByMemberId: harness.fixture.a.admin.id });
    expect(await db.projectMember.count({ where: { memberId: seeded.leaver.id } })).toBe(0);
    expect(await db.runner.findUniqueOrThrow({ where: { id: seeded.runnerId } })).toMatchObject({ state: "revoked" });
    expect((await db.cliSession.findUniqueOrThrow({ where: { id: seeded.cliId } })).revokedAt).toBeInstanceOf(Date);
    expect(await db.task.findUniqueOrThrow({ where: { id: seeded.task.taskId } })).toMatchObject({ driverMemberId: null });
    const driverEvents = await db.event.findMany({ where: { taskId: seeded.task.taskId, kind: "driver.changed" } });
    expect(driverEvents.map((row) => row.payload)).toEqual([{ kind: "driver.changed", memberId: null, byMemberId: harness.fixture.a.admin.id }]);
    expect(await db.needsYouItem.findUniqueOrThrow({ where: { id: seeded.itemId } })).toMatchObject({ audience: "project_members", state: "open" });
    if (seeded.draftId !== null) {
      expect(await db.diffComment.findUniqueOrThrow({ where: { id: seeded.draftId } })).toMatchObject({ state: "deleted" });
    }
    expect(await db.invitation.findUniqueOrThrow({ where: { id: seeded.invitationId } })).toMatchObject({ status: "canceled" });
    expect(await db.auditEntry.count({ where: { organizationId: orgA, action: "member.removed", entityId: seeded.leaver.id } })).toBe(1);
    // The account stays: it may belong to other organizations.
    expect(await db.user.count({ where: { id: seeded.leaver.userId } })).toBe(1);
  });

  it("F-002/c3: a removal that fails part-way leaves everything as it was", async () => {
    const seeded = await seedLeaver();
    const scope = (await harness.contextOf(harness.fixture.a.admin)).member?.scope;
    if (scope === undefined) throw new Error("no scope");
    const { removeMember } = await import("@ostra/domain");
    const failingAudit = {
      recordInTx: async (...args: Parameters<typeof harness.deps.ports.audit.recordInTx>) => {
        if (args[1].action === "member.removed") throw new Error("the audit write failed");
        await harness.deps.ports.audit.recordInTx(...args);
      },
    };
    await expect(removeMember({ db: harness.test.db, ...harness.deps.ports, audit: failingAudit }, scope, { memberId: seeded.leaver.id })).rejects.toThrow("the audit write failed");
    const db = harness.test.db;
    expect(await db.member.findUniqueOrThrow({ where: { id: seeded.leaver.id } })).toMatchObject({ state: "active" });
    expect(await db.projectMember.count({ where: { memberId: seeded.leaver.id } })).toBe(1);
    expect(await db.runner.findUniqueOrThrow({ where: { id: seeded.runnerId } })).toMatchObject({ state: "online" });
    expect(await db.task.findUniqueOrThrow({ where: { id: seeded.task.taskId } })).toMatchObject({ driverMemberId: seeded.leaver.id });
    expect(await db.invitation.findUniqueOrThrow({ where: { id: seeded.invitationId } })).toMatchObject({ status: "pending" });
  });

  it("F-002/c3: a removed member's next call is refused, and their open stream ends at once", async () => {
    const leaver = await seedMember(orgA, "member");
    const caller = await harness.as(leaver);
    expect(Array.isArray(await caller.projects.list())).toBe(true);
    const context = await harness.contextOf(leaver);
    const scope = context.member?.scope;
    if (scope === undefined) throw new Error("no scope");
    const controller = new AbortController();
    let failure: unknown = null;
    // No task: the organization's change notices, on the default 30 s timer.
    const streaming = (async () => {
      try {
        for await (const value of openStream({ ...context, scope }, {}, controller.signal)) {
          expect(value).toBeDefined();
        }
      } catch (error) {
        failure = error;
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 300));

    await (await harness.as(harness.fixture.a.admin)).members.remove({ memberId: leaver.id });
    // Each request reads the membership again: the next one is refused.
    expect(await trpcFailure((await harness.as(leaver)).projects.list())).toMatchObject({ code: "FORBIDDEN" });
    expect(await trpcFailure((await harness.as(leaver)).members.list())).toMatchObject({ code: "FORBIDDEN" });
    await Promise.race([streaming, new Promise((resolve) => setTimeout(resolve, 5000))]);
    expect(failure).toMatchObject({ code: "FORBIDDEN" });
    controller.abort();
  });

  it("F-002/c3: a removed member's panel learns they're no longer a member, and an active member's has an organization", async () => {
    const leaver = await seedMember(orgA, "member");
    expect(await (await harness.as(leaver)).me.get()).toMatchObject({ noMembership: null, organization: { id: orgA } });
    await (await harness.as(harness.fixture.a.admin)).members.remove({ memberId: leaver.id });
    expect(await (await harness.as(leaver)).me.get()).toMatchObject({ noMembership: "removed", organization: null });
  });

  it("F-002/c3: history shows the removed member's name followed by (removed)", async () => {
    const leaver = await seedMember(orgA, "member", label("history"));
    const admin = await harness.as(harness.fixture.a.admin);
    // Something they did, in the audit log.
    await harness.test.db.$transaction((tx) =>
      harness.deps.ports.audit.recordInTx(tx, {
        organizationId: orgA,
        projectId: null,
        actor: { kind: "member", id: leaver.id },
        action: "github.unlinked",
        entity: "member",
        entityId: leaver.id,
      }),
    );
    await admin.members.remove({ memberId: leaver.id });
    const name = (await harness.test.db.user.findUniqueOrThrow({ where: { id: leaver.userId } })).name;

    const everyone = await admin.organization.members();
    expect(everyone.find((member) => member.memberId === leaver.id)).toMatchObject({ name: `${name} (removed)`, state: "removed" });
    expect((await admin.members.list()).map((member) => member.memberId)).not.toContain(leaver.id);
    expect((await admin.members.list({ includeRemoved: true })).find((member) => member.memberId === leaver.id)).toMatchObject({ name: `${name} (removed)` });
    const entries = await admin.audit.list({ actorId: leaver.id });
    expect(entries.entries[0]?.actor).toEqual({ kind: "member", id: leaver.id, name, removed: true });
  });
});

describe("members.list", () => {
  it("F-003/c2: addresses for admins only, and a member sees only the restricted projects they can open", async () => {
    const { a } = harness.fixture;
    const asAdmin = (await (await harness.as(a.admin)).members.list()).find((member) => member.memberId === a.insider.id);
    const asMember = (await (await harness.as(a.member)).members.list()).find((member) => member.memberId === a.insider.id);
    expect(asAdmin?.email).toContain("@example.com");
    expect(asAdmin?.projects.map((project) => project.projectId)).toContain(a.restrictedProject.id);
    expect(asMember?.email).toBeNull();
    expect(asMember?.projects).toEqual([]);
    // Another organization's members never.
    const ids = (await (await harness.as(a.admin)).members.list({ includeRemoved: true })).map((member) => member.memberId);
    expect(ids).not.toContain(harness.fixture.b.admin.id);
  });
});

describe("members.list for the panel (members.md)", () => {
  it("F-002/c3: an admin sees who invited a member, what removing them ends, and who removed them; a member sees none of it", async () => {
    const { a } = harness.fixture;
    const db = harness.test.db;
    const joiner = await seedMember(orgA, "member", label("joiner"));
    // Invited by the admin, accepted by the joiner; an older, revoked invitation of the same account counts for nothing.
    await db.invitation.create({
      data: { id: randomUUID(), organizationId: orgA, email: `${label("old")}@example.com`, role: "member", status: "canceled", expiresAt: new Date(Date.now() + 86_400_000), inviterId: a.member.userId, revokedAt: new Date() },
    });
    await db.invitation.create({
      data: { id: randomUUID(), organizationId: orgA, email: `${label("joined")}@example.com`, role: "member", status: "accepted", expiresAt: new Date(Date.now() + 86_400_000), inviterId: a.admin.userId, acceptedAt: new Date(), acceptedUserId: joiner.userId },
    });
    // What removal would end: two runners (one already revoked doesn't count), a CLI session, a task they drive, an invitation they sent.
    await seedPersonalRunner(harness, joiner.id, label("laptop"));
    await seedPersonalRunner(harness, joiner.id, label("desktop"));
    const gone = await seedPersonalRunner(harness, joiner.id, label("old-laptop"));
    await db.runner.update({ where: { id: gone }, data: { state: "revoked", revokedAt: new Date() } });
    await db.cliSession.create({
      data: { organizationId: orgA, memberId: joiner.id, userId: joiner.userId, tokenHash: hashCliToken(randomUUID()), name: "laptop", expiresAt: new Date(Date.now() + 86_400_000) },
    });
    await db.cliSession.create({
      data: { organizationId: orgA, memberId: joiner.id, userId: joiner.userId, tokenHash: hashCliToken(randomUUID()), name: "old", expiresAt: new Date(Date.now() + 86_400_000), revokedAt: new Date() },
    });
    await seedTask(harness, { organizationId: orgA, projectId: projectIdSchema.parse(a.openProject.id), driverMemberId: joiner.id, creatorMemberId: joiner.id });
    await db.invitation.create({
      data: { id: randomUUID(), organizationId: orgA, email: `${label("theirs")}@example.com`, role: "member", status: "pending", expiresAt: new Date(Date.now() + 86_400_000), inviterId: joiner.userId },
    });

    const adminName = (await db.user.findUniqueOrThrow({ where: { id: a.admin.userId }, select: { name: true } })).name;
    const admin = await harness.as(a.admin);
    const seen = (await admin.members.list()).find((member) => member.memberId === joiner.id);
    expect(seen?.invitedBy).toBe(adminName);
    expect(seen?.onBehalf).toEqual({ personalRunners: 2, cliSessions: 1, drivingTasks: 1, draftComments: 0, invitationsSent: 1 });
    expect(seen?.removedBy).toBeNull();
    // The first admin joined without an invitation.
    expect((await admin.members.list()).find((member) => member.memberId === a.admin.id)?.invitedBy).toBeNull();

    const asMember = (await (await harness.as(a.member)).members.list()).find((member) => member.memberId === joiner.id);
    expect(asMember).toMatchObject({ invitedBy: null, onBehalf: null, removedBy: null });

    // The counts are what the removal then ends.
    const removed = await admin.members.remove({ memberId: joiner.id });
    expect(removed.counts).toMatchObject({ runnersRevoked: 2, cliSessionsRevoked: 1, tasksUndriven: 1, invitationsRevoked: 1 });
    const after = (await admin.members.list({ includeRemoved: true })).find((member) => member.memberId === joiner.id);
    expect(after).toMatchObject({ state: "removed", removedBy: adminName, onBehalf: null });
  });
});
