import { randomBytes, randomUUID } from "node:crypto";

import {
  dispatchTask,
  jobPayloadSchemas,
  postgresAuditLog,
  postgresChangeNotices,
  postgresCommandOutbox,
  releaseHeldTurnsInTx,
  roundCountersInTx,
  sendMemberMessageInTx,
  submitReview,
  utcDayOf,
} from "@ostra/domain";
import type { MemberScope } from "@ostra/domain";
import { budgetIdSchema, CI_FILES_DIR, clientMessageIdSchema, leaseEpochSchema, memberIdSchema, steerBodySchema, taskIdSchema } from "@ostra/protocol";
import type { Finding, TaskId } from "@ostra/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildTaskSpec } from "../dispatch/task-spec.ts";
import { agentPushes, checkRun, followFreshSession, recorded, seedTaskInCi, startLoopHarness, stateOf } from "../testing/review-loop.ts";
import { seedOnlineRunner } from "../testing/world.ts";
import type { LoopHarness, LoopPr, LoopTask } from "../testing/review-loop.ts";

// Milestone 6's ticket 18 (F-101, F-035; ADR 0041, ADR 0058): the rounds, their caps and the
// automatic turn, against Postgres, the fake code host and core's real ingest. A findings round's
// one prompt; a CI round's failing checks and their log files; each cap, and the automatic turns
// across CI and review together; a person's message resetting the count; the spend cap and the
// budget gate, released in order; and a round on an old runner going to a fresh box.

let h: LoopHarness;
const LIMITS = { ciRounds: 2, reviewRounds: 2, automaticTurns: 4 } as const;

beforeAll(async () => {
  h = await startLoopHarness();
});

afterAll(async () => {
  await h.stop();
});

beforeEach(async () => {
  h.jobs.jobs.length = 0;
  h.records.length = 0;
  h.limits = LIMITS;
  await h.db.runnerPresence.update({ where: { runnerId: h.runner.runnerId }, data: { minor: 5 } });
});

const firstPr = (task: LoopTask): LoopPr => {
  const pr = task.prs[0];
  if (pr === undefined) throw new Error("the task has no PR");
  return pr;
};

/** The steers the outbox holds for the tasks, oldest first: a boxed task's go to its sidecar's queue. */
const steerRows = async (taskIds: readonly string[]) => {
  const [runner, sidecar] = await Promise.all([
    h.db.command.findMany({ where: { taskId: { in: [...taskIds] }, kind: "steer" }, select: { id: true, taskId: true, body: true } }),
    h.db.sidecarCommand.findMany({ where: { taskId: { in: [...taskIds] }, kind: "steer" }, select: { id: true, taskId: true, body: true } }),
  ]);
  return [...runner, ...sidecar].sort((a, b) => a.id.localeCompare(b.id));
};

const steersOf = async (taskId: string) => (await steerRows([taskId])).map((row) => steerBodySchema.parse(row.body));

/** CI fails on the task's head(s): `ci.evaluate`, then the round it asks for. */
const failCi = async (task: LoopTask, options: { readonly log?: string } = {}): Promise<void> => {
  checkRun(h, firstPr(task), `test-${randomBytes(2).toString("hex")}`, "failure", options.log === undefined ? {} : { log: options.log });
  for (const pr of task.prs) h.jobs.record("ci.evaluate", { organizationId: task.organizationId, taskRepoId: pr.taskRepoId, headSha: pr.head });
  await h.drain(["ci.evaluate"]);
  await h.drain(["round.start"]);
};

const finding = (task: LoopTask, overrides: Partial<Finding> = {}): Finding => ({
  repoId: firstPr(task).repoId,
  path: "src/index.ts",
  line: 5,
  side: "new",
  severity: "blocking",
  title: "The loop never ends",
  body: "`while (true)` has no exit.",
  suggestion: null,
  ...overrides,
});

