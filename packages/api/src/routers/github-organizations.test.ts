import { secretRefSchema } from "@ostra/adapter-sdk";
import { repoFullNameSchema } from "@ostra/protocol";
import type { ConnectionId, ProjectId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness } from "../testing/index.ts";
import type { ApiHarness, AppCaller } from "../testing/index.ts";

// F-136 (ticket 51; ADR 0065): GitHub organizations, installations and several Apps through the
// panel's API, proved with the fake GitHub's second account and a stranger's installation (the
// live run with a second test org is ticket 55, the maintainer's). A waiting installation's repos
// are offered nowhere; link, unlink and remove are an organization admin's, each an audit entry;
// two Apps each have their own webhook address; a generated webhook secret is shown once; and the
// manifest flow takes `public`.

const PEM_OWN = "-----BEGIN RSA PRIVATE KEY-----\nOWN-APP-KEY-0123456789\n-----END RSA PRIVATE KEY-----";
const PEM_CLIENT = "-----BEGIN RSA PRIVATE KEY-----\nCLIENT-APP-KEY-0123456789\n-----END RSA PRIVATE KEY-----";
const OWN_SECRET = "whsec-own-app-0123456789";
const PERMISSIONS = { checks: "write", actions: "read", contents: "write", pull_requests: "write", metadata: "read" } as const;
const repo = (id: string, fullName: string) => ({ hostRepoId: id, fullName, defaultBranch: "main", private: true, cloneUrl: `https://github.example/${fullName}.git` });

let harness: ApiHarness;
let own: ConnectionId;
let client: ConnectionId;
let clientSecret: string | null;
let projectId: ProjectId;

const admin = (): Promise<AppCaller> => harness.as(harness.fixture.a.admin);

beforeAll(async () => {
  harness = await createApiHarness();
  const host = harness.fakes.codeHost;
  // The organization's own App, on ostra-test, installed there and by a stranger it made it public for.
  host.apps.set("5001", {
    privateKey: PEM_OWN,
    info: { appId: "5001", slug: "ostra-own", name: "ostra own", permissions: PERMISSIONS, events: [], owner: { login: "ostra-test", accountId: "100" } },
    bot: { name: "ostra-own[bot]", email: "1+ostra-own[bot]@users.noreply.github.com" },
    installations: [
      { installationId: "9001", accountLogin: "ostra-test", accountId: "100", accountKind: "organization", repositorySelection: "all" },
      { installationId: "9002", accountLogin: "stranger-co", accountId: "200", accountKind: "organization", repositorySelection: "selected" },
    ],
    repos: new Map([
      ["9001", [repo("1", "ostra-test/test1"), repo("2", "ostra-test/test2")]],
      ["9002", [repo("50", "stranger-co/secret-sauce")]],
    ]),
  });
  // A client's own App, on client-b.
  host.apps.set("6001", {
    privateKey: PEM_CLIENT,
    info: { appId: "6001", slug: "client-b-ostra", name: "client b ostra", permissions: PERMISSIONS, events: [], owner: { login: "client-b", accountId: "300" } },
    bot: { name: "client-b-ostra[bot]", email: "2+client-b-ostra[bot]@users.noreply.github.com" },
    installations: [{ installationId: "9101", accountLogin: "client-b", accountId: "300", accountKind: "organization", repositorySelection: "all" }],
    repos: new Map([["9101", [repo("70", "client-b/testb1")]]]),
  });
  for (const name of ["ostra-test/test1", "ostra-test/test2", "stranger-co/secret-sauce", "client-b/testb1"]) {
    host.files.set(name, new Map([["package.json", "{}"]]));
  }
  const caller = await admin();
  const first = await caller.github.connectExisting({ appId: "5001", privateKey: PEM_OWN, webhookSecret: OWN_SECRET });
  own = first.connectionId;
  expect(first.webhookSecret).toBeNull();
  const second = await caller.github.connectExisting({ appId: "6001", privateKey: PEM_CLIENT });
  client = second.connectionId;
  clientSecret = second.webhookSecret;
  // A project on the own App's own installation.
  const created = await caller.projects.create({ name: "Own", slug: "own", access: "open", repo: { connectionId: own, installationId: "9001", fullName: repoFullNameSchema.parse("ostra-test/test1") } });
  projectId = created.projectId;
});

afterAll(async () => {
  await harness.dispose();
});

const connectionsNow = async () => (await admin()).github.connections();

