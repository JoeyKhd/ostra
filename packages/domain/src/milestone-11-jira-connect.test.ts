import { createHmac, randomUUID } from "node:crypto";

import { secretRefSchema } from "@ostra/adapter-sdk";
import { createJiraSite, JiraFakeAdapter } from "@ostra/adapter-sdk/testing";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { boardIdSchema, connectionIdSchema } from "@ostra/protocol";
import type { BoardId, ConnectionId, OrganizationId, ProjectId } from "@ostra/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { MemberScope } from "./access.ts";
import { boardStateOf } from "./lifecycles/m11-trackers.ts";
import type { JobQueue } from "./ports.ts";
import { postgresAuditLog, postgresChangeNotices } from "./postgres-ports.ts";
import { FakeSecretStore } from "./testing/fake-adapters.ts";
import { createFakeJiraConnectKit } from "./testing/jira-connect.ts";
import type { FakeJiraTokenProfile } from "./testing/jira-connect.ts";
import {
  activateOnFirstDelivery,
  checkJiraToken,
  findJiraSite,
  finishJiraPolling,
  jiraWebhookOf,
  recheckJiraToken,
  replaceJiraToken,
  rotateJiraSecret,
  saveJiraToken,
  tokenExpiryState,
} from "./use-cases/jira-connection.ts";
import type { JiraConnectionDeps } from "./use-cases/jira-connection.ts";
import { authorizeLinear, connectLinear } from "./use-cases/linear-connection.ts";
import type { LinearAppIdentity, LinearAppKit } from "./use-cases/linear-connection.ts";
import { disconnectTracker, startTrackerConnection } from "./use-cases/tracker-connection-changes.ts";
import type { TrackerConnectionChangeDeps } from "./use-cases/tracker-connection-changes.ts";
import { failConnection, renameConnection } from "./use-cases/tracker-connections.ts";

// Milestone 11, ticket 06 (F-008, F-152; ADR 0047, ADR 0071; spec sections 4 and 5.4): connecting
// Jira in its three checked steps against the fake connect kit, a connection's changes (rename,
// re-check, rotate, replace, fail, disconnect), Linear's one connection per workspace, and resume on
// either kind's activation. On Postgres; organization B's rows and admin stay apart throughout.

let test: TestDatabase;
let fixture: IsolationFixture;
let organizationA: OrganizationId;
let openProject: ProjectId;
let admin: MemberScope;
let member: MemberScope;
let adminB: MemberScope;

const NOW = Date.parse("2026-11-23T12:00:00Z");
const clock = { now: () => NOW };
const CORE = "https://core.example.com";
const PUBLIC = "https://ostra.example.com";
const EMAIL = "ostra-bot@serviceaccount.atlassian.com";
const EXPIRES = "2027-09-14";

/** What the store and the kit did, in order: the read-back must come before the token is stored. */
const events: string[] = [];

const store = new FakeSecretStore({ onPut: (purpose) => events.push(`put:${purpose}`) });
const fake = createFakeJiraConnectKit();
const kit = {
  ...fake.kit,
  checkToken: (input: Parameters<typeof fake.kit.checkToken>[0]) => {
    events.push("check");
    return fake.kit.checkToken(input);
  },
};

const enqueued: unknown[] = [];
const jobs: JobQueue = {
  enqueueInTx: (_tx, job, payload) => {
    enqueued.push({ job, payload });
    return Promise.resolve();
  },
};
const ports = { audit: postgresAuditLog, notices: postgresChangeNotices, clock, jobs };

// ---------- Linear's side, for its disconnect and its one connection per workspace ----------

const linearRevoked: string[] = [];
const linearExchanged: string[] = [];
let linearIdentity: LinearAppIdentity = { appUserId: "app-user", appUserName: "ostra", workspaceId: "ws-none", workspaceKey: "none", workspaceName: "None" };
const linearKit: LinearAppKit = {
  scopes: ["read", "write"],
  webhookEvents: ["Issue", "Comment"],
  checkPublicUrl: () => ({ public: true }),
  manifestUrl: () => "https://linear.invalid/manifest",
  authorizeUrl: ({ state }) => `https://linear.invalid/authorize?state=${encodeURIComponent(state)}`,
  exchangeCode: () => {
    const accessToken = `lin-access-${randomUUID()}`;
    linearExchanged.push(accessToken);
    return Promise.resolve({ ok: true, value: { accessToken, refreshToken: `lin-refresh-${randomUUID()}`, expiresAt: NOW + 86_400_000, scopes: ["read", "write"] } });
  },
  checkAppToken: () => Promise.resolve({ ok: true, value: linearIdentity }),
  revokeToken: (token) => {
    linearRevoked.push(token);
    return Promise.resolve({ ok: true, value: null });
  },
  capabilities: { agentSessions: true, agentScopes: ["app:assignable"] },
};

// ---------- deps ----------

const jiraDeps = (scope: MemberScope, corePublicUrl: string | null = CORE): JiraConnectionDeps => ({
  db: test.db,
  scope,
  jira: kit,
  adapters: { secretStore: store },
  corePublicUrl,
  corePublicUrlProblem: corePublicUrl === null ? "private-network" : null,
  audit: ports.audit,
  notices: ports.notices,
  clock,
});

const changeDeps = (scope: MemberScope, corePublicUrl: string | null = CORE): TrackerConnectionChangeDeps => ({
  db: test.db,
  scope,
  adapters: { secretStore: store },
  corePublicUrl,
  corePublicUrlProblem: corePublicUrl === null ? "private-network" : null,
  publicUrl: PUBLIC,
  linear: linearKit,
  audit: ports.audit,
  notices: ports.notices,
  clock,
});

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  organizationA = fixture.a.organization.id;
  openProject = fixture.a.openProject.id;
  admin = { organizationId: organizationA, memberId: fixture.a.admin.id, role: "admin", projectRoles: new Map() };
  member = { organizationId: organizationA, memberId: fixture.a.member.id, role: "member", projectRoles: new Map() };
  adminB = { organizationId: fixture.b.organization.id, memberId: fixture.b.admin.id, role: "admin", projectRoles: new Map() };
});

