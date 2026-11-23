import { verifyJiraWebhook } from "@ostra/adapter-jira";
import { linearAppEndpoints } from "@ostra/adapter-linear";
import { secretRefSchema } from "@ostra/adapter-sdk";
import { createFakeJira, createFakeLinear } from "@ostra/adapter-sdk/testing";
import type { FakeJira, FakeLinear } from "@ostra/adapter-sdk/testing";
import { activateOnFirstDelivery, postgresAuditLog, postgresChangeNotices, systemClock } from "@ostra/domain";
import { connectionIdSchema, organizationIdSchema } from "@ostra/protocol";
import type { ConnectionId } from "@ostra/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApiHarness, seedBoard, trpcFailure } from "../testing/index.ts";
import type { ApiHarness, AppCaller } from "../testing/index.ts";

// Milestone 11, ticket 09 (F-152, F-008; ADR 0071, ADR 0047): `trackers.*`, `trackers.jira.*` and
// `trackers.linear.*` through the procedures, as the panel calls them, on Postgres, with the HTTP
// fake Jira behind the connect kit (`services/jira-connect.ts`, `OSTRA_JIRA_API_URL` pointed at it)
// and the fake Linear behind Linear's OAuth.

const PUBLIC_CORE = "https://ostra.example.com";
const CALLBACK = "http://localhost:3000/api/linear/callback";
const ALL_SCOPES = ["read:jira-work", "write:jira-work", "read:jira-user", "read:workflow:jira"];

let harness: ApiHarness;
let jira: FakeJira;
let linear: FakeLinear;
/** Organization B's own connections: never A's to read or change. */
let linearOfB: ConnectionId;

beforeAll(async () => {
  jira = await createFakeJira({ siteName: "globex" });
  linear = await createFakeLinear();
  harness = await createApiHarness({ jiraApiUrl: jira.gatewayUrl, linearEndpoints: linearAppEndpoints(linear.apiUrl) });
  const b = harness.fixture.b.organization.id;
  const made = await harness.test.db.connection.create({ data: { organizationId: b, kind: "linear", name: "B's Linear", appId: "b-linear", externalWorkspaceId: "b-workspace", state: "active" }, select: { id: true } });
  linearOfB = connectionIdSchema.parse(made.id);
  await harness.test.db.connection.create({ data: { organizationId: b, kind: "jira", name: "B's Jira", appId: jira.cloudId, externalWorkspaceId: jira.cloudId, externalWorkspaceKey: "globex.atlassian.net", state: "active" } });
}, 120_000);

afterAll(async () => {
  await harness.dispose();
  await jira.close();
  await linear.close();
});

const organizationId = () => organizationIdSchema.parse(harness.fixture.a.organization.id);

/** A year from today, as the admin types a token's expiry date. */
const nextYear = (): string => new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);

/** A caller on a panel session, with core at a public address (webhooks) or a private one (polling). */
const callerOn = async (who: "admin" | "member", session: string, core: "public" | "private" = "public"): Promise<AppCaller> => {
  const member = who === "admin" ? harness.fixture.a.admin : harness.fixture.a.member;
  const context = await harness.contextOf(member, session);
  return harness.callerFor({
    ...context,
    deps: { ...context.deps, settings: { ...context.deps.settings, corePublicUrl: core === "public" ? PUBLIC_CORE : "http://localhost:8787" } },
  });
};

/** What Linear's consent page does: the admin presses Authorize, and Linear redirects back with a code. */
const consent = async (authorizeUrl: string): Promise<{ readonly code: string; readonly state: string }> => {
  const response = await fetch(authorizeUrl, { redirect: "manual" });
  const target = new URL(response.headers.get("location") ?? "http://invalid/");
  return { code: target.searchParams.get("code") ?? "", state: target.searchParams.get("state") ?? "" };
};

/**
 * Each case starts with no tracker connection in A: earlier ones revoked, their app IDs given back,
 * as a disconnect leaves them, and their boards detached, so no later connection resumes them.
 */
beforeEach(async () => {
  await harness.test.db.board.updateMany({ where: { organizationId: organizationId(), detachedAt: null }, data: { detachedAt: new Date() } });
  await harness.test.db.$executeRaw`UPDATE "connection" SET "state" = 'revoked', "appId" = 'revoked:' || "id" WHERE "organizationId" = ${organizationId()} AND "kind" IN ('linear', 'jira') AND "state" <> 'revoked'`;
  await harness.test.db.organizationSetting.updateMany({ where: { organizationId: organizationId() }, data: { trackerSkippedAt: null, linearSkippedAt: null } });
});

