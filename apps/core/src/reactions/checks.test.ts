import { randomBytes } from "node:crypto";

import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { createTestDatabase, seedInstallation, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import {
  askAgentToFixChecks,
  CHECKS_SECTION_END,
  CHECKS_SECTION_START,
  checkRunsForMember,
  postgresAuditLog,
  postgresChangeNotices,
  postgresCommandOutbox,
  systemClock,
} from "@ostra/domain";
import type { M3Deps, MemberScope, SessionTimers } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { checkIdSchema, gitShaSchema, leaseEpochSchema, memberIdSchema, readMarkedBlocks, repoIdSchema, segmentIdSchema, taskEventSchema, turnIdSchema } from "@ostra/protocol";
import type { CheckId, CheckStatus, RepoId, TaskEvent } from "@ostra/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildTaskSpec } from "../dispatch/task-spec.ts";
import type { RunnerRef } from "../gateway/context.ts";
import { createIngest } from "../ingest/ingest.ts";
import type { Ingest } from "../ingest/ingest.ts";
import { createLiveTextWriter } from "../ingest/live-text.ts";
import type { LiveTextWriter } from "../ingest/live-text.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { acceptedTask, jobContext, sha } from "../testing/turns.ts";
import type { DrivenTask } from "../testing/turns.ts";
import { INSTALLATION_ID, seedOnlineRunner, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";
import { openPullRequestsHandler } from "./session-end.ts";
import type { ReactionDeps } from "./session-end.ts";

// Ticket 23 (F-054, ADR 0052): checks before the PR. The runner runs the environment's checks after
// a turn with changes and reports each; core keeps a run per check and turn, writes a "Checks"
// section into each PR's body, opens a draft when one failed, makes an open PR a draft, marks ready
// a PR ostra made a draft once they pass, and sends the failing ones to the agent on request.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let world: World;
let otherWorld: World;
let ingest: Ingest;
let liveText: LiveTextWriter;
let reactionDeps: ReactionDeps;
let deps: M3Deps;
let runner: RunnerRef;
let secondRepoId: RepoId;
let driver: MemberScope;
let outsider: MemberScope;
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const records: LogRecord[] = [];
const logger = createLogger((record) => records.push(record));

const scopeOf = (organizationId: MemberScope["organizationId"], memberId: string, role: "admin" | "member" = "member"): MemberScope => ({
  organizationId,
  memberId: memberIdSchema.parse(memberId),
  role,
  projectRoles: new Map(),
});

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  otherWorld = await seedWorld(test.db, { codeHost, secretStore }, fixture.b.organization.id, fixture.b.project.id, { fullName: "ostra-test/other" });
  // A second repo of the project, on the same App, for the two-repo cases (Q188).
  const first = await test.db.repo.findUniqueOrThrow({ where: { id: world.repoId } });
  await seedInstallation(test.db, { organizationId: world.organizationId, connectionId: first.connectionId, installationId: INSTALLATION_ID });
  const second = await test.db.repo.create({
    data: {
      organizationId: world.organizationId,
      projectId: world.projectId,
      connectionId: first.connectionId,
      installationId: INSTALLATION_ID,
      hostRepoId: "host-ostra-test/test2",
      fullName: "ostra-test/test2",
      defaultBranch: "main",
      checkoutDir: "test2",
    },
  });
  secondRepoId = repoIdSchema.parse(second.id);
  codeHost.templates.set("ostra-test/test2", "## What\n");
  const timers: SessionTimers = { sessionMaxMs: 120 * 60_000, boxReleaseIdleMs: 14 * 24 * 3_600_000, cancelInTx: (tx, job, payload) => jobs.cancelInTx(tx, job, payload) };
  liveText = createLiveTextWriter({ db: test.db, logger });
  ingest = createIngest({ db: test.db, jobs, notices: postgresChangeNotices, clock: systemClock, liveText, logger, timers, outbox: postgresCommandOutbox });
  const adapters = { codeHost, secretStore, modelProvider: new FakeModelProvider() };
  reactionDeps = { db: test.db, jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, adapters, publicUrl: "http://localhost:3000", logger, timers };
  deps = { db: test.db, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, adapters };
  runner = await seedOnlineRunner(test.db, fixture.a.organization.id, { kind: "personal", memberId: fixture.a.member.id }, 50);
  await test.db.runnerPresence.update({ where: { runnerId: runner.runnerId }, data: { minor: 2 } });
  driver = scopeOf(fixture.a.organization.id, fixture.a.member.id);
  outsider = scopeOf(fixture.b.organization.id, fixture.b.admin.id, "admin");
});

