import { createHash } from "node:crypto";

import { secretRefSchema } from "@ostra/adapter-sdk";
import { startCliSession } from "@ostra/domain";
import { memberIdSchema, userIdSchema } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { completeGitHubLink, startGitHubLink } from "../services/github-link.ts";
import { createApiHarness, GITHUB_APP_ID, seedConnectionAndModel } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// F-103, F-119, ticket 39: the Account page's data and the verified GitHub link. The member's own CLI
// sessions are listed and revoked; the GitHub link is made through the App's OAuth with a `state`
// bound to the member's session for ten minutes and one use, keeps the verified ID and login and no
// token, refuses an account linked to someone else, and unlinks.

let harness: ApiHarness;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

beforeAll(async () => {
  harness = await createApiHarness();
  await seedConnectionAndModel(harness);
  // The App's OAuth client: its ID from GitHub's own `GET /app`, its secret in the secret store.
  const app = harness.fakes.codeHost.apps.get(GITHUB_APP_ID);
  if (app === undefined) {
    throw new Error("no App");
  }
  harness.fakes.codeHost.apps.set(GITHUB_APP_ID, { ...app, info: { ...app.info, clientId: "Iv1.worldclient" } });
});

afterAll(async () => {
  await harness.dispose();
});

const sessionFor = async (member: { readonly id: string; readonly userId: string }, name = "alex-laptop") => {
  const started = await startCliSession(
    { db: harness.test.db, ...harness.deps.ports },
    { userId: userIdSchema.parse(member.userId), memberId: memberIdSchema.parse(member.id), machineName: name, sessionDays: 30 },
  );
  if (!started.ok) {
    throw new Error("no session");
  }
  return started;
};

const CLIENT_SECRET = "client-secret-value-0123456789";

/** Gives the install's GitHub App its OAuth client secret as an admin does, on the GitHub page (Q295). */
const giveClientSecret = async (clientSecret = CLIENT_SECRET) => (await harness.as(harness.fixture.a.admin)).github.setClientSecret({ clientSecret });

/** The own App's client secret, as the secret store holds it. */
const storedClientSecret = async (): Promise<string | null> => {
  const row = await harness.test.db.connection.findFirstOrThrow({ where: { organizationId: harness.fixture.a.organization.id, kind: "github" }, orderBy: { createdAt: "asc" } });
  const ref = secretRefSchema.safeParse(row.clientSecretSecretRef);
  if (!ref.success) return null;
  const read = await harness.fakes.secretStore.get(harness.fixture.a.organization.id, ref.data);
  return read.ok ? read.value : null;
};

