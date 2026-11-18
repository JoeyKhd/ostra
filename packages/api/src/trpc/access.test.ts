import { randomUUID } from "node:crypto";

import { projectIdSchema, userIdSchema } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createApiHarness } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";
import { adminProcedure, authedProcedure, createCallerFactory, memberProcedure, projectProcedure, publicProcedure, router } from "./init.ts";

// Every procedure helper, one test each, against the isolation fixture (ADR 0026): two
// organizations, and in the first an open and a restricted project. The routers are a probe's:
// these tests are about the helpers, not about a router.

const projectInput = z.object({ projectId: projectIdSchema });

const probe = router({
  open: publicProcedure.query(() => "open"),
  signedIn: authedProcedure.query(({ ctx }) => ctx.user.userId),
  member: memberProcedure.query(({ ctx }) => ctx.scope.organizationId),
  admin: adminProcedure.query(({ ctx }) => ctx.scope.organizationId),
  projectRead: projectProcedure("read", projectInput).query(({ ctx }) => ctx.project.role),
  projectAdmin: projectProcedure("admin", projectInput).mutation(({ ctx }) => ctx.project.role),
});
const callerFactory = createCallerFactory(probe);

let harness: ApiHarness;

beforeAll(async () => {
  harness = await createApiHarness();
});

afterAll(async () => {
  await harness.dispose();
});

type Member = ApiHarness["fixture"]["a"]["member"];

const asMember = async (member: Member) => callerFactory(await harness.contextOf(member));

const signedOut = () => callerFactory({ deps: harness.deps, headers: new Headers(), resHeaders: new Headers(), user: null, member: null, revalidate: () => Promise.resolve(null) });

/** An account that is signed in but belongs to no organization. */
const withoutOrganization = async () => {
  const account = await harness.test.db.user.create({
    data: { id: randomUUID(), name: "stray", email: `stray-${randomUUID()}@example.com`, username: `stray-${randomUUID()}` },
  });
  return callerFactory({
    deps: harness.deps,
    headers: new Headers(),
    resHeaders: new Headers(),
    user: {
      sessionId: "stray-session",
      userId: userIdSchema.parse(account.id),
      name: account.name,
      username: account.username,
      email: account.email,
      instanceAdmin: false,
      sessionOrganizationId: null,
    },
    member: null,
    revalidate: () => Promise.resolve(null),
  });
};

describe("publicProcedure and authedProcedure", () => {
  it("let anyone in, and refuse the signed-out", async () => {
    expect(await signedOut().open()).toBe("open");
    await expect(signedOut().signedIn()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(signedOut().member()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await (await asMember(harness.fixture.a.member)).signedIn()).toBe(harness.fixture.a.member.userId);
  });
});

describe("memberProcedure", () => {
  it("gives a member their own organization's scope, and nobody else's", async () => {
    expect(await (await asMember(harness.fixture.a.member)).member()).toBe(harness.fixture.a.organization.id);
    expect(await (await asMember(harness.fixture.b.admin)).member()).toBe(harness.fixture.b.organization.id);
  });

  it("refuses an account that belongs to no organization", async () => {
    await expect((await withoutOrganization()).member()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("adminProcedure", () => {
  it("lets an organization admin in", async () => {
    expect(await (await asMember(harness.fixture.a.admin)).admin()).toBe(harness.fixture.a.organization.id);
  });

  it("is FORBIDDEN to a member, an insider of a restricted project, and an account with no organization", async () => {
    await expect((await asMember(harness.fixture.a.member)).admin()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect((await asMember(harness.fixture.a.insider)).admin()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect((await withoutOrganization()).admin()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("takes its scope from the member's own organization: another organization's admin is only that organization's", async () => {
    expect(await (await asMember(harness.fixture.b.admin)).admin()).toBe(harness.fixture.b.organization.id);
  });
});

describe("projectProcedure", () => {
  it("opens an open project to any member and its settings to admins only", async () => {
    const { a } = harness.fixture;
    const member = await asMember(a.member);
    expect(await member.projectRead({ projectId: a.openProject.id })).toBe("member");
    await expect(member.projectAdmin({ projectId: a.openProject.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await (await asMember(a.admin)).projectAdmin({ projectId: a.openProject.id })).toBe("admin");
  });

  it("hides a restricted project from a member who isn't listed, and shows it to an insider and admins", async () => {
    const { a } = harness.fixture;
    await expect((await asMember(a.member)).projectRead({ projectId: a.restrictedProject.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await (await asMember(a.insider)).projectRead({ projectId: a.restrictedProject.id })).toBe("member");
    expect(await (await asMember(a.admin)).projectRead({ projectId: a.restrictedProject.id })).toBe("admin");
    // An insider reads, and still can't administer it.
    await expect((await asMember(a.insider)).projectAdmin({ projectId: a.restrictedProject.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("never admits another organization: its project is NOT_FOUND to an admin too, and a made-up ID is the same", async () => {
    const { a, b } = harness.fixture;
    await expect((await asMember(b.admin)).projectRead({ projectId: a.openProject.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect((await asMember(a.admin)).projectRead({ projectId: b.project.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect((await asMember(a.admin)).projectAdmin({ projectId: b.project.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      (await asMember(a.admin)).projectRead({ projectId: projectIdSchema.parse("no-such-project") }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses an input that isn't a project ID before it reads anything", async () => {
    const admin = await asMember(harness.fixture.a.admin);
    // @ts-expect-error -- deliberately the wrong shape: a procedure's input is validated at run time too.
    await expect(admin.projectRead({ projectId: 42 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