/** Jira's three steps up to the webhook, through the procedures: a pending connection with its site and a saved token. */
const jiraThroughStepTwo = async (admin: AppCaller) => {
  const created = await admin.trackers.create({ kind: "jira" });
  if (created.kind !== "jira") throw new Error("not a Jira connection");
  const site = await admin.trackers.jira.findSite({ connectionId: created.connectionId, site: "https://globex.atlassian.net/jira/software/projects/PROJ/boards/1" });
  if (!site.ok) throw new Error(site.message);
  const saved = await admin.trackers.jira.saveToken({ connectionId: created.connectionId, email: jira.serviceAccount.email, token: jira.token, expiresOn: nextYear() });
  if (!saved.ok) throw new Error(saved.message);
  return created.connectionId;
};

/** Core's inbox on the first delivery with a valid signature (ticket 07): the claim's transaction activates the connection. */
const firstDelivery = (connectionId: ConnectionId) =>
  harness.test.db.$transaction((tx) => activateOnFirstDelivery({ tx, audit: postgresAuditLog, notices: postgresChangeNotices, clock: systemClock }, { organizationId: organizationId(), connectionId }));

/** A Jira connection connected by its webhook: the steps, then a first delivery. */
const connectedJira = async (admin: AppCaller) => {
  const connectionId = await jiraThroughStepTwo(admin);
  const shown = await admin.trackers.jira.webhook({ connectionId });
  await firstDelivery(connectionId);
  return { connectionId, secret: shown.webhook.mode === "webhooks" ? shown.webhook.secret : null };
};

/** A Linear connection made by `trackers.create`, its app saved and authorized on the fake Linear. */
const linearAuthorized = async (admin: AppCaller, name?: string) => {
  const created = await admin.trackers.create(name === undefined ? { kind: "linear" } : { kind: "linear", name });
  if (created.kind !== "linear") throw new Error("not a Linear connection");
  const app = linear.createApp({ name: "ostra", redirectUris: [CALLBACK], webhookUrl: created.webhookUrl });
  const saved = await admin.trackers.linear.saveApp({ connectionId: created.connectionId, clientId: app.clientId, clientSecret: app.clientSecret, webhookSecret: app.webhookSecret });
  return { connectionId: created.connectionId, completed: await admin.trackers.linear.complete(await consent(saved.authorizeUrl)) };
};

const auditActions = async (connectionId: string): Promise<readonly string[]> =>
  (await harness.test.db.auditEntry.findMany({ where: { organizationId: organizationId(), entityId: connectionId }, orderBy: { createdAt: "asc" }, select: { action: true } })).map((entry) => entry.action);

/** A connection row written directly, as an install upgraded or connected earlier holds it. */
const seedTracker = async (input: { readonly kind: "linear" | "jira"; readonly name: string; readonly state: "pending" | "active" | "failed"; readonly mode: "webhooks" | "polling"; readonly site: string }) => {
  const row = await harness.test.db.connection.create({
    data: {
      organizationId: organizationId(),
      kind: input.kind,
      name: input.name,
      appId: `${input.kind}-${input.site}`,
      state: input.state,
      webhookMode: input.mode,
      externalWorkspaceId: `${input.site}-id`,
      externalWorkspaceKey: input.site,
      externalWorkspaceName: input.name,
      activatedAt: input.state === "pending" ? null : new Date(),
      ...(input.state === "failed" ? { failedReason: "token-refused" } : {}),
    },
    select: { id: true },
  });
  return connectionIdSchema.parse(row.id);
};

