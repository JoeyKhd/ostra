import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

let harness: ApiHarness;

beforeAll(async () => {
  harness = await createApiHarness();
});

afterAll(async () => {
  await harness.dispose();
});

describe("organization.get and me.get", () => {
  it("say which organization the caller is in, and their role", async () => {
    const { a, b } = harness.fixture;
    const asMember = await harness.as(a.member);
    expect(await asMember.organization.get()).toMatchObject({ id: a.organization.id, role: "member" });
    expect(await (await harness.as(a.admin)).organization.get()).toMatchObject({ id: a.organization.id, role: "admin" });
    expect(await (await harness.as(b.admin)).organization.get()).toMatchObject({ id: b.organization.id, role: "admin" });
    const me = await asMember.me.get();
    expect(me).toMatchObject({ memberId: a.member.id, organization: { id: a.organization.id, role: "member" } });
  });

  it("are refused to the signed-out", async () => {
    await expect(harness.anonymous().organization.get()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(harness.anonymous().me.get()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("organization.members", () => {
  it("lists the caller's organization only, and shows addresses to admins only", async () => {
    const { a, b } = harness.fixture;
    const forMember = await (await harness.as(a.member)).organization.members();
    expect(forMember.map((row) => row.memberId).sort()).toEqual([a.admin.id, a.member.id, a.insider.id].sort());
    expect(forMember.every((row) => row.email === null)).toBe(true);
    const forAdmin = await (await harness.as(a.admin)).organization.members();
    expect(forAdmin.every((row) => row.email !== null)).toBe(true);
    const other = await (await harness.as(b.admin)).organization.members();
    expect(other.map((row) => row.memberId)).toEqual([b.admin.id]);
  });
});

describe("organization.rename and setMemberRole", () => {
  it("are for admins: a member is FORBIDDEN", async () => {
    const { a } = harness.fixture;
    const member = await harness.as(a.member);
    await expect(member.organization.rename({ name: "Nope" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(member.organization.setMemberRole({ memberId: a.member.id, role: "admin" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rename an organization, with an audit entry and a change notice", async () => {
    const { a } = harness.fixture;
    await (await harness.as(a.admin)).organization.rename({ name: "Renamed Org" });
    expect((await harness.test.db.organization.findUniqueOrThrow({ where: { id: a.organization.id } })).name).toBe("Renamed Org");
    expect(await harness.test.db.auditEntry.count({ where: { organizationId: a.organization.id, action: "organization.renamed" } })).toBe(1);
    expect(await harness.test.db.changeNotice.count({ where: { organizationId: a.organization.id, entity: "organization" } })).toBe(1);
  });

  it("change a role, but never to a role other than admin or member, and never another organization's member", async () => {
    const { a, b } = harness.fixture;
    const admin = await harness.as(a.admin);
    expect(await admin.organization.setMemberRole({ memberId: a.member.id, role: "admin" })).toEqual({ memberId: a.member.id, role: "admin" });
    expect((await harness.test.db.member.findUniqueOrThrow({ where: { id: a.member.id } })).role).toBe("admin");
    await admin.organization.setMemberRole({ memberId: a.member.id, role: "member" });
    // @ts-expect-error -- "owner" isn't a role: the input schema refuses it at run time as well.
    await expect(admin.organization.setMemberRole({ memberId: a.member.id, role: "owner" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // B's admin is invisible to A's admin.
    await expect(admin.organization.setMemberRole({ memberId: b.admin.id, role: "member" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await harness.test.db.member.findUniqueOrThrow({ where: { id: b.admin.id } })).role).toBe("admin");
  });

  it("never demote the last admin", async () => {
    const { b } = harness.fixture;
    await expect(
      (await harness.as(b.admin)).organization.setMemberRole({ memberId: b.admin.id, role: "member" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("leave one admin when two demote each other at once", async () => {
    const { a } = harness.fixture;
    await (await harness.as(a.admin)).organization.setMemberRole({ memberId: a.member.id, role: "admin" });
    const first = await harness.as(a.admin);
    const second = await harness.as(a.member);
    const results = await Promise.allSettled([
      first.organization.setMemberRole({ memberId: a.member.id, role: "member" }),
      second.organization.setMemberRole({ memberId: a.admin.id, role: "member" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    const admins = await harness.test.db.member.count({ where: { organizationId: a.organization.id, role: "admin" } });
    expect(admins).toBeGreaterThanOrEqual(1);
  });
});

describe("organization.previews", () => {
  it("F-142/c2: Organization › Previews reads the organization's own public-links switch and the link limit, for its admins only, and follows each audited change", async () => {
    const { a, b } = harness.fixture;
    const admin = await harness.as(a.admin);
    // Its name as it is now (an earlier case renamed it).
    const { name } = await harness.test.db.organization.findUniqueOrThrow({ where: { id: a.organization.id }, select: { name: true } });
    expect(await admin.organization.previews()).toEqual({ name, publicPreviewLinks: false, linkMaxDays: 7 });
    await expect((await harness.as(a.member)).organization.previews()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(harness.anonymous().organization.previews()).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    await admin.organization.setPublicPreviewLinks({ enabled: true });
    expect(await admin.organization.previews()).toMatchObject({ publicPreviewLinks: true });
    // Another organization's switch is its own.
    expect(await (await harness.as(b.admin)).organization.previews()).toMatchObject({ name: b.organization.name, publicPreviewLinks: false });
    await admin.organization.setPublicPreviewLinks({ enabled: false });
    expect(await admin.organization.previews()).toMatchObject({ publicPreviewLinks: false });
    expect(await harness.test.db.auditEntry.count({ where: { organizationId: a.organization.id, action: "organization.public_preview_links_changed" } })).toBe(2);
  });
});