afterAll(async () => {
  await test.dispose();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------- seeds and steps ----------

const unique = (): string => randomUUID().slice(0, 8);

const rowOf = (connectionId: ConnectionId) => test.db.connection.findUniqueOrThrow({ where: { id: connectionId } });

/** Starts a Jira connection; its name is the kind's placeholder until step 1. */
const startJira = async (scope: MemberScope = admin, corePublicUrl: string | null = CORE): Promise<ConnectionId> => {
  const started = await startTrackerConnection(changeDeps(scope, corePublicUrl), { kind: "jira" });
  if (!started.ok) throw new Error(`start: ${started.message}`);
  return started.connectionId;
};

/** A Jira connection through steps 1 and 2: its site found and a token saved. */
const connectJira = async (input: { readonly site?: string; readonly cloudId?: string; readonly profile?: FakeJiraTokenProfile; readonly core?: string | null; readonly scope?: MemberScope } = {}) => {
  const site = input.site ?? `site-${unique()}`;
  const { cloudId } = fake.site(site, { cloudId: input.cloudId ?? `cloud-${site}` });
  const scope = input.scope ?? admin;
  const core = input.core === undefined ? CORE : input.core;
  const connectionId = await startJira(scope, core);
  const found = await findJiraSite(jiraDeps(scope, core), { connectionId, site });
  if (!found.ok) throw new Error(`find: ${found.message}`);
  const token = `jira-token-${randomUUID()}`;
  fake.token(token, { cloudId, profile: input.profile ?? "service-account" });
  const saved = await saveJiraToken(jiraDeps(scope, core), { connectionId, email: EMAIL, token, expiresOn: EXPIRES });
  if (!saved.ok) throw new Error(`save: ${saved.message}`);
  return { connectionId, cloudId, token, site };
};

/** Step 3's secret, made by its first read. */
const secretOf = async (connectionId: ConnectionId): Promise<string> => {
  const webhook = await jiraWebhookOf(jiraDeps(admin), { connectionId });
  if (!webhook.ok || webhook.webhook.mode !== "webhooks" || webhook.webhook.secret === null) throw new Error("no secret");
  return webhook.webhook.secret;
};

/** A connection the first signed delivery activated. */
const activate = (connectionId: ConnectionId) =>
  test.db.$transaction((tx) => activateOnFirstDelivery({ tx, ...ports }, { organizationId: organizationA, connectionId }));

const seedBoard = async (connectionId: ConnectionId, externalId = "10000"): Promise<BoardId> =>
  boardIdSchema.parse(
    (await test.db.board.create({ data: { organizationId: organizationA, projectId: openProject, connectionId, externalId, name: "Project", key: "PROJ", statusMap: {} }, select: { id: true } })).id,
  );

const boardState = async (boardId: BoardId) => {
  const board = await test.db.board.findUniqueOrThrow({ where: { id: boardId }, include: { connection: { select: { state: true } } } });
  return { connectionId: board.connectionId, state: boardStateOf(board, board.connection) };
};

/** A revoked connection of a site, holding a board: what a reconnect resumes. */
const seedRevoked = async (kind: "jira" | "linear", workspaceId: string): Promise<{ readonly connectionId: ConnectionId; readonly boardId: BoardId }> => {
  const id = randomUUID();
  const row = await test.db.connection.create({
    data: { id, organizationId: organizationA, kind, name: `Old ${kind} ${unique()}`, appId: `revoked:${id}`, state: "revoked", externalWorkspaceId: workspaceId, externalWorkspaceName: "Old" },
    select: { id: true },
  });
  const connectionId = connectionIdSchema.parse(row.id);
  return { connectionId, boardId: await seedBoard(connectionId, `team-${unique()}`) };
};

/** Signs a Jira delivery as Jira's admin webhook does, and verifies it under the connection's stored secret. */
const verifiesUnderStored = async (connectionId: ConnectionId, signedWith: string): Promise<boolean> => {
  const row = await rowOf(connectionId);
  const ref = secretRefSchema.parse(row.webhookSecretSecretRef);
  const stored = await store.get(organizationA, ref);
  if (!stored.ok) throw new Error("the stored secret is gone");
  const rawBody = new TextEncoder().encode(JSON.stringify({ timestamp: Date.now(), webhookEvent: "jira:issue_updated", user: { accountId: "someone" } }));
  const signature = createHmac("sha256", signedWith).update(rawBody).digest("hex");
  const verified = new JiraFakeAdapter({ site: createJiraSite() }).verifyWebhook({
    rawBody,
    headers: { "x-hub-signature": `sha256=${signature}`, "x-atlassian-webhook-identifier": randomUUID() },
    secret: stored.value,
    now: Date.now(),
  });
  return verified.ok;
};

// ---------- F-008/c1: the three steps ----------

describe("Connecting Jira (F-008/c1)", () => {
  it("F-008/c1: a site is found and its cloud ID saved; a pasted URL is trimmed to the name, and the placeholder name becomes the site's", async () => {
    fake.site("globex", { cloudId: "cloud-globex" });
    const connectionId = await startJira();
    const pending = await rowOf(connectionId);
    expect(pending).toMatchObject({ kind: "jira", state: "pending", appId: `pending:${connectionId}`, credentialKind: "service_account_token", webhookMode: "webhooks" });
    expect(pending.name).toMatch(/^Jira( \d+)?$/);

    const found = await findJiraSite(jiraDeps(admin), { connectionId, site: " https://globex.atlassian.net/jira/software/projects/PROJ/boards/1 " });
    expect(found).toEqual({ ok: true, connectionId, cloudId: "cloud-globex", host: "globex.atlassian.net", title: "Globex", name: "Globex Jira", webhooksPage: "https://globex.atlassian.net/plugins/servlet/webhooks", cleared: false });
    expect(fake.calls.at(-1)).toEqual({ method: "findSite", site: "globex" });
    expect(await rowOf(connectionId)).toMatchObject({
      state: "pending",
      appId: "cloud-globex",
      externalWorkspaceId: "cloud-globex",
      externalWorkspaceKey: "globex.atlassian.net",
      externalWorkspaceName: "Globex",
      name: "Globex Jira",
    });
    expect(await test.db.auditEntry.findFirst({ where: { action: "tracker.site-found", entityId: connectionId }, select: { data: true } })).toEqual({ data: { kind: "jira", changed: false } });

    // A second connection of another site is deduped by name, never refused, when ostra names it.
    fake.site("globex-eu", { cloudId: "cloud-globex-eu", title: "Globex" });
    const second = await startJira();
    expect(await findJiraSite(jiraDeps(admin), { connectionId: second, site: "globex-eu" })).toMatchObject({ ok: true, name: "Globex Jira 2" });
    // A name an admin gives that another connection holds is refused.
    const third = await startJira();
    fake.site("globex-us", { cloudId: "cloud-globex-us" });
    expect(await findJiraSite(jiraDeps(admin), { connectionId: third, site: "globex-us", name: "globex jira" })).toMatchObject({ ok: false, error: "name-taken" });
    expect(await findJiraSite(jiraDeps(admin), { connectionId: third, site: "globex-us", name: "Globex US" })).toMatchObject({ ok: true, name: "Globex US" });
  });

  it("F-008/c1: not-found, data-center and site-taken (naming the holder) are refused; a revoked holder doesn't block, nor another organization's", async () => {
    const connectionId = await startJira();
    const nobody = await findJiraSite(jiraDeps(admin), { connectionId, site: `nobody-${unique()}` });
    expect(nobody).toMatchObject({ ok: false, error: "not-found" });
    expect(nobody.ok ? "" : nobody.message).toMatch(/^No Jira Cloud site answers at nobody-[0-9a-f]{8}\.atlassian\.net\. /);
    expect(await findJiraSite(jiraDeps(admin), { connectionId, site: "https://jira.globex.example/secure/Dashboard.jspa" })).toMatchObject({ ok: false, error: "data-center", message: "That's a Jira Data Center address. ostra connects to Jira Cloud only." });
    fake.site("down", { kind: "unreachable" });
    expect(await findJiraSite(jiraDeps(admin), { connectionId, site: "down" })).toMatchObject({ ok: false, error: "unreachable" });

    const holder = await connectJira({ site: `stark-${unique()}` });
    const taken = await findJiraSite(jiraDeps(admin), { connectionId, site: holder.site });
    const holderName = (await rowOf(holder.connectionId)).name;
    expect(taken).toEqual({ ok: false, error: "site-taken", message: `${holder.site}.atlassian.net is already connected, as ${String(holderName)}.`, holder: { id: holder.connectionId, name: holderName } });
    // Nothing of the refused site was kept.
    expect(await rowOf(connectionId)).toMatchObject({ appId: `pending:${connectionId}`, externalWorkspaceId: null });

    // Another organization connects the same site: one per site is per organization, not install-wide.
    const theirs = await startJira(adminB);
    expect(await findJiraSite(jiraDeps(adminB), { connectionId: theirs, site: holder.site })).toMatchObject({ ok: true, cloudId: holder.cloudId });

    // Disconnected, the holder no longer holds it.
    expect(await disconnectTracker(changeDeps(admin), { connectionId: holder.connectionId })).toMatchObject({ ok: true });
    expect(await findJiraSite(jiraDeps(admin), { connectionId, site: holder.site })).toMatchObject({ ok: true, cloudId: holder.cloudId });
  });

  it("F-008/c1: a token is checked with nothing stored; it's saved only after a pass or warnings, and refused on a fail", async () => {
    const site = `wayne-${unique()}`;
    const { cloudId } = fake.site(site, { cloudId: `cloud-${site}` });
    const connectionId = await startJira();
    const before = { token: `jira-token-${randomUUID()}` };
    fake.token(before.token, { cloudId });
    // Before step 1, there's no site to check against.
    expect(await checkJiraToken(jiraDeps(admin), { connectionId, email: EMAIL, token: before.token, expiresOn: EXPIRES })).toMatchObject({ ok: false, error: "no-site" });
    expect(await findJiraSite(jiraDeps(admin), { connectionId, site })).toMatchObject({ ok: true });

    const storedBefore = store.entries.size;
    const rowBefore = await rowOf(connectionId);
    const checked = await checkJiraToken(jiraDeps(admin), { connectionId, email: EMAIL, token: before.token, expiresOn: EXPIRES });
    expect(checked).toMatchObject({ ok: true, verdict: "pass", readBack: { kind: "checked", account: { outcome: "ok", name: "ostra-bot" }, projects: { outcome: "ok" } } });
    // Checked, nothing stored: the secret store and the row are as they were.
    expect(store.entries.size).toBe(storedBefore);
    expect(await rowOf(connectionId)).toEqual(rowBefore);
    expect(await checkJiraToken(jiraDeps(admin), { connectionId, email: EMAIL, token: before.token, expiresOn: "2026-11-23" })).toMatchObject({ ok: false, error: "expired-date" });

    // A fail refuses: a person's account, a token that sees no project, a token Jira refuses.
    for (const profile of ["person", "no-projects"] as const) {
      const token = `jira-token-${randomUUID()}`;
      fake.token(token, { cloudId, profile });
      expect(await saveJiraToken(jiraDeps(admin), { connectionId, email: EMAIL, token, expiresOn: EXPIRES })).toMatchObject({ ok: false, error: "token-failed", readBack: { kind: "checked" } });
    }
    const refused = await saveJiraToken(jiraDeps(admin), { connectionId, email: EMAIL, token: "not-a-token-jira-knows", expiresOn: EXPIRES });
    expect(refused).toMatchObject({ ok: false, error: "token-refused", status: 401 });
    expect(refused.ok ? "" : refused.message).toContain("Jira refused the token: 401.");
    expect(store.entries.size).toBe(storedBefore);
    expect((await rowOf(connectionId)).accessTokenSecretRef).toBeNull();

    // Warnings save: no workflows, and a project short of two permissions.
    const token = `jira-token-${randomUUID()}`;
    fake.token(token, { cloudId, profile: "no-workflows" });
    expect(await saveJiraToken(jiraDeps(admin), { connectionId, email: EMAIL, token, expiresOn: EXPIRES })).toMatchObject({ ok: true, verdict: "warnings", tokenExpiresOn: EXPIRES, state: "pending" });
    const saved = await rowOf(connectionId);
    expect(saved).toMatchObject({
      accountEmail: EMAIL,
      tokenExpiresOn: new Date(`${EXPIRES}T00:00:00Z`),
      appUserId: "ostra-bot-id",
      appUserName: "ostra-bot",
      scopes: ["read:jira-work", "read:jira-user"],
      accessCheckedAt: new Date(NOW),
    });
    expect(saved.accessCheck).toMatchObject({ workflowsReadable: false, projects: [{ key: "PROJ" }, { key: "SHOP" }, { key: "OPS" }] });
    expect(store.entries.get(saved.accessTokenSecretRef ?? "")).toEqual({ organizationId: organizationA, purpose: "jira-token", value: token });

    const short = `jira-token-${randomUUID()}`;
    fake.token(short, { cloudId, profile: "short-permissions" });
    expect(await saveJiraToken(jiraDeps(admin), { connectionId, email: EMAIL, token: short, expiresOn: EXPIRES })).toMatchObject({ ok: true, verdict: "warnings" });
    const shortRow = await rowOf(connectionId);
    // The kit says what each project lacks; the column holds what it has.
    expect(shortRow.accessCheck).toEqual({
      workflowsReadable: true,
      projects: [
        { id: "10000", key: "PROJ", name: "Project", permissions: ["BROWSE_PROJECTS", "CREATE_ISSUES", "EDIT_ISSUES", "TRANSITION_ISSUES", "ADD_COMMENTS"] },
        { id: "10001", key: "SHOP", name: "Shop", permissions: ["BROWSE_PROJECTS", "CREATE_ISSUES", "EDIT_ISSUES", "TRANSITION_ISSUES", "ADD_COMMENTS"] },
        { id: "10002", key: "OPS", name: "Operations", permissions: ["BROWSE_PROJECTS", "CREATE_ISSUES", "EDIT_ISSUES"] },
      ],
    });
    // The token it replaced is gone from the store.
    expect(store.has(saved.accessTokenSecretRef)).toBe(false);
    expect(await test.db.auditEntry.count({ where: { action: "tracker.token-saved", entityId: connectionId } })).toBe(2);
  });

  it("F-008/c1: the secret is made once while pending and shown until the first delivery, which activates the connection and resumes a revoked one's boards", async () => {
    const site = `acme-${unique()}`;
    const old = await seedRevoked("jira", `cloud-${site}`);
    const oldTicket = await test.db.ticket.create({
      data: { organizationId: organizationA, projectId: openProject, boardId: old.boardId, connectionId: old.connectionId, externalId: "10100", key: "PROJ-1", title: "A ticket", statusId: "1", statusName: "To Do", statusCategory: "open", url: "https://acme.invalid/PROJ-1", trackerUpdatedAt: new Date() },
      select: { id: true },
    });
    expect((await boardState(old.boardId)).state).toEqual({ state: "paused", pausedBy: "disconnected" });

    const site2 = await (async () => {
      fake.site(site, { cloudId: `cloud-${site}` });
      const connectionId = await startJira();
      // Before a token is saved, step 3 has nothing to show.
      expect(await jiraWebhookOf(jiraDeps(admin), { connectionId })).toMatchObject({ ok: false, error: "not-ready" });
      return connectionId;
    })();
    expect(await findJiraSite(jiraDeps(admin), { connectionId: site2, site })).toMatchObject({ ok: true });
    const token = `jira-token-${randomUUID()}`;
    fake.token(token, { cloudId: `cloud-${site}` });
    expect(await saveJiraToken(jiraDeps(admin), { connectionId: site2, email: EMAIL, token, expiresOn: EXPIRES })).toMatchObject({ ok: true });

    const first = await jiraWebhookOf(jiraDeps(admin), { connectionId: site2 });
    if (!first.ok || first.webhook.mode !== "webhooks") throw new Error("step 3 isn't webhooks");
    expect(first.webhook).toMatchObject({
      url: `${CORE}/webhooks/jira/${site2}`,
      events: ["jira:issue_created", "jira:issue_updated", "jira:issue_deleted", "comment_created", "comment_updated", "comment_deleted"],
      jql: "project in (PROJ, SHOP, OPS)",
      webhooksPage: `https://${site}.atlassian.net/plugins/servlet/webhooks`,
      firstDeliveryAt: null,
    });
    const secret = first.webhook.secret ?? "";
    // 32 random bytes, base64url.
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(secret, "base64url")).toHaveLength(32);
    // Made once: the second read shows the same secret, and the store holds one.
    expect(await jiraWebhookOf(jiraDeps(admin), { connectionId: site2 })).toMatchObject({ ok: true, webhook: { secret } });
    const pendingRow = await rowOf(site2);
    expect(store.entries.get(pendingRow.webhookSecretSecretRef ?? "")).toEqual({ organizationId: organizationA, purpose: "jira-webhook-secret", value: secret });
    expect([...store.entries.values()].filter((entry) => entry.value === secret)).toHaveLength(1);
    expect(await test.db.auditEntry.count({ where: { action: "tracker.secret-made", entityId: site2 } })).toBe(1);

    // The first signed delivery: active, the revoked connection's board and ticket move over.
    expect(await activate(site2)).toEqual({ activated: true, resumedBoards: 1 });
    expect(await rowOf(site2)).toMatchObject({ state: "active", firstDeliveryAt: new Date(NOW), activatedAt: new Date(NOW), badSignatureAt: null });
    expect(await boardState(old.boardId)).toEqual({ connectionId: site2, state: { state: "attached" } });
    expect((await test.db.ticket.findUniqueOrThrow({ where: { id: oldTicket.id } })).connectionId).toBe(site2);
    expect((await rowOf(old.connectionId)).resumedIntoId).toBe(site2);
    expect(await test.db.auditEntry.findFirst({ where: { action: "tracker.connected", entityId: site2 }, select: { actorKind: true, data: true } })).toMatchObject({
      data: { kind: "jira", mode: "webhooks", resumedBoards: 1 },
    });
    // After it, the secret is never shown again, and a second delivery activates nothing more.
    expect(await jiraWebhookOf(jiraDeps(admin), { connectionId: site2 })).toMatchObject({ ok: true, webhook: { mode: "webhooks", secret: null, firstDeliveryAt: NOW } });
    expect(await activate(site2)).toEqual({ activated: false, resumedBoards: 0 });
  });

  it("F-008/c1: finishJiraPolling activates the connection without a secret, and Use polling instead drops one", async () => {
    // No public address: step 3 is polling, and nothing makes a secret.
    const polled = await connectJira({ core: null });
    expect(await rowOf(polled.connectionId)).toMatchObject({ webhookMode: "polling" });
    expect(await jiraWebhookOf(jiraDeps(admin, null), { connectionId: polled.connectionId })).toEqual({ ok: true, connectionId: polled.connectionId, webhook: { mode: "polling", reason: "private-network" } });
    expect(await finishJiraPolling(jiraDeps(admin, null), { connectionId: polled.connectionId })).toEqual({ ok: true, connectionId: polled.connectionId, mode: "polling", resumedBoards: 0 });
    expect(await rowOf(polled.connectionId)).toMatchObject({ state: "active", webhookMode: "polling", webhookSecretSecretRef: null, firstDeliveryAt: null, activatedAt: new Date(NOW) });
    expect(await test.db.auditEntry.findFirst({ where: { action: "tracker.connected", entityId: polled.connectionId }, select: { data: true } })).toEqual({ data: { kind: "jira", mode: "polling", resumedBoards: 0 } });
    expect(await finishJiraPolling(jiraDeps(admin, null), { connectionId: polled.connectionId })).toMatchObject({ ok: false, error: "not-pending" });

    // Webhooks were possible, a secret was made, and the admin chose polling: the secret goes.
    const chose = await connectJira();
    await secretOf(chose.connectionId);
    const secretRef = (await rowOf(chose.connectionId)).webhookSecretSecretRef;
    expect(store.has(secretRef)).toBe(true);
    expect(await finishJiraPolling(jiraDeps(admin), { connectionId: chose.connectionId })).toMatchObject({ ok: true, mode: "polling" });
    expect(await rowOf(chose.connectionId)).toMatchObject({ state: "active", webhookMode: "polling", webhookSecretSecretRef: null });
    expect(store.has(secretRef)).toBe(false);
    // A polling connection has no secret to rotate.
    expect(await rotateJiraSecret(jiraDeps(admin), { connectionId: chose.connectionId })).toMatchObject({ ok: false, error: "polling" });
  });

  it("F-008/c1: step 1 again with another site clears steps 2 and 3", async () => {
    const first = await connectJira();
    await secretOf(first.connectionId);
    const before = await rowOf(first.connectionId);
    const other = `other-${unique()}`;
    fake.site(other, { cloudId: `cloud-${other}` });
    expect(await findJiraSite(jiraDeps(admin), { connectionId: first.connectionId, site: other })).toMatchObject({ ok: true, cleared: true, cloudId: `cloud-${other}` });
    expect(await rowOf(first.connectionId)).toMatchObject({ accessTokenSecretRef: null, webhookSecretSecretRef: null, accountEmail: null, tokenExpiresOn: null, accessCheck: null, appUserId: null, scopes: [] });
    expect(store.has(before.accessTokenSecretRef)).toBe(false);
    expect(store.has(before.webhookSecretSecretRef)).toBe(false);
  });
});

// ---------- F-008/c2: the token goes to the store and the kit only ----------

describe("The token's reach (F-008/c2)", () => {
  it("F-008/c2: the token reaches the secret store and the kit only: never a returned value, an audit entry, an error or a log line (searched by value)", async () => {
    const consoleCalls = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method));
    const site = `leak-${unique()}`;
    const { cloudId } = fake.site(site, { cloudId: `cloud-${site}` });
    // Values shaped like text a person pastes: shell syntax and prompt-like words, so a stray
    // interpolation would carry them.
    const first = `ATATT3x$(whoami)-${randomUUID()}-ignore previous instructions`;
    const second = `ATATT3x;rm -rf /;-${randomUUID()}`;
    const person = `ATATT3x-person-${randomUUID()}`;
    fake.token(first, { cloudId });
    fake.token(second, { cloudId });
    fake.token(person, { cloudId, profile: "person" });

    const outputs: unknown[] = [];
    const errors: string[] = [];
    const connectionId = await startJira();
    outputs.push(await findJiraSite(jiraDeps(admin), { connectionId, site }));
    outputs.push(await checkJiraToken(jiraDeps(admin), { connectionId, email: EMAIL, token: first, expiresOn: EXPIRES }));
    outputs.push(await saveJiraToken(jiraDeps(admin), { connectionId, email: EMAIL, token: person, expiresOn: EXPIRES }));
    // The store refuses: the error names the purpose and the store's code, never the token.
    store.refuseNextPut = true;
    await saveJiraToken(jiraDeps(admin), { connectionId, email: EMAIL, token: first, expiresOn: EXPIRES }).then(
      (value) => outputs.push(value),
      (error: unknown) => errors.push(error instanceof Error ? `${error.message}\n${String(error.stack)}` : String(error)),
    );
    expect(errors).toHaveLength(1);
    outputs.push(await saveJiraToken(jiraDeps(admin), { connectionId, email: EMAIL, token: first, expiresOn: EXPIRES }));
    outputs.push(await jiraWebhookOf(jiraDeps(admin), { connectionId }));
    outputs.push(await activate(connectionId));
    outputs.push(await recheckJiraToken(jiraDeps(admin), { connectionId }));
    outputs.push(await replaceJiraToken(jiraDeps(admin), { connectionId, email: EMAIL, token: person, expiresOn: EXPIRES }));
    outputs.push(await replaceJiraToken(jiraDeps(admin), { connectionId, email: EMAIL, token: "unknown-to-jira-token", expiresOn: EXPIRES }));
    outputs.push(await replaceJiraToken(jiraDeps(admin), { connectionId, email: EMAIL, token: second, expiresOn: EXPIRES }));
    outputs.push(await rotateJiraSecret(jiraDeps(admin), { connectionId }));
    outputs.push(await renameConnection({ db: test.db, scope: admin, ...ports }, { connectionId, name: "Leak Jira" }));
    const row = await rowOf(connectionId);

    const audit = await test.db.auditEntry.findMany({ where: { organizationId: organizationA } });
    const rows = await test.db.connection.findMany({ where: { organizationId: organizationA } });
    const logged = consoleCalls.flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(" ")));
    const haystacks = { outputs: JSON.stringify(outputs), audit: JSON.stringify(audit), rows: JSON.stringify(rows), jobs: JSON.stringify(enqueued), errors: errors.join("\n"), logged: logged.join("\n") };
    for (const token of [first, second, person]) {
      for (const [where, text] of Object.entries(haystacks)) {
        expect(text.includes(token), `a token is in the ${where}`).toBe(false);
      }
    }
    // It reached the kit, and the store holds the one in use, the replaced one deleted.
    expect(fake.calls.filter((call) => call.method === "checkToken").map((call) => call.token)).toEqual(expect.arrayContaining([first, second, person]));
    expect(store.entries.get(row.accessTokenSecretRef ?? "")).toMatchObject({ purpose: "jira-token", value: second });
    expect(store.values()).not.toContain(first);
    expect(store.values()).not.toContain(person);
  });
});

