import { randomUUID } from "node:crypto";

import { mapMember } from "@ostra/db";
import type { SeededMember } from "@ostra/db/testing";
import { userIdSchema } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedTask, trpcFailure } from "../testing/index.ts";
import type { ApiHarness, AppCaller } from "../testing/index.ts";
import { appRouter } from "./app-router.ts";

// F-003 (ADR 0053, ADR 0026, ticket 43): the instance admin's accounts. The role is about the install:
// it lists accounts and grants the role, the last instance admin can't give it up, and it reaches
// nothing inside an organization the account isn't a member of.

let harness: ApiHarness;
let instanceAdmin: AppCaller;

const seedAccount = async (name: string, organizationId: string | null): Promise<{ readonly userId: string; readonly member: SeededMember | null }> => {
  const user = await harness.test.db.user.create({ data: { id: randomUUID(), name, email: `${name.toLowerCase()}@example.com`, username: name.toLowerCase() } });
  if (organizationId === null) return { userId: user.id, member: null };
  const member = await harness.test.db.member.create({ data: { id: randomUUID(), organizationId, userId: user.id, role: "member", createdAt: new Date() } });
  return { userId: user.id, member: mapMember(member) };
};

beforeAll(async () => {
  harness = await createApiHarness();
  await harness.test.db.user.update({ where: { id: harness.fixture.a.admin.userId }, data: { role: "admin" } });
  instanceAdmin = await harness.as(harness.fixture.a.admin);
});

afterAll(async () => {
  await harness.dispose();
});

