import { reviewPrompt } from "@ostra/domain";
import { httpUrlSchema, reviewRunIdSchema } from "@ostra/protocol";
import type { OrganizationId, ProjectId, RepoId, ReviewRunId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appendEvent, createApiHarness, seedConnectionAndModel, seedProject, seedTask } from "../testing/index.ts";
import type { ApiHarness, SeededTask } from "../testing/index.ts";

// Milestone 10 (F-151/c6, c7, ticket 08): what the compact thread reads from `tasks.get` and Home's
// board that it didn't before. The code host's CI counted in jobs, with every failing job by name,
// on each repo's `ci` and on a task in CI on Home's board (the targets' choice 7); and a review
// task's figures (`review`) for its status line, Result group and top bar (choice 10, `s3.md`).
// Who sees them is who sees the task: another organization's and a restricted project's stay out.

let harness: ApiHarness;
let world: Awaited<ReturnType<typeof seedConnectionAndModel>>;
let projectId: ProjectId;
let repoId: RepoId;
let projectCounter = 0;

const orgA = (): OrganizationId => harness.fixture.a.organization.id;
const HEAD = "4be21c0aa1b2c3d4e5f60718293a4b5c6d7e8f90";
const BASE = "91f00c3aa1b2c3d4e5f60718293a4b5c6d7e8f90";

beforeAll(async () => {
  harness = await createApiHarness();
  world = await seedConnectionAndModel(harness);
  ({ projectId, repoId } = await seedProject(harness, world, "thread-data"));
});

afterAll(async () => {
  await harness.dispose();
});

type Check = { readonly name: string; readonly conclusion: string };

/**
 * A code task in review with its PR on `HEAD`, the code host's CI on that head as `ci.evaluate`
 * stores it (each check's conclusion, or its status while it runs), in the given sub-state.
 */
const seedInCi = async (
  place: { readonly projectId: ProjectId; readonly repoId: RepoId },
  ci: { readonly state: "pending" | "passed" | "failed" | "none"; readonly checks: readonly Check[] } | null,
  subState: "ci_running" | "waiting_for_reviewer" = "ci_running",
): Promise<SeededTask> => {
  const member = harness.fixture.a.member.id;
  const task = await seedTask(harness, { organizationId: orgA(), projectId: place.projectId, title: "Show the calculation history", state: "in_review", driverMemberId: member, creatorMemberId: member, sessionState: "idle" });
  await harness.test.db.task.update({ where: { id: task.taskId }, data: { subState } });
  const repo = await harness.test.db.taskRepo.create({
    data: {
      organizationId: orgA(),
      projectId: place.projectId,
      taskId: task.taskId,
      repoId: place.repoId,
      branchName: `ostra/calc-${task.taskId.slice(-8)}`,
      baseBranch: "main",
      headSha: HEAD,
      prNumber: 483,
      prUrl: "https://github.example/ostra-test/test1/pull/483",
      state: "pr_open",
    },
  });
  if (ci !== null) {
    // An older head's run, which the head's counts never mix in.
    await harness.test.db.ciRun.create({ data: { organizationId: orgA(), projectId: place.projectId, taskRepoId: repo.id, headSha: BASE, state: "failed", checks: [{ name: "old", conclusion: "failure", externalId: "0" }], firstSeenAt: new Date(Date.now() - 60_000) } });
    await harness.test.db.ciRun.create({
      data: { organizationId: orgA(), projectId: place.projectId, taskRepoId: repo.id, headSha: HEAD, state: ci.state, checks: ci.checks.map((check, index) => ({ ...check, externalId: String(index + 1) })) },
    });
  }
  return task;
};

/** Four jobs on the head: two with a conclusion, two still running (queued, in progress). */
const halfDone: readonly Check[] = [
  { name: "build", conclusion: "success" },
  { name: "lint", conclusion: "success" },
  { name: "test", conclusion: "in_progress" },
  { name: "e2e", conclusion: "queued" },
];

/** A failed head: three failing jobs among five, a commit status's `error` among them, in the host's order. */
const failedChecks: readonly Check[] = [
  { name: "build", conclusion: "success" },
  { name: "test", conclusion: "failure" },
  { name: "lint", conclusion: "skipped" },
  { name: "e2e", conclusion: "timed_out" },
  { name: "deploy/preview", conclusion: "error" },
];

