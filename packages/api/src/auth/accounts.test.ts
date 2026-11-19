import { randomBytes, randomUUID } from "node:crypto";

import { isAPIError } from "better-auth/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBareHarness, cookieHeaderFrom, TEST_PASSWORD } from "../testing/index.ts";
import type { BareHarness } from "../testing/index.ts";
import { ensureFirstAdmin } from "./first-admin.ts";

// F-002 (Q54, ADR 0003, ADR 0026): accounts, through better-auth with ostra's rules on top, on a
// real database. The parts of the row milestone 1 builds: unique usernames and addresses, sign-in
// with either, the two organization roles, a reset link that signs out the other sessions, no
// verification without email, and no sign-in method but the password. Invitations as a flow, and
// who creates a reset link, are milestone 4.

let harness: BareHarness;
let admin: Headers;
let organizationId: string;

const refusalOf = async (call: () => Promise<unknown>): Promise<{ readonly code: string | undefined; readonly status: number }> => {
  try {
    await call();
  } catch (error) {
    if (isAPIError(error)) {
      const code: unknown = Reflect.get(error.body ?? {}, "code");
      return { code: typeof code === "string" ? code : undefined, status: error.statusCode };
    }
    throw error;
  }
  throw new Error("expected the call to be refused");
};

const signIn = async (username: string, password = TEST_PASSWORD): Promise<Headers> => {
  const { headers } = await harness.auth.api.signInUsername({ body: { username, password }, returnHeaders: true });
  return cookieHeaderFrom(headers);
};

/** The instance admin makes an account (better-auth's admin route): the way milestone 1 can add one. */
const createAccount = (input: { readonly email: string; readonly username?: string }) =>
  harness.auth.api.createUser({
    body: {
      email: input.email,
      password: TEST_PASSWORD,
      name: input.username ?? "nameless",
      ...(input.username === undefined ? {} : { data: { username: input.username } }),
    },
    headers: admin,
  });

beforeAll(async () => {
  harness = await createBareHarness();
  const seeded = await ensureFirstAdmin({
    db: harness.test.db,
    settings: { firstAdmin: { email: "ada@example.com", username: "ada", password: TEST_PASSWORD, organizationName: "Calculator Co" } },
    hashPassword: harness.deps.hashPassword,
    ports: harness.deps.ports,
    logger: harness.deps.logger,
  });
  if (seeded === null) throw new Error("the first admin was not seeded");
  organizationId = seeded.organizationId;
  const { headers } = await harness.auth.api.signInEmail({ body: { email: "ada@example.com", password: TEST_PASSWORD }, returnHeaders: true });
  admin = cookieHeaderFrom(headers);
});

afterAll(async () => {
  await harness.dispose();
});

