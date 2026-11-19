import { randomUUID } from "node:crypto";

import type { SeededMember } from "@ostra/db/testing";
import { hashCliToken, inviteMember } from "@ostra/domain";
import { createEmailVerificationToken } from "better-auth/api";
import { hashPassword } from "better-auth/crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createApiHarness, cookieHeaderFrom, TEST_PASSWORD, trpcFailure } from "../testing/index.ts";
import type { ApiHarness, AppCaller } from "../testing/index.ts";
import { createContext } from "../trpc/context.ts";
import { hashResetToken, INVITATION_HEADER } from "./account-hooks.ts";

// F-002 (ADR 0053, ticket 22): invitations, sign-up through the link, verification and resets, through
// better-auth's own HTTP handler (`auth.handler`, what `/api/auth/*` serves) on a real database, with
// ostra's hooks around it. Ported from spikes/auth-foundation/src/scenarios/accounts.ts and
// reset-link.ts.

const BASE = "http://localhost:3000";
const DAY = 24 * 60 * 60 * 1000;

let harness: ApiHarness;
let admin: AppCaller;
let organizationId: string;

const responseSchema = z.looseObject({ code: z.string().optional(), message: z.string().optional() });

const call = async (method: "GET" | "POST", path: string, body: object | null, headers: Record<string, string> = {}) => {
  const response = await harness.auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method,
      headers: { "content-type": "application/json", origin: BASE, ...headers },
      ...(body === null ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  const json: unknown = text === "" ? {} : JSON.parse(text);
  return { status: response.status, body: responseSchema.parse(json), raw: json, headers: response.headers };
};

const signUp = (input: { readonly email: string; readonly username: string; readonly invitationId?: string; readonly password?: string }) =>
  call(
    "POST",
    "/sign-up/email",
    { email: input.email, name: input.username, username: input.username, password: input.password ?? TEST_PASSWORD },
    input.invitationId === undefined ? {} : { [INVITATION_HEADER]: input.invitationId },
  );

const signIn = async (email: string, password = TEST_PASSWORD): Promise<Headers> => {
  const response = await call("POST", "/sign-in/email", { email, password });
  if (response.status !== 200) {
    throw new Error(`sign-in refused: ${String(response.status)}`);
  }
  return cookieHeaderFrom(response.headers);
};

/** A caller for a real browser session: the cookie goes through better-auth and ostra's scope. */
const callerWithCookie = async (cookie: Headers): Promise<AppCaller> =>
  harness.callerFor(await createContext(harness.deps, { headers: cookie, resHeaders: new Headers() }));

/** Gives a fixture account a password, so it can sign in through better-auth. */
const givePassword = async (userId: string): Promise<void> => {
  await harness.test.db.account.create({
    data: { id: randomUUID(), accountId: userId, providerId: "credential", userId, password: await hashPassword(TEST_PASSWORD) },
  });
};

const inviteOf = (email: string, extra: { readonly role?: "admin" | "member"; readonly projectGrants?: { projectId: string; role: "admin" | "member" }[] } = {}) =>
  admin.members.invite({
    email,
    role: extra.role ?? "member",
    projectGrants: (extra.projectGrants ?? []).map((grant) => ({ projectId: z.string().brand<"ProjectId">().parse(grant.projectId), role: grant.role })),
  });

const memberOf = (email: string) => harness.test.db.member.findFirst({ where: { organizationId, user: { email } } });

let unique = 0;
const fresh = (label: string) => {
  unique += 1;
  return { email: `${label}-${String(unique)}@example.com`, username: `${label}-${String(unique)}` };
};

beforeAll(async () => {
  harness = await createApiHarness();
  organizationId = harness.fixture.a.organization.id;
  // The fixture's admin of A is also the instance admin, as the seeded first admin is.
  await harness.test.db.user.update({ where: { id: harness.fixture.a.admin.userId }, data: { role: "admin" } });
  admin = await harness.as(harness.fixture.a.admin);
});

afterAll(async () => {
  await harness.dispose();
});

beforeEach(() => {
  harness.emailSwitch.on = false;
  harness.fakes.jobs.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sign-up through an invitation", () => {
  it("F-002: sign-up is refused without an invitation, and leaves no account behind", async () => {
    const before = await harness.test.db.user.count();
    const refused = await signUp(fresh("stranger"));
    expect(refused).toMatchObject({ status: 403, body: { code: "SIGN_UP_CLOSED" } });
    expect(await harness.test.db.user.count()).toBe(before);
  });

  it("F-002: an invitation's ID lets one sign-up through: the account, the membership, its project grants and the acceptance together", async () => {
    const who = fresh("sam");
    const invited = await inviteOf(who.email, { projectGrants: [{ projectId: harness.fixture.a.restrictedProject.id, role: "admin" }] });
    expect(invited.link).toBe(`${BASE}/invite/${invited.invitationId}`);
    expect(invited.invitationId.length).toBeGreaterThanOrEqual(32);

    const signedUp = await signUp({ ...who, invitationId: invited.invitationId });
    expect(signedUp.status).toBe(200);
    const member = await memberOf(who.email);
    expect(member).toMatchObject({ state: "active", role: "member" });
    if (member === null) return;
    expect(await harness.test.db.projectMember.findMany({ where: { memberId: member.id }, select: { projectId: true, role: true } })).toEqual([
      { projectId: harness.fixture.a.restrictedProject.id, role: "admin" },
    ]);
    expect(await harness.test.db.invitation.findUniqueOrThrow({ where: { id: invited.invitationId } })).toMatchObject({ status: "accepted", acceptedUserId: member.userId });
    expect(await harness.test.db.auditEntry.count({ where: { organizationId, action: "invitation.accepted", data: { path: ["invitation"], equals: invited.handle } } })).toBe(1);

    // Signed in, in the organization, and the restricted project it granted is open to them.
    const caller = await callerWithCookie(cookieHeaderFrom(signedUp.headers));
    const projects = await caller.projects.list();
    expect(projects.map((project) => project.id)).toContain(harness.fixture.a.restrictedProject.id);
  });

  it("F-002: a stranger who knows only the address is refused", async () => {
    const who = fresh("known");
    await inviteOf(who.email);
    expect(await signUp(who)).toMatchObject({ status: 403, body: { code: "SIGN_UP_CLOSED" } });
    expect(await signUp({ ...who, invitationId: "a-guess-at-the-id-00000000000000000" })).toMatchObject({ status: 403, body: { code: "INVITATION_NOT_USABLE" } });
    expect(await harness.test.db.user.count({ where: { email: who.email } })).toBe(0);
  });

  it("F-002: an invitation works once", async () => {
    const first = fresh("once");
    const invited = await inviteOf(first.email);
    expect((await signUp({ ...first, invitationId: invited.invitationId })).status).toBe(200);
    const second = fresh("twice");
    expect(await signUp({ ...second, invitationId: invited.invitationId })).toMatchObject({ status: 403, body: { code: "INVITATION_NOT_USABLE" } });
    expect(await harness.test.db.user.count({ where: { email: second.email } })).toBe(0);
  });

  it("F-002: two sign-ups with one invitation at once make one account and one membership", async () => {
    const a = fresh("race-a");
    const b = fresh("race-b");
    const invited = await inviteOf(a.email);
    const results = await Promise.all([signUp({ ...a, invitationId: invited.invitationId }), signUp({ ...b, invitationId: invited.invitationId })]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 403]);
    const joined = await harness.test.db.member.count({ where: { organizationId, user: { email: { in: [a.email, b.email] } } } });
    expect(joined).toBe(1);
    expect(await harness.test.db.user.count({ where: { email: { in: [a.email, b.email] } } })).toBe(1);
  });

  it("F-002: an invitation is refused after 7 days, by the clock", async () => {
    const who = fresh("late");
    const invited = await inviteOf(who.email);
    expect(invited.expiresAt - Date.now()).toBeGreaterThan(7 * DAY - 60_000);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 7 * DAY + 60_000 });
    expect(await signUp({ ...who, invitationId: invited.invitationId })).toMatchObject({ status: 403, body: { code: "INVITATION_NOT_USABLE" } });
    expect(await harness.anonymous().invitations.preview({ invitationId: invited.invitationId })).toMatchObject({ state: "expired", days: 7 });
    vi.useRealTimers();
    // A day short of it, the same invitation still works.
    expect((await signUp({ ...who, invitationId: invited.invitationId })).status).toBe(200);
  });

  it("F-002: an invitation is refused after an admin revokes it", async () => {
    const who = fresh("revoked");
    const invited = await inviteOf(who.email);
    await admin.members.revokeInvitation({ handle: invited.handle });
    expect(await signUp({ ...who, invitationId: invited.invitationId })).toMatchObject({ status: 403, body: { code: "INVITATION_NOT_USABLE" } });
    expect(await harness.anonymous().invitations.preview({ invitationId: invited.invitationId })).toMatchObject({ state: "revoked" });
    expect(await harness.test.db.auditEntry.count({ where: { organizationId, action: "invitation.revoked", data: { path: ["invitation"], equals: invited.handle } } })).toBe(1);
    // A member can't revoke one.
    const another = await inviteOf(fresh("kept").email);
    const member = await harness.as(harness.fixture.a.member);
    expect(await trpcFailure(member.members.revokeInvitation({ handle: another.handle }))).toMatchObject({ code: "FORBIDDEN" });
  });

  it("F-002: owner, or any role but admin and member, is refused, and only an organization admin invites", async () => {
    const who = fresh("owner");
    // @ts-expect-error -- the input allows admin and member only; this is what a request could send.
    expect(await trpcFailure(admin.members.invite({ email: who.email, role: "owner", projectGrants: [] }))).toMatchObject({ code: "BAD_REQUEST" });
    const member = await harness.as(harness.fixture.a.member);
    expect(await trpcFailure(member.members.invite({ email: who.email, role: "member", projectGrants: [] }))).toMatchObject({ code: "FORBIDDEN" });
    // The use case refuses a member too, whatever route calls it.
    const memberScope = (await harness.contextOf(harness.fixture.a.member)).member?.scope;
    if (memberScope === undefined) throw new Error("the fixture's member has no scope");
    expect(
      await inviteMember({ db: harness.test.db, ...harness.deps.ports }, memberScope, { email: who.email, role: "member", projectGrants: [], emailOn: false, days: 7 }),
    ).toMatchObject({ ok: false, error: "forbidden" });
    // Another organization's project can't be granted.
    expect(await trpcFailure(inviteOf(who.email, { projectGrants: [{ projectId: harness.fixture.b.project.id, role: "member" }] }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await harness.test.db.invitation.count({ where: { email: who.email } })).toBe(0);
  });

  it("F-002: the link is returned once: no later read of the invitation holds it", async () => {
    const who = fresh("shown");
    const invited = await inviteOf(who.email, { role: "admin" });
    const listed = await admin.members.invitations();
    const row = listed.find((invitation) => invitation.handle === invited.handle);
    expect(row).toMatchObject({ email: who.email, role: "admin", state: "pending" });
    // Neither the link nor the ID it is made of.
    expect(JSON.stringify(listed)).not.toContain(invited.invitationId);
    expect((await harness.test.db.invitation.findUniqueOrThrow({ where: { id: invited.invitationId } })).linkShownAt).toBeInstanceOf(Date);
    // The public preview says what the page shows, and nothing of the organization's members or projects.
    const preview = await harness.anonymous().invitations.preview({ invitationId: invited.invitationId });
    expect(preview).toEqual({
      state: "pending",
      organizationName: harness.fixture.a.organization.name,
      inviterName: (await harness.test.db.user.findUniqueOrThrow({ where: { id: harness.fixture.a.admin.userId } })).name,
      email: who.email,
      addressLocked: false,
      role: "admin",
      days: 7,
      verificationPending: false,
    });
    expect(await harness.anonymous().invitations.preview({ invitationId: "nothing-like-it" })).toEqual({ state: "not-found" });
  });

  it("F-002: the preview is rate-limited by the client's address", async () => {
    const from = (address: string) =>
      harness.callerFor({ deps: harness.deps, headers: new Headers({ "x-forwarded-for": address }), resHeaders: new Headers(), user: null, member: null, revalidate: () => Promise.resolve(null) });
    const prober = from("203.0.113.9");
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await prober.invitations.preview({ invitationId: `guess-${String(attempt)}` });
    }
    expect(await trpcFailure(prober.invitations.preview({ invitationId: "guess-31" }))).toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(await from("203.0.113.10").invitations.preview({ invitationId: "guess-31" })).toEqual({ state: "not-found" });
  });
});