const boardCard = async (as: "member" | "insider" | "outsider", taskId: string, project?: ProjectId) => {
  const member = as === "member" ? harness.fixture.a.member : as === "insider" ? harness.fixture.a.insider : harness.fixture.b.admin;
  const board = await (await harness.as(member)).home.board({ column: "in-review", ...(project === undefined ? {} : { projectId: project }) });
  return board.columns.flatMap((column) => column.cards).find((card) => card.taskId === taskId);
};

describe("CI counted in jobs (the targets' choice 7)", () => {
  it("F-151/c6: a CiRun with 4 check runs, 2 concluded, gives jobs { done: 2, total: 4 } on the repo's ci and on Home's board", async () => {
    const task = await seedInCi({ projectId, repoId }, { state: "pending", checks: halfDone });
    const member = await harness.as(harness.fixture.a.member);
    const [repo] = (await member.tasks.get({ taskId: task.taskId })).repos;
    expect(repo?.ci).toEqual({ state: "running", failing: null, jobs: { done: 2, total: 4 }, failingJobs: [] });

    const card = await boardCard("member", task.taskId, projectId);
    expect(card?.status).toEqual({ kind: "in-review", subState: "ci_running", prNumbers: [483], ciJobs: { done: 2, total: 4 } });
  });

  it("F-151/c6: a failed head lists every failing job by name, in the code host's order, and keeps its first for the Code group", async () => {
    const task = await seedInCi({ projectId, repoId }, { state: "failed", checks: failedChecks });
    const [repo] = (await (await harness.as(harness.fixture.a.member)).tasks.get({ taskId: task.taskId })).repos;
    expect(repo?.ci).toEqual({ state: "failed", failing: "test", jobs: { done: 5, total: 5 }, failingJobs: ["test", "e2e", "deploy/preview"] });
    // The board counts the same jobs while the task is in CI.
    expect((await boardCard("member", task.taskId, projectId))?.status).toMatchObject({ kind: "in-review", ciJobs: { done: 5, total: 5 } });
  });

  it("F-151/c6: none counts no jobs, a head with no CI read yet neither, and a task past CI carries no count on the board", async () => {
    const none = await seedInCi({ projectId, repoId }, { state: "none", checks: [] });
    const unseen = await seedInCi({ projectId, repoId }, null);
    const member = await harness.as(harness.fixture.a.member);
    expect((await member.tasks.get({ taskId: none.taskId })).repos[0]?.ci).toEqual({ state: "none", failing: null, jobs: { done: 0, total: 0 }, failingJobs: [] });
    expect((await member.tasks.get({ taskId: unseen.taskId })).repos[0]?.ci).toEqual({ state: "none", failing: null, jobs: { done: 0, total: 0 }, failingJobs: [] });
    expect((await boardCard("member", unseen.taskId, projectId))?.status).toMatchObject({ ciJobs: { done: 0, total: 0 } });

    const waiting = await seedInCi({ projectId, repoId }, { state: "passed", checks: halfDone.map((check) => ({ ...check, conclusion: "success" })) }, "waiting_for_reviewer");
    expect((await member.tasks.get({ taskId: waiting.taskId })).repos[0]?.ci).toMatchObject({ state: "passed", jobs: { done: 4, total: 4 } });
    expect((await boardCard("member", waiting.taskId, projectId))?.status).toEqual({ kind: "in-review", subState: "waiting_for_reviewer", prNumbers: [483], ciJobs: null });
  });
});

