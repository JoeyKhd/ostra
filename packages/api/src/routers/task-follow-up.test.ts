import { dispatchWaitColumns } from "@ostra/domain";
import type { ProjectId, RepoId, RunnerId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedConnectionAndModel, seedPersonalRunner, seedProject, seedTask } from "../testing/index.ts";
import type { ApiHarness, SeededTask } from "../testing/index.ts";

// 2026-11-21 (F-100, F-147, ADR 0059 amended): the task page of a follow-up and of its code task.
// A review task says which task and PR it reviews, how its newest round went, and why it waits
// (the runner its task ran on, by name); a code task says how its AI review is doing; the task
// list and Home's board name a follow-up's code task, so a live list nests it there.

let harness: ApiHarness;
let projectId: ProjectId;
let repoId: RepoId;
let runnerId: RunnerId;

beforeAll(async () => {
  harness = await createApiHarness();
  const world = await seedConnectionAndModel(harness);
  ({ projectId, repoId } = await seedProject(harness, world, "follow-ups"));
  runnerId = await seedPersonalRunner(harness, harness.fixture.a.member.id, "santi-laptop");
});

afterAll(async () => {
  await harness.dispose();
});

const place = () => ({ organizationId: harness.fixture.a.organization.id, projectId });

/** A code task in its AI review with its PR open, and the review task `review.start` made for it. */
const seedFamily = async (): Promise<{ readonly code: SeededTask; readonly review: SeededTask }> => {
  const member = harness.fixture.a.member.id;
  const code = await seedTask(harness, { ...place(), title: "Add a simple index.html", state: "in_review", creatorMemberId: member, driverMemberId: member, runnerId, sessionState: "idle" });
  await harness.test.db.task.update({ where: { id: code.taskId }, data: { subState: "ai_review" } });
  await harness.test.db.taskRepo.create({
    data: { ...place(), taskId: code.taskId, repoId, branchName: "ostra/index-html", baseBranch: "main", prNumber: 12, prUrl: "https://github.example/ostra-test/test1/pull/12", state: "pr_open" },
  });
  const review = await seedTask(harness, { ...place(), title: "Review: Add a simple index.html", state: "queued", creatorMemberId: member, driverMemberId: member, sessionState: "starting" });
  await harness.test.db.task.update({
    where: { id: review.taskId },
    data: { kind: "review", reviewOfTaskId: code.taskId, origin: "pr_review", ...dispatchWaitColumns({ code: "follow-up-waits", runner: { id: runnerId, name: "santi-laptop" }, personal: "busy" }) },
  });
  await harness.test.db.reviewRun.create({ data: { ...place(), codeTaskId: code.taskId, reviewTaskId: review.taskId, round: 1, heads: [], state: "running" } });
  return { code, review };
};

describe("a follow-up and its code task (ADR 0059 amended 2026-11-21)", () => {
  it("F-100/c6: a review task names the task and PR it reviews and why it waits; its code task names its AI review and its state", async () => {
    const { code, review } = await seedFamily();
    const caller = await harness.as(harness.fixture.a.insider);
    const shown = await caller.tasks.get({ taskId: review.taskId });
    expect(shown.reviewOf).toMatchObject({
      taskId: code.taskId,
      title: "Add a simple index.html",
      prs: [{ repo: "ostra-test/test1", number: 12, url: "https://github.example/ostra-test/test1/pull/12" }],
      run: { round: 1, state: "running", blocking: 0, nits: 0 },
    });
    expect(shown.aiReview).toBeNull();
    expect(shown.waiting).toEqual({ kind: "no-runner", reason: { code: "follow-up-waits", runner: { id: runnerId, name: "santi-laptop" }, personal: "busy" } });

    const parent = await caller.tasks.get({ taskId: code.taskId });
    expect(parent.reviewOf).toBeNull();
    expect(parent.aiReview).toEqual({ taskId: review.taskId, state: "queued", run: { round: 1, state: "running", blocking: 0, nits: 0 } });

    // Once it's handed in and posted, the code task reads the round's result.
    await harness.test.db.reviewRun.updateMany({ where: { reviewTaskId: review.taskId }, data: { state: "posted", blocking: 0, nits: 2 } });
    await harness.test.db.task.update({ where: { id: review.taskId }, data: { state: "done", ...dispatchWaitColumns(null) } });
    expect((await caller.tasks.get({ taskId: code.taskId })).aiReview).toMatchObject({ state: "done", run: { state: "posted", blocking: 0, nits: 2 } });
  });

  it("F-147/c8: the task list and Home's board name a follow-up's code task, and no other task's", async () => {
    const { code, review } = await seedFamily();
    const caller = await harness.as(harness.fixture.a.member);
    const rows = (await caller.tasks.list({ projectId })).flatMap((group) => group.tasks);
    expect(rows.find((row) => row.id === review.taskId)?.reviewOf).toBe(code.taskId);
    expect(rows.find((row) => row.id === code.taskId)?.reviewOf).toBeNull();

    await harness.test.db.task.update({ where: { id: review.taskId }, data: { state: "running", ...dispatchWaitColumns(null) } });
    await harness.test.db.session.updateMany({ where: { taskId: review.taskId }, data: { state: "running" } });
    const board = await caller.home.board({ column: "running" });
    const card = board.columns.flatMap((column) => column.cards).find((one) => one.taskId === review.taskId);
    expect(card?.reviewOf).toEqual({ taskId: code.taskId, key: null, title: "Add a simple index.html" });
  });
});
