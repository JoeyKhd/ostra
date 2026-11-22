import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedBoard, seedConnectionAndModel, seedLinearConnection, seedProject, seedTicket } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// F-016: a task uses one branch name, named from its ticket or its prompt, in every repo of its
// project. A project has one repo through the panel until milestone 2's several repos per project,
// so the second repo here is written as a row.

let harness: ApiHarness;
let world: Awaited<ReturnType<typeof seedConnectionAndModel>>;

beforeAll(async () => {
  harness = await createApiHarness();
  world = await seedConnectionAndModel(harness);
});

afterAll(async () => {
  await harness.dispose();
});

/** A project with two repos: `ostra-test/test1` on `main`, as the panel makes it, and `ostra-test/test2` on `develop`. */
const twoRepoProject = async (slug: string) => {
  const { projectId, repoId } = await seedProject(harness, world, slug);
  const first = await harness.test.db.repo.findUniqueOrThrow({ where: { id: repoId } });
  await harness.test.db.repo.create({
    data: {
      organizationId: first.organizationId,
      projectId,
      connectionId: first.connectionId,
      installationId: first.installationId,
      hostRepoId: `${first.hostRepoId}-2-${slug}`,
      fullName: "ostra-test/test2",
      defaultBranch: "develop",
      checkoutDir: "test2",
    },
  });
  return projectId;
};

/** The task's branch name, and each of its repos' name and base, sorted by repo. */
const branchesOf = async (taskId: string) => {
  const task = await harness.test.db.task.findUniqueOrThrow({ where: { id: taskId }, include: { repos: { include: { repo: true } } } });
  return { branchName: task.branchName, repos: task.repos.map((repo) => [repo.repo.fullName, repo.branchName, repo.baseBranch]).sort() };
};

describe("a task's branch", () => {
  it("F-016/c2: a prompt task's one branch name is named from its prompt, and every repo of its project gets that name", async () => {
    const projectId = await twoRepoProject("two-repos");

    const created = await (await harness.as(harness.fixture.a.member)).tasks.create({ projectId, prompt: "\n  Fix the Résumé upload: it drops PDFs\nThe rest of the prompt." });

    // Named from the prompt's first line, after the part of the task's ID that keeps it unique.
    expect(created.branchName).toBe(`ostra/${created.taskId.replaceAll("-", "").slice(-8)}-fix-the-resume-upload-it-drops-pdfs`);
    // One name in every repo, each from its own base branch.
    expect(await branchesOf(created.taskId)).toEqual({
      branchName: created.branchName,
      repos: [
        ["ostra-test/test1", created.branchName, "main"],
        ["ostra-test/test2", created.branchName, "develop"],
      ],
    });
  });

  it("F-016/c2: a ticket task's one branch name is named from its ticket's key and title, and every repo of its project gets that name", async () => {
    const projectId = await twoRepoProject("two-repos-ticket");
    const connectionId = await seedLinearConnection(harness);
    const boardId = await seedBoard(harness, { projectId, connectionId, key: "BR" });
    const ticketId = await seedTicket(harness, {
      projectId,
      boardId,
      connectionId,
      key: "BR-7",
      title: "Show the Résumé page count",
      statusId: "s-todo",
      statusName: "Todo",
      statusCategory: "open",
    });

    const started = await (await harness.as(harness.fixture.a.member)).tasks.startFromTicket({ projectId, ticketId });

    // Named from the ticket's key, then the part of the task's ID that keeps it unique, then its title.
    expect(started.branchName).toBe(`ostra/br-7-${started.taskId.replaceAll("-", "").slice(-8)}-show-the-resume-page-count`);
    expect(await branchesOf(started.taskId)).toEqual({
      branchName: started.branchName,
      repos: [
        ["ostra-test/test1", started.branchName, "main"],
        ["ostra-test/test2", started.branchName, "develop"],
      ],
    });
  });
});
