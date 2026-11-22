import { repoFullNameSchema } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// F-136/c12 (ADR 0065): a team whose repos are all in its App owner's account sets up GitHub as it
// did before milestone 4 (F-006). It answers no new question, links nothing by hand, and nothing
// waits on the GitHub page: the App is created from the manifest, private by default, installed on
// its owner's own account, and that installation's repos are offered and make a project.

const OWNER = { login: "acme-co", accountId: "4200" };
const PERMISSIONS = { checks: "write", actions: "read", contents: "write", pull_requests: "write", metadata: "read" } as const;
const created = {
  appId: "5830001",
  privateKey: "-----BEGIN RSA PRIVATE KEY-----\nONE-ACCOUNT-KEY-0123456789\n-----END RSA PRIVATE KEY-----",
  slug: "ostra-org-a",
  name: "ostra-org-a",
  webhookSecret: "whsec-one-account-0123",
  clientId: "Iv1.oneaccount",
  clientSecret: "one-account-client-secret",
};
const repo = (id: string, fullName: string) => ({ hostRepoId: id, fullName, defaultBranch: "main", private: true, cloneUrl: `https://github.example/${fullName}.git` });

let harness: ApiHarness;

beforeAll(async () => {
  harness = await createApiHarness();
  const host = harness.fakes.codeHost;
  // The App GitHub makes from the manifest: owned by acme-co, installed nowhere yet.
  host.apps.set(created.appId, {
    privateKey: created.privateKey,
    info: { appId: created.appId, slug: created.slug, name: created.name, permissions: PERMISSIONS, events: [], owner: OWNER },
    bot: { name: `${created.slug}[bot]`, email: `7+${created.slug}[bot]@users.noreply.github.com` },
    installations: [],
    repos: new Map(),
  });
  host.manifestCodes.set("one-account-code", created);
  for (const name of ["acme-co/web", "acme-co/api"]) {
    host.files.set(name, new Map([["package.json", "{}"]]));
  }
});

afterAll(async () => {
  await harness.dispose();
});

describe("F-136: a team whose repos are all in one GitHub account", () => {
  it("F-136/c12: sets up GitHub as before: the manifest flow with no new answer, its owner's installation linked when seen, its repos offered and a project made, and nothing waiting", async () => {
    const { a } = harness.fixture;
    const admin = await harness.as(a.admin);
    const host = harness.fakes.codeHost;

    // The manifest flow as F-006 has it: the admin names the account and answers nothing about other accounts.
    const started = await admin.github.startManifest({ ownerLogin: OWNER.login });
    expect(host.manifests.at(-1)).toMatchObject({ ownerLogin: OWNER.login, public: false });
    const connected = await admin.github.completeManifest({ code: "one-account-code", state: started.state });
    expect(connected.slug).toBe(created.slug);

    // The admin installs the App on its owner's own account, on GitHub.
    const app = host.apps.get(created.appId);
    if (app === undefined) throw new Error("the fake has no such App");
    host.apps.set(created.appId, {
      ...app,
      installations: [{ installationId: "9301", accountLogin: OWNER.login, accountId: OWNER.accountId, accountKind: "organization", repositorySelection: "all" }],
      repos: new Map([["9301", [repo("31", "acme-co/web"), repo("32", "acme-co/api")]]]),
    });

    // ostra sees the installation and links it itself: no admin links it.
    expect(await admin.github.installations()).toEqual([{ installationId: "9301", accountLogin: OWNER.login, accountKind: "organization", repositorySelection: "all" }]);
    expect(await harness.test.db.codeHostInstallation.findMany({ where: { organizationId: a.organization.id }, select: { installationId: true, state: true, linkedByMemberId: true } })).toEqual([
      { installationId: "9301", state: "linked", linkedByMemberId: null },
    ]);

    // Its repos are offered, and a project is made from them, as before.
    expect((await admin.github.repos({ installationId: "9301" })).map((offered) => offered.fullName)).toEqual(["acme-co/web", "acme-co/api"]);
    const project = await admin.projects.create({
      name: "Acme",
      slug: "acme",
      access: "open",
      repo: { connectionId: connected.connectionId, installationId: "9301", fullName: repoFullNameSchema.parse("acme-co/web") },
      moreRepos: [{ connectionId: connected.connectionId, installationId: "9301", fullName: repoFullNameSchema.parse("acme-co/api") }],
    });
    expect((await admin.projects.get({ projectId: project.projectId })).repos.map((held) => [held.fullName, held.installation])).toEqual([
      ["acme-co/web", { accountLogin: OWNER.login, accountKind: "organization", state: "linked" }],
      ["acme-co/api", { accountLogin: OWNER.login, accountKind: "organization", state: "linked" }],
    ]);

    // The GitHub page holds the one App, installed by no other account, with its one installation
    // linked and nothing waiting.
    const views = await admin.github.connections();
    expect(views.map((view) => [view.connectionId, view.own, view.public, view.ownerLogin])).toEqual([[connected.connectionId, true, null, OWNER.login]]);
    expect(views[0]?.installations.map((installation) => [installation.installationId, installation.state, installation.isOwner, installation.installedBy])).toEqual([["9301", "linked", true, null]]);
    // No admin linked or removed anything on the way.
    expect(await harness.test.db.auditEntry.count({ where: { organizationId: a.organization.id, action: { in: ["installation.linked", "installation.unlinked", "installation.removed"] }, actorKind: "member" } })).toBe(0);
  });
});
