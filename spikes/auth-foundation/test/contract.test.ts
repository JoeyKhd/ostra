import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { getAuthTables } from "better-auth/db";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import * as z from "zod";
import { createAuth } from "../src/auth/create-auth.ts";
import type { OstraAuth } from "../src/auth/create-auth.ts";
import { createPrismaClient } from "../src/db/prisma-client.ts";
import { readSpikeEnv } from "../src/env.ts";
import type { PrismaClient } from "../src/db/prisma-client.ts";
import { randomSecret } from "../src/scenarios/world.ts";
import { installedVersion } from "../src/checks/static-checks.ts";
import { PASSWORD, cookieHeaderFrom, expectRefused, runTag, signInWithEmail, signInWithUsername, signUp } from "../src/scenarios/support.ts";
import { spikeRoot } from "../src/paths.ts";

// The contract between ostra and better-auth: what ostra's server relies on,
// written as tests, so a better-auth upgrade (which can break in a minor
// version, ADR 0003) shows up here first. Covers sign up, the session, a role.

const columnRowsSchema = z.array(z.object({ table_name: z.string(), column_name: z.string() }));

let prisma: PrismaClient;
let auth: OstraAuth;
const tag = runTag();

const spec = (key: string) => ({
  key,
  email: `${key}.${tag}@example.test`,
  username: `${key}_${tag}`,
  password: PASSWORD,
});

