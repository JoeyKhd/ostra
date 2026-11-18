import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, trpcFailure } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// Ticket 31: the GitHub connection routers, against the fake code host. The live case, with the
// real App, is in github.live.test.ts.

const APP_ID = "5821041";
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nFAKE-KEY-BODY-0123456789\n-----END RSA PRIVATE KEY-----";
const WEBHOOK_SECRET = "whsec-0123456789abcdef";
const FULL = { checks: "write", actions: "read", contents: "write", pull_requests: "write", metadata: "read" } as const;

let harness: ApiHarness;

beforeAll(async () => {
  harness = await createApiHarness();
  harness.fakes.codeHost.apps.set(APP_ID, {
    privateKey: PEM,
    info: { appId: APP_ID, slug: "ostra-test-app", name: "ostra test app", permissions: FULL, events: [] },
    bot: { name: "ostra-test-app[bot]", email: "5821041+ostra-test-app[bot]@users.noreply.github.com" },
    installations: [{ installationId: "9001", accountLogin: "ostra-test", accountKind: "organization", repositorySelection: "all" }],
    repos: new Map([
      [
        "9001",
        [
          { hostRepoId: "1", fullName: "ostra-test/test1", defaultBranch: "main", private: true, cloneUrl: "https://github.example/ostra-test/test1.git" },
          { hostRepoId: "2", fullName: "ostra-test/test2", defaultBranch: "main", private: true, cloneUrl: "https://github.example/ostra-test/test2.git" },
        ],
      ],
    ]),
  });
});

afterAll(async () => {
  await harness.dispose();
});

const existing = { appId: APP_ID, privateKey: PEM, webhookSecret: WEBHOOK_SECRET };

