import { LinearAdapter } from "@ostra/adapter-linear";
import { createFakeLinear } from "@ostra/adapter-sdk/testing";
import type { FakeLinear } from "@ostra/adapter-sdk/testing";
import { repoFullNameSchema } from "@ostra/protocol";
import type { ConnectionId, ProjectId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedLinearConnection } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// F-086/c1: an organization admin creates a project with its repos (linked through the GitHub App),
// its boards (from Linear, or none), one environment, a default agent profile per task kind, and
// the runner pools it may use. The project's repos come in order from the App's installation; its
// boards are Linear teams, the first attached as New project does once the project exists, or none. Against
// the fake GitHub and the fake Linear server through the real Linear adapter.

const APP_ID = "5821077";
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nCREATE-KEY-BODY-0123456789\n-----END RSA PRIVATE KEY-----";
const installationId = "9601";
const repo = (id: string, fullName: string) => ({ hostRepoId: id, fullName, defaultBranch: "main", private: true, cloneUrl: `https://github.example/${fullName}.git` });

let harness: ApiHarness;
let connectionId: ConnectionId;
let fake: FakeLinear;

beforeAll(async () => {
  harness = await createApiHarness();
  harness.fakes.codeHost.apps.set(APP_ID, {
    privateKey: PEM,
    info: { appId: APP_ID, slug: "ostra-create-app", name: "ostra create app", permissions: { checks: "write", actions: "read" }, events: [] },
    bot: { name: "ostra-create-app[bot]", email: "3+ostra-create-app[bot]@users.noreply.github.com" },
    installations: [{ installationId, accountLogin: "ostra-test", accountKind: "organization", repositorySelection: "all" }],
    repos: new Map([[installationId, [repo("61", "ostra-test/web"), repo("62", "ostra-test/api"), repo("63", "ostra-test/docs")]]]),
  });
  for (const name of ["ostra-test/web", "ostra-test/api", "ostra-test/docs"]) {
    harness.fakes.codeHost.files.set(name, new Map([["package.json", "{}"]]));
  }
  const connected = await (await harness.as(harness.fixture.a.admin)).github.connectExisting({ appId: APP_ID, privateKey: PEM, webhookSecret: "whsec-0123456789" });
  connectionId = connected.connectionId;
  fake = await createFakeLinear();
});

afterAll(async () => {
  await fake.close();
  await harness.dispose();
});

const repoInput = (fullName: string) => ({ connectionId, installationId, fullName: repoFullNameSchema.parse(fullName) });

/** What every project starts with: one environment, the built-in profile of each kind and the default pool. */
const expectProjectBasics = async (projectId: ProjectId) => {
  const organizationId = harness.fixture.a.organization.id;
  const project = await harness.test.db.project.findUniqueOrThrow({ where: { id: projectId }, include: { pools: { include: { pool: true } } } });
  expect(await harness.test.db.environment.count({ where: { projectId } })).toBe(1);
  const builtIn = await harness.test.db.agentProfile.findFirstOrThrow({ where: { organizationId, builtIn: true } });
  expect([project.defaultRefineProfileId, project.defaultCodeProfileId, project.defaultReviewProfileId]).toEqual([builtIn.id, builtIn.id, builtIn.id]);
  expect(project.pools.map((link) => [link.pool.isDefault, link.pool.organizationId])).toEqual([[true, organizationId]]);
};

describe("F-086: creating a project", () => {
  it("F-086/c1: an organization admin creates a project with several repos in order and no tracker: no board, one environment, a profile per kind, the default pool", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    const created = await admin.projects.create({
      name: "No tracker",
      slug: "no-tracker",
      access: "open",
      repo: repoInput("ostra-test/web"),
      moreRepos: [repoInput("ostra-test/api"), repoInput("ostra-test/docs")],
    });
    const projectId = created.projectId;
    // Each repo through the App's installation, in the order picked, each in its own folder.
    expect(
      (await harness.test.db.repo.findMany({ where: { projectId }, orderBy: { position: "asc" } })).map((row) => [row.position, row.fullName, row.checkoutDir, row.installationId, row.connectionId]),
    ).toEqual([
      [0, "ostra-test/web", "web", installationId, connectionId],
      [1, "ostra-test/api", "api", installationId, connectionId],
      [2, "ostra-test/docs", "docs", installationId, connectionId],
    ]);
    expect((await admin.projects.get({ projectId })).repos.map((held) => held.fullName)).toEqual(["ostra-test/web", "ostra-test/api", "ostra-test/docs"]);
    // No tracker: the project has no board, and nothing was attached.
    expect((await admin.boards.get({ projectId })).boards).toEqual([]);
    expect(await harness.test.db.board.count({ where: { projectId } })).toBe(0);
    await expectProjectBasics(projectId);
  });

  it("F-086/c1: an organization admin creates a project with Linear teams as its boards, the first attached as New project does once the project exists", async () => {
    const connectionId = await seedLinearConnection(harness);
    const saved = harness.fakes.tracker.adapter;
    harness.fakes.tracker.adapter = new LinearAdapter({ auth: { kind: "api-key", token: fake.adminApiKey }, apiUrl: fake.apiUrl });
    try {
      const admin = await harness.as(harness.fixture.a.admin);
      const ops = fake.addTeam("OPZ", "Ops");
      // New project offers the organization's Linear teams before the project exists.
      const offered = (await admin.boards.teams()).connections.find((group) => group.id === connectionId)?.items ?? [];
      const team = offered.find((candidate) => candidate.key === fake.team.key);
      const second = offered.find((candidate) => candidate.key === ops.key);
      if (team === undefined || second === undefined) throw new Error("the fake Linear's teams aren't offered");
      const created = await admin.projects.create({ name: "With Linear", slug: "with-linear", access: "open", repo: repoInput("ostra-test/web"), moreRepos: [repoInput("ostra-test/api")] });
      const attached = await admin.boards.attach({ projectId: created.projectId, connectionId, externalId: team.externalId });
      // A second team, from the project's Boards page: a project has several boards.
      const alsoAttached = await admin.boards.attach({ projectId: created.projectId, connectionId, externalId: second.externalId });
      // The project's boards are the Linear teams, each with the mapping drafted from its statuses.
      const boards = (await (await harness.as(harness.fixture.a.member)).boards.get({ projectId: created.projectId })).boards;
      expect(boards.map((board) => [board.id, board.key])).toEqual([
        [attached.boardId, fake.team.key],
        [alsoAttached.boardId, ops.key],
      ]);
      expect(attached.mapping.started).toBe(fake.states(fake.team.id).find((state) => state.type === "started")?.id);
      expect(alsoAttached.mapping.started).toBe(fake.states(ops.id).find((state) => state.type === "started")?.id);
      expect((await admin.projects.get({ projectId: created.projectId })).repos.map((held) => held.fullName)).toEqual(["ostra-test/web", "ostra-test/api"]);
      await expectProjectBasics(created.projectId);
      // A member can't make a project, nor attach a board to one.
      const member = await harness.as(harness.fixture.a.member);
      await expect(member.projects.create({ name: "Mine", slug: "mine", access: "open", repo: repoInput("ostra-test/docs") })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(member.boards.attach({ projectId: created.projectId, connectionId, externalId: team.externalId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      harness.fakes.tracker.adapter = saved;
    }
  });
});