describe("an account", () => {
  it("F-002: every account has a unique username and an email address", async () => {
    const bob = await createAccount({ email: "bob@example.com", username: "bob" });
    expect(bob.user).toMatchObject({ email: "bob@example.com" });

    // A second account can't take the username, nor the address (in any case).
    await expect(createAccount({ email: "other-bob@example.com", username: "bob" })).rejects.toThrow();
    for (const email of ["bob@example.com", "BOB@Example.com"]) {
      await expect(createAccount({ email, username: "bobby" })).rejects.toThrow();
    }
    // The database holds the rule too, for any path that writes an account: a duplicate username or address is refused.
    for (const duplicate of [
      { username: "bob", email: "another@example.com" },
      { username: "another", email: "bob@example.com" },
    ]) {
      await expect(harness.test.db.user.create({ data: { id: randomUUID(), name: "dup", ...duplicate } })).rejects.toThrow();
    }
    // Nor can one be made with no username at all.
    expect(await refusalOf(() => createAccount({ email: "nameless@example.com" }))).toMatchObject({ code: "USERNAME_REQUIRED" });

    const users = await harness.test.db.user.findMany({ orderBy: { createdAt: "asc" }, select: { username: true, email: true } });
    expect(users).toEqual([
      { username: "ada", email: "ada@example.com" },
      { username: "bob", email: "bob@example.com" },
    ]);
  });

  it("F-002: a member signs in with the username or the email, and the password, and not with a wrong one", async () => {
    for (const attempt of ["username", "email"] as const) {
      const { headers } =
        attempt === "username"
          ? await harness.auth.api.signInUsername({ body: { username: "bob", password: TEST_PASSWORD }, returnHeaders: true })
          : await harness.auth.api.signInEmail({ body: { email: "bob@example.com", password: TEST_PASSWORD }, returnHeaders: true });
      const session = await harness.auth.api.getSession({ headers: cookieHeaderFrom(headers) });
      expect(session?.user.email).toBe("bob@example.com");
    }
    await expect(harness.auth.api.signInUsername({ body: { username: "bob", password: "not-the-password-at-all" } })).rejects.toThrow();
    await expect(harness.auth.api.signInEmail({ body: { email: "bob@example.com", password: "not-the-password-at-all" } })).rejects.toThrow();
  });

  it("F-002: with no email set up, an account signs in with an address nobody verified, and no verification mail can be asked for", async () => {
    expect(await harness.test.db.user.findUniqueOrThrow({ where: { username: "bob" }, select: { emailVerified: true } })).toEqual({ emailVerified: false });
    const session = await harness.auth.api.getSession({ headers: await signIn("bob") });
    expect(session?.user).toMatchObject({ email: "bob@example.com", emailVerified: false });
    // There is no mail to send: better-auth has no sender for it.
    await expect(harness.auth.api.sendVerificationEmail({ body: { email: "bob@example.com" } })).rejects.toThrow();
  });

  it("F-002: the password is the only way in: no social, magic-link or anonymous sign-in is on", async () => {
    expect(await refusalOf(() => harness.auth.api.signInSocial({ body: { provider: "github" } }))).toMatchObject({ status: 404 });
    // Over HTTP too, as a browser would ask.
    for (const route of ["sign-in/social", "sign-in/magic-link", "sign-in/anonymous", "sign-in/email-otp", "sign-in/passkey"]) {
      const response = await harness.auth.handler(
        new Request(`http://localhost:3000/api/auth/${route}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:3000" },
          body: JSON.stringify({ provider: "github", email: "bob@example.com" }),
        }),
      );
      expect({ route, ok: response.ok }).toEqual({ route, ok: false });
    }
    const passwordSignIn = await harness.auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/username", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({ username: "bob", password: TEST_PASSWORD }),
      }),
    );
    expect(passwordSignIn.status).toBe(200);
  });
});

describe("a reset link", () => {
  it("F-002: using a reset link sets the new password, signs out the account's other sessions, and works once", async () => {
    const elsewhere = await signIn("bob");
    expect(await harness.auth.api.getSession({ headers: elsewhere })).not.toBeNull();

    // The link's token, stored the way better-auth stores the one it makes (milestone 4 adds the
    // instance admin's button that makes it; this checks what using one does).
    const bob = await harness.test.db.user.findUniqueOrThrow({ where: { username: "bob" } });
    const token = randomBytes(18).toString("base64url");
    await harness.test.db.verification.create({
      data: { id: randomUUID(), identifier: `reset-password:${token}`, value: bob.id, expiresAt: new Date(Date.now() + 60_000) },
    });
    const newPassword = "a-brand-new-password-for-bob";
    await harness.auth.api.resetPassword({ body: { token, newPassword } });

    expect(await harness.auth.api.getSession({ headers: elsewhere })).toBeNull();
    expect(await harness.test.db.authSession.count({ where: { userId: bob.id } })).toBe(0);
    await expect(signIn("bob")).rejects.toThrow();
    expect(await signIn("bob", newPassword)).toBeInstanceOf(Headers);
    // The same link again is refused.
    expect(await refusalOf(() => harness.auth.api.resetPassword({ body: { token, newPassword: "yet-another-password-1" } }))).toMatchObject({
      code: "INVALID_TOKEN",
    });
  });
});

describe("organization roles", () => {
  it("F-002: only admin and member exist: an invitation, a new member or a role change to owner or any other role is refused", async () => {
    // better-auth refuses a name it doesn't know; "owner" and a list holding it are ones it knows, which ostra's hook refuses.
    for (const [role, code] of [["owner", "ROLE_NOT_FOUND"], ["admin,owner", "ROLE_NOT_FOUND"], ["superadmin", undefined]] as const) {
      const refusal = await refusalOf(() =>
        harness.auth.api.createInvitation({
          // @ts-expect-error -- the types allow admin and member only; the hook is the runtime guard for what a request sends.
          body: { email: "carol@example.com", role, organizationId },
          headers: admin,
        }),
      );
      expect({ role, ...refusal }).toEqual({ role, code, status: 400 });
    }
    expect(await harness.test.db.invitation.count()).toBe(0);

    const dave = await createAccount({ email: "dave@example.com", username: "dave" });
    expect(
      // @ts-expect-error -- as above: "owner" is not one of ostra's roles.
      await refusalOf(() => harness.auth.api.addMember({ body: { userId: dave.user.id, role: "owner", organizationId } })),
    ).toMatchObject({ code: "ROLE_NOT_FOUND" });
    const member = await harness.auth.api.addMember({ body: { userId: dave.user.id, role: "member", organizationId } });
    expect(member.role).toBe("member");
    expect(
      await refusalOf(() => harness.auth.api.updateMemberRole({ body: { memberId: member.id, role: "owner", organizationId }, headers: admin })),
    ).toMatchObject({ code: "ROLE_NOT_FOUND" });
    expect((await harness.test.db.member.findMany({ select: { role: true }, orderBy: { createdAt: "asc" } })).map((row) => row.role)).toEqual(["admin", "member"]);

    for (const role of ["admin", "member"] as const) {
      const invitation = await harness.auth.api.createInvitation({ body: { email: `${role}-invitee@example.com`, role, organizationId }, headers: admin });
      expect(invitation.role).toBe(role);
    }
  });
});

describe("an invitation", () => {
  it("F-002: an invitation expires after 7 days, and an admin can revoke it", async () => {
    const before = Date.now();
    const invitation = await harness.auth.api.createInvitation({ body: { email: "erin@example.com", role: "member", organizationId }, headers: admin });
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    expect(new Date(invitation.expiresAt).getTime() - before).toBeGreaterThanOrEqual(sevenDays - 5_000);
    expect(new Date(invitation.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(sevenDays);

    // A member can't revoke it; the admin can.
    const dave = await signIn("dave");
    await expect(harness.auth.api.cancelInvitation({ body: { invitationId: invitation.id }, headers: dave })).rejects.toThrow();
    expect((await harness.test.db.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).status).toBe("pending");
    await harness.auth.api.cancelInvitation({ body: { invitationId: invitation.id }, headers: admin });
    expect((await harness.test.db.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).status).toBe("canceled");
  });
});