afterAll(async () => {
  await liveText.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

const repo = (): RepoId => repoIdSchema.parse(world.repoId);

/** The environment's checks, replaced: `lint` and `test` in repo 1, and a repo-less `typecheck` when asked. */
let checkIds: { readonly lint: CheckId; readonly test: CheckId; readonly typecheck: CheckId; readonly test2: CheckId };

beforeEach(async () => {
  await test.db.check.deleteMany({ where: { projectId: world.projectId } });
  const environment = await test.db.environment.findUniqueOrThrow({ where: { projectId: world.projectId } });
  const make = async (name: string, command: string, repoId: string | null, position: number) =>
    checkIdSchema.parse(
      (
        await test.db.check.create({
          data: { organizationId: world.organizationId, projectId: world.projectId, environmentId: environment.id, name, command, repoId, position, timeoutSeconds: 300 },
        })
      ).id,
    );
  checkIds = {
    lint: await make("lint", "pnpm lint", world.repoId, 0),
    test: await make("test", "pnpm test", world.repoId, 1),
    typecheck: await make("typecheck", "pnpm -r typecheck", null, 2),
    test2: await make("test2", "pnpm test", secondRepoId, 3),
  };
});

type CheckResult = { readonly checkId: CheckId; readonly name: string; readonly repoId: RepoId | null; readonly status: CheckStatus; readonly tail?: string };

/** A running task, its first turn started, on one repo or both. */
const runningTask = async (repos: readonly RepoId[] = [repo()]): Promise<DrivenTask> => {
  const task = await acceptedTask({ db: test.db, jobs, ingest, logger }, world, fixture.a.member, runner);
  const row = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
  for (const repoId of repos.filter((id) => id !== repo())) {
    await test.db.taskRepo.create({ data: { organizationId: world.organizationId, projectId: world.projectId, taskId: task.taskId, repoId, branchName: row.branchName, baseBranch: "main" } });
  }
  return task;
};

/** One turn: pushes to `heads`, ends, runs `checks`, and saves; then the PR opener runs for the save. */
const turn = async (task: DrivenTask, ordinal: number, heads: readonly { readonly repoId: RepoId; readonly head: string }[], checks: readonly CheckResult[]): Promise<void> => {
  const { branchName } = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
  const turnId = turnIdSchema.parse(`turn-${String(ordinal)}`);
  const all = await test.db.taskRepo.findMany({ where: { taskId: task.taskId } });
  const events: TaskEvent[] = [
    { kind: "turn.started", turnId },
    { kind: "agent.message", turnId, segmentId: segmentIdSchema.parse(`s${String(ordinal)}`), text: `turn ${String(ordinal)}` },
    ...heads.map((head): TaskEvent => ({ kind: "git.pushed", repoId: head.repoId, branch: branchName, headSha: sha(head.head), ref: `refs/heads/${branchName}` })),
    { kind: "turn.ended", turnId, stopReason: "end_turn" },
  ];
  for (const check of checks) {
    events.push(
      { kind: "check.started", checkId: check.checkId, repoId: check.repoId, name: check.name },
      {
        kind: "check.finished",
        checkId: check.checkId,
        status: check.status,
        exitCode: check.status === "passed" ? 0 : 1,
        durationMs: 1200,
        outputTail: check.tail ?? `${check.name} output`,
        outputBlobId: null,
      },
    );
  }
  events.push({
    kind: "session.saved",
    turnOrdinal: ordinal,
    repos: all.map((taskRepo) => {
      const pushed = heads.find((head) => head.repoId === taskRepo.repoId);
      const headSha = pushed === undefined ? gitShaSchema.nullable().parse(taskRepo.headSha) : sha(pushed.head);
      return { repoId: repoIdSchema.parse(taskRepo.repoId), headSha, ahead: headSha !== null, hiddenRefSha: sha(`wip-${String(ordinal)}`) };
    }),
    archive: null,
    checks: checks.map((check) => ({ checkId: check.checkId, status: check.status })),
  });
  await task.send(...events);
  const saved = await test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "session.saved" }, orderBy: { seq: "desc" } });
  const payload = { organizationId: task.organizationId, taskId: task.taskId, sessionId: task.sessionId, eventSeq: saved.seq };
  if ((await jobs.find("task.open-pull-requests", payload)).length > 0) {
    await openPullRequestsHandler(reactionDeps)(jobContext("task.open-pull-requests", payload, logger));
  }
};