/** CI passes, the AI review runs and hands in these findings, its review is posted, and any round it asks for starts. */
const reviewRound = async (task: LoopTask, findings: readonly Finding[]): Promise<void> => {
  const pr = firstPr(task);
  checkRun(h, pr, `test-${randomBytes(2).toString("hex")}`, "success");
  for (const one of task.prs) h.jobs.record("ci.evaluate", { organizationId: task.organizationId, taskRepoId: one.taskRepoId, headSha: one.head });
  await h.drain(["ci.evaluate"]);
  await h.drain(["review.start"]);
  const review = await h.db.task.findFirstOrThrow({ where: { reviewOfTaskId: task.taskId } });
  // The review task's agent is under way, as its runner's start leaves it.
  await h.db.task.update({ where: { id: review.id }, data: { state: "running" } });
  const submitted = await h.db.$transaction((tx) =>
    submitReview({ tx, jobs: h.jobs, notices: postgresChangeNotices, clock: h.clock }, { organizationId: h.world.organizationId, reviewTaskId: taskIdSchema.parse(review.id), review: { summary: "Read it.", findings: [...findings] } }),
  );
  if (!submitted.ok) throw new Error(submitted.message);
  h.codeHost.ci.setDiff(pr.repo, pr.number, [{ path: "src/index.ts", new: [{ start: 1, end: 20 }], old: [] }]);
  await h.drain(["review.post"]);
  await h.drain(["round.start"]);
};

const counters = (taskId: TaskId) => h.db.$transaction((tx) => roundCountersInTx(tx, taskId));

const scopeOf = (): MemberScope => ({ organizationId: h.world.organizationId, memberId: memberIdSchema.parse(h.fixture.a.member.id), role: "member", projectRoles: new Map() });

const capItem = (taskId: string) => h.db.needsYouItem.findFirst({ where: { taskId, reason: "round_cap", state: "open" } });