describe("github.connectExisting", () => {
  it("is FORBIDDEN to a member, and nothing is stored", async () => {
    await expect((await harness.as(harness.fixture.a.member)).github.connectExisting(existing)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(harness.fakes.secretStore.entries.size).toBe(0);
    expect(await harness.test.db.connection.count()).toBe(0);
  });

  it("names the missing permissions and stores nothing when the App lacks them", async () => {
    harness.fakes.codeHost.apps.set("77", {
      privateKey: PEM,
      info: { appId: "77", slug: "weak", name: "weak", permissions: { contents: "write", actions: "read" }, events: [] },
      bot: { name: "weak[bot]", email: "77+weak[bot]@users.noreply.github.com" },
      installations: [],
      repos: new Map(),
    });
    const admin = await harness.as(harness.fixture.a.admin);
    const refusal = await trpcFailure(admin.github.connectExisting({ appId: "77", privateKey: PEM, webhookSecret: WEBHOOK_SECRET }));
    expect(refusal.code).toBe("BAD_REQUEST");
    expect(refusal.message).toContain("checks: write");
    expect(harness.fakes.secretStore.entries.size).toBe(0);
  });

  it("refuses credentials the host refuses", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    await expect(admin.github.connectExisting({ ...existing, privateKey: "-----BEGIN RSA PRIVATE KEY-----\nWRONG\n-----END RSA PRIVATE KEY-----" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(await harness.test.db.connection.count()).toBe(0);
  });

  it("reads the App, keeps its key and secret in the secret store, and stores the slug and bot identity", async () => {
    const { a } = harness.fixture;
    const connected = await (await harness.as(a.admin)).github.connectExisting(existing);
    expect(connected).toMatchObject({ slug: "ostra-test-app", permissions: FULL });

    const row = await harness.test.db.connection.findUniqueOrThrow({ where: { id: connected.connectionId } });
    expect(row).toMatchObject({
      organizationId: a.organization.id,
      kind: "github",
      appId: APP_ID,
      slug: "ostra-test-app",
      botName: "ostra-test-app[bot]",
    });
    expect(row.botEmail).toContain("[bot]@users.noreply.github.com");
    // References only: neither the key nor the webhook secret is in the row.
    expect(JSON.stringify(row)).not.toContain("FAKE-KEY-BODY");
    expect(JSON.stringify(row)).not.toContain(WEBHOOK_SECRET);
    const values = harness.fakes.secretStore.values();
    expect(values).toEqual(expect.arrayContaining([PEM, WEBHOOK_SECRET]));
    expect(await harness.test.db.auditEntry.count({ where: { action: "github.connected" } })).toBe(1);
    expect(JSON.stringify(await harness.test.db.auditEntry.findMany())).not.toContain("FAKE-KEY-BODY");
  });

  it("is refused a second time (one App per organization), and is invisible to the other organization", async () => {
    const { a, b } = harness.fixture;
    await expect((await harness.as(a.admin)).github.connectExisting(existing)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await (await harness.as(b.admin)).github.connection()).toBeNull();
    expect(await (await harness.as(a.admin)).github.connection()).toMatchObject({ appId: APP_ID, slug: "ostra-test-app", permissions: FULL });
    await expect((await harness.as(a.member)).github.connection()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("github.installations and github.repos", () => {
  it("lists the installation and its repos through the stored credentials", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    expect(await admin.github.installations()).toEqual([
      { installationId: "9001", accountLogin: "ostra-test", accountKind: "organization", repositorySelection: "all" },
    ]);
    const repos = await admin.github.repos({ installationId: "9001" });
    expect(repos.map((repo) => repo.fullName)).toEqual(["ostra-test/test1", "ostra-test/test2"]);
    await expect(admin.github.repos({ installationId: "nope" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("are for admins of an organization that has connected GitHub", async () => {
    const { a, b } = harness.fixture;
    await expect((await harness.as(a.member)).github.installations()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect((await harness.as(a.member)).github.repos({ installationId: "9001" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Organization B has no connection: it can't borrow A's.
    await expect((await harness.as(b.admin)).github.installations()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect((await harness.as(b.admin)).github.repos({ installationId: "9001" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});

describe("the manifest flow", () => {
  const created = {
    appId: "5821099",
    privateKey: "-----BEGIN RSA PRIVATE KEY-----\nMANIFEST-KEY-BODY-9876543210\n-----END RSA PRIVATE KEY-----",
    slug: "ostra-org-b",
    name: "ostra-org-b",
    webhookSecret: "whsec-manifest-secret-0123",
    clientId: "Iv1.manifestclient",
    clientSecret: "manifest-client-secret-abcdef",
  };

  beforeAll(() => {
    harness.fakes.codeHost.apps.set(created.appId, {
      privateKey: created.privateKey,
      info: { appId: created.appId, slug: created.slug, name: created.name, permissions: FULL, events: [] },
      bot: { name: `${created.slug}[bot]`, email: `99+${created.slug}[bot]@users.noreply.github.com` },
      installations: [],
      repos: new Map(),
    });
    harness.fakes.codeHost.manifestCodes.set("good-code", created);
  });

  it("builds the manifest with no webhook for a private address, and says so", async () => {
    const started = await (await harness.as(harness.fixture.b.admin)).github.startManifest({ ownerLogin: "ostra-test" });
    expect(started.webhookEnabled).toBe(false);
    expect(started.createUrl).toContain("github");
    expect(started.note).toContain("OSTRA_CORE_PUBLIC_URL");
    expect(started.manifest).not.toHaveProperty("hook_attributes");
    expect(started.state.length).toBeGreaterThanOrEqual(32);
    // The state is stored hashed, not as given.
    const keys = (await harness.test.db.verification.findMany()).map((row) => row.identifier);
    expect(keys.some((key) => key.includes(started.state))).toBe(false);
  });

  it("includes the webhook when the server's address is public", async () => {
    const context = await harness.contextOf(harness.fixture.b.admin);
    const caller = harness.callerFor({
      ...context,
      deps: { ...context.deps, settings: { ...context.deps.settings, corePublicUrl: "https://ostra.example.com" } },
    });
    const started = await caller.github.startManifest({ ownerLogin: null });
    expect(started).toMatchObject({ webhookEnabled: true, note: null });
    expect(started.manifest).toHaveProperty("hook_attributes");
  });

  it("is for admins", async () => {
    await expect((await harness.as(harness.fixture.b.admin)).github.startManifest({ ownerLogin: null })).resolves.toBeDefined();
    await expect((await harness.as(harness.fixture.a.member)).github.startManifest({ ownerLogin: null })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("can't be completed from another session, even the same admin's", async () => {
    const { b } = harness.fixture;
    const started = await (await harness.as(b.admin)).github.startManifest({ ownerLogin: null });
    const elsewhere = harness.callerFor(await harness.contextOf(b.admin, "another-session"));
    await expect(elsewhere.github.completeManifest({ code: "good-code", state: started.state })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await harness.test.db.connection.count({ where: { organizationId: b.organization.id } })).toBe(0);
    // The refused attempt didn't use the state up: the session that started it can still finish.
    const connected = await (await harness.as(b.admin)).github.completeManifest({ code: "good-code", state: started.state });
    expect(connected.slug).toBe("ostra-org-b");
  });

  it("can't be replayed, and can't cross organizations", async () => {
    const { a, b } = harness.fixture;
    const started = await (await harness.as(a.admin)).github.startManifest({ ownerLogin: null });
    // Organization B's admin presenting A's state.
    await expect((await harness.as(b.admin)).github.completeManifest({ code: "good-code", state: started.state })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // A made-up state, and an unknown one.
    await expect((await harness.as(a.admin)).github.completeManifest({ code: "good-code", state: "x".repeat(40) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("uses the state up: a second completion is refused", async () => {
    const { b } = harness.fixture;
    const admin = await harness.as(b.admin);
    // B is already connected by the earlier test, so this completion fails at the connect step; the state is gone either way.
    const started = await admin.github.startManifest({ ownerLogin: null });
    await expect(admin.github.completeManifest({ code: "good-code", state: started.state })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(admin.github.completeManifest({ code: "good-code", state: started.state })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a state past its time", async () => {
    const { b } = harness.fixture;
    const admin = await harness.as(b.admin);
    const started = await admin.github.startManifest({ ownerLogin: null });
    await harness.test.db.verification.updateMany({
      where: { identifier: { startsWith: "ostra.github-manifest:" } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(admin.github.completeManifest({ code: "good-code", state: started.state })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("stores the manifest App's secrets in the secret store too, and keeps the webhook-less case", async () => {
    expect(harness.fakes.secretStore.values()).toEqual(
      expect.arrayContaining([created.privateKey, created.webhookSecret, created.clientSecret]),
    );
    const row = await harness.test.db.connection.findFirstOrThrow({ where: { organizationId: harness.fixture.b.organization.id } });
    expect(row.clientSecretSecretRef).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain(created.clientSecret);
  });
});