describe("F-152: an organization's tracker connections, of any kind", () => {
  it("F-152/c1: trackers.list holds two Linear and two Jira connections with their names, kinds, modes, states and capabilities; create, rename and disconnect work and are audited", async () => {
    const admin = await callerOn("admin", "list-1");
    const linearMade = await admin.trackers.create({ kind: "linear", name: "Acme Linear" });
    const jiraMade = await admin.trackers.create({ kind: "jira" });
    expect(linearMade).toMatchObject({ kind: "linear", name: "Acme Linear", mode: "webhooks", modeReason: null, webhookUrl: `${PUBLIC_CORE}/webhooks/linear/${linearMade.connectionId}` });
    expect(jiraMade).toMatchObject({ kind: "jira", name: "Jira", mode: "webhooks" });
    const northwind = await seedTracker({ kind: "linear", name: "Northwind Linear", state: "active", mode: "polling", site: "northwind" });
    const initech = await seedTracker({ kind: "jira", name: "Initech Jira", state: "failed", mode: "webhooks", site: "initech.atlassian.net" });

    const listed = await admin.trackers.list();
    expect(listed.canManage).toBe(true);
    expect(listed.connections.map((row) => [row.name, row.kind, row.webhookMode, row.state, row.failedReason])).toEqual([
      ["Acme Linear", "linear", "webhooks", "pending", null],
      ["Jira", "jira", "webhooks", "pending", null],
      ["Northwind Linear", "linear", "polling", "active", null],
      ["Initech Jira", "jira", "webhooks", "failed", "token-refused"],
    ]);
    const byName = (name: string) => listed.connections.find((row) => row.name === name);
    // Each kind's adapter's own declaration: Linear moves statuses directly and has agent sessions; Jira walks transitions.
    expect(byName("Northwind Linear")?.capabilities).toMatchObject({ agentSessions: true, transitions: false, magicWords: true, richText: "markdown", jqlFilter: false });
    expect(byName("Initech Jira")?.capabilities).toMatchObject({ agentSessions: false, transitions: true, magicWords: false, richText: "adf", jqlFilter: true, subIssues: true });
    expect(byName("Northwind Linear")?.site).toBe("northwind");
    expect(byName("Initech Jira")?.site).toBe("initech.atlassian.net");
    // Another organization's connections never show.
    const ofB = await harness.test.db.connection.findMany({ where: { organizationId: harness.fixture.b.organization.id }, select: { id: true } });
    expect(ofB.length).toBeGreaterThan(0);
    expect(listed.connections.filter((row) => ofB.some((other) => other.id === row.id))).toEqual([]);

    // Rename: what boards, tickets and the panel call it. A name another connection holds is refused.
    expect(await admin.trackers.rename({ id: initech, name: "  Globex Jira  " })).toEqual({ id: initech, name: "Globex Jira" });
    expect(await trpcFailure(admin.trackers.rename({ id: jiraMade.connectionId, name: "globex jira" }))).toMatchObject({ code: "CONFLICT" });
    expect(await trpcFailure(admin.trackers.rename({ id: jiraMade.connectionId, name: "   " }))).toMatchObject({ code: "BAD_REQUEST" });
    expect((await admin.trackers.get({ id: initech })).name).toBe("Globex Jira");

    // Disconnect: revoked, gone from the list, its boards paused.
    const project = harness.fixture.a.openProject.id;
    await seedBoard(harness, { projectId: project, connectionId: northwind, externalId: "team-northwind", key: "NW" });
    const disconnected = await admin.trackers.disconnect({ id: northwind });
    expect(disconnected).toMatchObject({ id: northwind, kind: "linear", pausedBoards: 1 });
    expect(disconnected.revokedAtTracker).toEqual(expect.any(Boolean));
    expect(await harness.test.db.connection.findUniqueOrThrow({ where: { id: northwind } })).toMatchObject({ state: "revoked", appId: `revoked:${northwind}` });
    expect((await admin.trackers.list()).connections.map((row) => row.name)).toEqual(["Acme Linear", "Jira", "Globex Jira"]);
    expect(await trpcFailure(admin.trackers.get({ id: northwind }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await admin.trackers.disconnect({ id: jiraMade.connectionId })).toMatchObject({ kind: "jira", revokedAtTracker: false, pausedBoards: 0 });

    // Each change audited, with IDs only.
    expect(await auditActions(linearMade.connectionId)).toEqual(["tracker.connection-created"]);
    expect(await auditActions(jiraMade.connectionId)).toEqual(["tracker.connection-created", "tracker.disconnected"]);
    expect(await auditActions(initech)).toEqual(["tracker.renamed"]);
    expect(await auditActions(northwind)).toEqual(["tracker.disconnected"]);
  });

  it("F-152/c2: findSite on a site the organization holds is refused, naming the holder; a Linear Authorize on a workspace another connection holds is refused the same way", async () => {
    const admin = await callerOn("admin", "site-taken");
    const first = await admin.trackers.create({ kind: "jira" });
    expect(await admin.trackers.jira.findSite({ connectionId: first.connectionId, site: "globex" })).toMatchObject({ ok: true, name: "Globex Jira", host: "globex.atlassian.net" });
    const second = await admin.trackers.create({ kind: "jira" });
    expect(await admin.trackers.jira.findSite({ connectionId: second.connectionId, site: "globex.atlassian.net" })).toEqual({
      ok: false,
      error: "site-taken",
      message: "globex.atlassian.net is already connected, as Globex Jira.",
      holder: { id: first.connectionId, name: "Globex Jira" },
    });
    expect(await harness.test.db.connection.findUniqueOrThrow({ where: { id: second.connectionId } })).toMatchObject({ externalWorkspaceId: null, state: "pending" });

    // Linear: the workspace is known only at the callback, which names the connection that holds it.
    const held = await linearAuthorized(admin, "Acme Linear");
    expect(held.completed).toMatchObject({ ok: true, connectionId: held.connectionId, workspaceName: linear.organization.name, mode: "webhooks" });
    const again = await linearAuthorized(admin, "Acme Linear again");
    expect(again.completed).toEqual({
      ok: false,
      error: "workspace-taken",
      message: `The Linear workspace ${linear.organization.name} is already connected, as Acme Linear.`,
      holder: { id: held.connectionId, name: "Acme Linear" },
    });
    // The refused connection holds no secret any more, and stays pending.
    expect(await harness.test.db.connection.findUniqueOrThrow({ where: { id: again.connectionId } })).toMatchObject({ state: "pending", accessTokenSecretRef: null, clientSecretSecretRef: null });
  });

  it("F-152/c3: a member gets list and get with no webhook URL, secret, email or token detail, and every write is refused; another organization's connection is a 404", async () => {
    const admin = await callerOn("admin", "member-view");
    const { connectionId, secret } = await connectedJira(admin);
    if (secret === null) throw new Error("no secret was shown");
    const { a } = harness.fixture;
    await seedBoard(harness, { projectId: a.openProject.id, connectionId, externalId: "10000", key: "PROJ" });
    await seedBoard(harness, { projectId: a.restrictedProject.id, connectionId, externalId: "10001", key: "SHOP" });
    const webhookUrl = `${PUBLIC_CORE}/webhooks/jira/${connectionId}`;

    // The admin's view holds them all.
    const asAdmin = await admin.trackers.get({ id: connectionId });
    if (asAdmin.kind !== "jira") throw new Error("not Jira");
    expect(asAdmin).toMatchObject({ state: "active", signsInAs: "ostra-bot", tokenExpiry: { state: "healthy" } });
    expect(asAdmin.jira).toMatchObject({ email: jira.serviceAccount.email, webhookUrl, cloudId: jira.cloudId, workflowsReadable: true });
    expect(asAdmin.boards.map((board) => board.key).sort()).toEqual(["PROJ", "SHOP"]);

    const member = await callerOn("member", "member-view");
    const listed = await member.trackers.list();
    const got = await member.trackers.get({ id: connectionId });
    expect(listed.canManage).toBe(false);
    const row = listed.connections.find((one) => one.id === connectionId);
    expect(row).toMatchObject({ kind: "jira", name: "Globex Jira", state: "active", site: "globex.atlassian.net", tokenExpiresAt: null, tokenExpiry: null, signsInAs: null });
    // Only the boards of projects the member may open.
    expect(row?.boards.map((board) => board.key)).toEqual(["PROJ"]);
    if (got.kind !== "jira") throw new Error("not Jira");
    expect(got.jira).toMatchObject({ email: null, webhookUrl: null, webhooksPage: null, reach: null, scopes: [], badSignatureAt: null });
    const said = JSON.stringify([listed, got]);
    for (const hidden of [webhookUrl, secret, jira.serviceAccount.email, jira.token, "SHOP"]) {
      expect(said.includes(hidden), hidden).toBe(false);
    }

    // Every write, and the webhook's values, are an admin's.
    const input = { connectionId };
    const token = { connectionId, email: jira.serviceAccount.email, token: jira.token, expiresOn: nextYear() };
    const refusals = await Promise.all([
      trpcFailure(member.trackers.create({ kind: "jira" })),
      trpcFailure(member.trackers.rename({ id: connectionId, name: "Mine" })),
      trpcFailure(member.trackers.disconnect({ id: connectionId })),
      trpcFailure(member.trackers.jira.findSite({ connectionId, site: "globex" })),
      trpcFailure(member.trackers.jira.checkToken(token)),
      trpcFailure(member.trackers.jira.saveToken(token)),
      trpcFailure(member.trackers.jira.replaceToken(token)),
      trpcFailure(member.trackers.jira.recheck(input)),
      trpcFailure(member.trackers.jira.webhook(input)),
      trpcFailure(member.trackers.jira.finishPolling(input)),
      trpcFailure(member.trackers.jira.rotateSecret(input)),
      trpcFailure(member.trackers.linear.status(input)),
      trpcFailure(member.trackers.linear.enableAgentMode(input)),
    ]);
    expect(refusals.map((refusal) => refusal.code)).toEqual(Array(13).fill("FORBIDDEN"));
    expect(await harness.test.db.connection.findUniqueOrThrow({ where: { id: connectionId } })).toMatchObject({ name: "Globex Jira", state: "active" });

    // Another organization's connection: not found, for reads and writes alike.
    const other = linearOfB;
    for (const call of [
      () => admin.trackers.get({ id: other }),
      () => admin.trackers.rename({ id: other, name: "Taken over" }),
      () => admin.trackers.disconnect({ id: other }),
      () => admin.trackers.jira.webhook({ connectionId: other }),
      () => admin.trackers.linear.status({ connectionId: other }),
      () => member.trackers.get({ id: other }),
    ]) {
      expect(await trpcFailure(call())).toMatchObject({ code: "NOT_FOUND" });
    }
    expect(await harness.test.db.connection.findUniqueOrThrow({ where: { id: other } })).toMatchObject({ name: "B's Linear", state: "active" });
    // No log line carries the token or the secret.
    const logged = JSON.stringify(harness.logs);
    expect(logged.includes(jira.token)).toBe(false);
    expect(logged.includes(secret)).toBe(false);
  });

  it("F-152/c7: setup.status's tracker step is open, pending (either kind), failed, done and skipped, naming the connection it stands on", async () => {
    const admin = await callerOn("admin", "setup-step");
    const stepOf = async () => (await admin.setup.status()).steps.find((step) => step.id === "tracker");
    expect(await stepOf()).toMatchObject({ state: "open", connection: null });

    const linearMade = await admin.trackers.create({ kind: "linear", name: "Acme Linear" });
    expect(await stepOf()).toMatchObject({ state: "pending", connection: { id: linearMade.connectionId, kind: "linear", name: "Acme Linear" } });
    // The newest connection names the step: a Jira one started after.
    const jiraMade = await admin.trackers.create({ kind: "jira", name: "Globex Jira" });
    expect(await stepOf()).toMatchObject({ state: "pending", connection: { id: jiraMade.connectionId, kind: "jira", name: "Globex Jira" } });
    await harness.test.db.connection.update({ where: { id: jiraMade.connectionId }, data: { state: "failed", failedReason: "token-expired" } });
    expect(await stepOf()).toMatchObject({ state: "failed", connection: { id: jiraMade.connectionId, kind: "jira" } });
    const active = await seedTracker({ kind: "jira", name: "Initech Jira", state: "active", mode: "polling", site: "initech.atlassian.net" });
    expect(await stepOf()).toMatchObject({ state: "done", connection: { id: active, kind: "jira", name: "Initech Jira" } });

    // Skipped, until a connection is active again; a skip from before milestone 11 counts too.
    for (const id of [linearMade.connectionId, jiraMade.connectionId, active]) {
      await admin.trackers.disconnect({ id });
    }
    expect(await stepOf()).toMatchObject({ state: "open", connection: null });
    await admin.setup.skip({ step: "tracker" });
    expect(await stepOf()).toMatchObject({ state: "skipped", connection: null });
    const setting = await harness.test.db.organizationSetting.findUniqueOrThrow({ where: { organizationId: organizationId() } });
    expect(setting.trackerSkippedAt).toEqual(expect.any(Date));
    expect(setting.linearSkippedAt).toEqual(expect.any(Date));
    await harness.test.db.organizationSetting.update({ where: { organizationId: organizationId() }, data: { trackerSkippedAt: null } });
    expect(await stepOf()).toMatchObject({ state: "skipped" });
    const later = await seedTracker({ kind: "linear", name: "Northwind Linear", state: "active", mode: "webhooks", site: "northwind" });
    expect(await stepOf()).toMatchObject({ state: "done", connection: { id: later, kind: "linear", name: "Northwind Linear" } });
    // Setup is complete without a tracker: the step is optional.
    expect((await admin.setup.status()).steps.map((step) => step.id)).toContain("tracker");
  });
});

describe("F-008: connecting Jira", () => {
  it("F-008/c1: the three steps through the procedures against the fake Jira: the site, a checked token saved, the webhook's words, and a first delivery making get answer active", async () => {
    const admin = await callerOn("admin", "connect-webhooks");
    const created = await admin.trackers.create({ kind: "jira" });
    const connectionId = created.connectionId;
    expect(await admin.trackers.get({ id: connectionId })).toMatchObject({ kind: "jira", state: "pending", name: "Jira", site: null });

    // Step 1: the site, from a URL pasted out of Jira.
    expect(await admin.trackers.jira.findSite({ connectionId, site: "https://globex.atlassian.net/jira/software/projects/PROJ/boards/1" })).toEqual({
      ok: true,
      connectionId,
      cloudId: jira.cloudId,
      host: "globex.atlassian.net",
      title: "Globex",
      name: "Globex Jira",
      webhooksPage: "https://globex.atlassian.net/plugins/servlet/webhooks",
      cleared: false,
    });

    // Step 2: the read-back, nothing stored; then saved.
    const token = { connectionId, email: jira.serviceAccount.email, token: jira.token, expiresOn: nextYear() };
    const checked = await admin.trackers.jira.checkToken(token);
    expect(checked).toMatchObject({ verdict: "pass", readBack: { kind: "checked", account: { outcome: "ok", name: "ostra-bot", accountType: "app" }, projects: { outcome: "ok" }, workflows: { readable: true } } });
    expect(await harness.test.db.connection.findUniqueOrThrow({ where: { id: connectionId } })).toMatchObject({ accessTokenSecretRef: null, accountEmail: null });
    const saved = await admin.trackers.jira.saveToken(token);
    expect(saved).toMatchObject({ ok: true, verdict: "pass", state: "pending", tokenExpiresOn: token.expiresOn });
    const row = await harness.test.db.connection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(row).toMatchObject({ credentialKind: "service_account_token", accountEmail: jira.serviceAccount.email, appUserId: jira.serviceAccount.accountId });
    expect(row.scopes).toEqual(["read:jira-work", "read:jira-user", "read:workflow:jira"]);
    // The token is in the secret store, under the row's reference, and nowhere in the row itself.
    const ref = secretRefSchema.parse(row.accessTokenSecretRef);
    expect(await harness.fakes.secretStore.get(organizationId(), ref)).toMatchObject({ ok: true, value: jira.token });
    expect(JSON.stringify(row).includes(jira.token)).toBe(false);

    // Step 3: the webhook's words, and the secret while no delivery has come.
    const step3 = await admin.trackers.jira.webhook({ connectionId });
    expect(step3.webhook).toMatchObject({
      mode: "webhooks",
      url: `${PUBLIC_CORE}/webhooks/jira/${connectionId}`,
      events: ["jira:issue_created", "jira:issue_updated", "jira:issue_deleted", "comment_created", "comment_updated", "comment_deleted"],
      jql: `project in (${jira.project.key})`,
      firstDeliveryAt: null,
      badSignatureAt: null,
    });
    const secret = step3.webhook.mode === "webhooks" ? (step3.webhook.secret ?? "") : "";
    expect(secret.length).toBeGreaterThanOrEqual(40);
    // The same secret on the next poll of the page: made once.
    expect((await admin.trackers.jira.webhook({ connectionId })).webhook).toMatchObject({ secret });
    // A delivery Jira signs with it verifies; one signed with another secret doesn't.
    const issue = jira.createIssue({ summary: "A first ticket" });
    const signed = jira.signedDelivery({ issueId: issue.id, byAccountId: jira.person.accountId, sentAt: jira.clock.now(), secret });
    expect(verifyJiraWebhook({ rawBody: signed.rawBody, headers: signed.headers, secret, now: jira.clock.now() }).ok).toBe(true);
    const wrong = jira.signedDelivery({ issueId: issue.id, byAccountId: jira.person.accountId, sentAt: jira.clock.now(), secret: "another-secret" });
    expect(verifyJiraWebhook({ rawBody: wrong.rawBody, headers: wrong.headers, secret, now: jira.clock.now() }).ok).toBe(false);

    // The first valid delivery (core's inbox): the connection is active, and the secret no longer shown.
    expect(await firstDelivery(connectionId)).toEqual({ activated: true, resumedBoards: 0 });
    const got = await admin.trackers.get({ id: connectionId });
    if (got.kind !== "jira") throw new Error("not Jira");
    expect(got).toMatchObject({ state: "active", webhookMode: "webhooks", name: "Globex Jira", site: "globex.atlassian.net" });
    expect(got.jira.firstDeliveryAt).toEqual(expect.any(Number));
    expect(got.jira).toMatchObject({ webhookUrl: `${PUBLIC_CORE}/webhooks/jira/${connectionId}`, workflowsReadable: true });
    expect((await admin.trackers.jira.webhook({ connectionId })).webhook).toMatchObject({ mode: "webhooks", secret: null });
    // (`tracker.resumed` too, naming this one the successor of the site's earlier connections in this file.)
    expect((await auditActions(connectionId)).filter((action) => action !== "tracker.resumed")).toEqual([
      "tracker.connection-created",
      "tracker.site-found",
      "tracker.token-saved",
      "tracker.secret-made",
      "tracker.connected",
    ]);
    // The connection's adapter is built with the site, the cloud ID and the service account.
    expect((await harness.deps.trackers.forConnection(organizationId(), connectionId)).ok).toBe(true);
    expect(harness.fakes.jiraTrackers.at(-1)).toEqual({ host: "globex.atlassian.net", cloudId: jira.cloudId, email: jira.serviceAccount.email });
  });

  it("F-008/c1: finishPolling connects a site without a public address, by polling, with no secret", async () => {
    const admin = await callerOn("admin", "connect-polling", "private");
    const created = await admin.trackers.create({ kind: "jira" });
    expect(created).toMatchObject({ kind: "jira", mode: "polling", modeReason: "not-https" });
    const connectionId = created.connectionId;
    await admin.trackers.jira.findSite({ connectionId, site: "globex" });
    // Not before the token is saved.
    expect(await trpcFailure(admin.trackers.jira.finishPolling({ connectionId }))).toMatchObject({ code: "PRECONDITION_FAILED" });
    await admin.trackers.jira.saveToken({ connectionId, email: jira.serviceAccount.email, token: jira.token, expiresOn: nextYear() });
    expect(await admin.trackers.jira.webhook({ connectionId })).toEqual({ connectionId, webhook: { mode: "polling", reason: "not-https" } });
    expect(await admin.trackers.jira.finishPolling({ connectionId })).toEqual({ connectionId, mode: "polling", resumedBoards: 0 });
    const got = await admin.trackers.get({ id: connectionId });
    if (got.kind !== "jira") throw new Error("not Jira");
    expect(got).toMatchObject({ state: "active", webhookMode: "polling" });
    expect(got.jira).toMatchObject({ webhookUrl: null, modeReason: "not-https" });
    expect(await harness.test.db.connection.findUniqueOrThrow({ where: { id: connectionId } })).toMatchObject({ webhookSecretSecretRef: null });
    expect(await trpcFailure(admin.trackers.jira.finishPolling({ connectionId }))).toMatchObject({ code: "CONFLICT" });
  });

  it("F-008/c1: each step's refusal says what to do: no site there, a Data Center address, a person's token, a token Jira refuses with its status code", async () => {
    const admin = await callerOn("admin", "connect-refusals");
    const { connectionId } = await admin.trackers.create({ kind: "jira" });
    expect(await admin.trackers.jira.findSite({ connectionId, site: "globex-shop" })).toEqual({
      ok: false,
      error: "not-found",
      message: "No Jira Cloud site answers at globex-shop.atlassian.net. Check the name in the browser's address bar when you're in Jira.",
    });
    expect(await admin.trackers.jira.findSite({ connectionId, site: `https://${jira.dataCenterHost}/secure/Dashboard.jspa` })).toEqual({
      ok: false,
      error: "data-center",
      message: "That's a Jira Data Center address. ostra connects to Jira Cloud only.",
    });
    // Step 2 before step 1 is a precondition.
    const early = { connectionId, email: jira.serviceAccount.email, token: jira.token, expiresOn: nextYear() };
    expect(await trpcFailure(admin.trackers.jira.checkToken(early))).toMatchObject({ code: "PRECONDITION_FAILED" });
    await admin.trackers.jira.findSite({ connectionId, site: "globex" });

    const person = jira.mintToken(jira.person.accountId, ALL_SCOPES);
    const red = await admin.trackers.jira.saveToken({ connectionId, email: jira.person.email, token: person, expiresOn: nextYear() });
    expect(red).toMatchObject({ ok: false, error: "token-failed", readBack: { account: { outcome: "fail", accountType: "atlassian" } } });
    const refused = jira.mintToken(jira.serviceAccount.accountId, ALL_SCOPES);
    jira.refuseToken(refused, 401);
    const said = await admin.trackers.jira.saveToken({ connectionId, email: jira.serviceAccount.email, token: refused, expiresOn: nextYear() });
    expect(said).toEqual({
      ok: false,
      error: "token-refused",
      status: 401,
      message: "Jira refused the token: 401. Check the email is the service account's, and that the token isn't expired or revoked.",
    });
    expect(await admin.trackers.jira.checkToken({ connectionId, email: jira.serviceAccount.email, token: refused, expiresOn: nextYear() })).toMatchObject({ readBack: { kind: "refused", status: 401 }, verdict: null });
    // A token without workflow access saves, with the warning.
    const noWorkflows = jira.mintToken(jira.serviceAccount.accountId, ["read:jira-work", "write:jira-work", "read:jira-user"]);
    expect(await admin.trackers.jira.saveToken({ connectionId, email: jira.serviceAccount.email, token: noWorkflows, expiresOn: nextYear() })).toMatchObject({
      ok: true,
      verdict: "warnings",
      readBack: { workflows: { outcome: "warn", readable: false } },
    });
    // A date already past is refused before Jira is asked.
    expect(await trpcFailure(admin.trackers.jira.checkToken({ ...early, expiresOn: "2020-01-01" }))).toMatchObject({ code: "BAD_REQUEST" });
    // Nothing refused was stored.
    expect(harness.fakes.secretStore.values().includes(person)).toBe(false);
    expect(harness.fakes.secretStore.values().includes(refused)).toBe(false);
  });

  it("F-008/c8: replaceToken reads the new token back first; rotateSecret answers a new secret once and never again", async () => {
    const admin = await callerOn("admin", "replace-rotate");
    const { connectionId, secret } = await connectedJira(admin);
    const tokenRef = async () => secretRefSchema.parse((await harness.test.db.connection.findUniqueOrThrow({ where: { id: connectionId } })).accessTokenSecretRef);
    const storedToken = async () => {
      const value = await harness.fakes.secretStore.get(organizationId(), await tokenRef());
      return value.ok ? value.value : null;
    };
    expect(await storedToken()).toBe(jira.token);
    const oldRef = await tokenRef();

    // Refused or red tokens are read back and never take the old one's place.
    const refused = jira.mintToken(jira.serviceAccount.accountId, ALL_SCOPES);
    jira.refuseToken(refused, 403);
    expect(await admin.trackers.jira.replaceToken({ connectionId, email: jira.serviceAccount.email, token: refused, expiresOn: nextYear() })).toMatchObject({ ok: false, error: "token-refused", status: 403 });
    const person = jira.mintToken(jira.person.accountId, ALL_SCOPES);
    expect(await admin.trackers.jira.replaceToken({ connectionId, email: jira.person.email, token: person, expiresOn: nextYear() })).toMatchObject({ ok: false, error: "token-failed" });
    expect(await storedToken()).toBe(jira.token);

    // A new token that reads back takes its place; the old one is deleted from the store.
    const fresh = jira.mintToken(jira.serviceAccount.accountId, ALL_SCOPES);
    const calls = jira.calls().length;
    const expiresOn = new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10);
    expect(await admin.trackers.jira.replaceToken({ connectionId, email: jira.serviceAccount.email, token: fresh, expiresOn })).toMatchObject({ ok: true, verdict: "pass", state: "active", tokenExpiresOn: expiresOn });
    expect(jira.calls().slice(calls).map((call) => call.route)).toContain("GET /rest/api/3/myself");
    expect(await storedToken()).toBe(fresh);
    expect((await harness.fakes.secretStore.get(organizationId(), oldRef)).ok).toBe(false);
    const listed = (await admin.trackers.list()).connections.find((row) => row.id === connectionId);
    expect(listed?.tokenExpiresAt).toBe(Date.parse(`${expiresOn}T00:00:00Z`));

    // Rotate: a new secret, answered by this call alone.
    const rotated = await admin.trackers.jira.rotateSecret({ connectionId });
    expect(rotated.secret).not.toBe(secret);
    expect(rotated.secret.length).toBeGreaterThanOrEqual(40);
    const row = await harness.test.db.connection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(await harness.fakes.secretStore.get(organizationId(), secretRefSchema.parse(row.webhookSecretSecretRef))).toMatchObject({ ok: true, value: rotated.secret });
    const afterwards = JSON.stringify([await admin.trackers.jira.webhook({ connectionId }), await admin.trackers.get({ id: connectionId }), await admin.trackers.list()]);
    expect(afterwards.includes(rotated.secret)).toBe(false);
    expect((await admin.trackers.jira.webhook({ connectionId })).webhook).toMatchObject({ mode: "webhooks", secret: null });
    // The old secret is gone from the store: a delivery signed with it no longer verifies.
    expect(secret === null ? false : harness.fakes.secretStore.values().includes(secret)).toBe(false);
    expect(await auditActions(connectionId)).toEqual(expect.arrayContaining(["tracker.token-replaced", "tracker.secret-rotated"]));
  });

  it("F-008/c9: a Jira connection's capabilities hold no agent sessions, and trackers.linear.*'s agent mode refuses a Jira connection", async () => {
    const admin = await callerOn("admin", "agent-mode");
    const { connectionId } = await connectedJira(admin);
    const listed = (await admin.trackers.list()).connections.find((row) => row.id === connectionId);
    expect(listed?.capabilities).toMatchObject({ agentSessions: false, agentScopes: [], agentSessionLink: false });
    expect(listed?.agentModeAt).toBeNull();
    expect(await trpcFailure(admin.trackers.linear.enableAgentMode({ connectionId }))).toEqual({ code: "PRECONDITION_FAILED", message: "Agent mode is Linear's: Jira has no agent sessions" });
    expect(await trpcFailure(admin.trackers.linear.status({ connectionId }))).toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await harness.test.db.connection.findUniqueOrThrow({ where: { id: connectionId } })).toMatchObject({ agentModeAt: null });
    // Linear's own connection declares them, and its page answers.
    const held = await linearAuthorized(admin);
    expect((await admin.trackers.list()).connections.find((row) => row.id === held.connectionId)?.capabilities).toMatchObject({ agentSessions: true });
    expect(await admin.trackers.linear.status({ connectionId: held.connectionId })).toMatchObject({ state: "active", connectionId: held.connectionId });
  });
});