describe("F-101: the findings round", () => {
  it("F-101: blocking findings as one prompt, nits listed only, as an automatic turn on the warm box", async () => {
    const task = await seedTaskInCi(h);
    const nit = `Rename x ${randomBytes(3).toString("hex")}`;
    await reviewRound(task, [finding(task), finding(task, { path: "src/util.ts", line: 9, title: "Handle the empty list", body: "It throws." }), finding(task, { severity: "nit", line: 12, title: nit, body: "A clearer name." })]);
    expect(await stateOf(h, task.taskId)).toBe("in_review/fixing_findings");
    const steers = await steersOf(task.taskId);
    expect(steers.length).toBe(1);
    const steer = steers[0];
    expect(steer).toMatchObject({ intent: "fix-findings", automatic: true, delivery: "queue", sessionId: task.sessionId });
    const text = steer?.text ?? "";
    // One prompt: both blocking findings with their repo, file and line, then the nit as not required.
    expect(text).toContain("ostra-test/test1");
    expect(text).toContain("src/index.ts");
    expect(text).toContain("src/util.ts");
    expect(text).toMatch(/2 blocking; 1 nit is listed after them, and you don't have to act on it/);
    expect(text.indexOf("Handle the empty list")).toBeLessThan(text.indexOf(nit));
    // The round, its counters, and `round.started` in the thread.
    expect(await counters(task.taskId)).toMatchObject({ ciRounds: 0, reviewRounds: 1, automaticTurns: 1 });
    const started = await h.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "round.started" } });
    expect(started.payload).toMatchObject({ round: "findings", number: 1, automatic: true });
    // Its push takes the task back to "CI running".
    await agentPushes(h, task);
    expect(await stateOf(h, task.taskId)).toBe("in_review/ci_running");
    expect(JSON.stringify(h.records)).not.toContain(nit);
  });

  it("F-101: 2 review rounds, then the task needs its driver", async () => {
    const task = await seedTaskInCi(h);
    await reviewRound(task, [finding(task)]);
    await agentPushes(h, task);
    await reviewRound(task, [finding(task, { title: "Still looping" })]);
    expect(await counters(task.taskId)).toMatchObject({ reviewRounds: 2, automaticTurns: 2 });
    await agentPushes(h, task);
    await reviewRound(task, [finding(task, { title: "Looping again" })]);
    expect(await stateOf(h, task.taskId)).toBe("needs_you/round_cap");
    expect((await steersOf(task.taskId)).length).toBe(2);
    const item = await capItem(task.taskId);
    expect(item).toMatchObject({ audience: "driver" });
    expect(item?.summary).toContain("2 rounds");
    const capped = await h.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "round.capped" } });
    expect(capped.payload).toMatchObject({ round: "findings", reason: "rounds" });
  });

  it("F-101: CI, review, CI, review are 4 automatic turns, then the task needs you", async () => {
    // Each kind's own cap above the run, so the automatic turns are what stops it.
    h.limits = { ciRounds: 3, reviewRounds: 3, automaticTurns: 4 };
    const task = await seedTaskInCi(h);
    await failCi(task);
    await agentPushes(h, task);
    await reviewRound(task, [finding(task)]);
    await agentPushes(h, task);
    await failCi(task);
    await agentPushes(h, task);
    await reviewRound(task, [finding(task, { title: "Again" })]);
    expect(await counters(task.taskId)).toMatchObject({ ciRounds: 2, reviewRounds: 2, automaticTurns: 4 });
    expect((await steersOf(task.taskId)).map((steer) => steer.intent)).toEqual(["fix-ci", "fix-findings", "fix-ci", "fix-findings"]);
    await agentPushes(h, task);
    await failCi(task);
    expect(await stateOf(h, task.taskId)).toBe("needs_you/round_cap");
    expect((await steersOf(task.taskId)).length).toBe(4);
    const capped = await h.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "round.capped" } });
    expect(capped.payload).toMatchObject({ round: "ci", reason: "automatic-turns" });
    expect((await capItem(task.taskId))?.summary).toContain("4 automatic turns");
  });

  it("F-101: a member's message resets the count", async () => {
    const task = await seedTaskInCi(h);
    await failCi(task);
    await agentPushes(h, task);
    await failCi(task);
    expect(await counters(task.taskId)).toMatchObject({ ciRounds: 2, automaticTurns: 2, lastPersonActionAt: null });
    // The driver steps in: a message is a person's action.
    const sent = await h.db.$transaction((tx) =>
      sendMemberMessageInTx({ jobs: h.jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: h.clock }, tx, scopeOf(), {
        taskId: task.taskId,
        clientMessageId: clientMessageIdSchema.parse(randomUUID()),
        text: "Skip the flaky e2e job for now.",
        intent: "message",
        sender: "driver",
      }),
    );
    expect(sent.ok).toBe(true);
    const reset = await counters(task.taskId);
    expect(reset).toMatchObject({ ciRounds: 0, reviewRounds: 0, automaticTurns: 0 });
    expect(reset.lastPersonActionAt).toBeInstanceOf(Date);
    // The message's turn runs and pushes; CI failing again then starts a round where the cap would have stopped it.
    await followFreshSession(h, task);
    await agentPushes(h, task);
    expect(await stateOf(h, task.taskId)).toBe("in_review/ci_running");
    await failCi(task);
    expect(await stateOf(h, task.taskId)).toBe("in_review/fixing_ci");
    expect(await counters(task.taskId)).toMatchObject({ ciRounds: 1, automaticTurns: 1 });
  });
});

