import { repoFullNameSchema, repoIdSchema } from "@ostra/protocol";
import type { ConnectionId, ProjectId, RepoId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, GITHUB_APP_ID, seedConnectionAndModel, seedTask } from "../testing/index.ts";
import type { ApiHarness, AppCaller } from "../testing/index.ts";

// F-098 (ticket 30; ADR 0027 amended): a project's several repos through the panel's API. A project
// is created with two repos; a project admin adds, reorders and removes them, each with its access
// and its limit; a removal while an unfinished task has a branch in the repo is refused, naming the
// tasks; and anyone who can open the project reads the repos in order.

let harness: ApiHarness;
let world: { readonly connectionId: ConnectionId; readonly installationId: string };
let projectId: ProjectId;

const repo = (id: string, name: string) => ({ hostRepoId: id, fullName: `ostra-test/${name}`, defaultBranch: "main", private: true, cloneUrl: `https://github.example/ostra-test/${name}.git` });

beforeAll(async () => {
  harness = await createApiHarness();
  world = await seedConnectionAndModel(harness);
  const app = harness.fakes.codeHost.apps.get(GITHUB_APP_ID);
  if (app === undefined) {
    throw new Error("the world's App is missing");
  }
  harness.fakes.codeHost.apps.set(GITHUB_APP_ID, {
    ...app,
    repos: new Map([["9001", [repo("1", "test1"), repo("2", "test2"), repo("3", "test3"), repo("4", "test4"), repo("5", "web")]]]),
  });
  for (const name of ["test2", "test3", "test4", "web"]) {
    harness.fakes.codeHost.files.set(`ostra-test/${name}`, new Map([["package.json", "{}"]]));
  }
  // The restricted project's insider is its admin here: a project admin who isn't an organization admin.
  await harness.test.db.projectMember.updateMany({ where: { projectId: harness.fixture.a.restrictedProject.id, memberId: harness.fixture.a.insider.id }, data: { role: "admin" } });
});

afterAll(async () => {
  await harness.dispose();
});

const admin = (): Promise<AppCaller> => harness.as(harness.fixture.a.admin);

const repoOf = (name: string) => ({ connectionId: world.connectionId, installationId: world.installationId, fullName: repoFullNameSchema.parse(`ostra-test/${name}`) });

