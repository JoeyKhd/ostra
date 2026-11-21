import { linearAppEndpoints } from "@ostra/adapter-linear";
import { createFakeLinear } from "@ostra/adapter-sdk/testing";
import type { FakeLinear } from "@ostra/adapter-sdk/testing";
import { connectionIdSchema } from "@ostra/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createApiHarness, seedBoard, seedConnectionAndModel, seedProject, seedTicket } from "../testing/index.ts";
import type { ApiHarness, AppCaller } from "../testing/index.ts";

// Ticket 27: the Linear connection, from `start` to `active`, against the fake Linear server (the
// real OAuth endpoints with PKCE, `actor=app`, rotating tokens, `viewer`, revoke). Every procedure is
// for organization admins; no secret comes back from any of them.

const PUBLIC_CORE = "https://ostra.example.com";
const CALLBACK = "http://localhost:3000/api/linear/callback";

let harness: ApiHarness;
let fake: FakeLinear;

beforeAll(async () => {
  fake = await createFakeLinear();
  // The endpoints as the panel derives them from OSTRA_LINEAR_API_URL set to the fake's API.
  harness = await createApiHarness({ linearEndpoints: linearAppEndpoints(fake.apiUrl) });
});

afterAll(async () => {
  await harness.dispose();
  await fake.close();
});

/** An admin's caller on a panel session, with core at a public address (webhooks) or a private one (polling). */
const adminOn = async (session: string, core: "public" | "private" = "public"): Promise<AppCaller> => {
  const context = await harness.contextOf(harness.fixture.a.admin, session);
  return harness.callerFor({
    ...context,
    deps: { ...context.deps, settings: { ...context.deps.settings, corePublicUrl: core === "public" ? PUBLIC_CORE : "http://localhost:8787" } },
  });
};

/** What Linear's consent page does: the admin presses Authorize, and Linear redirects back with a code. */
const consent = async (authorizeUrl: string): Promise<{ readonly code: string; readonly state: string }> => {
  const response = await fetch(authorizeUrl, { redirect: "manual" });
  const location = response.headers.get("location");
  if (location === null) {
    throw new Error(`the fake Linear refused the consent with ${String(response.status)}`);
  }
  const target = new URL(location);
  return { code: target.searchParams.get("code") ?? "", state: target.searchParams.get("state") ?? "" };
};

const manifestSchema = z.looseObject({
  distribution: z.string(),
  oauth: z.looseObject({ redirect_uris: z.array(z.string()), grant_types: z.array(z.string()) }),
  webhook: z.looseObject({ url: z.string(), enabled: z.boolean(), resourceTypes: z.array(z.string()) }).optional(),
});

/** The manifest a link carries: Linear's page reads it from the `manifest` parameter. */
const manifestOf = (link: string) => manifestSchema.parse(JSON.parse(decodeURIComponent(link.split("?manifest=")[1] ?? "")));

const organizationId = () => harness.fixture.a.organization.id;

const rowOf = () => harness.test.db.connection.findFirst({ where: { organizationId: organizationId(), kind: "linear", state: { not: "revoked" } } });

/** Starts a connection and registers the matching app on the fake, as the admin does in Linear. */
const startAndCreateApp = async (admin: AppCaller) => {
  const started = await admin.linear.start();
  const app = fake.createApp({ name: "ostra", redirectUris: [CALLBACK], webhookUrl: started.webhookUrl });
  return { started, app };
};

const clearConnection = async (admin: AppCaller) => {
  const row = await rowOf();
  if (row !== null) {
    await admin.linear.disconnect({ connectionId: connectionIdSchema.parse(row.id) });
  }
};

beforeEach(async () => {
  harness.fakes.jobs.clear();
  await clearConnection(await adminOn("cleanup"));
});