beforeAll(() => {
  prisma = createPrismaClient(inject("databaseUrl"));
  // Open sign-up keeps this file about the contract; the invite-only gate is tested by the scenarios.
  auth = createAuth({
    prisma,
    baseURL: "http://127.0.0.1:3999",
    // The same input the harness takes: BETTER_AUTH_SECRET when set, a random one otherwise.
    secret: readSpikeEnv(process.env).BETTER_AUTH_SECRET ?? randomSecret(),
    settings: { openAccountSignup: true, openOrganizationSignup: false },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("the pinned version", () => {
  it("is exact, and is the one installed", async () => {
    const manifest: unknown = JSON.parse(await fs.readFile(path.join(spikeRoot, "package.json"), "utf8"));
    assert.ok(typeof manifest === "object" && manifest !== null && "dependencies" in manifest);
    const dependencies: unknown = manifest.dependencies;
    assert.ok(typeof dependencies === "object" && dependencies !== null && "better-auth" in dependencies);
    const declared: unknown = dependencies["better-auth"];
    expect(declared).toMatch(/^\d+\.\d+\.\d+$/);
    expect(await installedVersion("better-auth")).toBe(declared);
  });
});

describe("sign up", () => {
  it("creates an account from a username, an email and a password, and signs it in", async () => {
    const first = spec("first");
    const { headers, response } = await auth.api.signUpEmail({
      body: { name: first.key, email: first.email, password: first.password, username: first.username },
      returnHeaders: true,
    });
    expect(response.user.email).toBe(first.email);

    // ostra's other processes may read this cookie by name: it is part of the contract.
    const setCookie = headers.getSetCookie().find((line) => line.startsWith("better-auth.session_token="));
    expect(setCookie, "the session cookie keeps its name").toBeDefined();
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//i);

    const session = await auth.api.getSession({ headers: cookieHeaderFrom(headers) });
    expect(session?.user.id).toBe(response.user.id);
  });

  it("stores the username lower-cased and keeps the typed form for display", async () => {
    const mixed = { ...spec("mixed"), username: `Mixed_${tag}` };
    const account = await signUp(auth, mixed);
    const session = await auth.api.getSession({ headers: account.headers });
    expect(session?.user.username).toBe(mixed.username.toLowerCase());
    expect(session?.user.displayUsername).toBe(mixed.username);
  });

  it("refuses an account without a username, and a username that is an email address", async () => {
    const plain = spec("nameless");
    const missing = await expectRefused(() =>
      auth.api.signUpEmail({ body: { name: "n", email: plain.email, password: plain.password } }),
    );
    expect(missing.code).toBe("USERNAME_REQUIRED");
    const shaped = await expectRefused(() =>
      auth.api.signUpEmail({ body: { name: "n", email: plain.email, password: plain.password, username: "a@b" } }),
    );
    expect(shaped.status).toBe(400);
  });

  it("refuses a second account with the same username in another case, or the same email", async () => {
    const original = spec("dupe");
    await signUp(auth, original);
    await expectRefused(() => signUp(auth, { ...original, key: "dupe2", email: `dupe2.${tag}@example.test`, username: original.username.toUpperCase() }));
    await expectRefused(() => signUp(auth, { ...original, key: "dupe3", username: `dupe3_${tag}` }));
  });
});

describe("the session", () => {
  it("is the same account whether you sign in by email or by username", async () => {
    const account = spec("both");
    const created = await signUp(auth, account);
    const byEmail = await signInWithEmail(auth, account);
    const byUsername = await signInWithUsername(auth, account);
    expect(byEmail.userId).toBe(created.userId);
    expect(byUsername.userId).toBe(created.userId);
  });

  it("has the shape ostra reads: user, session, an expiry about a week ahead, no active organization yet", async () => {
    const account = await signUp(auth, spec("shape"));
    const session = await auth.api.getSession({ headers: account.headers });
    expect(session).not.toBeNull();
    expect(session?.session.userId).toBe(account.userId);
    expect(session?.session.activeOrganizationId ?? null).toBeNull();
    const days = ((session?.session.expiresAt.getTime() ?? 0) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);
  });

  it("ends on sign-out, and a request with no cookie has none", async () => {
    const account = await signUp(auth, spec("leaving"));
    expect(await auth.api.getSession({ headers: new Headers() })).toBeNull();
    await auth.api.signOut({ headers: account.headers });
    expect(await auth.api.getSession({ headers: account.headers })).toBeNull();
  });

  it("does not survive a changed password", async () => {
    const account = await signUp(auth, spec("changing"));
    const other = await signInWithEmail(auth, account);
    await auth.api.changePassword({
      body: { currentPassword: account.password, newPassword: "a different passphrase 7", revokeOtherSessions: true },
      headers: account.headers,
    });
    expect(await auth.api.getSession({ headers: other.headers })).toBeNull();
  });
});

describe("a role", () => {
  it("is on the user for the instance: the first account is admin, the next is a plain user", async () => {
    // A database of its own is not needed: whichever account is first overall is the admin,
    // and every account made after it is a user.
    const admins = await prisma.user.findMany({ where: { role: "admin" }, select: { email: true } });
    expect(admins).toHaveLength(1);
    expect(admins[0]?.email).toBe(`first.${tag}@example.test`);

    const later = await signUp(auth, spec("later"));
    const session = await auth.api.getSession({ headers: later.headers });
    expect(session?.user.role).toBe("user");

    const first = await signInWithEmail(auth, spec("first"));
    expect((await auth.api.getSession({ headers: first.headers }))?.user.role).toBe("admin");
  });

  it("is on the membership for an organization: the creator is admin, an invitee is a member", async () => {
    const owner = await signInWithEmail(auth, spec("first"));
    const created = await auth.api.createOrganization({
      body: { name: `Contract ${tag}`, slug: `contract-${tag}` },
      headers: owner.headers,
    });
    expect(created.members[0]?.role).toBe("admin");

    const invitee = await signUp(auth, spec("invitee"));
    const invitation = await auth.api.createInvitation({
      body: { email: invitee.email, role: "member", organizationId: created.id },
      headers: owner.headers,
    });
    const accepted = await auth.api.acceptInvitation({ body: { invitationId: invitation.id }, headers: invitee.headers });
    expect(accepted.member.role).toBe("member");

    await auth.api.setActiveOrganization({ body: { organizationId: created.id }, headers: invitee.headers });
    expect((await auth.api.getActiveMemberRole({ headers: invitee.headers })).role).toBe("member");
    await auth.api.setActiveOrganization({ body: { organizationId: created.id }, headers: owner.headers });
    expect((await auth.api.getActiveMemberRole({ headers: owner.headers })).role).toBe("admin");
  });

  it("decides what a person may do: admins invite, members do not, and there is no owner", async () => {
    const owner = await signInWithEmail(auth, spec("first"));
    const invitee = await signInWithEmail(auth, spec("invitee"));
    const organization = await prisma.organization.findFirst({ where: { slug: `contract-${tag}` }, select: { id: true } });
    assert.ok(organization !== null);

    const asAdmin = await auth.api.hasPermission({
      body: { organizationId: organization.id, permissions: { invitation: ["create"] } },
      headers: owner.headers,
    });
    const asMember = await auth.api.hasPermission({
      body: { organizationId: organization.id, permissions: { invitation: ["create"] } },
      headers: invitee.headers,
    });
    expect(asAdmin.success).toBe(true);
    expect(asMember.success).toBe(false);

    const roles = await prisma.member.findMany({ select: { role: true } });
    expect(new Set(roles.map((member) => member.role))).toEqual(new Set(["admin", "member"]));
  });

  it("separates the instance admin from an organization admin", async () => {
    const orgAdmin = await signInWithEmail(auth, spec("first"));
    const member = await signInWithEmail(auth, spec("invitee"));
    // `first` is both; `invitee` is neither an instance admin nor an organization admin.
    await expect(auth.api.listUsers({ query: { limit: 5 }, headers: orgAdmin.headers })).resolves.toBeDefined();
    await expectRefused(() => auth.api.listUsers({ query: { limit: 5 }, headers: member.headers }));
  });
});

describe("the schema", () => {
  it("has every table and column better-auth expects for ostra's plugins", async () => {
    // better-auth cannot check a Prisma database at start-up, so an upgrade that adds a column
    // would fail at the first query that touches it. This finds the gap first.
    const expected = getAuthTables((await auth.$context).options);
    const rows = columnRowsSchema.parse(await prisma.$queryRaw`
      SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'
    `);
    const actual = new Map<string, Set<string>>();
    for (const row of rows) {
      const columns = actual.get(row.table_name) ?? new Set<string>();
      columns.add(row.column_name);
      actual.set(row.table_name, columns);
    }
    for (const table of Object.values(expected)) {
      const columns = actual.get(table.modelName);
      expect(columns, `table "${table.modelName}" exists`).toBeDefined();
      const wanted = ["id", ...Object.entries(table.fields).map(([key, field]) => field.fieldName ?? key)];
      const missing = wanted.filter((column) => columns?.has(column) !== true);
      expect(missing, `columns missing from "${table.modelName}"`).toEqual([]);
    }
  });
});