/** A review task for a code task's PR #483, its prompt for `promptRound` (or one that doesn't read as a review's), and its runs. */
const seedReview = async (input: { readonly promptRound: { readonly number: number; readonly of: number } | null; readonly runs: readonly { readonly round: number; readonly state: "running" | "submitted" | "posted"; readonly blocking: number; readonly nits: number }[] }) => {
  const member = harness.fixture.a.member.id;
  const code = await seedInCi({ projectId, repoId }, { state: "passed", checks: [{ name: "build", conclusion: "success" }] }, "waiting_for_reviewer");
  await harness.test.db.task.update({ where: { id: code.taskId }, data: { ticketKey: "CALC-192", subState: "ai_review" } });
  const prompt =
    input.promptRound === null
      ? "A prompt"
      : reviewPrompt({
          ticket: { key: "CALC-192", title: "Show the calculation history", description: "Keep the last 50 results." },
          acceptanceCriteria: "- The panel lists the last 50 results",
          pullRequests: [{ repo: "ostra-test/test1", number: 483, url: "https://github.example/ostra-test/test1/pull/483", branch: "ostra/calc-192", baseSha: BASE, headSha: HEAD, files: 3, additions: 203, deletions: 6 }],
          round: input.promptRound,
        });
  const review = await seedTask(harness, { organizationId: orgA(), projectId, title: "Review: Show the calculation history", state: "running", creatorMemberId: member, driverMemberId: member, sessionState: "running" });
  await harness.test.db.task.update({ where: { id: review.taskId }, data: { kind: "review", reviewOfTaskId: code.taskId, origin: "pr_review", prompt } });
  const runs: ReviewRunId[] = [];
  for (const run of input.runs) {
    const created = await harness.test.db.reviewRun.create({
      data: { organizationId: orgA(), projectId, codeTaskId: code.taskId, reviewTaskId: review.taskId, round: run.round, heads: [{ repoId, prNumber: 483, baseSha: BASE, headSha: HEAD }], state: run.state, blocking: run.blocking, nits: run.nits },
    });
    runs.push(reviewRunIdSchema.parse(created.id));
  }
  return { code, review, runs };
};

const posted = async (task: SeededTask, reviewRunId: ReviewRunId, url: string) =>
  appendEvent(harness, task, { organizationId: orgA(), projectId }, { kind: "review.posted", reviewRunId, repoId, prNumber: 483, url: httpUrlSchema.parse(url) });

describe("a review task's figures (the targets' choice 10)", () => {
  it("F-151/c7: a submitted round gives its round of its limit, its counts, the code task and the PR, and no review URL before it posts", async () => {
    const { code, review } = await seedReview({ promptRound: { number: 2, of: 3 }, runs: [{ round: 1, state: "posted", blocking: 1, nits: 0 }, { round: 2, state: "submitted", blocking: 0, nits: 1 }] });
    const shown = await (await harness.as(harness.fixture.a.member)).tasks.get({ taskId: review.taskId });
    expect(shown.review).toEqual({
      round: 2,
      limit: 3,
      state: "submitted",
      blocking: 0,
      nits: 1,
      url: null,
      codeTask: { id: code.taskId, key: "CALC-192", title: "Show the calculation history" },
      prNumber: 483,
    });
  });

  it("F-151/c7: a posted round gives the review's URL, its own round's and not an earlier one's; a code task's review is null", async () => {
    const { code, review, runs } = await seedReview({ promptRound: { number: 2, of: 3 }, runs: [{ round: 1, state: "posted", blocking: 1, nits: 0 }, { round: 2, state: "posted", blocking: 0, nits: 1 }] });
    const [first, second] = runs;
    if (first === undefined || second === undefined) throw new Error("two runs were seeded");
    await posted(review, first, "https://github.example/ostra-test/test1/pull/483#pullrequestreview-1");
    await posted(review, second, "https://github.example/ostra-test/test1/pull/483#pullrequestreview-2");
    const member = await harness.as(harness.fixture.a.member);
    expect((await member.tasks.get({ taskId: review.taskId })).review).toMatchObject({
      round: 2,
      limit: 3,
      state: "posted",
      blocking: 0,
      nits: 1,
      url: "https://github.example/ostra-test/test1/pull/483#pullrequestreview-2",
      prNumber: 483,
    });
    const parent = await member.tasks.get({ taskId: code.taskId });
    expect(parent.review).toBeNull();
    expect(parent.aiReview).toMatchObject({ taskId: review.taskId, run: { round: 2, state: "posted", nits: 1 } });
  });

  it("F-151/c7: the round reads as ostra's first message names it, after a person's action restarted the count; a prompt that doesn't read falls back to the run's round", async () => {
    // Round 3 of the code task's life, the first since a person last acted: the message says `round 1 of 3`.
    const restarted = await seedReview({ promptRound: { number: 1, of: 3 }, runs: [{ round: 3, state: "running", blocking: 0, nits: 0 }] });
    const member = await harness.as(harness.fixture.a.member);
    expect((await member.tasks.get({ taskId: restarted.review.taskId })).review).toMatchObject({ round: 1, limit: 3, state: "running", blocking: 0, nits: 0, url: null });

    const unread = await seedReview({ promptRound: null, runs: [{ round: 2, state: "submitted", blocking: 2, nits: 0 }] });
    const limit = harness.deps.settings.team.roundLimits.reviewRounds + 1;
    expect((await member.tasks.get({ taskId: unread.review.taskId })).review).toMatchObject({ round: 2, limit: Math.max(limit, 2), blocking: 2, nits: 0 });
  });
});