describe("F-005: the whole flow, from start to active", () => {
  it("starts pending, keeps the app's values, authorizes as the app and goes active", async () => {
    const admin = await adminOn("session-1");
    const before = await admin.linear.status();
    expect(before).toMatchObject({ state: "none", mode: "webhooks", modeReason: null, lastRevoked: null, scopes: ["read", "write", "issues:create", "comments:create"] });

    const { started, app } = await startAndCreateApp(admin);
    expect(started.mode).toBe("webhooks");
    expect(started.callbackUrl).toBe(CALLBACK);
    expect(started.webhookUrl).toBe(`${PUBLIC_CORE}/webhooks/linear/${started.connectionId}`);
    // The manifest link: private distribution, the callback, the per-connection webhook, authorization code only.
    const manifest = manifestOf(started.manifestUrl);
    expect(manifest).toMatchObject({
      distribution: "private",
      oauth: { redirect_uris: [CALLBACK], grant_types: ["authorization_code"] },
      webhook: { url: started.webhookUrl, enabled: true },
    });
    expect(manifest.webhook?.resourceTypes).toEqual(["Issue", "Comment", "Attachment", "IssueLabel", "OAuthAuthorization", "AgentSessionEvent"]);
    const pending = await rowOf();
    expect(pending).toMatchObject({ id: started.connectionId, state: "pending", appId: "pending", webhookMode: "webhooks", credentialKind: "app_oauth", createdByMemberId: harness.fixture.a.admin.id });
    const waiting = await admin.linear.status();
    expect(waiting).toMatchObject({ state: "pending", appSaved: false, manifestUrl: started.manifestUrl });
    expect(waiting.state === "none" ? null : waiting.startedByName).not.toBeNull();

    const saved = await admin.linear.saveApp({ connectionId: started.connectionId, clientId: app.clientId, clientSecret: app.clientSecret, webhookSecret: app.webhookSecret });
    const savedRow = await rowOf();
    expect(savedRow).toMatchObject({ appId: app.clientId, state: "pending" });
    expect(savedRow?.clientSecretSecretRef).toBeTruthy();
    expect(savedRow?.webhookSecretSecretRef).toBeTruthy();
    expect(await admin.linear.status()).toMatchObject({ state: "pending", appSaved: true });

    const { code, state } = await consent(saved.authorizeUrl);
    const connected = await admin.linear.complete({ code, state });
    expect(connected).toMatchObject({ connectionId: started.connectionId, workspaceName: fake.organization.name, appUserName: "ostra", mode: "webhooks" });

    const active = await rowOf();
    expect(active).toMatchObject({
      state: "active",
      credentialKind: "app_oauth",
      externalWorkspaceKey: fake.organization.urlKey,
      externalWorkspaceName: fake.organization.name,
      appUserId: fake.appUser()?.id,
      appUserName: "ostra",
      failedReason: null,
    });
    expect(active?.accessTokenSecretRef).toBeTruthy();
    expect(active?.refreshTokenSecretRef).toBeTruthy();
    expect(active?.accessTokenExpiresAt?.getTime()).toBeGreaterThan(Date.now());
    expect(active?.activatedAt).not.toBeNull();

    // The token is refreshed before it expires: one delayed job, keyed by the connection.
    const refreshes = harness.fakes.jobs.jobs.filter((job) => job.job === "linear.refresh-token");
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]).toMatchObject({ key: `connection:${started.connectionId}:refresh-token`, payload: { connectionId: started.connectionId } });
    expect(refreshes[0]?.options?.startAfterMs).toBeGreaterThan(60_000);

    const status = await admin.linear.status();
    expect(status).toMatchObject({
      state: "active",
      connectionId: started.connectionId,
      credentialKind: "app_oauth",
      workspaceKey: fake.organization.urlKey,
      workspaceName: fake.organization.name,
      appUserName: "ostra",
      mode: "webhooks",
      lastEvent: null,
      lastPoll: null,
      silentSince: null,
      pollSeconds: 60,
      reconcileMinutes: 5,
    });
    expect(status.state === "active" ? status.accessTokenExpiresAt : null).toBe(active?.accessTokenExpiresAt?.getTime());
  });

  it("refuses a second start while a connection is active", async () => {
    const admin = await adminOn("session-1");
    const { started, app } = await startAndCreateApp(admin);
    const saved = await admin.linear.saveApp({ connectionId: started.connectionId, clientId: app.clientId, clientSecret: app.clientSecret, webhookSecret: app.webhookSecret });
    await admin.linear.complete(await consent(saved.authorizeUrl));
    await expect(admin.linear.start()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await harness.test.db.connection.count({ where: { organizationId: organizationId(), kind: "linear", state: { not: "revoked" } } })).toBe(1);
  });

  it("picks up a pending connection where it was left, with the same webhook URL", async () => {
    const admin = await adminOn("session-1");
    const first = await admin.linear.start();
    const second = await admin.linear.start();
    expect(second.connectionId).toBe(first.connectionId);
    expect(second.webhookUrl).toBe(first.webhookUrl);
  });

  it("runs in polling mode on a private address: no webhook in the manifest, no webhook secret asked, the reason as the pre-check's code", async () => {
    const admin = await adminOn("session-1", "private");
    expect(await admin.linear.status()).toMatchObject({ state: "none", mode: "polling" });
    const started = await admin.linear.start();
    expect(started).toMatchObject({ mode: "polling", webhookUrl: null });
    expect(started.modeReason).toBe("not-https");
    expect(manifestOf(started.manifestUrl).webhook).toBeUndefined();

    const app = fake.createApp({ name: "ostra", redirectUris: [CALLBACK], webhookUrl: null });
    const saved = await admin.linear.saveApp({ connectionId: started.connectionId, clientId: app.clientId, clientSecret: app.clientSecret });
    expect((await rowOf())?.webhookSecretSecretRef).toBeNull();
    await admin.linear.complete(await consent(saved.authorizeUrl));
    const status = await admin.linear.status();
    expect(status).toMatchObject({ state: "active", mode: "polling" });
    expect(status.modeReason).toBe("not-https");
    expect(status.state === "active" ? status.webhookUrl : "x").toBeNull();
  });

  it("asks for the webhook signing secret in webhooks mode", async () => {
    const admin = await adminOn("session-1");
    const { started, app } = await startAndCreateApp(admin);
    await expect(admin.linear.saveApp({ connectionId: started.connectionId, clientId: app.clientId, clientSecret: app.clientSecret })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await rowOf())?.appId).toBe("pending");
  });
});