describe("F-098: a project's repos", () => {
  it("F-098/c1: a project created with two repos has both, in order, each in its own folder", async () => {
    const created = await (await admin()).projects.create({ name: "Two", slug: "two", access: "open", repo: repoOf("test1"), moreRepos: [repoOf("test2")] });
    projectId = created.projectId;
    const repos = await (await harness.as(harness.fixture.a.member)).projects.repos({ projectId });
    expect(repos.map((row) => [row.fullName, row.position, row.checkoutDir, row.defaultBranch])).toEqual([
      ["ostra-test/test1", 0, "test1", "main"],
      ["ostra-test/test2", 1, "test2", "main"],
    ]);
    expect(repos[0]?.repoId).toBe(created.repoId);
    expect((await (await admin()).projects.get({ projectId })).repos.map((row) => row.fullName)).toEqual(["ostra-test/test1", "ostra-test/test2"]);
    const audit = await harness.test.db.auditEntry.findFirstOrThrow({ where: { action: "project.created", entityId: projectId } });
    expect(audit.data).toMatchObject({ repos: "ostra-test/test1,ostra-test/test2" });
    // Each repo once; and no repo the App's installation doesn't list.
    await expect((await admin()).projects.create({ name: "Twice", slug: "twice", access: "open", repo: repoOf("test1"), moreRepos: [repoOf("test1")] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect((await admin()).projects.create({ name: "Unknown", slug: "unknown", access: "open", repo: repoOf("test1"), moreRepos: [repoOf("nope")] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await harness.test.db.project.count({ where: { slug: { in: ["twice", "unknown"] } } })).toBe(0);
  });

  it("F-098/c1: a project admin adds, reorders and removes repos; a member can't, and an outsider gets NOT_FOUND", async () => {
    const { a } = harness.fixture;
    const caller = await admin();
    const added = await caller.projects.addRepo({ projectId, fullName: repoFullNameSchema.parse("ostra-test/test3") });
    expect(added).toMatchObject({ position: 2, checkoutDir: "test3" });
    await expect(caller.projects.addRepo({ projectId, fullName: repoFullNameSchema.parse("ostra-test/test3") })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller.projects.addRepo({ projectId, fullName: repoFullNameSchema.parse("ostra-test/elsewhere") })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const member = await harness.as(a.member);
    await expect(member.projects.addRepo({ projectId, fullName: repoFullNameSchema.parse("ostra-test/test4") })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(member.projects.removeRepo({ projectId, repoId: added.repoId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(member.projects.reorderRepos({ projectId, repoIds: [added.repoId] })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const ids = (await caller.projects.repos({ projectId })).map((row) => row.repoId);
    const [first, second, third] = ids;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("three repos");
    }
    await caller.projects.reorderRepos({ projectId, repoIds: [third, first, second] });
    expect((await member.projects.repos({ projectId })).map((row) => [row.fullName, row.position])).toEqual([
      ["ostra-test/test3", 0],
      ["ostra-test/test1", 1],
      ["ostra-test/test2", 2],
    ]);
    await expect(caller.projects.reorderRepos({ projectId, repoIds: [third, first] })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(await caller.projects.removeRepo({ projectId, repoId: third })).toEqual({ removed: true });
    expect((await member.projects.repos({ projectId })).map((row) => row.fullName)).toEqual(["ostra-test/test1", "ostra-test/test2"]);
    const actions = (await harness.test.db.auditEntry.findMany({ where: { entityId: projectId, action: { startsWith: "project.repo" } }, select: { action: true } })).map((row) => row.action);
    expect(actions.sort()).toEqual(["project.repo-added", "project.repo-removed", "project.repos-reordered"]);

    // The restricted project: its own admin may; an organization member who isn't on it gets NOT_FOUND.
    const restricted = a.restrictedProject.id;
    const insider = await harness.as(a.insider);
    const insiderAdded = await insider.projects.addRepo({ projectId: restricted, fullName: repoFullNameSchema.parse("ostra-test/test4") });
    expect(insiderAdded.checkoutDir).toBe("test4");
    for (const call of [
      () => member.projects.repos({ projectId: restricted }),
      () => member.projects.addRepo({ projectId: restricted, fullName: repoFullNameSchema.parse("ostra-test/web") }),
      () => member.projects.removeRepo({ projectId: restricted, repoId: insiderAdded.repoId }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    await expect((await harness.as(harness.fixture.b.admin)).projects.repos({ projectId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("F-098/c1: the limit holds at creation and at an add", async () => {
    const context = await harness.contextOf(harness.fixture.a.admin);
    const limited = harness.callerFor({ ...context, deps: { ...context.deps, settings: { ...context.deps.settings, projectMaxRepos: 2 } } });
    await expect(limited.projects.create({ name: "Three", slug: "three", access: "open", repo: repoOf("test1"), moreRepos: [repoOf("test2"), repoOf("test3")] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "A project holds at most 2 repos",
    });
    await expect(limited.projects.addRepo({ projectId, fullName: repoFullNameSchema.parse("ostra-test/test4") })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "A project holds at most 2 repos",
    });
    expect((await limited.projects.repos({ projectId })).length).toBe(2);
  });

  it("F-098/c1: a removal is refused while an unfinished task has a branch in the repo, naming the tasks; and the last repo stays", async () => {
    const { a } = harness.fixture;
    const caller = await admin();
    const repos = await caller.projects.repos({ projectId });
    const second = repos[1];
    if (second === undefined) {
      throw new Error("two repos");
    }
    const running = await seedTask(harness, { organizationId: a.organization.id, projectId, title: "Rename the API" });
    const done = await seedTask(harness, { organizationId: a.organization.id, projectId, title: "Old work", state: "stopped" });
    for (const task of [running, done]) {
      await harness.test.db.taskRepo.create({
        data: { organizationId: a.organization.id, projectId, taskId: task.taskId, repoId: second.repoId, branchName: `ostra/${task.taskId.slice(-8)}`, baseBranch: "main", state: "branch_pushed" },
      });
    }
    expect((await caller.projects.repos({ projectId }))[1]?.tasks).toEqual([{ taskId: running.taskId, title: "Rename the API", ticketKey: null }]);
    const refused = await caller.projects.removeRepo({ projectId, repoId: second.repoId });
    expect(refused).toEqual({ removed: false, message: "Unfinished tasks have a branch in this repo: Rename the API", tasks: [{ taskId: running.taskId, title: "Rename the API", ticketKey: null }] });
    expect(await harness.test.db.repo.count({ where: { id: second.repoId } })).toBe(1);

    // Once it's finished, the repo goes; the last one stays.
    await harness.test.db.task.update({ where: { id: running.taskId }, data: { state: "stopped", stoppedReason: "requested" } });
    expect(await caller.projects.removeRepo({ projectId, repoId: second.repoId })).toEqual({ removed: true });
    const last: RepoId = repoIdSchema.parse((await caller.projects.repos({ projectId }))[0]?.repoId);
    await expect(caller.projects.removeRepo({ projectId, repoId: last })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});