describe("F-035: the CI round", () => {
  it("F-035: the failing checks and their log files reach the agent, on a fresh box", async () => {
    const task = await seedTaskInCi(h);
    const marker = `AssertionError ${randomBytes(3).toString("hex")}`;
    await failCi(task, { log: `running 12 tests\n${marker}: expected 2 to be 3` });
    expect(await stateOf(h, task.taskId)).toBe("queued");
    const run = await h.db.ciRun.findFirstOrThrow({ where: { taskRepoId: firstPr(task).taskRepoId, headSha: firstPr(task).head } });
    const logs = run.logBlobIds;
    if (!Array.isArray(logs) || logs.length !== 1) throw new Error("one log tail expected");
    // A log file only a dispatch carries: the round's turn starts in a new session, its prompt first.
    const session = await h.db.session.findFirstOrThrow({ where: { taskId: task.taskId }, orderBy: [{ startedAt: "desc" }, { id: "desc" }] });
    expect(session.id).not.toBe(task.sessionId);
    const message = await h.db.event.findFirstOrThrow({ where: { taskId: task.taskId, sessionId: session.id, kind: "user.message" } });
    const blob = await h.db.blob.findFirstOrThrow({ where: { taskId: task.taskId, purpose: "ci-log" } });
    expect(message.payload).toMatchObject({ intent: "fix-ci" });
    expect(JSON.stringify(message.payload)).toContain(`${CI_FILES_DIR}/${blob.id}.log`);
    // Its dispatch goes to a runner at minor 5, with `automatic`; its spec carries the log as a `ci` file.
    const dispatch = recorded(h, "task.dispatch").map((one) => jobPayloadSchemas["task.dispatch"].parse(one)).find((one) => one.sessionId === session.id);
    if (dispatch === undefined) throw new Error("the round has no dispatch");
    const offered = await h.db.$transaction((tx) => dispatchTask({ tx, jobs: h.jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: h.clock }, dispatch));
    if (!offered.ok) throw new Error(offered.message);
    const command = await h.db.command.findUniqueOrThrow({ where: { id: offered.commandId } });
    expect(command.body).toMatchObject({ automatic: true });
    const spec = await buildTaskSpec({ db: h.db, codeHost: h.codeHost, secretStore: h.secretStore }, { taskId: task.taskId, runnerId: h.runner.runnerId, leaseEpoch: leaseEpochSchema.parse(offered.leaseEpoch) });
    if (!spec.ok) throw new Error(spec.message);
    expect(spec.spec.automatic).toBe(true);
    expect(spec.spec.contextFiles?.filter((file) => file.folder === "ci")).toEqual([{ blobId: blob.id, path: `${blob.id}.log`, contentType: "text/plain", size: blob.size, folder: "ci" }]);
  });

  it("F-035: 2 CI rounds, then the task needs its driver", async () => {
    const task = await seedTaskInCi(h);
    await failCi(task);
    expect(await stateOf(h, task.taskId)).toBe("in_review/fixing_ci");
    await agentPushes(h, task);
    expect(await stateOf(h, task.taskId)).toBe("in_review/ci_running");
    await failCi(task);
    await agentPushes(h, task);
    await failCi(task);
    expect(await stateOf(h, task.taskId)).toBe("needs_you/round_cap");
    expect((await steersOf(task.taskId)).map((steer) => steer.intent)).toEqual(["fix-ci", "fix-ci"]);
    const capped = await h.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "round.capped" } });
    expect(capped.payload).toMatchObject({ round: "ci", reason: "rounds" });
    expect((await capItem(task.taskId))?.summary).toContain("CI still fails after 2 rounds");
  });
});