describe("the member's CLI sessions", () => {
  it("F-103/c4: lists only the member's own working sessions, newest first, with when each ends and how long they last", async () => {
    const alex = harness.fixture.a.member;
    const sam = harness.fixture.a.insider;
    const first = await sessionFor(alex, "alex-laptop");
    const second = await sessionFor(alex, "alex-desktop");
    await sessionFor(sam, "sam-laptop");
    const revoked = await sessionFor(alex, "revoked-one");
    const expired = await sessionFor(alex, "expired-one");
    await harness.test.db.cliSession.update({ where: { id: revoked.sessionId }, data: { revokedAt: new Date() } });
    await harness.test.db.cliSession.update({ where: { id: expired.sessionId }, data: { expiresAt: new Date(Date.now() - 1_000) } });

    const listed = await (await harness.as(alex)).account.cliSessions.list();
    expect(listed.sessions.map((session) => session.name)).toEqual(["alex-desktop", "alex-laptop"]);
    expect(listed.sessions.map((session) => session.id)).toEqual([second.sessionId, first.sessionId]);
    expect(listed.days).toBe(30);
    expect(listed.serverUrl).toBe("http://localhost:3000");
    expect(listed.sessions[0]?.expiresAt).toBe(second.expiresAt);
    expect(listed.sessions[0]?.lastUsedAt).toBeNull();
    // Nothing of a token or its hash.
    expect(JSON.stringify(listed)).not.toContain(second.token);
    expect(JSON.stringify(listed)).not.toContain(sha256(second.token));
    expect((await (await harness.as(sam)).account.cliSessions.list()).sessions.map((session) => session.name)).toEqual(["sam-laptop"]);
  });

  it("F-103/c4: a member revokes their own session and no one else's; another organization's is not found either", async () => {
    const alex = await harness.as(harness.fixture.a.member);
    const sam = await harness.as(harness.fixture.a.insider);
    const outsider = await harness.as(harness.fixture.b.admin);
    const mine = await sessionFor(harness.fixture.a.member, "to-revoke");
    await expect(sam.account.cliSessions.revoke({ sessionId: mine.sessionId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(outsider.account.cliSessions.revoke({ sessionId: mine.sessionId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await harness.test.db.cliSession.findUniqueOrThrow({ where: { id: mine.sessionId } })).revokedAt).toBeNull();

    await alex.account.cliSessions.revoke({ sessionId: mine.sessionId });
    expect((await harness.test.db.cliSession.findUniqueOrThrow({ where: { id: mine.sessionId } })).revokedAt).not.toBeNull();
    expect((await alex.account.cliSessions.list()).sessions.some((session) => session.id === mine.sessionId)).toBe(false);
    // Again is the same answer and changes nothing.
    await expect(alex.account.cliSessions.revoke({ sessionId: mine.sessionId })).resolves.toEqual({ sessionId: mine.sessionId });
    expect(await harness.test.db.auditEntry.count({ where: { action: "cli-session.revoked", entityId: harness.fixture.a.member.id } })).toBeGreaterThanOrEqual(1);
  });

  it("F-103/c4: the device page learns the purpose and the machine's name of a code the member opened, and of no other", async () => {
    const alex = harness.fixture.a.member;
    await harness.test.db.deviceCode.create({
      data: { id: "dc-1", deviceCode: "device-code-for-the-page-0123456789", userCode: "PAGECODE", expiresAt: new Date(Date.now() + 600_000), status: "pending", userId: alex.userId, clientId: "ostra-cli", purpose: "cli", machineName: "alex-laptop" },
    });
    const caller = await harness.as(alex);
    expect(await caller.account.deviceRequest({ userCode: "page-code" })).toEqual({ purpose: "cli", machineName: "alex-laptop" });
    // A code another member opened is nobody else's to read.
    expect(await (await harness.as(harness.fixture.a.insider)).account.deviceRequest({ userCode: "PAGECODE" })).toEqual({ purpose: null, machineName: null });
  });
});

describe("the verified GitHub link", () => {
  it("F-119/c1: an install with no GitHub App can't link, Account says GitHub isn't connected, and there is no secret to add", async () => {
    const outsider = await harness.as(harness.fixture.b.admin);
    expect(await outsider.account.github.get()).toEqual({ linking: "not-connected", link: null });
    expect(await startGitHubLink(await harness.contextOf(harness.fixture.b.admin))).toEqual({ kind: "not-connected" });
    await expect(outsider.github.setClientSecret({ clientSecret: CLIENT_SECRET })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(harness.fakes.secretStore.values()).not.toContain(CLIENT_SECRET);
  });

  it("F-119/c1: an App without its OAuth client secret can't link, and Account says an admin must add it (Q295); an admin adding it on the GitHub page turns linking on", async () => {
    const alex = await harness.as(harness.fixture.a.member);
    expect(await alex.account.github.get()).toEqual({ linking: "needs-client-secret", link: null });
    expect(await startGitHubLink(await harness.contextOf(harness.fixture.a.member))).toEqual({ kind: "needs-client-secret" });
    expect((await (await harness.as(harness.fixture.a.admin)).github.connection())?.clientSecretSet).toBe(false);
    // Only an organization admin adds it.
    await expect(alex.github.setClientSecret({ clientSecret: CLIENT_SECRET })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await alex.account.github.get()).toEqual({ linking: "needs-client-secret", link: null });

    expect(await giveClientSecret()).toMatchObject({ replaced: false });
    expect(await alex.account.github.get()).toEqual({ linking: "ready", link: null });
    expect((await (await harness.as(harness.fixture.a.admin)).github.connection())?.clientSecretSet).toBe(true);
    // In the secret store, never in the row, the audit entry or a log line.
    expect(await storedClientSecret()).toBe(CLIENT_SECRET);
    const row = await harness.test.db.connection.findFirstOrThrow({ where: { organizationId: harness.fixture.a.organization.id, kind: "github" } });
    expect(JSON.stringify(row)).not.toContain(CLIENT_SECRET);
    const audit = await harness.test.db.auditEntry.findFirstOrThrow({ where: { action: "github.client-secret-set", organizationId: harness.fixture.a.organization.id } });
    expect(audit).toMatchObject({ actorId: harness.fixture.a.admin.id, entityId: row.id });
    expect(JSON.stringify(audit)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(harness.logs)).not.toContain(CLIENT_SECRET);
    // The sign-in starts now, with the App's client ID.
    harness.fakes.codeHost.linkStarts.length = 0;
    expect((await startGitHubLink(await harness.contextOf(harness.fixture.a.member))).kind).toBe("redirect");
    expect(harness.fakes.codeHost.linkStarts.at(-1)?.clientId).toBe("Iv1.worldclient");
    // Signed out: sent to sign in.
    expect(await startGitHubLink({ ...(await harness.contextOf(harness.fixture.a.member)), user: null, member: null })).toEqual({ kind: "sign-in" });
  });

  it("F-119/c1,c2: links the verified ID and login, keeps no token, and uses the state once", async () => {
    harness.fakes.codeHost.linkStarts.length = 0;
    const alex = harness.fixture.a.member;
    const context = await harness.contextOf(alex, "browser-session-1");
    const started = await startGitHubLink(context);
    expect(started.kind).toBe("redirect");
    const start = harness.fakes.codeHost.linkStarts.at(-1);
    expect(start).toMatchObject({ clientId: "Iv1.worldclient", redirectUri: "http://localhost:3000/api/github/link/callback" });
    const state = start?.state ?? "";
    // The state is kept as a hash, bound to the session, for ten minutes.
    const stored = await harness.test.db.oAuthState.findFirstOrThrow({ where: { stateHash: sha256(state) } });
    expect(stored).toMatchObject({ memberId: alex.id, authSessionId: "browser-session-1", usedAt: null });
    expect(JSON.stringify(stored)).not.toContain(state);
    expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBeLessThanOrEqual(10 * 60_000 + 1_000);

    harness.fakes.codeHost.linkCodes.set("code-alex", { userId: "4411", login: "alexkim" });
    const done = await completeGitHubLink(context, { code: "code-alex", state });
    expect(done).toEqual({ outcome: "linked", login: "alexkim" });
    const user = await harness.test.db.user.findUniqueOrThrow({ where: { id: alex.userId } });
    expect(user).toMatchObject({ githubUserId: "4411", githubLogin: "alexkim" });
    expect(user.githubLinkedAt).not.toBeNull();
    const shown = await (await harness.as(alex)).account.github.get();
    expect(shown.link).toMatchObject({ login: "alexkim", githubUserId: "4411" });
    expect(shown.linking).toBe("ready");
    // The audit entry names the member and the ID, and holds no code or state.
    const audit = await harness.test.db.auditEntry.findFirstOrThrow({ where: { action: "github.linked", entityId: alex.id } });
    expect(JSON.stringify(audit)).not.toContain("code-alex");
    expect(JSON.stringify(audit)).not.toContain(state);

    // The same callback again: the state is used up, nothing changes.
    harness.fakes.codeHost.linkCodes.set("code-again", { userId: "9999", login: "someone-else" });
    expect(await completeGitHubLink(context, { code: "code-again", state })).toEqual({ outcome: "failed", login: null });
    expect((await harness.test.db.user.findUniqueOrThrow({ where: { id: alex.userId } })).githubLogin).toBe("alexkim");
    expect(JSON.stringify(harness.logs)).not.toContain("code-alex");
    expect(JSON.stringify(harness.logs)).not.toContain(state);
  });

  it("F-119/c1: a state from another session, an expired one and a declined consent link nothing", async () => {
    const sam = harness.fixture.a.insider;
    const own = await harness.contextOf(sam, "sam-browser");
    const stateOf = async (context = own) => {
      await startGitHubLink(context);
      return harness.fakes.codeHost.linkStarts.at(-1)?.state ?? "";
    };

    // Another browser session: the state is bound to the one that started it.
    harness.fakes.codeHost.linkCodes.set("code-sam", { userId: "5522", login: "samrivera" });
    const first = await stateOf();
    expect(await completeGitHubLink(await harness.contextOf(sam, "another-browser"), { code: "code-sam", state: first })).toEqual({ outcome: "failed", login: null });
    // Another member's state is no one else's.
    expect(await completeGitHubLink(await harness.contextOf(harness.fixture.a.member, "sam-browser"), { code: "code-sam", state: first })).toEqual({ outcome: "failed", login: null });

    // Older than ten minutes.
    const old = await stateOf();
    await harness.test.db.oAuthState.updateMany({ where: { stateHash: sha256(old) }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    expect(await completeGitHubLink(own, { code: "code-sam", state: old })).toEqual({ outcome: "failed", login: null });

    // A declined consent has no code; the state is used up all the same.
    const declined = await stateOf();
    expect(await completeGitHubLink(own, { code: null, state: declined })).toEqual({ outcome: "failed", login: null });
    expect(await completeGitHubLink(own, { code: "code-sam", state: declined })).toEqual({ outcome: "failed", login: null });
    // No state at all.
    expect(await completeGitHubLink(own, { code: "code-sam", state: null })).toEqual({ outcome: "failed", login: null });
    expect((await harness.test.db.user.findUniqueOrThrow({ where: { id: sam.userId } })).githubUserId).toBeNull();
  });

  it("F-119/c2: refuses a GitHub account that another ostra account has linked, and a token GitHub would not confirm revoked", async () => {
    const sam = harness.fixture.a.insider;
    const own = await harness.contextOf(sam, "sam-browser-2");
    const linkAs = async (code: string) => {
      await startGitHubLink(own);
      return completeGitHubLink(own, { code, state: harness.fakes.codeHost.linkStarts.at(-1)?.state ?? "" });
    };
    // Alex linked GitHub user 4411 in the test above.
    harness.fakes.codeHost.linkCodes.set("taken-code", { userId: "4411", login: "alexkim" });
    expect(await linkAs("taken-code")).toEqual({ outcome: "taken", login: null });
    expect((await harness.test.db.user.findUniqueOrThrow({ where: { id: sam.userId } })).githubUserId).toBeNull();
    expect((await harness.test.db.user.findUniqueOrThrow({ where: { id: harness.fixture.a.member.userId } })).githubUserId).toBe("4411");

    harness.fakes.codeHost.linkCodes.set("unrevoked-code", "revoke-failed");
    expect(await linkAs("unrevoked-code")).toEqual({ outcome: "revoke-failed", login: null });
    expect((await harness.test.db.user.findUniqueOrThrow({ where: { id: sam.userId } })).githubUserId).toBeNull();

    // A code GitHub refuses (expired, used) is a plain failure.
    expect(await linkAs("unknown-code")).toEqual({ outcome: "failed", login: null });
  });

  it("F-119/c2: unlinking clears the link, so the next commit credits the ostra name again; unlinking twice is refused", async () => {
    const alex = await harness.as(harness.fixture.a.member);
    await alex.account.github.unlink();
    const user = await harness.test.db.user.findUniqueOrThrow({ where: { id: harness.fixture.a.member.userId } });
    expect(user).toMatchObject({ githubUserId: null, githubLogin: null, githubLinkedAt: null });
    expect((await alex.account.github.get()).link).toBeNull();
    await expect(alex.account.github.unlink()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await harness.test.db.auditEntry.count({ where: { action: "github.unlinked", entityId: harness.fixture.a.member.id } })).toBe(1);
    // The account can link another GitHub account now, and the freed ID can be linked by anyone.
    const sam = await harness.contextOf(harness.fixture.a.insider, "sam-browser-3");
    await startGitHubLink(sam);
    harness.fakes.codeHost.linkCodes.set("freed-code", { userId: "4411", login: "alexkim" });
    expect(await completeGitHubLink(sam, { code: "freed-code", state: harness.fakes.codeHost.linkStarts.at(-1)?.state ?? "" })).toEqual({ outcome: "linked", login: "alexkim" });
  });

  it("F-119/c1: an admin replaces the App's client secret (Q295): the new one is used, and the old one leaves the secret store", async () => {
    const before = harness.fakes.secretStore.values().filter((value) => value === CLIENT_SECRET).length;
    expect(before).toBe(1);
    expect(await giveClientSecret("client-secret-value-replaced-9876")).toMatchObject({ replaced: true });
    expect(await storedClientSecret()).toBe("client-secret-value-replaced-9876");
    expect(harness.fakes.secretStore.values()).not.toContain(CLIENT_SECRET);
    expect(await (await harness.as(harness.fixture.a.member)).account.github.get()).toMatchObject({ linking: "ready" });
  });

  it("F-119/c1: an existing App connected with its client secret (Q295) lets a member link at once, through the App's own OAuth", async () => {
    const { b } = harness.fixture;
    const app = harness.fakes.codeHost.apps.get(GITHUB_APP_ID);
    if (app === undefined) throw new Error("no App");
    const secret = "existing-client-secret-0123456789";
    const admin = await harness.as(b.admin);
    // GitHub's `GET /app` answers the client ID ("Iv1.worldclient"): the admin gives only the secret.
    const connected = await admin.github.connectExisting({ appId: GITHUB_APP_ID, privateKey: app.privateKey, webhookSecret: "whsec-b-0123456789", clientSecret: secret });
    expect(JSON.stringify(connected)).not.toContain(secret);
    expect((await admin.github.connection())?.clientSecretSet).toBe(true);
    expect(harness.fakes.secretStore.values()).toContain(secret);
    expect(JSON.stringify(await harness.test.db.connection.findUniqueOrThrow({ where: { id: connected.connectionId } }))).not.toContain(secret);
    expect(await admin.account.github.get()).toEqual({ linking: "ready", link: null });

    const context = await harness.contextOf(b.admin, "b-browser");
    harness.fakes.codeHost.linkStarts.length = 0;
    expect((await startGitHubLink(context)).kind).toBe("redirect");
    const start = harness.fakes.codeHost.linkStarts.at(-1);
    expect(start?.clientId).toBe("Iv1.worldclient");
    harness.fakes.codeHost.linkCodes.set("code-b", { userId: "6601", login: "dana-b" });
    expect(await completeGitHubLink(context, { code: "code-b", state: start?.state ?? "" })).toEqual({ outcome: "linked", login: "dana-b" });
    expect((await admin.account.github.get()).link).toMatchObject({ login: "dana-b", githubUserId: "6601" });
    // A client's App beside the own one takes no client secret: members link through the own App.
    await expect(admin.github.connectExisting({ appId: "4242", privateKey: app.privateKey, clientSecret: secret })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