// ---------- F-008/c8: the token's date, failing, replacing, rotating ----------

describe("A connection's token and secret (F-008/c8)", () => {
  it("F-008/c8: tokenExpiryState is expires-soon from 14 days before the date, and expired on it", () => {
    const day = 86_400_000;
    const on = Date.parse("2027-09-14T00:00:00Z");
    const at = (ms: number) => tokenExpiryState({ tokenExpiresOn: "2027-09-14" }, ms);
    expect(at(on - 15 * day)).toEqual({ state: "healthy" });
    expect(at(on - 14 * day)).toEqual({ state: "expires-soon", days: 14 });
    expect(at(on - 14 * day + 23 * 3_600_000)).toEqual({ state: "expires-soon", days: 14 });
    expect(at(on - 13 * day)).toEqual({ state: "expires-soon", days: 13 });
    expect(at(on - 1)).toEqual({ state: "expires-soon", days: 1 });
    expect(at(on)).toEqual({ state: "expired" });
    expect(at(on + 5 * day)).toEqual({ state: "expired" });
    // The column's `@db.Date` reads the same as the date the admin gave.
    expect(tokenExpiryState({ tokenExpiresOn: new Date("2027-09-14T00:00:00Z") }, on - day)).toEqual({ state: "expires-soon", days: 1 });
    expect(tokenExpiryState({ tokenExpiresOn: null }, on)).toEqual({ state: "healthy" });
  });

  it("F-008/c8: failConnection fails an active connection with its reason, and its boards pause", async () => {
    const connected = await connectJira({ core: null });
    await finishJiraPolling(jiraDeps(admin, null), { connectionId: connected.connectionId });
    const board = await seedBoard(connected.connectionId);
    expect((await boardState(board)).state).toEqual({ state: "attached" });
    const fail = () => test.db.$transaction((tx) => failConnection({ tx, ...ports }, { organizationId: organizationA, connectionId: connected.connectionId, reason: "token-expired" }));
    expect(await fail()).toBe(true);
    expect(await rowOf(connected.connectionId)).toMatchObject({ state: "failed", failedReason: "token-expired" });
    expect((await boardState(board)).state).toEqual({ state: "paused", pausedBy: "failed" });
    expect(await test.db.auditEntry.findFirst({ where: { action: "tracker.failed", entityId: connected.connectionId }, select: { data: true, actorKind: true } })).toEqual({ actorKind: "system", data: { kind: "jira", reason: "token-expired" } });
    // Failed once: it fails no further. A pending connection, or another organization's, doesn't fail.
    expect(await fail()).toBe(false);
    const pending = await startJira();
    expect(await test.db.$transaction((tx) => failConnection({ tx, ...ports }, { organizationId: organizationA, connectionId: pending, reason: "token-refused" }))).toBe(false);
    expect(await test.db.$transaction((tx) => failConnection({ tx, ...ports }, { organizationId: adminB.organizationId, connectionId: connected.connectionId, reason: "token-refused" }))).toBe(false);
  });

  it("F-008/c8: replaceJiraToken runs the read-back first; a failing token leaves the old one, and a passing one fixes a failed connection", async () => {
    const connected = await connectJira({ core: null });
    await finishJiraPolling(jiraDeps(admin, null), { connectionId: connected.connectionId });
    const oldRef = (await rowOf(connected.connectionId)).accessTokenSecretRef;
    // Step 2's save is for a pending connection; a connected one replaces.
    expect(await saveJiraToken(jiraDeps(admin), { connectionId: connected.connectionId, email: EMAIL, token: connected.token, expiresOn: EXPIRES })).toMatchObject({ ok: false, error: "not-pending" });

    const person = `jira-token-${randomUUID()}`;
    fake.token(person, { cloudId: connected.cloudId, profile: "person" });
    events.length = 0;
    expect(await replaceJiraToken(jiraDeps(admin), { connectionId: connected.connectionId, email: EMAIL, token: person, expiresOn: EXPIRES })).toMatchObject({ ok: false, error: "token-failed" });
    // The read-back ran, and nothing was stored.
    expect(events).toEqual(["check"]);
    expect((await rowOf(connected.connectionId)).accessTokenSecretRef).toBe(oldRef);
    expect(store.has(oldRef)).toBe(true);

    // The date passed: failed. A new token that reads back makes it active again, its boards with it.
    const board = await seedBoard(connected.connectionId);
    await test.db.$transaction((tx) => failConnection({ tx, ...ports }, { organizationId: organizationA, connectionId: connected.connectionId, reason: "token-expired" }));
    const fresh = `jira-token-${randomUUID()}`;
    fake.token(fresh, { cloudId: connected.cloudId });
    events.length = 0;
    expect(await replaceJiraToken(jiraDeps(admin), { connectionId: connected.connectionId, email: EMAIL, token: fresh, expiresOn: "2028-01-31" })).toMatchObject({ ok: true, verdict: "pass", state: "active" });
    expect(events).toEqual(["check", "put:jira-token"]);
    const replaced = await rowOf(connected.connectionId);
    expect(replaced).toMatchObject({ state: "active", failedReason: null, tokenExpiresOn: new Date("2028-01-31T00:00:00Z") });
    expect(store.entries.get(replaced.accessTokenSecretRef ?? "")?.value).toBe(fresh);
    expect(store.has(oldRef)).toBe(false);
    expect((await boardState(board)).state).toEqual({ state: "attached" });
    expect(await test.db.auditEntry.count({ where: { action: "tracker.token-replaced", entityId: connected.connectionId } })).toBe(1);
  });

  it("F-008/c8: recheckJiraToken reads back with the saved token, and Jira refusing it fails the connection", async () => {
    const connected = await connectJira({ core: null });
    await finishJiraPolling(jiraDeps(admin, null), { connectionId: connected.connectionId });
    expect(await recheckJiraToken(jiraDeps(admin), { connectionId: connected.connectionId })).toMatchObject({ ok: true, verdict: "pass", state: "active" });
    expect(fake.calls.at(-1)).toEqual({ method: "checkToken", cloudId: connected.cloudId, email: EMAIL, token: connected.token });
    expect(await test.db.auditEntry.count({ where: { action: "tracker.token-checked", entityId: connected.connectionId } })).toBe(1);
    // Revoked at admin.atlassian.com: Check again finds it refused, and the connection fails.
    fake.token(connected.token, { cloudId: connected.cloudId, profile: "refused-401" });
    expect(await recheckJiraToken(jiraDeps(admin), { connectionId: connected.connectionId })).toMatchObject({ ok: true, readBack: { kind: "refused", status: 401 }, state: "failed" });
    expect(await rowOf(connected.connectionId)).toMatchObject({ state: "failed", failedReason: "token-refused" });
    // Taken again, Check again makes it active.
    fake.token(connected.token, { cloudId: connected.cloudId });
    expect(await recheckJiraToken(jiraDeps(admin), { connectionId: connected.connectionId })).toMatchObject({ ok: true, state: "active" });
  });

  it("F-008/c8: rotateJiraSecret makes a new secret, and the old one no longer verifies", async () => {
    const connected = await connectJira();
    const old = await secretOf(connected.connectionId);
    await activate(connected.connectionId);
    const oldRef = (await rowOf(connected.connectionId)).webhookSecretSecretRef;
    expect(await verifiesUnderStored(connected.connectionId, old)).toBe(true);
    await test.db.connection.update({ where: { id: connected.connectionId }, data: { badSignatureAt: new Date(NOW) } });

    const rotated = await rotateJiraSecret(jiraDeps(admin), { connectionId: connected.connectionId });
    if (!rotated.ok) throw new Error(rotated.message);
    expect(rotated.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rotated.secret).not.toBe(old);
    expect(await verifiesUnderStored(connected.connectionId, old)).toBe(false);
    expect(await verifiesUnderStored(connected.connectionId, rotated.secret)).toBe(true);
    expect(store.has(oldRef)).toBe(false);
    expect(await rowOf(connected.connectionId)).toMatchObject({ badSignatureAt: null });
    // Answered that once: after the first delivery, step 3 never shows it.
    expect(await jiraWebhookOf(jiraDeps(admin), { connectionId: connected.connectionId })).toMatchObject({ ok: true, webhook: { secret: null } });
    const entry = await test.db.auditEntry.findFirst({ where: { action: "tracker.secret-rotated", entityId: connected.connectionId }, select: { data: true } });
    expect(entry).toEqual({ data: { kind: "jira", firstDelivery: true } });
    expect(JSON.stringify(entry)).not.toContain(rotated.secret);
  });
});