describe("with email set up", () => {
  beforeEach(() => {
    harness.emailSwitch.on = true;
  });

  it("F-002: the address must be the invitation's, the membership waits for its verification, and the link alone activates nothing", async () => {
    const who = fresh("verify");
    const invited = await inviteOf(who.email);
    // The invitation itself is mailed: an account mail by its ID, never its link.
    expect(harness.fakes.jobs.jobs).toContainEqual(expect.objectContaining({ job: "account-mail.send", payload: { organizationId, purpose: "invitation", recordId: invited.invitationId } }));

    // Another address with the link: refused.
    expect(await signUp({ ...fresh("pasted"), invitationId: invited.invitationId })).toMatchObject({ status: 403, body: { code: "ADDRESS_MISMATCH" } });

    const signedUp = await signUp({ ...who, invitationId: invited.invitationId });
    expect(signedUp.status).toBe(200);
    const member = await memberOf(who.email);
    expect(member).toMatchObject({ state: "pending_verification" });
    if (member === null) return;
    expect(harness.fakes.jobs.jobs).toContainEqual(expect.objectContaining({ job: "account-mail.send", payload: { organizationId, purpose: "email_verification", recordId: member.id } }));

    // The account is signed in, and sees nothing of the organization.
    const caller = await callerWithCookie(cookieHeaderFrom(signedUp.headers));
    expect(await trpcFailure(caller.projects.list())).toMatchObject({ code: "FORBIDDEN" });
    expect(await harness.anonymous().invitations.preview({ invitationId: invited.invitationId })).toMatchObject({ state: "accepted", verificationPending: true, addressLocked: true });

    // Opening the mail's link verifies the address: the membership is active, with `member.verified`.
    const secret = (await harness.auth.$context).secret;
    const token = await createEmailVerificationToken(secret, who.email, undefined, 24 * 60 * 60);
    const verified = await call("GET", `/verify-email?token=${token}`, null);
    expect(verified.status).toBe(200);
    expect(await harness.test.db.member.findUniqueOrThrow({ where: { id: member.id } })).toMatchObject({ state: "active" });
    expect(await harness.test.db.auditEntry.count({ where: { organizationId, action: "member.verified", entityId: member.id } })).toBe(1);
    const now = await callerWithCookie(cookieHeaderFrom(signedUp.headers));
    expect(Array.isArray(await now.projects.list())).toBe(true);
  });

  it("F-002: \"Send it again\" enqueues one more verification mail for the waiting membership", async () => {
    const who = fresh("again");
    const invited = await inviteOf(who.email);
    await signUp({ ...who, invitationId: invited.invitationId });
    harness.fakes.jobs.clear();
    const sent = await call("POST", "/send-verification-email", { email: who.email });
    expect(sent.status).toBe(200);
    const member = await memberOf(who.email);
    expect(harness.fakes.jobs.jobs).toEqual([expect.objectContaining({ job: "account-mail.send", payload: { organizationId, purpose: "email_verification", recordId: member?.id } })]);
  });
});

