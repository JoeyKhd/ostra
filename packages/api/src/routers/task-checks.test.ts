import { createHash, randomUUID } from "node:crypto";

import { createNeedsYouItemInTx, recordChecksRunInTx, startCliSession } from "@ostra/domain";
import { blobIdSchema, gitShaSchema, memberIdSchema, repoIdSchema, userIdSchema } from "@ostra/protocol";
import type { CheckId, OrganizationId, ProjectId, RepoId, TaskEvent } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { serveCheckOutput } from "../services/check-output.ts";
import { appendEvent, createApiHarness, seedBoard, seedConnectionAndModel, seedLease, seedLinearConnection, seedPersonalRunner, seedProject, seedTask, seedTicket } from "../testing/index.ts";
import type { ApiHarness, SeededTask } from "../testing/index.ts";

// F-054, F-028, F-084, F-070, F-066, ticket 39: the Checks tab's data, "Ask the agent to fix", the
// check output's download, "Take it local", and what the task page now carries (PRs, how far behind,
// usage). Check output is untrusted text returned as data; it is served only to members of the project.

let harness: ApiHarness;
let orgA: OrganizationId;
let project: ProjectId;
let repoId: RepoId;
let lint: CheckId;
let unit: CheckId;
let settings: CheckId;
let world: Awaited<ReturnType<typeof seedConnectionAndModel>>;
const HEAD = gitShaSchema.parse(createHash("sha1").update("checks-head").digest("hex"));

const place = () => ({ organizationId: orgA, projectId: project });

beforeAll(async () => {
  harness = await createApiHarness();
  orgA = harness.fixture.a.organization.id;
  world = await seedConnectionAndModel(harness);
  const calc = await seedProject(harness, world, "calc");
  project = calc.projectId;
  repoId = calc.repoId;
  const admin = await harness.as(harness.fixture.a.admin);
  lint = (await admin.environments.checks.save({ projectId: project, name: "lint", command: "pnpm lint", repoId: null, timeoutSeconds: 600 })).checkId;
  unit = (await admin.environments.checks.save({ projectId: project, name: "unit-tests", command: "pnpm test", repoId, timeoutSeconds: 600 })).checkId;
  settings = (await admin.environments.checks.save({ projectId: project, name: "settings-json", command: "node scripts/check-settings.mjs", repoId, timeoutSeconds: 60 })).checkId;
});

afterAll(async () => {
  await harness.dispose();
});