describe("F-101: the spend cap, the budget and old runners", () => {
  it("F-101, F-035: an automatic turn stops at the task's spend cap", async () => {
    const task = await seedTaskInCi(h);
    await h.db.task.update({ where: { id: task.taskId }, data: { spentMicroUsd: 25_000_000 } });
    await failCi(task);
    expect(await stateOf(h, task.taskId)).toBe("needs_you/spend_cap");
    expect(await steersOf(task.taskId)).toEqual([]);
    expect(await counters(task.taskId)).toMatchObject({ automaticTurns: 0 });
  });

  it("F-101, F-035: an automatic turn waits at 100% of the budget, and the held rounds are released in order", async () => {
    const model = await h.db.agentProfile.findUniqueOrThrow({ where: { id: h.world.profileId }, select: { modelId: true } });
    if (model.modelId === null) throw new Error("the profile has no model");
    const budget = await h.db.budget.create({ data: { organizationId: h.world.organizationId, projectId: h.world.projectId, monthlyMicroUsd: 1_000_000n } });
    const spend = await h.db.spendDaily.create({
      data: { organizationId: h.world.organizationId, projectId: h.world.projectId, day: utcDayOf(h.clock.now()), modelId: model.modelId, spentMicroUsd: 1_000_000n },
    });
    try {
      const first = await seedTaskInCi(h);
      const second = await seedTaskInCi(h);
      await failCi(first);
      h.clock.advance(1_000);
      await failCi(second);
      for (const task of [first, second]) {
        // Held: the round waits, its sub-state set, no turn sent, no counter used.
        expect(await stateOf(h, task.taskId)).toBe("in_review/fixing_ci");
        expect(await h.db.taskRound.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({ state: "held", kind: "ci" });
        expect(await h.db.heldTurn.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({ origin: "automatic_round", releasedAt: null });
        expect(await steersOf(task.taskId)).toEqual([]);
        expect(await counters(task.taskId)).toMatchObject({ automaticTurns: 0 });
      }
      // The budget is raised: the held rounds go, oldest first, each counted as it starts.
      await h.db.budget.update({ where: { id: budget.id }, data: { monthlyMicroUsd: 100_000_000n } });
      const released = await h.db.$transaction((tx) =>
        releaseHeldTurnsInTx({ jobs: h.jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: h.clock }, tx, { organizationId: h.world.organizationId, budgetId: budgetIdSchema.parse(budget.id) }),
      );
      expect(released).toMatchObject({ released: 2, stillHeld: 0 });
      const commands = await steerRows([first.taskId, second.taskId]);
      expect(commands.map((command) => command.taskId)).toEqual([first.taskId, second.taskId]);
      for (const command of commands) expect(steerBodySchema.parse(command.body)).toMatchObject({ intent: "fix-ci", automatic: true });
      for (const task of [first, second]) {
        expect(await h.db.taskRound.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({ state: "started" });
        expect(await counters(task.taskId)).toMatchObject({ ciRounds: 1, automaticTurns: 1 });
      }
    } finally {
      await h.db.spendDaily.delete({ where: { id: spend.id } });
      await h.db.budget.delete({ where: { id: budget.id } });
    }
  });

  it("F-101: a round on an old runner goes to a fresh box, offered only to a runner at minor 5", async () => {
    await h.db.runnerPresence.update({ where: { runnerId: h.runner.runnerId }, data: { minor: 4 } });
    const task = await seedTaskInCi(h);
    await failCi(task);
    // No steer to the minor-4 runner's warm box: a new session, and a dispatch.
    expect(await steersOf(task.taskId)).toEqual([]);
    const session = await h.db.session.findFirstOrThrow({ where: { taskId: task.taskId }, orderBy: [{ startedAt: "desc" }, { id: "desc" }] });
    expect(session.id).not.toBe(task.sessionId);
    expect(await h.db.taskRound.findFirstOrThrow({ where: { taskId: task.taskId } })).toMatchObject({ state: "started", turnId: session.id });
    const dispatch = recorded(h, "task.dispatch").map((one) => jobPayloadSchemas["task.dispatch"].parse(one)).find((one) => one.sessionId === session.id);
    if (dispatch === undefined) throw new Error("the round has no dispatch");
    // Only the minor-4 runner is online: the round waits for a runner that reads it, even its kept box's.
    const refused = await h.db.$transaction((tx) => dispatchTask({ tx, jobs: h.jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: h.clock }, dispatch));
    expect(refused).toMatchObject({ ok: false });
    // A runner at minor 5 joins the pool: the round's fresh box is its, offered with `automatic`.
    const pool = await h.db.projectPool.findFirstOrThrow({ where: { projectId: h.world.projectId } });
    const newer = await seedOnlineRunner(h.db, h.world.organizationId, { kind: "pool", poolId: pool.poolId }, 20);
    await h.db.runnerPresence.update({ where: { runnerId: newer.runnerId }, data: { minor: 5 } });
    const followed = await followFreshSession(h, task);
    expect(followed.runnerId).toBe(newer.runnerId);
    expect(followed.boxId).not.toBe(task.boxId);
    expect(followed.automatic).toBe(true);
    // The fresh session's push takes the task back into the loop.
    await agentPushes(h, task);
    expect(await stateOf(h, task.taskId)).toBe("in_review/ci_running");
    await h.db.runnerPresence.update({ where: { runnerId: newer.runnerId }, data: { disconnectedAt: new Date() } });
  });
});
