import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedConnectionAndModel, seedProject } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// F-016: a task uses one branch name, named from its prompt, in every repo of its project. A
// project has one repo through the panel until milestone 2's several repos per project, so the
// second repo here is written as a row.

let harness: ApiHarness;

beforeAll(async () => {
  harness = await createApiHarness();
});

afterAll(async () => {
  await harness.dispose();
});

describe("a task's branch", () => {
  it("F-016/c2: a prompt task's one branch name is named from its prompt, and every repo of its project gets that name", async () => {
    const world = await seedConnectionAndModel(harness);
    const { projectId, repoId } = await seedProject(harness, world, "two-repos");
    const first = await harness.test.db.repo.findUniqueOrThrow({ where: { id: repoId } });
    await harness.test.db.repo.create({
      data: {
        organizationId: first.organizationId,
        projectId,
        connectionId: first.connectionId,
        installationId: first.installationId,
        hostRepoId: `${first.hostRepoId}-2`,
        fullName: "ostra-test/test2",
        defaultBranch: "develop",
        checkoutDir: "test2",
      },
    });

    const created = await (await harness.as(harness.fixture.a.member)).tasks.create({ projectId, prompt: "\n  Fix the Résumé upload: it drops PDFs\nThe rest of the prompt." });

    // Named from the prompt's first line, after the part of the task's ID that keeps it unique.
    expect(created.branchName).toBe(`ostra/${created.taskId.replaceAll("-", "").slice(-8)}-fix-the-resume-upload-it-drops-pdfs`);
    const task = await harness.test.db.task.findUniqueOrThrow({ where: { id: created.taskId }, include: { repos: { include: { repo: true } } } });
    expect(task.branchName).toBe(created.branchName);
    // One name in every repo, each from its own base branch.
    expect(task.repos.map((repo) => [repo.repo.fullName, repo.branchName, repo.baseBranch]).sort()).toEqual([
      ["ostra-test/test1", created.branchName, "main"],
      ["ostra-test/test2", created.branchName, "develop"],
    ]);
  });
});