describe("F-136: GitHub organizations in the API", () => {
  it("F-136: two Apps are listed, the organization's own first, each with its own webhook address and its installations", async () => {
    const views = await connectionsNow();
    expect(views.map((view) => [view.connectionId, view.slug, view.ownerLogin, view.own])).toEqual([
      [own, "ostra-own", "ostra-test", true],
      [client, "client-b-ostra", "client-b", false],
    ]);
    const core = harness.deps.settings.corePublicUrl;
    expect(views.map((view) => view.webhookUrl)).toEqual([`${core}/webhooks/github/${own}`, `${core}/webhooks/github/${client}`]);
    expect(new Set(views.map((view) => view.webhookUrl)).size).toBe(2);
    expect(views.every((view) => view.webhook.kind === "receiving")).toBe(true);
    const [ownView, clientView] = views;
    // The owner's own installations are linked when seen; the stranger's waits.
    expect(ownView?.installations.map((installation) => [installation.installationId, installation.accountLogin, installation.state, installation.isOwner])).toEqual([
      ["9001", "ostra-test", "linked", true],
      ["9002", "stranger-co", "waiting", false],
    ]);
    expect(ownView?.installations[0]?.projects).toEqual([{ projectId, name: "Own" }]);
    expect(ownView?.installations[0]?.repos.map((repo) => repo.fullName)).toEqual(["ostra-test/test1", "ostra-test/test2"]);
    expect(ownView?.public).toBe(true);
    expect(clientView?.installations.map((installation) => [installation.installationId, installation.state, installation.isOwner])).toEqual([["9101", "linked", true]]);
    expect(clientView?.ownerKind).toBe("organization");
  });

  it("F-136: a waiting installation's repos are offered nowhere, and projects.addRepo and projects.create refuse them", async () => {
    const caller = await admin();
    const views = await connectionsNow();
    expect(views[0]?.installations.find((installation) => installation.installationId === "9002")?.repos).toEqual([]);
    await expect(caller.github.repos({ connectionId: own, installationId: "9002" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "This installation isn't linked" });
    await expect(caller.github.detect({ connectionId: own, installationId: "9002", fullName: repoFullNameSchema.parse("stranger-co/secret-sauce"), ref: "main" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const offered = await caller.github.reposByAccount();
    expect(offered.map((group) => [group.accountLogin, group.repos.map((repo) => repo.fullName)])).toEqual([
      ["client-b", ["client-b/testb1"]],
      ["ostra-test", ["ostra-test/test1", "ostra-test/test2"]],
    ]);
    expect(JSON.stringify(offered)).not.toContain("secret-sauce");
    // A waiting installation's repo is refused as not linked (spec step 15); one no installation lists, as unreachable.
    await expect(caller.projects.addRepo({ projectId, fullName: repoFullNameSchema.parse("stranger-co/secret-sauce") })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "This installation isn't linked",
    });
    await expect(caller.projects.addRepo({ projectId, fullName: repoFullNameSchema.parse("nobody-co/nowhere") })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "The organization's GitHub App can't reach that repo: install it there first",
    });
    await expect(
      caller.projects.create({ name: "Stranger", slug: "stranger", access: "open", repo: { connectionId: own, installationId: "9002", fullName: repoFullNameSchema.parse("stranger-co/secret-sauce") } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await harness.test.db.repo.count({ where: { fullName: "stranger-co/secret-sauce" } })).toBe(0);
    // A client App's own installation offers its repos to a project of this organization.
    const added = await caller.projects.addRepo({ projectId, fullName: repoFullNameSchema.parse("client-b/testb1") });
    expect(await harness.test.db.repo.findUniqueOrThrow({ where: { id: added.repoId }, select: { connectionId: true, installationId: true } })).toEqual({ connectionId: client, installationId: "9101" });
  });

  it("F-136: link, unlink and remove are an organization admin's, each with its audit entry", async () => {
    const { a, b } = harness.fixture;
    const caller = await admin();
    const target = { connectionId: own, installationId: "9002" };
    for (const who of [a.member, a.insider]) {
      const other = await harness.as(who);
      await expect(other.github.linkInstallation(target)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(other.github.unlinkInstallation(target)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(other.github.removeInstallation(target)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(other.github.connections()).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    // Another organization's admin can't reach this organization's Apps.
    const outsider = await harness.as(b.admin);
    await expect(outsider.github.linkInstallation(target)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(outsider.github.removeInstallation(target)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await outsider.github.connections()).toEqual([]);

    const audits = (action: string) => harness.test.db.auditEntry.findMany({ where: { organizationId: a.organization.id, action, entityId: own }, orderBy: { createdAt: "asc" }, select: { actorId: true, data: true } });

    await caller.github.linkInstallation(target);
    expect((await caller.github.repos(target)).map((repo) => repo.fullName)).toEqual(["stranger-co/secret-sauce"]);
    const linkedView = (await connectionsNow())[0]?.installations.find((installation) => installation.installationId === "9002");
    expect(linkedView).toMatchObject({ state: "linked", installedBy: { memberId: a.admin.id } });
    expect((await audits("installation.linked")).filter((entry) => entry.actorId === a.admin.id)).toHaveLength(1);

    await caller.github.unlinkInstallation(target);
    await expect(caller.github.repos(target)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await connectionsNow())[0]?.installations.find((installation) => installation.installationId === "9002")).toMatchObject({ state: "removed", removedBy: { memberId: a.admin.id } });
    const unlinked = await audits("installation.unlinked");
    expect(unlinked.map((entry) => [entry.actorId, JSON.stringify(entry.data)])).toEqual([[a.admin.id, JSON.stringify({ installationId: "9002" })]]);
    // Unlinking what isn't linked is NOT_FOUND.
    await expect(caller.github.unlinkInstallation(target)).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Remove: a failed uninstall on GitHub leaves it linked; then it goes, on GitHub too.
    await caller.github.linkInstallation(target);
    harness.fakes.codeHost.removeInstallationFails = true;
    await expect(caller.github.removeInstallation(target)).rejects.toMatchObject({ code: "BAD_GATEWAY" });
    expect((await caller.github.repos(target)).length).toBe(1);
    harness.fakes.codeHost.removeInstallationFails = false;
    await caller.github.removeInstallation(target);
    expect(harness.fakes.codeHost.removedInstallations).toEqual([{ appId: "5001", installationId: "9002" }]);
    expect((await audits("installation.removed")).map((entry) => entry.actorId)).toEqual([a.admin.id]);
    expect((await connectionsNow())[0]?.installations.find((installation) => installation.installationId === "9002")).toMatchObject({ state: "removed", repoSelection: null, repos: [] });
  });

  it("F-136: the webhook secret ostra generates is shown once, stored in the secret store, and in no view after", async () => {
    expect(clientSecret).toMatch(/^[0-9a-f]{64}$/);
    if (clientSecret === null) {
      throw new Error("a generated secret");
    }
    const row = await harness.test.db.connection.findUniqueOrThrow({ where: { id: client } });
    const ref = secretRefSchema.parse(row.webhookSecretSecretRef);
    const stored = await harness.fakes.secretStore.get(harness.fixture.a.organization.id, ref);
    expect(stored.ok && stored.value).toBe(clientSecret);
    const caller = await admin();
    const views = JSON.stringify([await caller.github.connections(), await caller.github.connection(), await caller.github.reposByAccount()]);
    expect(views).not.toContain(clientSecret);
    expect(views).not.toContain(OWN_SECRET);
    expect(JSON.stringify(row)).not.toContain(clientSecret);
    // Connecting the same App again shows nothing new: it's refused.
    await expect(caller.github.connectExisting({ appId: "6001", privateKey: PEM_CLIENT })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await harness.test.db.auditEntry.count({ where: { organizationId: harness.fixture.a.organization.id, action: "connection.added", entityId: client } })).toBe(1);
  });

  it("F-136: createApp and startManifest take public, private unless the admin says", async () => {
    const caller = await admin();
    const host = harness.fakes.codeHost;
    await caller.github.createApp({ ownerLogin: "ostra-test", public: true });
    expect(host.manifests.at(-1)).toMatchObject({ ownerLogin: "ostra-test", public: true });
    await caller.github.createApp({ ownerLogin: null, public: false });
    expect(host.manifests.at(-1)).toMatchObject({ ownerLogin: null, public: false });
    await caller.github.createApp({ ownerLogin: null });
    expect(host.manifests.at(-1)?.public).toBe(false);
    await caller.github.startManifest({ ownerLogin: null, public: true });
    expect(host.manifests.at(-1)?.public).toBe(true);
    await expect((await harness.as(harness.fixture.a.member)).github.createApp({ ownerLogin: null, public: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