describe("an existing account", () => {
  it("F-002: joins by accepting while signed in, without a second account", async () => {
    // B's admin has an account already, in another organization.
    const existing: SeededMember = harness.fixture.b.admin;
    const account = await harness.test.db.user.findUniqueOrThrow({ where: { id: existing.userId } });
    await givePassword(existing.userId);
    const invited = await inviteOf(account.email, { projectGrants: [{ projectId: harness.fixture.a.restrictedProject.id, role: "member" }] });
    const accounts = await harness.test.db.user.count();

    const cookie = await signIn(account.email);
    const caller = await callerWithCookie(cookie);
    const accepted = await caller.invitations.accept({ invitationId: invited.invitationId });
    expect(accepted).toMatchObject({ organizationId, state: "active" });
    expect(await harness.test.db.user.count()).toBe(accounts);
    expect(await harness.test.db.member.count({ where: { userId: existing.userId } })).toBe(2);
    // The session moved to the organization it joined, and the granted project is open.
    const there = await callerWithCookie(cookie);
    expect((await there.projects.list()).map((project) => project.id)).toContain(harness.fixture.a.restrictedProject.id);
    // Once only.
    expect(await trpcFailure(caller.invitations.accept({ invitationId: invited.invitationId }))).toMatchObject({ code: "CONFLICT" });
  });

  it("F-002: with email set up, a signed-in account with another address can't accept", async () => {
    harness.emailSwitch.on = true;
    const invited = await inviteOf(fresh("someone-else").email);
    const insider = await harness.test.db.user.findUniqueOrThrow({ where: { id: harness.fixture.a.insider.userId } });
    await givePassword(insider.id);
    const caller = await callerWithCookie(await signIn(insider.email));
    expect(await trpcFailure(caller.invitations.accept({ invitationId: invited.invitationId }))).toMatchObject({ code: "FORBIDDEN" });
    expect(await harness.test.db.invitation.findUniqueOrThrow({ where: { id: invited.invitationId } })).toMatchObject({ status: "pending" });
  });

  it("F-002: better-auth's own accept, remove, leave and role routes are refused: ostra's use cases replace them", async () => {
    const cookie = await signIn((await harness.test.db.user.findUniqueOrThrow({ where: { id: harness.fixture.b.admin.userId } })).email);
    for (const path of ["/organization/accept-invitation", "/organization/remove-member", "/organization/leave", "/organization/update-member-role"]) {
      const refused = await call("POST", path, { invitationId: "x", memberIdOrEmail: "x", organizationId, memberId: "x", role: "member" }, { cookie: cookie.get("cookie") ?? "" });
      expect({ path, ...refused.body }).toMatchObject({ path, code: "USE_OSTRA" });
    }
  });
});