const lint = (status: CheckStatus, tail?: string): CheckResult => ({ checkId: checkIds.lint, name: "lint", repoId: repo(), status, ...(tail === undefined ? {} : { tail }) });
const unit = (status: CheckStatus, tail?: string): CheckResult => ({ checkId: checkIds.test, name: "test", repoId: repo(), status, ...(tail === undefined ? {} : { tail }) });
const typecheck = (status: CheckStatus): CheckResult => ({ checkId: checkIds.typecheck, name: "typecheck", repoId: null, status });

const pullOf = (task: DrivenTask, fullName = "ostra-test/test1") => {
  const pulls = codeHost.pulls.filter((pull) => pull.repo === fullName && pull.body.includes(task.taskId));
  expect(pulls).toHaveLength(1);
  const [pull] = pulls;
  if (pull === undefined) {
    throw new Error("no PR");
  }
  return pull;
};

const sections = (body: string): number => body.split(CHECKS_SECTION_START).length - 1;

describe("checks before the PR (F-054)", () => {
  it("F-054: the task spec carries the environment's checks in their order, with their repos and timeouts", async () => {
    const task = await runningTask();
    const row = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    const spec = await buildTaskSpec({ db: test.db, codeHost, secretStore }, { taskId: task.taskId, runnerId: runner.runnerId, leaseEpoch: leaseEpochSchema.parse(row.leaseEpoch) });
    expect(spec.ok && spec.spec.checks).toEqual([
      { checkId: checkIds.lint, name: "lint", command: "pnpm lint", repoId: world.repoId, timeoutSeconds: 300 },
      { checkId: checkIds.test, name: "test", command: "pnpm test", repoId: world.repoId, timeoutSeconds: 300 },
      // The repo-less check runs at the workspace root; test2's repo isn't the task's.
      { checkId: checkIds.typecheck, name: "typecheck", command: "pnpm -r typecheck", repoId: null, timeoutSeconds: 300 },
    ]);
  });

  it("F-054: a passing turn opens a ready PR with the Checks section, and each check's run is kept", async () => {
    const task = await runningTask();
    await turn(task, 1, [{ repoId: repo(), head: "pass-1" }], [lint("passed"), unit("passed")]);
    const pull = pullOf(task);
    expect(pull.draft).toBe(false);
    expect(sections(pull.body)).toBe(1);
    expect(pull.body).toContain("- **lint**: ✅ passed\n- **test**: ✅ passed");
    // The section sits between the agent's text and ostra's footer.
    expect(pull.body.indexOf("turn 1")).toBeLessThan(pull.body.indexOf(CHECKS_SECTION_START));
    expect(pull.body.indexOf(CHECKS_SECTION_END)).toBeLessThan(pull.body.indexOf("Opened by [ostra]"));
    const runs = await test.db.checkRun.findMany({ where: { taskId: task.taskId }, orderBy: { name: "asc" } });
    expect(runs.map((run) => [run.name, run.status, run.turnOrdinal, run.repoId, run.durationMs, run.finishedAt !== null])).toEqual([
      ["lint", "passed", 1, world.repoId, 1200, true],
      ["test", "passed", 1, world.repoId, 1200, true],
    ]);
    expect(await test.db.taskPullRequest.findFirst({ where: { taskRepo: { taskId: task.taskId } } })).toMatchObject({ number: pull.number, draft: false, draftByOstra: false, state: "open" });
    expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "in_review" });
  });

  it("F-054: a failing turn opens a draft; a later pass marks it ready; the section is edited, not appended", async () => {
    const task = await runningTask();
    await turn(task, 1, [{ repoId: repo(), head: "fail-1" }], [lint("passed"), unit("failed", "FAIL src/app.test.ts\nexpected 2, got 3")]);
    let pull = pullOf(task);
    expect(pull.draft).toBe(true);
    expect(pull.body).toContain("- **test**: ❌ failed");
    expect(pull.body).toContain("expected 2, got 3");
    expect(await test.db.taskPullRequest.findFirst({ where: { taskRepo: { taskId: task.taskId } } })).toMatchObject({ draft: true, draftByOstra: true });
    // The task is in review either way.
    expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "in_review" });

    // The next turn fixes it: the PR ostra made a draft is marked ready, and its section edited.
    const draftCalls = codeHost.draftCalls.length;
    await turn(task, 2, [{ repoId: repo(), head: "fail-2" }], [lint("passed"), unit("passed")]);
    pull = pullOf(task);
    expect(pull.draft).toBe(false);
    expect(codeHost.draftCalls.slice(draftCalls)).toEqual([{ repo: "ostra-test/test1", number: pull.number, draft: false }]);
    expect(sections(pull.body)).toBe(1);
    expect(pull.body).toContain("- **test**: ✅ passed");
    expect(pull.body).not.toContain("expected 2, got 3");
    expect(pull.body).toContain("turn 1");
    expect(await test.db.taskPullRequest.findFirst({ where: { taskRepo: { taskId: task.taskId } } })).toMatchObject({ draft: false, draftByOstra: false });

    // It fails again: the open PR becomes a draft ostra made, still one section.
    await turn(task, 3, [{ repoId: repo(), head: "fail-3" }], [lint("failed"), unit("passed")]);
    pull = pullOf(task);
    expect(pull.draft).toBe(true);
    expect(sections(pull.body)).toBe(1);
    expect(pull.body).toContain("- **lint**: ❌ failed");
    expect(await test.db.taskPullRequest.findFirst({ where: { taskRepo: { taskId: task.taskId } } })).toMatchObject({ draft: true, draftByOstra: true });
    expect(await test.db.checkRun.count({ where: { taskId: task.taskId } })).toBe(6);
  });

  it("F-054: a PR a person made a draft stays a draft when the checks pass, and a person's edit of the description stays", async () => {
    const task = await runningTask();
    await turn(task, 1, [{ repoId: repo(), head: "person-1" }], [lint("passed"), unit("passed")]);
    const opened = pullOf(task);
    expect(opened.draft).toBe(false);
    // A reviewer makes it a draft on GitHub, and adds a line to the description.
    codeHost.setDraftByPerson("ostra-test/test1", opened.number, true);
    const index = codeHost.pulls.findIndex((pull) => pull.number === opened.number && pull.repo === opened.repo);
    const current = codeHost.pulls[index];
    if (current !== undefined) {
      codeHost.pulls[index] = { ...current, body: `Reviewer's note: wait for the design.\n\n${current.body}` };
    }
    const draftCalls = codeHost.draftCalls.length;
    await turn(task, 2, [{ repoId: repo(), head: "person-2" }], [lint("passed"), unit("passed")]);
    const pull = pullOf(task);
    expect(pull.draft).toBe(true);
    expect(codeHost.draftCalls.slice(draftCalls)).toEqual([]);
    expect(pull.body).toContain("Reviewer's note: wait for the design.");
    expect(sections(pull.body)).toBe(1);
    expect(await test.db.taskPullRequest.findFirst({ where: { taskRepo: { taskId: task.taskId } } })).toMatchObject({ draft: true, draftByOstra: false });
  });

  it("F-054: check output with markdown and HTML is escaped in a code block, cut to its last 40 lines", async () => {
    const task = await runningTask();
    const lines = Array.from({ length: 60 }, (_, index) => `line ${String(index + 1)}`);
    const hostile = [...lines, "```", "</details><script>alert(1)</script> @JoeyKhd [click](https://evil.example)", CHECKS_SECTION_END, "\u001b[31mred\u001b[0m"].join("\n");
    await turn(task, 1, [{ repoId: repo(), head: "escape-1" }], [lint("failed", hostile), unit("passed")]);
    const { body } = pullOf(task);
    const fence = /\n(`{4,})text\n([\s\S]*?)\n\1\n/.exec(body);
    expect(fence).not.toBeNull();
    // A fence longer than the output's own backticks: nothing inside closes it.
    const inside = fence?.[2] ?? "";
    expect(inside).toContain("<script>alert(1)</script>");
    expect(inside).not.toContain("\u001b");
    expect(inside).toContain("red");
    expect(inside.split("\n")).toHaveLength(40);
    expect(inside).not.toContain("line 24\n");
    expect(inside.startsWith("line 25")).toBe(true);
    // Outside the code block there's no HTML, no mention and no link from the output.
    const outside = body.replace(fence?.[0] ?? "", "");
    expect(outside).not.toContain("<script>");
    expect(outside).not.toContain("@JoeyKhd");
    expect(outside).not.toContain("evil.example");
    expect(sections(body)).toBe(1);
  });

  it("F-054: a two-repo task where one repo changed drafts only that repo's PR for a failing repo-less check", async () => {
    const task = await runningTask([repo(), secondRepoId]);
    await turn(
      task,
      1,
      [
        { repoId: repo(), head: "two-1a" },
        { repoId: secondRepoId, head: "two-1b" },
      ],
      [lint("passed"), unit("passed"), typecheck("passed"), { checkId: checkIds.test2, name: "test2", repoId: secondRepoId, status: "passed" }],
    );
    const first = pullOf(task);
    const second = pullOf(task, "ostra-test/test2");
    expect([first.draft, second.draft]).toEqual([false, false]);
    // test2's PR reads its own check and the repo-less one, not repo 1's.
    expect(second.body).toContain("- **typecheck**: ✅ passed\n- **test2**: ✅ passed");
    expect(second.body).not.toContain("**lint**");
    // Turn 2 changes repo 1 only: its checks and the repo-less one run, and the repo-less one fails.
    await turn(task, 2, [{ repoId: repo(), head: "two-2a" }], [lint("passed"), unit("passed"), typecheck("failed")]);
    expect(pullOf(task).draft).toBe(true);
    expect(pullOf(task, "ostra-test/test2").draft).toBe(false);
    expect(pullOf(task).body).toContain("- **typecheck**: ❌ failed");
  });

  it("F-054: Ask the agent to fix sends one message with each failing check's command and output", async () => {
    const task = await runningTask();
    await turn(task, 1, [{ repoId: repo(), head: "fix-1" }], [lint("failed", "src/a.ts: missing semicolon"), unit("timed-out", "still running")]);
    const before = await test.db.command.count({ where: { taskId: task.taskId, kind: "steer" } });
    const asked = await askAgentToFixChecks(deps, {}, driver, { taskId: task.taskId });
    // The task waits in review with its session idle: the message reopens it, as the composer would.
    expect(asked).toMatchObject({ ok: true, checks: 2, delivery: "reopen" });
    // Asked twice about the same failures: still one message.
    expect(await askAgentToFixChecks(deps, {}, driver, { taskId: task.taskId })).toMatchObject({ ok: true, checks: 2 });
    const messages = (await test.db.event.findMany({ where: { taskId: task.taskId, kind: "user.message" } })).flatMap((row) => {
      const parsed = taskEventSchema.safeParse(row.payload);
      return parsed.success && parsed.data.kind === "user.message" && parsed.data.intent === "fix-checks" ? [parsed.data] : [];
    });
    expect(messages).toHaveLength(1);
    expect(await test.db.command.count({ where: { taskId: task.taskId, kind: "steer" } })).toBe(before);
    expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "queued" });
    expect(readMarkedBlocks(messages[0]?.text ?? "").map((block) => [block.label, block.text])).toEqual([
      ["check-command", "pnpm lint"],
      ["check-output", "src/a.ts: missing semicolon"],
      ["check-command", "pnpm test"],
      ["check-output", "still running"],
    ]);
    // Nothing failing: refused.
    const passing = await runningTask();
    await turn(passing, 1, [{ repoId: repo(), head: "fix-pass" }], [lint("passed")]);
    expect(await askAgentToFixChecks(deps, {}, driver, { taskId: passing.taskId })).toMatchObject({ ok: false, error: "nothing-failing" });
  });

  it("F-054: another organization's check runs are invisible, and its members can't ask for a fix", async () => {
    const task = await runningTask();
    await turn(task, 1, [{ repoId: repo(), head: "iso-1" }], [lint("failed")]);
    expect((await checkRunsForMember(test.db, driver, { taskId: task.taskId }))?.map((run) => run.name)).toEqual(["lint"]);
    expect(await checkRunsForMember(test.db, outsider, { taskId: task.taskId })).toBeNull();
    expect(await askAgentToFixChecks(deps, {}, outsider, { taskId: task.taskId })).toMatchObject({ ok: false, error: "not-found" });
    // The runs stay this organization's: none is filed under the other one.
    expect(await test.db.checkRun.count({ where: { organizationId: otherWorld.organizationId } })).toBe(0);
  });

  it("F-054: an environment with no checks opens its PR as milestone 2 did, with no section", async () => {
    await test.db.check.deleteMany({ where: { projectId: world.projectId } });
    const task = await runningTask();
    await turn(task, 1, [{ repoId: repo(), head: `none-${randomBytes(2).toString("hex")}` }], []);
    const pull = pullOf(task);
    expect(pull.draft).toBe(false);
    expect(pull.body).not.toContain(CHECKS_SECTION_START);
    // A later turn without checks enqueues no PR job.
    await turn(task, 2, [{ repoId: repo(), head: "none-2" }], []);
    const saved = await test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "session.saved" }, orderBy: { seq: "desc" } });
    expect(await jobs.find("task.open-pull-requests", { organizationId: task.organizationId, taskId: task.taskId, sessionId: task.sessionId, eventSeq: saved.seq })).toHaveLength(0);
  });
});