describe("the instance admin role", () => {
  it("F-003/c2: the last instance admin can't revoke the role, and two revokes at once leave one", async () => {
    const self = userIdSchema.parse(harness.fixture.a.admin.userId);
    expect(await trpcFailure(instanceAdmin.instance.revokeAdmin({ userId: self }))).toMatchObject({ code: "CONFLICT" });

    const second = await seedAccount("Second-Admin", harness.fixture.a.organization.id);
    const secondId = userIdSchema.parse(second.userId);
    expect(await instanceAdmin.instance.grantAdmin({ userId: secondId })).toEqual({ instanceAdmin: true });
    expect(await harness.test.db.auditEntry.count({ where: { action: "instance.admin-granted", entityId: secondId } })).toBe(1);
    if (second.member === null) throw new Error("no membership");
    const asSecond = await harness.as(second.member);
    // Five rounds of two revokes at once, each of the other: every round leaves exactly one.
    const ROUNDS = 5;
    for (let round = 0; round < ROUNDS; round += 1) {
      await harness.test.db.user.updateMany({ where: { id: { in: [self, secondId] } }, data: { role: "admin" } });
      const results = await Promise.allSettled([instanceAdmin.instance.revokeAdmin({ userId: secondId }), asSecond.instance.revokeAdmin({ userId: self })]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(await harness.test.db.user.count({ where: { role: "admin" } })).toBe(1);
    }
    expect(await harness.test.db.auditEntry.count({ where: { action: "instance.admin-revoked" } })).toBe(ROUNDS);
    // Put the fixture's admin back as the one instance admin for the tests below.
    await harness.test.db.user.update({ where: { id: self }, data: { role: "admin" } });
    await harness.test.db.user.update({ where: { id: secondId }, data: { role: "user" } });
  });

  it("F-003/c2: an account that isn't the instance admin is refused every instance.* procedure, an organization admin included", async () => {
    const someone = userIdSchema.parse(harness.fixture.a.member.userId);
    const calls: Record<string, (caller: AppCaller) => Promise<unknown>> = {
      "instance.accounts.search": (c) => c.instance.accounts.search({ query: "" }),
      "instance.admins": (c) => c.instance.admins(),
      "instance.grantAdmin": (c) => c.instance.grantAdmin({ userId: someone }),
      "instance.revokeAdmin": (c) => c.instance.revokeAdmin({ userId: someone }),
      "instance.saveRetention": (c) => c.instance.saveRetention({ days: 30 }),
    };
    // Every procedure under `instance.` has a row: a new one without its check fails here.
    const procedures = Object.keys(appRouter._def.procedures).filter((path) => path.startsWith("instance."));
    expect(procedures.sort()).toEqual(Object.keys(calls).sort());
    for (const member of [harness.fixture.a.member, harness.fixture.b.admin]) {
      const caller = await harness.as(member);
      for (const [path, call] of Object.entries(calls)) {
        expect({ path, ...(await trpcFailure(call(caller))) }).toMatchObject({ path, code: "FORBIDDEN" });
      }
    }
    expect(await harness.test.db.user.findUniqueOrThrow({ where: { id: someone } })).toMatchObject({ role: null });
  });

  it("F-003/c2: the instance admin sees no project or task of an organization it isn't a member of", async () => {
    const { b } = harness.fixture;
    const task = await seedTask(harness, { organizationId: b.organization.id, projectId: b.project.id });
    expect(await trpcFailure(instanceAdmin.projects.get({ projectId: b.project.id }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await trpcFailure(instanceAdmin.tasks.get({ taskId: task.taskId }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await trpcFailure(instanceAdmin.tasks.eventLog({ taskId: task.taskId }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await trpcFailure(instanceAdmin.audit.list({ projectId: b.project.id }))).toMatchObject({ code: "NOT_FOUND" });
    expect((await instanceAdmin.projects.list()).map((project) => project.id)).not.toContain(b.project.id);
    // The accounts list names organizations, and carries nothing of their content.
    const listed = await instanceAdmin.instance.accounts.search({ query: "" });
    const fields = new Set(listed.accounts.flatMap((account) => Object.keys(account)));
    expect([...fields].sort()).toEqual(
      ["createdAt", "email", "emailVerified", "instanceAdmin", "instanceAdminSince", "lastSignInAt", "name", "organizations", "userId", "username"].sort(),
    );
    const text = JSON.stringify(listed);
    expect(text).not.toContain(b.project.id);
    expect(text).not.toContain(task.taskId);
  });
});

describe("instance.accounts.search", () => {
  it("F-003/c2: finds accounts by a prefix of the username, the address or the name, case-insensitive, sorted by name, 50 a page", async () => {
    const organizationId = harness.fixture.a.organization.id;
    for (let index = 0; index < 60; index += 1) {
      await seedAccount(`Quill${String(index).padStart(2, "0")}-${randomUUID().slice(0, 4)}`, index % 2 === 0 ? organizationId : null);
    }
    const first = await instanceAdmin.instance.accounts.search({ query: "qUILL" });
    expect(first.accounts).toHaveLength(50);
    expect(first.next).not.toBeNull();
    const second = await instanceAdmin.instance.accounts.search({ query: "quill", ...(first.next === null ? {} : { cursor: first.next }) });
    expect(second.accounts).toHaveLength(10);
    expect(second.next).toBeNull();
    const names = [...first.accounts, ...second.accounts].map((account) => account.name);
    expect(new Set(names).size).toBe(60);
    expect(names).toEqual([...names].sort());
    const withOrganization = first.accounts.find((account) => account.name.startsWith("Quill00"));
    expect(withOrganization).toMatchObject({ organizations: [harness.fixture.a.organization.name], instanceAdmin: false, instanceAdminSince: null, lastSignInAt: null });

    // By the address and the username too, and no stranger matches.
    const address = first.accounts[3]?.email ?? "";
    expect((await instanceAdmin.instance.accounts.search({ query: address.toUpperCase() })).accounts.map((account) => account.email)).toEqual([address]);
    const username = first.accounts[4]?.username ?? "";
    expect((await instanceAdmin.instance.accounts.search({ query: username })).accounts.map((account) => account.username)).toEqual([username]);
    expect((await instanceAdmin.instance.accounts.search({ query: "nobody-like-this" })).accounts).toEqual([]);

    // The instance admin shows with the role and when it had it.
    const me = (await instanceAdmin.instance.accounts.search({ query: (await harness.test.db.user.findUniqueOrThrow({ where: { id: harness.fixture.a.admin.userId } })).username }))
      .accounts[0];
    expect(me?.instanceAdmin).toBe(true);
    expect(typeof me?.instanceAdminSince).toBe("number");
  });
});