/** Stores a blob the way core's blob service does for the built-in store: its row and one chunk. */
const storeBlob = async (task: SeededTask, text: string) => {
  const id = randomUUID();
  const bytes = new TextEncoder().encode(text);
  await harness.test.db.blob.create({
    data: { id, organizationId: orgA, projectId: project, taskId: task.taskId, store: "postgres", key: `postgres:${id}`, purpose: "check-output", contentType: "text/plain", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
  });
  await harness.test.db.blobChunk.create({ data: { organizationId: orgA, blobId: id, ordinal: 0, offset: 0, bytes } });
  return blobIdSchema.parse(id);
};

type Result = { readonly check: CheckId; readonly status: "passed" | "failed" | "timed-out" | "error"; readonly exitCode: number | null; readonly tail: string; readonly blob?: string };

/** One turn's checks as ingest stores them: the run rows, `check.finished` events, and the push after. */
const runTurn = async (task: SeededTask, turnOrdinal: number, results: readonly Result[], head: string | null = HEAD) => {
  const blobs = new Map<CheckId, ReturnType<typeof blobIdSchema.parse>>();
  for (const result of results) {
    if (result.blob !== undefined) {
      blobs.set(result.check, await storeBlob(task, result.blob));
    }
  }
  await harness.test.db.$transaction((tx) =>
    recordChecksRunInTx(tx, {
      taskId: task.taskId,
      sessionId: task.sessionId,
      turnOrdinal,
      checks: results.map((result) => ({ checkId: result.check, status: result.status, exitCode: result.exitCode, durationMs: 1_500, outputBlobId: blobs.get(result.check) ?? null })),
    }),
  );
  for (const result of results) {
    const event: TaskEvent = { kind: "check.finished", checkId: result.check, status: result.status, exitCode: result.exitCode, durationMs: 1_500, outputTail: result.tail, outputBlobId: blobs.get(result.check) ?? null };
    await appendEvent(harness, task, place(), event);
  }
  if (head !== null) {
    await appendEvent(harness, task, place(), { kind: "session.saved", turnOrdinal, repos: [{ repoId, headSha: gitShaSchema.parse(head), ahead: true, hiddenRefSha: null }], archive: null });
  }
};

const newTask = async (title: string, over: { readonly driver?: string | null; readonly state?: "running" | "in_review" | "stopped"; readonly going?: boolean } = {}) => {
  const driver = over.driver === undefined ? harness.fixture.a.member.id : over.driver;
  const task = await seedTask(harness, { ...place(), title, state: over.state ?? "in_review", driverMemberId: driver, creatorMemberId: driver, sessionState: over.state === "stopped" ? "ended" : over.state === "running" ? "running" : "idle" });
  if (over.going !== false && over.state !== "stopped") {
    await seedLease(harness, task, orgA, project, await seedPersonalRunner(harness, harness.fixture.a.member.id, `runner-${title}`));
  }
  await harness.test.db.taskRepo.create({ data: { organizationId: orgA, projectId: project, taskId: task.taskId, repoId, branchName: `ostra/${title}`, baseBranch: "main", state: "pr_open", headSha: HEAD, prNumber: 483, prUrl: "https://github.com/ostra-test/test1/pull/483" } });
  return task;
};

describe("tasks.checks", () => {
  it("F-054/c2: lists each turn's runs newest first with the output's end, the commit, the counts and a link only where the full output was saved", async () => {
    const task = await newTask("two-turns");
    await runTurn(task, 1, [
      { check: lint, status: "passed", exitCode: 0, tail: "lint ok" },
      { check: unit, status: "timed-out", exitCode: null, tail: "...killed after 600 s" },
      { check: settings, status: "passed", exitCode: 0, tail: "" },
    ]);
    const failedSha = gitShaSchema.parse(createHash("sha1").update("turn-2").digest("hex"));
    await runTurn(
      task,
      2,
      [
        { check: lint, status: "passed", exitCode: 0, tail: "lint ok again" },
        { check: unit, status: "passed", exitCode: 0, tail: "42 passed" },
        { check: settings, status: "failed", exitCode: 1, tail: "SyntaxError: Unexpected token } in settings.json <b>not html</b>", blob: "the whole output\nSyntaxError" },
      ],
      failedSha,
    );
    const member = await harness.as(harness.fixture.a.insider);
    const view = await member.tasks.checks({ taskId: task.taskId });
    expect(view.configured).toBe(true);
    expect(view.checks.map((check) => check.name)).toEqual(["lint", "unit-tests", "settings-json"]);
    expect(view.turns.map((turn) => turn.turnNumber)).toEqual([2, 1]);
    const [newest, older] = view.turns;
    expect(newest?.counts).toEqual({ passed: 2, failed: 1, timedOut: 0, error: 0, running: 0 });
    expect(older?.counts).toEqual({ passed: 2, failed: 0, timedOut: 1, error: 0, running: 0 });
    expect(newest?.heads).toEqual([{ repoId, repo: "ostra-test/test1", headSha: failedSha }]);
    expect(newest?.totalMs).toBe(4_500);
    // Runs are in the environment's order; the tail comes from that turn's own finish event.
    expect(newest?.runs.map((run) => [run.name, run.status, run.outputTail])).toEqual([
      ["lint", "passed", "lint ok again"],
      ["unit-tests", "passed", "42 passed"],
      ["settings-json", "failed", "SyntaxError: Unexpected token } in settings.json <b>not html</b>"],
    ]);
    expect(older?.runs.map((run) => [run.name, run.status, run.outputTail])).toEqual([
      ["lint", "passed", "lint ok"],
      ["unit-tests", "timed-out", "...killed after 600 s"],
      ["settings-json", "passed", ""],
    ]);
    expect(newest?.runs.find((run) => run.name === "unit-tests")).toMatchObject({ repo: "ostra-test/test1", command: "pnpm test", exitCode: 0 });
    expect(newest?.runs.find((run) => run.name === "lint")).toMatchObject({ repoId: null, repo: null });
    // A link only where the full output was saved, and it names this task and this run.
    const failedRun = newest?.runs.find((run) => run.name === "settings-json");
    expect(failedRun?.fullOutputPath).toBe(`/api/tasks/${task.taskId}/checks/${failedRun?.id ?? ""}/output`);
    expect(newest?.runs.filter((run) => run.fullOutputPath !== null)).toHaveLength(1);
    // "Ask the agent to fix" shows for the newest turn's failure.
    expect(view.fix).toEqual({ available: true, failing: 1, turnNumber: 2 });
    // No PR beyond the task repo's own is recorded yet, so none is listed.
    expect(view.pullRequests).toEqual([]);
  });

  it("F-054/c2: another organization's task and a task in a restricted project are not found; a project with no checks says so", async () => {
    const task = await newTask("hidden-checks");
    const outsider = await harness.as(harness.fixture.b.admin);
    await expect(outsider.tasks.checks({ taskId: task.taskId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const restricted = await seedTask(harness, { organizationId: orgA, projectId: harness.fixture.a.restrictedProject.id, title: "restricted checks" });
    await expect(
      (await harness.as(harness.fixture.a.member)).tasks.checks({ taskId: restricted.taskId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const insider = await harness.as(harness.fixture.a.insider);
    const none = await insider.tasks.checks({ taskId: restricted.taskId });
    expect(none).toMatchObject({ configured: false, checks: [], turns: [], pullRequests: [], fix: { available: false, failing: 0, turnNumber: null } });
  });

  it("F-054/c3: a draft PR is reported with whether ostra made it a draft, and all the PRs of a repo are listed", async () => {
    const task = await newTask("drafts");
    const taskRepo = await harness.test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId } });
    await harness.test.db.taskPullRequest.create({ data: { organizationId: orgA, projectId: project, taskRepoId: taskRepo.id, number: 483, url: "https://github.com/ostra-test/test1/pull/483", branchName: "ostra/drafts", state: "open", draft: true, draftByOstra: true } });
    const view = await (await harness.as(harness.fixture.a.insider)).tasks.checks({ taskId: task.taskId });
    expect(view.pullRequests).toEqual([{ repoId, repo: "ostra-test/test1", number: 483, url: "https://github.com/ostra-test/test1/pull/483", state: "open", draft: true, draftByOstra: true }]);
  });
});

describe("tasks.checks across several repos", () => {
  it("F-098/c3: names the task's repos in the project's order, and a turn's run of a check per repo with its repo and its commit there", async () => {
    const { projectId, repoId: first } = await seedProject(harness, world, "two-repos");
    const at = { organizationId: orgA, projectId };
    const firstRow = await harness.test.db.repo.findUniqueOrThrow({ where: { id: first } });
    // The second repo comes first in the project's order.
    const secondRow = await harness.test.db.repo.create({
      data: { ...at, connectionId: firstRow.connectionId, installationId: firstRow.installationId, hostRepoId: "host-calculator-api", fullName: "ostra-test/calculator-api", defaultBranch: "main", checkoutDir: "calculator-api", position: firstRow.position - 1 },
    });
    const second = repoIdSchema.parse(secondRow.id);
    const admin = await harness.as(harness.fixture.a.admin);
    const webTests = (await admin.environments.checks.save({ projectId, name: "web-tests", command: "pnpm test", repoId: first, timeoutSeconds: 600 })).checkId;
    const apiTests = (await admin.environments.checks.save({ projectId, name: "api-tests", command: "pnpm test", repoId: second, timeoutSeconds: 600 })).checkId;
    const member = harness.fixture.a.member.id;
    const task = await seedTask(harness, { ...at, title: "two-repos", state: "in_review", driverMemberId: member, creatorMemberId: member, sessionState: "idle" });
    for (const repo of [first, second]) {
      await harness.test.db.taskRepo.create({ data: { ...at, taskId: task.taskId, repoId: repo, branchName: "ostra/two-repos", baseBranch: "main" } });
    }
    await harness.test.db.$transaction((tx) =>
      recordChecksRunInTx(tx, {
        taskId: task.taskId,
        sessionId: task.sessionId,
        turnOrdinal: 1,
        checks: [
          { checkId: webTests, status: "passed", exitCode: 0, durationMs: 1_000, outputBlobId: null },
          { checkId: apiTests, status: "failed", exitCode: 1, durationMs: 2_000, outputBlobId: null },
        ],
      }),
    );
    const webHead = gitShaSchema.parse(createHash("sha1").update("web").digest("hex"));
    const apiHead = gitShaSchema.parse(createHash("sha1").update("api").digest("hex"));
    await appendEvent(harness, task, at, {
      kind: "session.saved",
      turnOrdinal: 1,
      repos: [
        { repoId: second, headSha: apiHead, ahead: true, hiddenRefSha: null },
        { repoId: first, headSha: webHead, ahead: true, hiddenRefSha: null },
      ],
      archive: null,
    });
    const view = await (await harness.as(harness.fixture.a.insider)).tasks.checks({ taskId: task.taskId });
    expect(view.repos).toEqual([
      { repoId: second, repo: "ostra-test/calculator-api" },
      { repoId: first, repo: "ostra-test/test1" },
    ]);
    const [turn] = view.turns;
    expect(turn?.runs.map((run) => [run.name, run.repo, run.status])).toEqual([
      ["web-tests", "ostra-test/test1", "passed"],
      ["api-tests", "ostra-test/calculator-api", "failed"],
    ]);
    expect(turn?.heads.map((head) => [head.repo, head.headSha])).toEqual([
      ["ostra-test/calculator-api", apiHead],
      ["ostra-test/test1", webHead],
    ]);
  });
});

describe("tasks.fixChecks", () => {
  it("F-054/c2: sends the failing checks as one message, once, to the driver's session; another member is told to take over", async () => {
    const task = await newTask("fix", { state: "running" });
    await runTurn(task, 1, [
      { check: lint, status: "passed", exitCode: 0, tail: "ok" },
      { check: settings, status: "failed", exitCode: 1, tail: "SyntaxError: bad token", blob: "full" },
    ]);
    const other = await harness.as(harness.fixture.a.insider);
    await expect(other.tasks.fixChecks({ taskId: task.taskId })).rejects.toMatchObject({ code: "FORBIDDEN", message: "Take over to send" });
    harness.fakes.outbox.clear();
    const driver = await harness.as(harness.fixture.a.member);
    const first = await driver.tasks.fixChecks({ taskId: task.taskId });
    expect(first).toEqual({ checks: 1, delivery: "steer" });
    const messages = (await harness.test.db.event.findMany({ where: { taskId: task.taskId, kind: "user.message" } })).map((row) => row.payload);
    expect(messages).toHaveLength(1);
    expect(JSON.stringify(messages[0])).toContain("settings-json");
    expect(JSON.stringify(messages[0])).toContain("fix-checks");
    expect(harness.fakes.outbox.commands.filter((command) => command.kind === "steer")).toHaveLength(1);
    // Asking again about the same failures is the same message.
    await driver.tasks.fixChecks({ taskId: task.taskId });
    expect(await harness.test.db.event.count({ where: { taskId: task.taskId, kind: "user.message" } })).toBe(1);
  });

  it("F-054/c2: with every check passing there is nothing to fix", async () => {
    const task = await newTask("all-pass");
    await runTurn(task, 1, [{ check: lint, status: "passed", exitCode: 0, tail: "ok" }]);
    await expect((await harness.as(harness.fixture.a.member)).tasks.fixChecks({ taskId: task.taskId })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});

describe("a check's full output", () => {
  it("F-054/c2: is served as plain text and an attachment to members of the project, and to no one else", async () => {
    const task = await newTask("download");
    await runTurn(task, 1, [{ check: settings, status: "failed", exitCode: 1, tail: "tail", blob: "line one\n<script>alert(1)</script>\n\u001b[31mred\u001b[0m" }]);
    const view = await (await harness.as(harness.fixture.a.insider)).tasks.checks({ taskId: task.taskId });
    const run = view.turns[0]?.runs[0];
    expect(run?.fullOutputPath).not.toBeNull();
    const asMember = await harness.contextOf(harness.fixture.a.insider);
    const response = await serveCheckOutput(asMember, task.taskId, run?.id ?? "");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="settings-json-turn-1.txt"');
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    // The bytes are the output as it was, uninterpreted.
    expect(await response.text()).toBe("line one\n<script>alert(1)</script>\n\u001b[31mred\u001b[0m");

    // Another organization's member, a member of another project, a signed-out request, a run of
    // another task and a task id that does not hold the run: all the same.
    expect((await serveCheckOutput(await harness.contextOf(harness.fixture.b.admin), task.taskId, run?.id ?? "")).status).toBe(404);
    expect((await serveCheckOutput({ ...asMember, user: null, member: null }, task.taskId, run?.id ?? "")).status).toBe(401);
    const other = await newTask("download-other");
    expect((await serveCheckOutput(asMember, other.taskId, run?.id ?? "")).status).toBe(404);
    expect((await serveCheckOutput(asMember, task.taskId, randomUUID())).status).toBe(404);
  });

  it("F-054/c2: a run in a restricted project is not served to a member who is not on it, and a blob store that doesn't answer is said so", async () => {
    const restrictedTask = await seedTask(harness, { organizationId: orgA, projectId: harness.fixture.a.restrictedProject.id, title: "restricted output" });
    const runId = randomUUID();
    const blobId = randomUUID();
    await harness.test.db.blob.create({ data: { id: blobId, organizationId: orgA, projectId: harness.fixture.a.restrictedProject.id, taskId: restrictedTask.taskId, store: "s3", key: "blobs/x", purpose: "check-output", contentType: "text/plain", size: 3, sha256: "0".repeat(64) } });
    await harness.test.db.checkRun.create({
      data: { id: runId, organizationId: orgA, projectId: harness.fixture.a.restrictedProject.id, taskId: restrictedTask.taskId, sessionId: restrictedTask.sessionId, turnOrdinal: 1, checkId: lint, name: "lint", status: "failed", outputBlobId: blobId },
    });
    expect((await serveCheckOutput(await harness.contextOf(harness.fixture.a.member), restrictedTask.taskId, runId)).status).toBe(404);
    const insider = await serveCheckOutput(await harness.contextOf(harness.fixture.a.insider), restrictedTask.taskId, runId);
    // The harness's stand-in for core can't reach an S3-compatible store (core's own test reads one).
    expect(insider.status).toBe(503);
    expect(await insider.text()).toContain("try again");
  });
});

describe("take it local", () => {
  it("F-028/c1: names the ostra checkout line by the ticket's key or the task's ID, the login line, and the plain git commands per repo", async () => {
    const linear = await seedLinearConnection(harness);
    const board = await seedBoard(harness, { projectId: project, connectionId: linear, key: "OST" });
    const ticketId = await seedTicket(harness, { projectId: project, boardId: board, connectionId: linear, key: "OST-142" });
    const withTicket = await newTask("ticket-local");
    await harness.test.db.task.update({ where: { id: withTicket.taskId }, data: { ticketId, ticketKey: "OST-142", boardId: board } });
    const prompt = await newTask("prompt-local");
    const member = await harness.as(harness.fixture.a.insider);

    const forTicket = await member.tasks.local({ taskId: withTicket.taskId });
    expect(forTicket).toMatchObject({
      ref: "OST-142",
      checkoutCommand: "ostra checkout OST-142",
      loginCommand: "ostra login --server http://localhost:3000",
      serverUrl: "http://localhost:3000",
      hasCliSession: false,
    });
    expect(forTicket.repos).toEqual([
      {
        fullName: "ostra-test/test1",
        branch: "ostra/ticket-local",
        baseBranch: "main",
        pushed: true,
        pr: { number: 483, url: "https://github.com/ostra-test/test1/pull/483", state: "open" },
        gitCommands: ["git fetch origin ostra/ticket-local", "git switch ostra/ticket-local"],
      },
    ]);
    const forPrompt = await member.tasks.local({ taskId: prompt.taskId });
    expect(forPrompt.checkoutCommand).toBe(`ostra checkout ${prompt.taskId}`);

    // With a CLI session of their own the login hint goes; another member's session does not count.
    const started = await startCliSession({ db: harness.test.db, ...harness.deps.ports }, { userId: userIdSchema.parse(harness.fixture.a.insider.userId), memberId: memberIdSchema.parse(harness.fixture.a.insider.id), machineName: "sam-laptop" });
    expect(started.ok).toBe(true);
    expect((await member.tasks.local({ taskId: prompt.taskId })).hasCliSession).toBe(true);
    expect((await (await harness.as(harness.fixture.a.member)).tasks.local({ taskId: prompt.taskId })).hasCliSession).toBe(false);
    await expect((await harness.as(harness.fixture.b.admin)).tasks.local({ taskId: prompt.taskId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("F-028/c1: a branch name that a shell would read is quoted, and nothing is pushed before the first turn", async () => {
    const task = await newTask("quoting");
    await harness.test.db.taskRepo.updateMany({ where: { taskId: task.taskId }, data: { branchName: "ostra/it's; rm -rf ~", headSha: null, state: "no_branch" } });
    const local = await (await harness.as(harness.fixture.a.member)).tasks.local({ taskId: task.taskId });
    expect(local.repos[0]).toMatchObject({ pushed: false, gitCommands: ["git fetch origin 'ostra/it'\\''s; rm -rf ~'", "git switch 'ostra/it'\\''s; rm -rf ~'"] });
  });
});

describe("tasks.get", () => {
  it("F-084/c1,c3: returns the task's tokens in four kinds, spend and agent time, in total and per turn, with estimates marked", async () => {
    const task = await newTask("usage");
    const caller = await harness.as(harness.fixture.a.insider);
    const empty = await caller.tasks.get({ taskId: task.taskId });
    expect(empty.usage?.totals).toMatchObject({ inputTokens: 0, outputTokens: 0, spentMicroUsd: 0, agentMs: 0, estimated: false });
    const turn = await harness.test.db.turn.create({
      data: { organizationId: orgA, projectId: project, taskId: task.taskId, sessionId: task.sessionId, ordinal: 1, startSeq: 1, endedAt: new Date(), inputTokens: 1_200, outputTokens: 300, cacheReadTokens: 5_000, cacheWriteTokens: 400, spentMicroUsd: 42_000, estimated: true, agentMs: 61_000 },
    });
    await harness.test.db.session.update({ where: { id: task.sessionId }, data: { inputTokens: 1_200, outputTokens: 300, cacheReadTokens: 5_000, cacheWriteTokens: 400 } });
    await harness.test.db.task.update({ where: { id: task.taskId }, data: { spentMicroUsd: 42_000 } });
    const got = await caller.tasks.get({ taskId: task.taskId });
    expect(got.usage?.totals).toEqual({ inputTokens: 1_200, outputTokens: 300, cacheReadTokens: 5_000, cacheWriteTokens: 400, spentMicroUsd: 42_000, agentMs: 61_000, reasoningTokens: 0, estimated: true });
    expect(got.usage?.turns).toEqual([
      expect.objectContaining({ turnId: turn.id, ordinal: 1, inputTokens: 1_200, outputTokens: 300, cacheReadTokens: 5_000, cacheWriteTokens: 400, spentMicroUsd: 42_000, agentMs: 61_000, estimated: true }),
    ]);
  });

  it("F-070/c1, F-066/c1: carries each repo's behind count and every PR it has had", async () => {
    const task = await newTask("behind");
    const taskRepo = await harness.test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId } });
    await harness.test.db.taskRepo.update({ where: { id: taskRepo.id }, data: { behindBy: 3, behindCheckedAt: new Date() } });
    await harness.test.db.taskPullRequest.createMany({
      data: [
        { organizationId: orgA, projectId: project, taskRepoId: taskRepo.id, number: 480, url: "https://github.com/ostra-test/test1/pull/480", branchName: "ostra/behind", state: "merged", draft: false, openedAt: new Date(Date.now() - 86_400_000), closedAt: new Date() },
        { organizationId: orgA, projectId: project, taskRepoId: taskRepo.id, number: 483, url: "https://github.com/ostra-test/test1/pull/483", branchName: "ostra/behind-2", state: "open", draft: true, draftByOstra: true },
      ],
    });
    const got = await (await harness.as(harness.fixture.a.insider)).tasks.get({ taskId: task.taskId });
    const repo = got.repos[0];
    expect(repo?.behindBy).toBe(3);
    expect(repo?.behindCheckedAt).not.toBeNull();
    expect(repo?.pullRequests.map((pr) => [pr.number, pr.state, pr.draft, pr.draftByOstra])).toEqual([
      [480, "merged", false, false],
      [483, "open", true, true],
    ]);
  });
});

describe("tasks.updateBranch", () => {
  it("F-070/c1: sends one message naming the repo that is behind and its base, once however often it is pressed; a task behind nowhere refuses it", async () => {
    const task = await newTask("update", { state: "running" });
    const taskRepo = await harness.test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId } });
    const driver = await harness.as(harness.fixture.a.member);
    // Nothing behind yet: refused, and nothing is sent.
    await expect(driver.tasks.updateBranch({ taskId: task.taskId })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await harness.test.db.taskRepo.update({ where: { id: taskRepo.id }, data: { behindBy: 2, behindCheckedAt: new Date() } });
    harness.fakes.outbox.clear();
    const [first, second] = await Promise.all([driver.tasks.updateBranch({ taskId: task.taskId }), driver.tasks.updateBranch({ taskId: task.taskId })]);
    expect(first).toEqual({ repos: 1, delivery: "steer" });
    expect(second).toEqual({ repos: 1, delivery: "steer" });
    const messages = await harness.test.db.event.findMany({ where: { taskId: task.taskId, kind: "user.message" } });
    expect(messages).toHaveLength(1);
    expect(JSON.stringify(messages[0]?.payload)).toContain("ostra-test/test1");
    expect(JSON.stringify(messages[0]?.payload)).toContain("update-branch");
    expect(harness.fakes.outbox.commands.filter((command) => command.kind === "steer")).toHaveLength(1);
  });

  it("F-070/c1: another member is told to take over while a session is going, and another organization's task is not found", async () => {
    const task = await newTask("update-other", { state: "running" });
    await harness.test.db.taskRepo.updateMany({ where: { taskId: task.taskId }, data: { behindBy: 1, behindCheckedAt: new Date() } });
    await expect((await harness.as(harness.fixture.a.insider)).tasks.updateBranch({ taskId: task.taskId })).rejects.toMatchObject({ code: "FORBIDDEN", message: "Take over to send" });
    await expect((await harness.as(harness.fixture.b.admin)).tasks.updateBranch({ taskId: task.taskId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await harness.test.db.event.count({ where: { taskId: task.taskId, kind: "user.message" } })).toBe(0);
  });
});

describe("a ticket closed while the task ran", () => {
  const closedTask = async (title: string) => {
    const task = await newTask(title, { state: "running" });
    await harness.test.db.task.update({ where: { id: task.taskId }, data: { state: "needs_you", needsYouReason: "ticket_closed" } });
    await harness.test.db.$transaction((tx) => createNeedsYouItemInTx(harness.deps.ports, tx, { ...place(), taskId: task.taskId, reason: "ticket_closed", audience: "driver" }));
    return task;
  };

  it("F-066/c3: \"Keep working\" dismisses the item and sends \"Carry on\" once; a second press finds nothing waiting; another member is told to take over", async () => {
    const task = await closedTask("keep-going");
    await expect((await harness.as(harness.fixture.a.insider)).tasks.keepWorking({ taskId: task.taskId })).rejects.toMatchObject({ code: "FORBIDDEN", message: "Take over to send" });
    const driver = await harness.as(harness.fixture.a.member);
    harness.fakes.outbox.clear();
    expect(await driver.tasks.keepWorking({ taskId: task.taskId })).toEqual({ delivery: "steer" });
    const messages = await harness.test.db.event.findMany({ where: { taskId: task.taskId, kind: "user.message" } });
    expect(messages).toHaveLength(1);
    expect(JSON.stringify(messages[0]?.payload)).toContain("keep-working");
    expect(await harness.test.db.needsYouItem.count({ where: { taskId: task.taskId, reason: "ticket_closed", state: "open" } })).toBe(0);
    expect(harness.fakes.outbox.commands.filter((command) => command.kind === "steer")).toHaveLength(1);
    await expect(driver.tasks.keepWorking({ taskId: task.taskId })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("F-101/c4: at a round limit, Keep working answers the cap's item, resets the round counters and sends the cap's words once", async () => {
    const task = await newTask("cap-keep-going", { state: "running" });
    await harness.test.db.task.update({ where: { id: task.taskId }, data: { state: "needs_you", needsYouReason: "round_cap", ciRounds: 2, automaticTurns: 3 } });
    await harness.test.db.$transaction((tx) => createNeedsYouItemInTx(harness.deps.ports, tx, { ...place(), taskId: task.taskId, reason: "round_cap", audience: "driver" }));
    const driver = await harness.as(harness.fixture.a.member);
    await driver.tasks.keepWorking({ taskId: task.taskId });
    const messages = await harness.test.db.event.findMany({ where: { taskId: task.taskId, kind: "user.message" } });
    expect(messages).toHaveLength(1);
    expect(JSON.stringify(messages[0]?.payload)).toContain("Keep working on what the last round sent you");
    expect(await harness.test.db.needsYouItem.count({ where: { taskId: task.taskId, reason: "round_cap", state: "open" } })).toBe(0);
    expect(await harness.test.db.task.findUniqueOrThrow({ where: { id: task.taskId }, select: { ciRounds: true, automaticTurns: true } })).toEqual({ ciRounds: 0, automaticTurns: 0 });
    await expect(driver.tasks.keepWorking({ taskId: task.taskId })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("F-066/c3: \"Stop the task\" is the other answer: the task stops as requested, and \"Keep working\" is then refused", async () => {
    const task = await closedTask("stop-it");
    const driver = await harness.as(harness.fixture.a.member);
    await driver.tasks.stop({ taskId: task.taskId });
    const stopped = await harness.test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    expect(stopped).toMatchObject({ state: "stopped", stoppedReason: "requested" });
    await expect(driver.tasks.keepWorking({ taskId: task.taskId })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect((await harness.as(harness.fixture.b.admin)).tasks.keepWorking({ taskId: task.taskId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
