import { startCliSession } from "@ostra/domain";
import { cliPaths, memberIdSchema, userIdSchema } from "@ostra/protocol";
import type { ProjectId, RepoId } from "@ostra/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { handleCliRequest } from "../services/cli-http.ts";
import { createApiHarness, seedConnectionAndModel, seedProject, seedTask } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// Ticket 49 (F-136, ADR 0065): the panel's own call sites that reach a repo through its App mint
// nothing through an installation that isn't linked: the environment's detection and the CLI's
// clone addresses. Core's call sites are in `apps/core/src/code-host/linked-installations.test.ts`.

let harness: ApiHarness;
let projectId: ProjectId;
let repoId: RepoId;
let installationId = "";

beforeAll(async () => {
  harness = await createApiHarness();
  const world = await seedConnectionAndModel(harness);
  const seeded = await seedProject(harness, world, "unlinked-installation");
  projectId = seeded.projectId;
  repoId = seeded.repoId;
  installationId = (await harness.test.db.repo.findUniqueOrThrow({ where: { id: repoId } })).installationId;
});

afterAll(async () => {
  await harness.dispose();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const setState = (state: "linked" | "removed") =>
  harness.test.db.codeHostInstallation.updateMany({
    where: { organizationId: harness.fixture.a.organization.id, installationId },
    data: state === "linked" ? { state, removedAt: null } : { state, removedAt: new Date() },
  });

/** Every code host call that names the repo's installation: each one mints its token. */
const spyOnHost = () => {
  const host = harness.fakes.codeHost;
  return [vi.spyOn(host, "listRepos"), vi.spyOn(host, "readFiles"), vi.spyOn(host, "listTree"), vi.spyOn(host, "getDefaultBranch")];
};

describe("the panel's call sites and an installation that isn't linked", () => {
  it("F-136/c6: environment detection and the CLI's branches mint nothing for a removed installation, and work again once it's linked", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    const task = await seedTask(harness, { organizationId: harness.fixture.a.organization.id, projectId, title: "A task", driverMemberId: harness.fixture.a.member.id });
    await harness.test.db.taskRepo.create({
      data: { organizationId: harness.fixture.a.organization.id, projectId, taskId: task.taskId, repoId, branchName: "ostra/unlinked-1", baseBranch: "main", state: "branch_pushed" },
    });
    const member = harness.fixture.a.member;
    const session = await startCliSession(
      { db: harness.test.db, ...harness.deps.ports },
      { userId: userIdSchema.parse(member.userId), memberId: memberIdSchema.parse(member.id), machineName: "laptop", sessionDays: 30 },
    );
    if (!session.ok) {
      throw new Error("no CLI session");
    }
    const branches = () =>
      handleCliRequest(harness.deps, new Request(`http://localhost:3000${cliPaths.taskBranches(task.taskId)}`, { headers: { authorization: `Bearer ${session.token}` } }));

    await setState("removed");
    try {
      const spies = spyOnHost();
      const detected = await admin.environments.detect({ projectId });
      expect(detected).toHaveLength(1);
      expect(detected[0]?.detection.reasons).toEqual([{ file: "(the repo)", finding: "its GitHub installation isn't linked to ostra" }]);
      const refused = await branches();
      expect(refused.status).toBe(409);
      expect(JSON.stringify(await refused.json())).toContain("isn't linked");
      // Not one call reached the code host for the repo.
      expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0]);
    } finally {
      await setState("linked");
    }

    // Linked again: both read the repo through the App.
    const spies = spyOnHost();
    expect((await admin.environments.detect({ projectId }))[0]?.detection.reasons).not.toContainEqual({ file: "(the repo)", finding: "its GitHub installation isn't linked to ostra" });
    expect((await branches()).status).toBe(200);
    expect(spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0)).toBeGreaterThan(0);
  });
});

describe("a project's repos and their installation", () => {
  it("F-136/c7: projects.get names each repo's installation account and says when it was unlinked or removed", async () => {
    const member = await harness.as(harness.fixture.a.member);
    const row = await harness.test.db.codeHostInstallation.findFirstOrThrow({ where: { organizationId: harness.fixture.a.organization.id, installationId } });
    const account = { accountLogin: row.accountLogin, accountKind: row.accountKind };
    const stateOf = async () => (await member.projects.get({ projectId })).repos.find((repo) => repo.repoId === repoId)?.installation;
    expect(await stateOf()).toEqual({ ...account, state: "linked" });
    const at = { organizationId: harness.fixture.a.organization.id, installationId };
    try {
      // An admin unlinked it: the member who unlinked it is kept.
      await harness.test.db.codeHostInstallation.updateMany({ where: at, data: { state: "removed", removedAt: new Date(), removedByMemberId: harness.fixture.a.admin.id } });
      expect(await stateOf()).toEqual({ ...account, state: "unlinked" });
      // GitHub said the App was uninstalled there: no member.
      await harness.test.db.codeHostInstallation.updateMany({ where: at, data: { removedByMemberId: null } });
      expect(await stateOf()).toEqual({ ...account, state: "removed" });
    } finally {
      await harness.test.db.codeHostInstallation.updateMany({ where: at, data: { state: "linked", removedAt: null, removedByMemberId: null } });
    }
  });
});

describe("the App owner's own installation, from a listing", () => {
  it("F-136/c4: the owner's own installation is linked when the installations listing shows it, and another account's waits", async () => {
    const host = harness.fakes.codeHost;
    const organizationId = harness.fixture.a.organization.id;
    const saved = new Map(host.apps);
    try {
      for (const [appId, app] of saved) {
        host.apps.set(appId, {
          ...app,
          info: { ...app.info, owner: { login: "ostra-test", accountId: "4100" } },
          installations: [
            ...app.installations,
            { installationId: "770001", accountLogin: "ostra-test", accountId: "4100", accountKind: "organization", repositorySelection: "all" },
            { installationId: "770002", accountLogin: "client-b", accountId: "7700", accountKind: "organization", repositorySelection: "selected" },
          ],
        });
      }
      const listed = await (await harness.as(harness.fixture.a.admin)).github.installations();
      expect(listed.map((installation) => installation.installationId)).toEqual(expect.arrayContaining(["770001", "770002"]));
      expect(await harness.test.db.codeHostInstallation.findFirst({ where: { organizationId, installationId: "770001" } })).toMatchObject({ state: "linked", linkedByMemberId: null, accountId: "4100" });
      expect(await harness.test.db.codeHostInstallation.count({ where: { organizationId, installationId: "770002" } })).toBe(0);
      expect(await harness.test.db.auditEntry.count({ where: { organizationId, action: "installation.linked", actorKind: "system" } })).toBe(1);
      // A second listing links nothing again.
      await (await harness.as(harness.fixture.a.admin)).github.installations();
      expect(await harness.test.db.auditEntry.count({ where: { organizationId, action: "installation.linked", actorKind: "system" } })).toBe(1);
    } finally {
      for (const [appId, app] of saved) {
        host.apps.set(appId, app);
      }
    }
  });
});
