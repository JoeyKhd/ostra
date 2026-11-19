import { repoFullNameSchema } from "@ostra/protocol";
import { afterAll, beforeAll, expect, it } from "vitest";

import { createApiHarness, GITHUB_APP_ID, seedConnectionAndModel, seedTask } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// F-104 (ticket 30; ADR 0040 amended): `tasks.get` carries each PR's `ostra/independent-review`
// check per repo and head: waiting or passed, its reason, and who approved, newest head first.

let harness: ApiHarness;

beforeAll(async () => {
  harness = await createApiHarness();
});

afterAll(async () => {
  await harness.dispose();
});

it("F-104: the check's state and reason on tasks.get, per repo and head", async () => {
  const { a } = harness.fixture;
  const world = await seedConnectionAndModel(harness);
  const app = harness.fakes.codeHost.apps.get(GITHUB_APP_ID);
  if (app === undefined) {
    throw new Error("the world's App is missing");
  }
  harness.fakes.codeHost.apps.set(GITHUB_APP_ID, {
    ...app,
    repos: new Map([["9001", [...(app.repos.get("9001") ?? []), { hostRepoId: "2", fullName: "ostra-test/test2", defaultBranch: "main", private: true, cloneUrl: "https://github.example/ostra-test/test2.git" }]]]),
  });
  harness.fakes.codeHost.files.set("ostra-test/test2", new Map([["package.json", "{}"]]));
  const admin = await harness.as(a.admin);
  const repoOf = (name: string) => ({ connectionId: world.connectionId, installationId: world.installationId, fullName: repoFullNameSchema.parse(`ostra-test/${name}`) });
  const created = await admin.projects.create({ name: "Checked", slug: "checked", access: "open", repo: repoOf("test1"), moreRepos: [repoOf("test2")] });
  const projectId = created.projectId;
  const [first, second] = await admin.projects.repos({ projectId });
  if (first === undefined || second === undefined) {
    throw new Error("two repos");
  }
  const task = await seedTask(harness, { organizationId: a.organization.id, projectId, title: "Two PRs", driverMemberId: a.member.id });
  const taskRepo = async (repoId: string, number: number) => {
    const row = await harness.test.db.taskRepo.create({
      data: { organizationId: a.organization.id, projectId, taskId: task.taskId, repoId, branchName: "ostra/two-prs", baseBranch: "main", state: "pr_open", prNumber: number, prUrl: `https://github.example/pr/${String(number)}` },
      select: { id: true },
    });
    await harness.test.db.taskPullRequest.create({ data: { organizationId: a.organization.id, projectId, taskRepoId: row.id, number, url: `https://github.example/pr/${String(number)}`, branchName: "ostra/two-prs" } });
    return row.id;
  };
  const firstRow = await taskRepo(first.repoId, 11);
  await taskRepo(second.repoId, 12);
  const oldHead = "a".repeat(40);
  const newHead = "b".repeat(40);
  await harness.test.db.reviewCheck.create({
    data: { organizationId: a.organization.id, projectId, taskRepoId: firstRow, prNumber: 11, headSha: oldHead, status: "passed", reason: "Approved by someone who didn't drive the task", approverMemberId: a.insider.id, createdAt: new Date("2026-11-19T10:00:00Z") },
  });
  await harness.test.db.reviewCheck.create({
    data: { organizationId: a.organization.id, projectId, taskRepoId: firstRow, prNumber: 11, headSha: newHead, status: "pending", reason: "Waiting for a review of the new head", createdAt: new Date("2026-11-19T11:00:00Z") },
  });

  const view = await (await harness.as(a.member)).tasks.get({ taskId: task.taskId });
  const byRepo = new Map(view.repos.map((row) => [row.fullName, row] as const));
  const checked = byRepo.get("ostra-test/test1")?.pullRequests[0]?.reviewCheck;
  expect(checked).toMatchObject({
    headSha: newHead,
    state: "waiting",
    reason: "Waiting for a review of the new head",
    approver: null,
    heads: [
      { headSha: newHead, state: "waiting", approver: null },
      { headSha: oldHead, state: "passed", reason: "Approved by someone who didn't drive the task", approver: { memberId: a.insider.id } },
    ],
  });
  // The other repo's PR has no check yet.
  expect(byRepo.get("ostra-test/test2")?.pullRequests[0]?.reviewCheck).toBeNull();

  // The new head approved: passed, with its approver.
  await harness.test.db.reviewCheck.updateMany({ where: { taskRepoId: firstRow, headSha: newHead }, data: { status: "passed", reason: "Approved", approverMemberId: a.admin.id } });
  const passed = (await (await harness.as(a.member)).tasks.get({ taskId: task.taskId })).repos.find((row) => row.fullName === "ostra-test/test1")?.pullRequests[0]?.reviewCheck;
  expect(passed).toMatchObject({ headSha: newHead, state: "passed", reason: "Approved", approver: { memberId: a.admin.id } });
});