describe("a reset link", () => {
  const NEW_PASSWORD = "a-brand-new-passphrase-2026";

  it("F-002: the instance admin's link works once within 24 hours, signs out the other sessions and revokes CLI sessions", async () => {
    const target = harness.fixture.a.member;
    const account = await harness.test.db.user.findUniqueOrThrow({ where: { id: target.userId } });
    await givePassword(target.userId);
    const elsewhere = await signIn(account.email);
    const cli = await harness.test.db.cliSession.create({
      data: { organizationId, memberId: target.id, userId: target.userId, tokenHash: hashCliToken(randomUUID()), name: "laptop", expiresAt: new Date(Date.now() + DAY) },
    });

    const created = await admin.accounts.createResetLink({ userId: target.userId });
    expect(created.expiresAt - Date.now()).toBeGreaterThan(24 * 60 * 60 * 1000 - 60_000);
    const token = new URL(created.link).searchParams.get("token") ?? "";
    expect(token).not.toBe("");
    expect(await harness.test.db.resetLinkGrant.findUniqueOrThrow({ where: { tokenHash: hashResetToken(token) } })).toMatchObject({
      kind: "admin_link",
      userId: target.userId,
      createdByUserId: harness.fixture.a.admin.userId,
      usedAt: null,
    });
    expect(await harness.test.db.auditEntry.count({ where: { organizationId, action: "reset-link.created", entityId: target.userId } })).toBe(1);

    const reset = await call("POST", "/reset-password", { token, newPassword: NEW_PASSWORD });
    expect(reset.status).toBe(200);
    expect(await harness.auth.api.getSession({ headers: elsewhere })).toBeNull();
    expect((await harness.test.db.cliSession.findUniqueOrThrow({ where: { id: cli.id } })).revokedAt).toBeInstanceOf(Date);
    expect((await harness.test.db.resetLinkGrant.findUniqueOrThrow({ where: { tokenHash: hashResetToken(token) } })).usedAt).toBeInstanceOf(Date);
    expect(await harness.test.db.auditEntry.count({ where: { organizationId, action: "reset-link.used", entityId: target.userId } })).toBe(1);
    await expect(signIn(account.email)).rejects.toThrow();
    expect(await signIn(account.email, NEW_PASSWORD)).toBeInstanceOf(Headers);

    // Once only.
    expect(await call("POST", "/reset-password", { token, newPassword: "yet-another-passphrase-1" })).toMatchObject({ status: 400, body: { code: "INVALID_TOKEN" } });

    // And within 24 hours: a link a day and a minute old is refused.
    const later = await admin.accounts.createResetLink({ userId: target.userId });
    const laterToken = new URL(later.link).searchParams.get("token") ?? "";
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + DAY + 60_000 });
    expect(await call("POST", "/reset-password", { token: laterToken, newPassword: "yet-another-passphrase-2" })).toMatchObject({ status: 400, body: { code: "INVALID_TOKEN" } });
  });

  it("F-002: a member who isn't the instance admin can't create one, an organization admin included", async () => {
    // B's admin is an organization admin and not the instance admin.
    const orgAdmin = await harness.as(harness.fixture.b.admin);
    expect(await trpcFailure(orgAdmin.accounts.createResetLink({ userId: harness.fixture.b.admin.userId }))).toMatchObject({ code: "FORBIDDEN" });
    const member = await harness.as(harness.fixture.a.insider);
    expect(await trpcFailure(member.accounts.createResetLink({ userId: harness.fixture.a.admin.userId }))).toMatchObject({ code: "FORBIDDEN" });
    expect(await trpcFailure(harness.anonymous().accounts.createResetLink({ userId: harness.fixture.a.admin.userId }))).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("F-002: \"Forgot your password?\" answers the same for an unknown address, and mails only a verified one", async () => {
    harness.emailSwitch.on = true;
    const verified = await harness.test.db.user.update({ where: { id: harness.fixture.a.insider.userId }, data: { emailVerified: true } });
    const unverified = await harness.test.db.user.findUniqueOrThrow({ where: { id: harness.fixture.a.admin.userId } });
    const ask = (email: string) => call("POST", "/request-password-reset", { email, redirectTo: `${BASE}/reset-password` });

    const known = await ask(verified.email);
    const unknown = await ask("nobody-at-all@example.com");
    const notVerified = await ask(unverified.email);
    expect(known.status).toBe(200);
    expect(unknown).toEqual(known);
    expect(notVerified.raw).toEqual(known.raw);
    // One mail, for the verified address, by the grant's ID; never the link or the token.
    const grant = await harness.test.db.resetLinkGrant.findFirstOrThrow({ where: { userId: verified.id, kind: "self_service" } });
    expect(harness.fakes.jobs.jobs).toEqual([expect.objectContaining({ job: "account-mail.send", payload: { organizationId, purpose: "password_reset", recordId: grant.id } })]);
    expect(await harness.test.db.resetLinkGrant.count({ where: { userId: unverified.id, kind: "self_service" } })).toBe(0);
  });

  it("F-002: without email set up, \"Forgot your password?\" makes no link at all", async () => {
    const before = await harness.test.db.resetLinkGrant.count();
    // A verified address: without email even that gets no link.
    const verified = await harness.test.db.user.update({ where: { id: harness.fixture.a.insider.userId }, data: { emailVerified: true } });
    expect((await call("POST", "/request-password-reset", { email: verified.email, redirectTo: `${BASE}/reset-password` })).status).toBe(200);
    expect(await harness.test.db.resetLinkGrant.count()).toBe(before);
    expect(harness.fakes.jobs.jobs).toEqual([]);
  });
});

describe("what never reaches a log line or a job", () => {
  it("F-002: no invitation link, reset token or address is in a log line or a job's payload", async () => {
    harness.emailSwitch.on = true;
    const who = fresh("secretive");
    const invited = await inviteOf(who.email);
    await signUp({ ...who, invitationId: invited.invitationId });
    const reset = await admin.accounts.createResetLink({ userId: harness.fixture.a.member.userId });
    const token = new URL(reset.link).searchParams.get("token") ?? "";
    const logged = JSON.stringify(harness.logs);
    const queued = JSON.stringify(harness.fakes.jobs.jobs);
    for (const value of [invited.link, reset.link, token, who.email]) {
      expect(logged).not.toContain(value);
      expect(queued).not.toContain(value);
    }
    // The audit entries hold IDs, not addresses or links.
    const entries = JSON.stringify(await harness.test.db.auditEntry.findMany({ where: { organizationId } }));
    for (const value of [invited.invitationId, reset.link, token, who.email]) {
      expect(entries).not.toContain(value);
    }
  });
});