describe("who sees the thread's data", () => {
  it("F-151/c6,c7: another organization's and a restricted project's tasks stay NOT_FOUND for tasks.get, and off Home's board", async () => {
    projectCounter += 1;
    const hidden = await seedProject(harness, world, `thread-hidden-${String(projectCounter)}`);
    const { review } = await seedReview({ promptRound: { number: 1, of: 3 }, runs: [{ round: 1, state: "submitted", blocking: 0, nits: 0 }] });
    const inCi = await seedInCi(hidden, { state: "pending", checks: halfDone });
    await harness.test.db.project.update({ where: { id: hidden.projectId }, data: { access: "restricted" } });
    await harness.test.db.projectMember.create({ data: { organizationId: orgA(), projectId: hidden.projectId, memberId: harness.fixture.a.insider.id, role: "member" } });

    // Another organization reaches neither the CI counts nor the review's figures.
    const outsider = await harness.as(harness.fixture.b.admin);
    await expect(outsider.tasks.get({ taskId: review.taskId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(outsider.tasks.get({ taskId: inCi.taskId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await boardCard("outsider", inCi.taskId)).toBeUndefined();

    // A member not on the restricted project: not found, and off the board.
    const member = await harness.as(harness.fixture.a.member);
    await expect(member.tasks.get({ taskId: inCi.taskId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await boardCard("member", inCi.taskId)).toBeUndefined();
    await expect(member.home.board({ column: "in-review", projectId: hidden.projectId })).rejects.toMatchObject({ code: "NOT_FOUND" });

    // A member on it sees the same counts.
    const insider = await harness.as(harness.fixture.a.insider);
    expect((await insider.tasks.get({ taskId: inCi.taskId })).repos[0]?.ci).toMatchObject({ jobs: { done: 2, total: 4 } });
    expect((await boardCard("insider", inCi.taskId, hidden.projectId))?.status).toMatchObject({ ciJobs: { done: 2, total: 4 } });
  });
});

describe("what the column reads of its task (ticket 09)", () => {
  it("gives each repo's checkout folder and the agent's MCP servers by name, never their settings", async () => {
    projectCounter += 1;
    const place = await seedProject(harness, world, `thread-frame-${String(projectCounter)}`);
    await harness.test.db.repo.update({ where: { id: place.repoId }, data: { checkoutDir: "calculator-web" } });
    const task = await seedInCi(place, null);
    const member = await harness.as(harness.fixture.a.member);
    const before = await member.tasks.get({ taskId: task.taskId });
    // The folder the repo is checked out in, so the thread shows its paths relative to it.
    expect(before.repos.map((repo) => repo.checkoutDir)).toEqual(["calculator-web"]);
    expect(before.agent?.mcpServers).toEqual([]);

    // The profile's servers, by name only: their URLs, commands, headers and variables stay out.
    const profileId = before.agent?.id;
    expect(profileId).toBeDefined();
    await harness.test.db.agentProfile.update({
      where: { id: profileId ?? "" },
      data: {
        mcpServers: [
          { name: "github", transport: "http", url: "https://mcp.example.test/github", readOnly: true, headerSecretRefs: { Authorization: "builtin:mcp-github-token" } },
          { name: "linear", transport: "stdio", command: "npx", args: ["linear-mcp"], env: { LINEAR_TOKEN: "not-a-real-token" }, readOnly: false },
        ],
      },
    });
    const after = await member.tasks.get({ taskId: task.taskId });
    expect(after.agent?.mcpServers).toEqual(["github", "linear"]);
    const shown = JSON.stringify(after.agent);
    for (const setting of ["mcp.example.test", "mcp-github-token", "linear-mcp", "not-a-real-token"]) expect(shown).not.toContain(setting);

    // A stored list that no longer reads names no server, rather than failing the page.
    await harness.test.db.agentProfile.update({ where: { id: profileId ?? "" }, data: { mcpServers: [{ name: "Not A Slug", transport: "carrier-pigeon" }] } });
    expect((await member.tasks.get({ taskId: task.taskId })).agent?.mcpServers).toEqual([]);
    await harness.test.db.agentProfile.update({ where: { id: profileId ?? "" }, data: { mcpServers: [] } });
  });
});