describe("F-005: the consent's state and token are checked", () => {
  const readyToAuthorize = async (session = "session-1") => {
    const admin = await adminOn(session);
    const { started, app } = await startAndCreateApp(admin);
    const saved = await admin.linear.saveApp({ connectionId: started.connectionId, clientId: app.clientId, clientSecret: app.clientSecret, webhookSecret: app.webhookSecret });
    return { admin, started, app, authorizeUrl: saved.authorizeUrl };
  };

  it("refuses a state another admin session made, and a state that was already used", async () => {
    const { admin, authorizeUrl } = await readyToAuthorize("session-1");
    const grant = await consent(authorizeUrl);
    // The same admin on another panel session, and another organization's admin: the state is not theirs.
    await expect((await adminOn("session-2")).linear.complete(grant)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect((await harness.as(harness.fixture.b.admin)).linear.complete(grant)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await rowOf())?.state).toBe("pending");

    await admin.linear.complete(grant);
    expect((await rowOf())?.state).toBe("active");
    // Reused: the state is used up, and nothing changes.
    const tokenCalls = fake.apiCalls()["oauth/token"] ?? 0;
    await expect(admin.linear.complete(grant)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fake.apiCalls()["oauth/token"] ?? 0).toBe(tokenCalls);
  });

  it("refuses an old state, and a state that was never made", async () => {
    const { admin, authorizeUrl } = await readyToAuthorize();
    const grant = await consent(authorizeUrl);
    await harness.test.db.oAuthState.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(admin.linear.complete(grant)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(admin.linear.complete({ code: grant.code, state: "x".repeat(43) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await rowOf())?.state).toBe("pending");
  });

  it("uses the state up even when Linear refuses the code", async () => {
    const { admin, authorizeUrl } = await readyToAuthorize();
    const grant = await consent(authorizeUrl);
    await expect(admin.linear.complete({ code: "not-a-code", state: grant.state })).rejects.toMatchObject({ code: "BAD_GATEWAY" });
    await expect(admin.linear.complete(grant)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await rowOf())?.state).toBe("pending");
  });

  it("refuses a token that isn't the app's own user, and revokes it", async () => {
    const { admin, authorizeUrl } = await readyToAuthorize();
    // Linear ignoring `actor=app`: the consent gives a person's token.
    const asPerson = new URL(authorizeUrl);
    asPerson.searchParams.delete("actor");
    const grant = await consent(asPerson.toString());
    const revokes = fake.apiCalls()["oauth/revoke"] ?? 0;
    const refusal = await admin.linear.complete(grant).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refusal).toMatchObject({ code: "BAD_REQUEST" });
    expect(String(Reflect.get(refusal ?? {}, "message"))).toMatch(/not for the app|person/);
    expect(fake.apiCalls()["oauth/revoke"] ?? 0).toBe(revokes + 1);
    const row = await rowOf();
    expect(row).toMatchObject({ state: "pending", accessTokenSecretRef: null, appUserId: null });
    expect(harness.fakes.jobs.jobs.filter((job) => job.job === "linear.refresh-token")).toEqual([]);
  });

  it("asks for nothing before the app's values are saved", async () => {
    const admin = await adminOn("session-1");
    const started = await admin.linear.start();
    await expect(admin.linear.authorizeUrl({ connectionId: started.connectionId })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("makes a fresh authorize URL to authorize again, bound to the session, with PKCE and actor=app", async () => {
    const { admin, started } = await readyToAuthorize();
    const again = await admin.linear.authorizeUrl({ connectionId: started.connectionId });
    const url = new URL(again.authorizeUrl);
    expect(url.searchParams.get("actor")).toBe("app");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("read,write,issues:create,comments:create");
    const states = await harness.test.db.oAuthState.findMany({ where: { connectionId: started.connectionId } });
    expect(states).toHaveLength(2);
    // Only a hash of the state is kept, and the verifier is a secret reference.
    for (const row of states) {
      expect(row.stateHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.stateHash).not.toBe(url.searchParams.get("state"));
      expect(row.authSessionId).toBe("session-1");
    }
    await admin.linear.complete(await consent(again.authorizeUrl));
    expect((await rowOf())?.state).toBe("active");
  });
});

describe("F-005: who may do what", () => {
  it("is admin-only everywhere, status included, and another organization's admin sees nothing of it", async () => {
    const admin = await adminOn("session-1");
    const { started, app } = await startAndCreateApp(admin);
    const member = await harness.as(harness.fixture.a.member);
    await expect(member.linear.status()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(member.linear.start()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(member.linear.saveApp({ connectionId: started.connectionId, clientId: app.clientId, clientSecret: app.clientSecret, webhookSecret: app.webhookSecret })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(member.linear.authorizeUrl({ connectionId: started.connectionId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(member.linear.complete({ code: "c", state: "s".repeat(32) })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(member.linear.disconnect({ connectionId: started.connectionId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(member.setup.skip({ step: "linear" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(harness.anonymous().linear.status()).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const other = await harness.as(harness.fixture.b.admin);
    expect(await other.linear.status()).toMatchObject({ state: "none" });
    await expect(other.linear.disconnect({ connectionId: started.connectionId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(other.linear.saveApp({ connectionId: started.connectionId, clientId: app.clientId, clientSecret: app.clientSecret, webhookSecret: app.webhookSecret })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(other.linear.authorizeUrl({ connectionId: started.connectionId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await rowOf())?.appId).toBe("pending");
  });

  it("never returns a secret: not the client secret, not the webhook secret, not a token, not the verifier", async () => {
    const admin = await adminOn("session-1");
    const { started, app } = await startAndCreateApp(admin);
    const outputs: unknown[] = [started, await admin.linear.status()];
    const saved = await admin.linear.saveApp({ connectionId: started.connectionId, clientId: app.clientId, clientSecret: app.clientSecret, webhookSecret: app.webhookSecret });
    outputs.push(saved, await admin.linear.status());
    const grant = await consent(saved.authorizeUrl);
    outputs.push(await admin.linear.complete(grant), await admin.linear.status());
    const secrets = harness.fakes.secretStore.values();
    expect(secrets.length).toBeGreaterThanOrEqual(4);
    const text = JSON.stringify(outputs) + JSON.stringify(harness.logs) + JSON.stringify(await harness.test.db.auditEntry.findMany({ where: { organizationId: organizationId() } }));
    for (const secret of [...secrets, app.clientSecret, app.webhookSecret]) {
      expect(text).not.toContain(secret);
    }
    // The row holds references to the store, never a value.
    const row = JSON.stringify(await rowOf());
    for (const secret of secrets) {
      expect(row).not.toContain(secret);
    }
  });
});

describe("F-076: the checklist's Linear step", () => {
  const linearStep = async (caller: AppCaller) => (await caller.setup.status()).steps.find((step) => step.id === "linear")?.state;

  it("is open, then skipped by an admin, then pending, failed and done as the connection goes", async () => {
    const admin = await adminOn("session-1");
    expect(await linearStep(admin)).toBe("open");

    const skipped = await admin.setup.skip({ step: "linear" });
    expect(skipped.skippedAt).toBeGreaterThan(0);
    expect(await linearStep(admin)).toBe("skipped");
    expect(await harness.test.db.organizationSetting.findUnique({ where: { organizationId: organizationId() } })).toMatchObject({ linearSkippedByMemberId: harness.fixture.a.admin.id });
    // Only this organization's checklist changes.
    expect(await linearStep(await harness.as(harness.fixture.b.admin))).toBe("open");

    const { started, app } = await startAndCreateApp(admin);
    expect(await linearStep(admin)).toBe("pending");
    const saved = await admin.linear.saveApp({ connectionId: started.connectionId, clientId: app.clientId, clientSecret: app.clientSecret, webhookSecret: app.webhookSecret });
    await harness.test.db.connection.update({ where: { id: started.connectionId }, data: { state: "failed", failedReason: "Linear refused the token" } });
    expect(await linearStep(admin)).toBe("failed");
    expect(await admin.linear.status()).toMatchObject({ state: "failed" });
    // Authorizing a failed connection again brings it back, and an active one is done even though it was skipped.
    const again = await admin.linear.authorizeUrl({ connectionId: started.connectionId });
    await admin.linear.complete(await consent(again.authorizeUrl));
    expect(await linearStep(admin)).toBe("done");
    expect(saved.authorizeUrl).toBeTruthy();

    // The progress counts a skipped step: next is the first open step.
    const status = await admin.setup.status();
    expect(status.steps.map((step) => step.id)).toEqual(["admin", "model-provider", "github", "linear", "project", "runner", "first-task"]);
    expect(status.next).not.toBe("linear");
  });
});

describe("F-005: disconnect", () => {
  it("revokes the token at Linear, deletes the secrets, ends the connection and keeps its boards and tickets", async () => {
    const admin = await adminOn("session-1");
    const { started, app } = await startAndCreateApp(admin);
    const saved = await admin.linear.saveApp({ connectionId: started.connectionId, clientId: app.clientId, clientSecret: app.clientSecret, webhookSecret: app.webhookSecret });
    await admin.linear.complete(await consent(saved.authorizeUrl));

    const world = await seedConnectionAndModel(harness);
    const project = await seedProject(harness, world, "linear-disconnect");
    const boardId = await seedBoard(harness, { projectId: project.projectId, connectionId: started.connectionId });
    await seedTicket(harness, { projectId: project.projectId, boardId, connectionId: started.connectionId, key: "ENG-1" });

    const secretsBefore = harness.fakes.secretStore.entries.size;
    const revokes = fake.apiCalls()["oauth/revoke"] ?? 0;
    const done = await admin.linear.disconnect({ connectionId: started.connectionId });
    expect(done).toEqual({ connectionId: started.connectionId, revokedAtLinear: true });
    // Both tokens are revoked at Linear.
    expect(fake.apiCalls()["oauth/revoke"] ?? 0).toBe(revokes + 2);

    const row = await harness.test.db.connection.findUniqueOrThrow({ where: { id: started.connectionId } });
    expect(row).toMatchObject({ state: "revoked", accessTokenSecretRef: null, refreshTokenSecretRef: null, clientSecretSecretRef: null, webhookSecretSecretRef: null });
    expect(harness.fakes.secretStore.entries.size).toBe(secretsBefore - 4);
    // Its boards and tickets stay, read-only.
    expect(await harness.test.db.board.count({ where: { connectionId: started.connectionId } })).toBe(1);
    expect(await harness.test.db.ticket.count({ where: { connectionId: started.connectionId } })).toBe(1);
    expect(await harness.test.db.oAuthState.count({ where: { connectionId: started.connectionId } })).toBe(0);

    const status = await admin.linear.status();
    expect(status).toMatchObject({ state: "none", lastRevoked: { workspaceKey: fake.organization.urlKey } });
    // A new connection can be started, and is a new row.
    const next = await admin.linear.start();
    expect(next.connectionId).not.toBe(started.connectionId);
    await expect(admin.linear.disconnect({ connectionId: started.connectionId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("ends a connection even when Linear doesn't answer the revoke", async () => {
    const admin = await adminOn("session-1");
    const { started, app } = await startAndCreateApp(admin);
    const saved = await admin.linear.saveApp({ connectionId: started.connectionId, clientId: app.clientId, clientSecret: app.clientSecret, webhookSecret: app.webhookSecret });
    await admin.linear.complete(await consent(saved.authorizeUrl));
    await fake.close();
    try {
      const done = await admin.linear.disconnect({ connectionId: started.connectionId });
      expect(done.revokedAtLinear).toBe(false);
      expect((await harness.test.db.connection.findUniqueOrThrow({ where: { id: started.connectionId } })).state).toBe("revoked");
    } finally {
      // The fake is closed for the rest of this file's tests; recreate it on the same ports is not possible, so the last test is this one.
    }
  });
});