// ---------- F-152: rename, disconnect, one per workspace ----------

describe("A connection's changes (F-152)", () => {
  it("F-152/c1: renameConnection renames a connection of any kind, refuses a name another holds, and audits no name", async () => {
    const one = await connectJira();
    const two = await connectJira();
    const twoName = (await rowOf(two.connectionId)).name ?? "";
    expect(await renameConnection({ db: test.db, scope: admin, ...ports }, { connectionId: one.connectionId, name: "  Globex Production  " })).toEqual({ ok: true, connectionId: one.connectionId, name: "Globex Production" });
    expect((await rowOf(one.connectionId)).name).toBe("Globex Production");
    expect(await renameConnection({ db: test.db, scope: admin, ...ports }, { connectionId: one.connectionId, name: twoName.toUpperCase() })).toMatchObject({ ok: false, error: "name-taken" });
    expect(await renameConnection({ db: test.db, scope: admin, ...ports }, { connectionId: one.connectionId, name: "   " })).toMatchObject({ ok: false, error: "invalid-name" });
    expect(await test.db.auditEntry.findFirst({ where: { action: "tracker.renamed", entityId: one.connectionId }, select: { data: true } })).toEqual({ data: { kind: "jira" } });
    // Another organization's connection isn't found.
    expect(await renameConnection({ db: test.db, scope: adminB, ...ports }, { connectionId: one.connectionId, name: "Theirs" })).toMatchObject({ ok: false, error: "no-connection" });
  });

  it("F-152/c5: disconnectTracker deletes every secret of a Jira and of a Linear connection, sets each revoked, and their boards read paused", async () => {
    // Jira: its token and its webhook secret.
    const jira = await connectJira();
    await secretOf(jira.connectionId);
    await activate(jira.connectionId);
    const jiraBoard = await seedBoard(jira.connectionId);
    const jiraRow = await rowOf(jira.connectionId);
    expect(store.has(jiraRow.accessTokenSecretRef) && store.has(jiraRow.webhookSecretSecretRef)).toBe(true);
    expect(await disconnectTracker(changeDeps(admin), { connectionId: jira.connectionId })).toEqual({ ok: true, connectionId: jira.connectionId, kind: "jira", revokedAtTracker: false });
    expect(await rowOf(jira.connectionId)).toMatchObject({ state: "revoked", appId: `revoked:${jira.connectionId}`, accessTokenSecretRef: null, webhookSecretSecretRef: null, externalWorkspaceId: jira.cloudId });
    expect(store.has(jiraRow.accessTokenSecretRef) || store.has(jiraRow.webhookSecretSecretRef)).toBe(false);
    expect(await boardState(jiraBoard)).toEqual({ connectionId: jira.connectionId, state: { state: "paused", pausedBy: "disconnected" } });
    expect(await test.db.auditEntry.findFirst({ where: { action: "tracker.disconnected", entityId: jira.connectionId }, select: { data: true } })).toEqual({
      data: { kind: "jira", boards: 1, sessions: 0, revokedAtTracker: false },
    });
    // Disconnected once: there's nothing left to disconnect.
    expect(await disconnectTracker(changeDeps(admin), { connectionId: jira.connectionId })).toMatchObject({ ok: false, error: "no-connection" });

    // Linear: its four secrets, a pending OAuth state's verifier, and an open agent session.
    const put = async (purpose: string) => {
      const stored = await store.put({ organizationId: organizationA, purpose }, `${purpose}-${randomUUID()}`);
      if (!stored.ok) throw new Error("the store refused");
      return stored.value;
    };
    const [access, refresh, client, webhook, verifier] = [await put("linear-access-token"), await put("linear-refresh-token"), await put("linear-client-secret"), await put("linear-webhook-secret"), await put("linear-pkce-verifier")];
    const accessValue = store.entries.get(access)?.value;
    const refreshValue = store.entries.get(refresh)?.value;
    const linearRow = await test.db.connection.create({
      data: {
        organizationId: organizationA,
        kind: "linear",
        name: `Acme Linear ${unique()}`,
        appId: `client-${randomUUID()}`,
        state: "active",
        credentialKind: "app_oauth",
        externalWorkspaceId: `ws-${randomUUID()}`,
        accessTokenSecretRef: access,
        refreshTokenSecretRef: refresh,
        clientSecretSecretRef: client,
        webhookSecretSecretRef: webhook,
      },
      select: { id: true },
    });
    const linear = connectionIdSchema.parse(linearRow.id);
    await test.db.oAuthState.create({
      data: { organizationId: organizationA, connectionId: linear, stateHash: randomUUID(), codeVerifierSecretRef: verifier, memberId: admin.memberId, authSessionId: "session", expiresAt: new Date(NOW + 60_000) },
    });
    const session = await test.db.agentSession.create({
      data: { organizationId: organizationA, connectionId: linear, externalSessionId: `session-${unique()}`, creatorExternalId: "user-1", creatorName: "Sam", state: "active" },
      select: { id: true },
    });
    const linearBoard = await seedBoard(linear, `team-${unique()}`);
    expect(await disconnectTracker(changeDeps(admin), { connectionId: linear })).toEqual({ ok: true, connectionId: linear, kind: "linear", revokedAtTracker: true });
    // Revoked at Linear first, then every secret deleted.
    expect(linearRevoked).toEqual(expect.arrayContaining([accessValue, refreshValue]));
    for (const ref of [access, refresh, client, webhook, verifier]) expect(store.has(ref)).toBe(false);
    expect(await rowOf(linear)).toMatchObject({ state: "revoked", appId: `revoked:${linear}`, accessTokenSecretRef: null, refreshTokenSecretRef: null, clientSecretSecretRef: null, webhookSecretSecretRef: null });
    expect(await test.db.oAuthState.count({ where: { connectionId: linear } })).toBe(0);
    expect(await test.db.agentSession.findUniqueOrThrow({ where: { id: session.id }, select: { state: true, endedAt: true } })).toEqual({ state: "ended", endedAt: new Date(NOW) });
    expect((await boardState(linearBoard)).state).toEqual({ state: "paused", pausedBy: "disconnected" });
    expect(await test.db.auditEntry.findFirst({ where: { action: "tracker.disconnected", entityId: linear }, select: { data: true } })).toEqual({
      data: { kind: "linear", boards: 1, sessions: 1, revokedAtTracker: true },
    });
  });

  /** Starts a Linear connection and takes it through its values and Linear's consent, for a workspace. */
  const authorizeNewLinear = async (workspace: { readonly id: string; readonly name: string }) => {
    linearIdentity = { appUserId: "app-user", appUserName: "ostra", workspaceId: workspace.id, workspaceKey: workspace.name.toLowerCase(), workspaceName: workspace.name };
    const started = await startTrackerConnection(changeDeps(admin), { kind: "linear" });
    if (!started.ok) throw new Error(started.message);
    const connectionId = started.connectionId;
    const linearDeps = { scope: admin, corePublicUrl: CORE, publicUrl: PUBLIC, linear: linearKit, authSessionId: "session-1", adapters: { secretStore: store }, ...ports };
    const connected = await test.db.$transaction((tx) =>
      connectLinear({ ...linearDeps, tx }, { connectionId, clientId: `client-${randomUUID()}`, clientSecret: `client-secret-${randomUUID()}`, webhookSecret: `signing-secret-${randomUUID()}` }),
    );
    if (!connected.ok) throw new Error(connected.message);
    const pending = await rowOf(connectionId);
    const state = new URL(connected.authorizeUrl).searchParams.get("state") ?? "";
    const verifierRefs = (await test.db.oAuthState.findMany({ where: { connectionId }, select: { codeVerifierSecretRef: true } })).map((row) => row.codeVerifierSecretRef);
    const result = await authorizeLinear({ ...linearDeps, db: test.db }, { code: "code-from-linear", state });
    return { connectionId, pending, verifierRefs, result };
  };

  it("F-152/c2: a Linear authorization on a workspace another connection holds is refused, naming it, with the pending row's secrets deleted", async () => {
    const workspaceId = `ws-acme-${unique()}`;
    const holder = await test.db.connection.create({
      data: { organizationId: organizationA, kind: "linear", name: `Acme Linear ${unique()}`, appId: `client-${randomUUID()}`, state: "active", credentialKind: "app_oauth", externalWorkspaceId: workspaceId },
      select: { id: true, name: true },
    });
    const refused = await authorizeNewLinear({ id: workspaceId, name: "Acme" });
    expect(refused.result).toEqual({
      ok: false,
      error: "workspace-taken",
      message: `The Linear workspace Acme is already connected, as ${String(holder.name)}.`,
      holder: { id: holder.id, name: holder.name },
    });
    // The pending row's values are gone from the store, and the token Linear gave is given back.
    for (const ref of [refused.pending.clientSecretSecretRef, refused.pending.webhookSecretSecretRef, ...refused.verifierRefs]) expect(store.has(ref)).toBe(false);
    expect(linearRevoked).toContain(linearExchanged.at(-1));
    expect(await rowOf(refused.connectionId)).toMatchObject({ state: "pending", appId: `pending:${refused.connectionId}`, clientSecretSecretRef: null, webhookSecretSecretRef: null, accessTokenSecretRef: null, externalWorkspaceId: null });
    expect(await rowOf(connectionIdSchema.parse(holder.id))).toMatchObject({ state: "active", externalWorkspaceId: workspaceId });

    // Another workspace connects, and its placeholder name becomes the workspace's.
    const accepted = await authorizeNewLinear({ id: `ws-newco-${unique()}`, name: `Newco${unique()}` });
    expect(accepted.result).toMatchObject({ ok: true, resumedBoards: 0 });
    const row = await rowOf(accepted.connectionId);
    expect(row).toMatchObject({ state: "active", name: `${String(row.externalWorkspaceName)} Linear` });
    expect(await test.db.auditEntry.findFirst({ where: { action: "tracker.connected", entityId: accepted.connectionId }, select: { data: true } })).toEqual({ data: { kind: "linear", mode: "webhooks", resumedBoards: 0 } });
  });

  it("F-152/c5: a Linear workspace a revoked connection held, authorized again, resumes its boards", async () => {
    const workspaceId = `ws-resume-${unique()}`;
    const old = await seedRevoked("linear", workspaceId);
    expect((await boardState(old.boardId)).state).toEqual({ state: "paused", pausedBy: "disconnected" });
    const again = await authorizeNewLinear({ id: workspaceId, name: "Resumed" });
    expect(again.result).toMatchObject({ ok: true, resumedBoards: 1 });
    expect(await boardState(old.boardId)).toEqual({ connectionId: again.connectionId, state: { state: "attached" } });
    expect((await rowOf(old.connectionId)).resumedIntoId).toBe(again.connectionId);
  });

  it("F-152/c3: a member who isn't an organization admin is refused every use case, and jiraWebhookOf never answers a secret to one", async () => {
    const connected = await connectJira();
    const secret = await secretOf(connected.connectionId);
    const connectionId = connected.connectionId;
    const callsBefore = fake.calls.length;
    const token = { connectionId, email: EMAIL, token: connected.token, expiresOn: EXPIRES };
    const asMember = jiraDeps(member);
    const results = [
      await startTrackerConnection(changeDeps(member), { kind: "jira" }),
      await startTrackerConnection(changeDeps(member), { kind: "linear" }),
      await findJiraSite(asMember, { connectionId, site: connected.site }),
      await checkJiraToken(asMember, token),
      await saveJiraToken(asMember, token),
      await replaceJiraToken(asMember, token),
      await recheckJiraToken(asMember, { connectionId }),
      await jiraWebhookOf(asMember, { connectionId }),
      await finishJiraPolling(asMember, { connectionId }),
      await rotateJiraSecret(asMember, { connectionId }),
      await renameConnection({ db: test.db, scope: member, ...ports }, { connectionId, name: "Mine" }),
      await disconnectTracker(changeDeps(member), { connectionId }),
    ];
    for (const result of results) expect(result).toMatchObject({ ok: false, error: "forbidden" });
    expect(JSON.stringify(results)).not.toContain(secret);
    // Nothing reached Jira for them, and nothing changed.
    expect(fake.calls).toHaveLength(callsBefore);
    const after = await rowOf(connectionId);
    expect(after.state).toBe("pending");
    expect(after.name).not.toBe("Mine");
    // Another organization's admin finds nothing: no secret crosses organizations either.
    const theirs = await jiraWebhookOf(jiraDeps(adminB), { connectionId });
    expect(theirs).toMatchObject({ ok: false, error: "no-connection" });
    expect(JSON.stringify(theirs)).not.toContain(secret);
    // The admin still reads it, while no delivery has come.
    expect(await jiraWebhookOf(jiraDeps(admin), { connectionId })).toMatchObject({ ok: true, webhook: { secret } });
  });
});
