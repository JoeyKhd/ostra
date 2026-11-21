import { randomBytes } from "node:crypto";

import { dispatchTask, jobPayloadSchemas, postgresAuditLog, postgresChangeNotices, postgresCommandOutbox, rememberFinding, submitReview } from "@ostra/domain";
import type { MemberScope } from "@ostra/domain";
import { readAgentMessage } from "@ostra/domain/agent-message";
import { boxIdSchema, findingIdSchema, leaseEpochSchema, memberIdSchema, reviewResponseSchema, runnerPaths, taskEventSchema, taskIdSchema, taskSpecMinMinor } from "@ostra/protocol";
import type { BoxId, Finding, RepoId, TaskId } from "@ostra/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildTaskSpec } from "../dispatch/task-spec.ts";
import { handleReviewEndpoint } from "../runner-http/review.ts";
import { postJson, startGateway } from "../testing/harness.ts";
import type { GatewayHarness } from "../testing/harness.ts";
import { agentPushes, BASE_SHA, checkRun, recorded, seedTaskInCi, startLoopHarness, stateOf } from "../testing/review-loop.ts";
import type { LoopHarness, LoopPr, LoopTask } from "../testing/review-loop.ts";
import { recordTaskPrHead } from "./ci.ts";

// Milestone 6's ticket 17 (F-100, F-111; ADR 0028 amended, ADR 0058): the AI review, against
// Postgres and the fake code host. One review task per code task, reopened per round, in its own
// box, on the PRs' heads, read-only, on the project's review profile and its model; typed findings
// through the sidecar's endpoint; one `COMMENT` review per PR with the findings off the diff in its
// body; the project's switch; a head a person moved; and "Remember this" on a finding.

let h: LoopHarness;
let gateway: GatewayHarness;
let reviewProfileId: string;
let reviewModelId: string;

beforeAll(async () => {
  h = await startLoopHarness();
  // The project's review profile, on a model of its own (F-100: "on the review profile and its model").
  const provider = await h.db.modelProvider.findFirstOrThrow({ where: { id: h.world.providerId } });
  const model = await h.db.model.create({ data: { organizationId: h.world.organizationId, providerId: provider.id, endpointModelId: "review-model-1" } });
  const profile = await h.db.agentProfile.create({
    data: { organizationId: h.world.organizationId, name: "Review", adapter: "opencode", modelId: model.id, builtIn: true, builtInKind: "review" },
  });
  await h.db.project.update({ where: { id: h.world.projectId }, data: { defaultReviewProfileId: profile.id } });
  reviewProfileId = profile.id;
  reviewModelId = model.id;
  gateway = await startGateway(h.db, h.test.url, {}, (gw) => [
    handleReviewEndpoint({ db: h.db, tokens: gw.context.tokens, taskTokens: gw.context.taskTokens, jobs: h.jobs, notices: postgresChangeNotices, clock: h.clock, logger: h.logger }),
  ]);
});

afterAll(async () => {
  await gateway.stop();
  await h.stop();
});

beforeEach(async () => {
  h.jobs.jobs.length = 0;
  h.records.length = 0;
  await h.db.project.update({ where: { id: h.world.projectId }, data: { aiReview: true } });
});

const firstPr = (task: LoopTask): LoopPr => {
  const pr = task.prs[0];
  if (pr === undefined) throw new Error("the task has no PR");
  return pr;
};

/** A code task whose CI passed: it waits for its AI review, and `review.start` has run. */
const reviewed = async (): Promise<LoopTask> => {
  const task = await seedTaskInCi(h);
  checkRun(h, firstPr(task), "test", "success");
  await h.drain(["ci.evaluate"]);
  expect(await stateOf(h, task.taskId)).toBe("in_review/ai_review");
  await h.drain(["review.start"]);
  return task;
};

const reviewTaskOf = (task: LoopTask) => h.db.task.findFirstOrThrow({ where: { reviewOfTaskId: task.taskId, kind: "review" } });

/** The review task's dispatch, through the domain's dispatch to the harness's runner. */
const dispatchReview = async (task: LoopTask): Promise<{ readonly boxId: BoxId; readonly epoch: number }> => {
  const review = await reviewTaskOf(task);
  const payload = recorded(h, "task.dispatch")
    .map((one) => jobPayloadSchemas["task.dispatch"].parse(one))
    .find((one) => one.taskId === review.id);
  if (payload === undefined) throw new Error("the review task has no dispatch");
  const offered = await h.db.$transaction((tx) => dispatchTask({ tx, jobs: h.jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: h.clock }, payload));
  if (!offered.ok) throw new Error(`the review's dispatch failed: ${offered.message}`);
  const index = h.jobs.jobs.findIndex((job) => job.job === "task.dispatch" && jobPayloadSchemas["task.dispatch"].parse(job.payload).taskId === review.id);
  h.jobs.jobs.splice(index, 1);
  return { boxId: offered.boxId, epoch: offered.leaseEpoch };
};

/** The review task dispatched and its agent's turn under way, as the runner's start leaves it. */
const runReview = async (task: LoopTask): Promise<{ readonly boxId: BoxId; readonly epoch: number; readonly reviewTaskId: TaskId }> => {
  const dispatched = await dispatchReview(task);
  const review = await reviewTaskOf(task);
  await h.db.task.update({ where: { id: review.id }, data: { state: "running" } });
  await h.db.session.updateMany({ where: { taskId: review.id, boxId: dispatched.boxId }, data: { state: "running" } });
  return { ...dispatched, reviewTaskId: taskIdSchema.parse(review.id) };
};

const finding = (repoId: RepoId, overrides: Partial<Finding> = {}): Finding => ({
  repoId,
  path: "src/index.ts",
  line: 5,
  side: "new",
  severity: "blocking",
  title: "The loop never ends",
  body: "`while (true)` has no exit.",
  suggestion: null,
  ...overrides,
});

const submit = (reviewTaskId: TaskId, findings: readonly Finding[], summary = "Two things to look at.") =>
  h.db.$transaction((tx) =>
    submitReview({ tx, jobs: h.jobs, notices: postgresChangeNotices, clock: h.clock }, { organizationId: h.world.organizationId, reviewTaskId, review: { summary, findings: [...findings] } }),
  );

describe("F-100: the review task", () => {
  it("F-100/c1: one review task per code task, reopened per round, in its own box, on the PR's head, read-only, on the review profile and its model", async () => {
    const task = await reviewed();
    const pr = firstPr(task);
    const review = await reviewTaskOf(task);
    expect(review).toMatchObject({ kind: "review", reviewOfTaskId: task.taskId, agentProfileId: reviewProfileId, state: "queued" });
    const run = await h.db.reviewRun.findFirstOrThrow({ where: { reviewTaskId: review.id } });
    expect(run).toMatchObject({ codeTaskId: task.taskId, round: 1, state: "running", heads: [{ repoId: pr.repoId, prNumber: pr.number, baseSha: BASE_SHA, headSha: pr.head }] });

    // Its own box, on its own lease, with the review profile's model.
    const dispatched = await dispatchReview(task);
    expect(dispatched.boxId).not.toBe(task.boxId);
    const session = await h.db.session.findFirstOrThrow({ where: { taskId: review.id }, orderBy: { startedAt: "desc" } });
    expect(session.modelId).toBe(reviewModelId);
    const spec = await buildTaskSpec({ db: h.db, codeHost: h.codeHost, secretStore: h.secretStore }, { taskId: taskIdSchema.parse(review.id), runnerId: h.runner.runnerId, leaseEpoch: leaseEpochSchema.parse(dispatched.epoch) });
    if (!spec.ok) throw new Error(`no spec: ${spec.message}`);
    // Read-only at the PR's head: the review kind (its git proxy refuses every push), the checkout, the tools.
    expect(spec.spec.kind).toBe("review");
    expect(spec.spec.review).toEqual({ codeTaskId: task.taskId, round: 1, repos: [{ repoId: pr.repoId, prNumber: pr.number, baseSha: BASE_SHA, headSha: pr.head }] });
    expect(spec.spec.tools).toEqual(["review", "memory"]);
    expect(spec.spec.agent).toMatchObject({ profileId: reviewProfileId, modelId: reviewModelId });
    // Only a runner at minor 5 reads a review task.
    expect(taskSpecMinMinor(spec.spec)).toBe(5);

    // Round 1 finds a blocking problem; the agent fixes it; CI passes on the new head.
    await h.db.task.update({ where: { id: review.id }, data: { state: "running" } });
    expect((await submit(taskIdSchema.parse(review.id), [finding(pr.repoId)])).ok).toBe(true);
    h.codeHost.ci.setDiff(pr.repo, pr.number, [{ path: "src/index.ts", new: [{ start: 1, end: 20 }], old: [] }]);
    await h.drain(["review.post"]);
    await h.drain(["round.start"]);
    expect(await stateOf(h, task.taskId)).toBe("in_review/fixing_findings");
    await agentPushes(h, task);
    checkRun(h, pr, "test", "success");
    await h.drain(["ci.evaluate"]);
    await h.drain(["review.start"]);

    // Round 2 reopens the same review task, on the new head.
    const reviews = await h.db.task.findMany({ where: { reviewOfTaskId: task.taskId } });
    expect(reviews.map((one) => one.id)).toEqual([review.id]);
    const second = await h.db.reviewRun.findFirstOrThrow({ where: { reviewTaskId: review.id, round: 2 } });
    expect(second).toMatchObject({ state: "running", heads: [{ repoId: pr.repoId, headSha: pr.head }] });
    expect(await h.db.taskRepo.findFirstOrThrow({ where: { taskId: review.id } })).toMatchObject({ headSha: pr.head });
    expect(await stateOf(h, review.id)).toBe("queued");
    const redispatched = await dispatchReview(task);
    expect(redispatched.boxId).not.toBe(dispatched.boxId);
    // Its one thread holds both rounds.
    const sessions = await h.db.session.count({ where: { taskId: review.id } });
    expect(sessions).toBe(2);
    // Round 2 finds nothing: round 1's finding, still on the diff, is resolved by it, and the task waits for its reviewer.
    await h.db.task.update({ where: { id: review.id }, data: { state: "running" } });
    expect((await submit(taskIdSchema.parse(review.id), [], "Looks right now."))).toMatchObject({ ok: true });
    h.codeHost.ci.setDiff(pr.repo, pr.number, [{ path: "src/index.ts", new: [{ start: 1, end: 20 }], old: [] }]);
    await h.drain(["review.post"]);
    const earlier = await h.db.finding.findFirstOrThrow({ where: { reviewRunId: run.id } });
    expect(earlier).toMatchObject({ state: "resolved", resolvedInRunId: second.id });
    expect(await stateOf(h, task.taskId)).toBe("in_review/waiting_for_reviewer");
  });

  it("F-100: each round's first message is ostra's AI review, read back from its prompt: the PR, its branch and size, and which round", async () => {
    const task = await seedTaskInCi(h);
    const pr = firstPr(task);
    const { branchName } = await h.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    /** The PR's current head, compared at `files` files of `added` and `removed` lines each. */
    const sized = (files: number, added: number, removed: number) => {
      h.codeHost.setCompare(pr.repo, pr.head, {
        aheadBy: 1,
        behindBy: 0,
        mergeBase: BASE_SHA,
        files: Array.from({ length: files }, (_, index) => ({ path: `src/f${String(index)}.ts`, previousPath: null, status: "modified" as const, additions: added, deletions: removed, patch: null, truncated: false })),
        filesTruncated: false,
        limits: { maxFiles: 300, maxPatchBytes: 1_000_000 },
      });
    };
    sized(2, 10, 3);
    checkRun(h, pr, "test", "success");
    await h.drain(["ci.evaluate"]);
    await h.drain(["review.start"]);
    // Round 1 finds a blocking problem; the findings round pushes a smaller change, which gets round 2.
    const review = await reviewTaskOf(task);
    await h.db.task.update({ where: { id: review.id }, data: { state: "running" } });
    expect((await submit(taskIdSchema.parse(review.id), [finding(pr.repoId)])).ok).toBe(true);
    h.codeHost.ci.setDiff(pr.repo, pr.number, [{ path: "src/index.ts", new: [{ start: 1, end: 20 }], old: [] }]);
    await h.drain(["review.post"]);
    await h.drain(["round.start"]);
    await agentPushes(h, task);
    sized(1, 4, 0);
    checkRun(h, pr, "test", "success");
    await h.drain(["ci.evaluate"]);
    await h.drain(["review.start"]);
    const messages = (await h.db.event.findMany({ where: { taskId: review.id, kind: "user.message" }, orderBy: { seq: "asc" } })).map((row) => {
      const event = taskEventSchema.parse(row.payload);
      return event.kind === "user.message" ? readAgentMessage({ text: event.text, intent: event.intent }) : null;
    });
    const named = { repo: pr.repo, number: pr.number, branch: branchName };
    expect(messages).toMatchObject([
      { kind: "ai-review", round: { number: 1, of: 3 }, pullRequests: [{ ...named, files: 2, additions: 20, deletions: 6 }] },
      { kind: "ai-review", round: { number: 2, of: 3 }, pullRequests: [{ ...named, files: 1, additions: 4, deletions: 0 }] },
    ]);
  });

  it("F-100/c5: AI review off skips it: CI passing goes straight to waiting for a reviewer", async () => {
    await h.db.project.update({ where: { id: h.world.projectId }, data: { aiReview: false } });
    const task = await seedTaskInCi(h);
    checkRun(h, firstPr(task), "test", "success");
    await h.drain(["ci.evaluate"]);
    expect(await stateOf(h, task.taskId)).toBe("in_review/waiting_for_reviewer");
    expect(recorded(h, "review.start")).toEqual([]);
    expect(await h.db.task.count({ where: { reviewOfTaskId: task.taskId } })).toBe(0);
  });
});

describe("F-100: findings and the posted review", () => {
  it("F-100/c2,c3: findings typed with severity, file and line; one COMMENT review per PR; off-diff findings in its body", async () => {
    const task = await reviewed();
    const pr = firstPr(task);
    const review = await reviewTaskOf(task);
    h.codeHost.ci.setDiff(pr.repo, pr.number, [{ path: "src/index.ts", new: [{ start: 1, end: 20 }], old: [] }]);
    await runReview(task);
    const offDiff = `Not in this diff ${randomBytes(3).toString("hex")}`;
    const findings = [
      finding(pr.repoId),
      finding(pr.repoId, { path: "src/other.ts", line: 40, severity: "nit", title: offDiff, body: "A name could be clearer." }),
      finding(pr.repoId, { path: "src/index.ts", line: 300, severity: "nit", title: `${offDiff} too`, body: "Below the hunk." }),
    ];
    const submitted = await submit(taskIdSchema.parse(review.id), findings);
    if (!submitted.ok) throw new Error(submitted.message);
    const rows = await h.db.finding.findMany({ where: { reviewRunId: submitted.reviewRunId }, orderBy: { line: "asc" } });
    expect(rows.map((row) => [row.severity, row.path, row.line, row.side])).toEqual([
      ["blocking", "src/index.ts", 5, "new"],
      ["nit", "src/other.ts", 40, "new"],
      ["nit", "src/index.ts", 300, "new"],
    ]);
    await h.drain(["review.post"]);
    // One review, posted once: the off-diff findings never reached GitHub as line comments.
    expect(h.codeHost.reviewCalls.filter((call) => call.number === pr.number)).toEqual([{ repo: pr.repo, number: pr.number, comments: 1 }]);
    const posted = h.codeHost.ci.reviews(pr.repo, pr.number);
    expect(posted.length).toBe(1);
    expect(posted[0]?.commitId).toBe(pr.head);
    expect(posted[0]?.comments.map((comment) => [comment.path, comment.line])).toEqual([["src/index.ts", 5]]);
    expect(posted[0]?.body).toContain("1 blocking, 2 nits");
    expect(posted[0]?.body).toContain(offDiff);
    const placed = await h.db.finding.findMany({ where: { reviewRunId: submitted.reviewRunId }, orderBy: { line: "asc" } });
    expect(placed.map((row) => row.postedAs)).toEqual(["line_comment", "review_body", "review_body"]);
    expect(await h.db.reviewRun.findUniqueOrThrow({ where: { id: submitted.reviewRunId } })).toMatchObject({ state: "posted", blocking: 1, nits: 2 });
    // The review task is done; its blocking finding asks for a findings round.
    expect(await stateOf(h, review.id)).toBe("done");
    expect(recorded(h, "round.start").map((one) => jobPayloadSchemas["round.start"].parse(one))).toEqual([
      { organizationId: h.world.organizationId, taskId: task.taskId, kind: "findings", causeRef: submitted.reviewRunId },
    ]);
    // A finding's text never reaches a log line.
    expect(JSON.stringify(h.records)).not.toContain(offDiff);
  });

  it("F-100/c3: no blocking finding sends the code task on to its reviewer", async () => {
    const task = await reviewed();
    const pr = firstPr(task);
    const review = await reviewTaskOf(task);
    h.codeHost.ci.setDiff(pr.repo, pr.number, [{ path: "src/index.ts", new: [{ start: 1, end: 20 }], old: [] }]);
    await runReview(task);
    expect((await submit(taskIdSchema.parse(review.id), [finding(pr.repoId, { severity: "nit" })])).ok).toBe(true);
    await h.drain(["review.post"]);
    expect(await stateOf(h, task.taskId)).toBe("in_review/waiting_for_reviewer");
    expect(recorded(h, "round.start")).toEqual([]);
  });

  it("F-100/c2: a code task's token can't post a review; the review task's can, once, while its round runs", async () => {
    const task = await reviewed();
    const pr = firstPr(task);
    const review = await reviewTaskOf(task);
    const dispatched = await runReview(task);
    const tokenOf = (taskId: string, epoch: number, boxId: string) =>
      gateway.gateway.context.taskTokens.issue({ organizationId: h.world.organizationId, taskId: taskIdSchema.parse(taskId), leaseEpoch: leaseEpochSchema.parse(epoch), boxId: boxIdSchema.parse(boxId), runnerId: h.runner.runnerId });
    const body = { summary: "One thing.", findings: [finding(pr.repoId)] };
    // The code task's own token, for its own task: not a review task.
    const fromCode = await postJson(`${gateway.url}${runnerPaths.taskReview(task.taskId)}`, body, tokenOf(task.taskId, 1, task.boxId));
    expect(fromCode.status).toBe(200);
    expect(reviewResponseSchema.parse(fromCode.body)).toEqual({ code: "wrong-kind" });
    // The code task's token for the review task's path is refused outright.
    const crossed = await postJson(`${gateway.url}${runnerPaths.taskReview(review.id)}`, body, tokenOf(task.taskId, 1, task.boxId));
    expect(crossed.status).toBe(403);
    expect(await h.db.finding.count({ where: { reviewRun: { codeTaskId: task.taskId } } })).toBe(0);
    // The review task's token: saved, then refused once the round has its review.
    const reviewToken = tokenOf(review.id, dispatched.epoch, dispatched.boxId);
    const saved = await postJson(`${gateway.url}${runnerPaths.taskReview(review.id)}`, body, reviewToken);
    const savedRun = await h.db.reviewRun.findFirstOrThrow({ where: { reviewTaskId: review.id }, orderBy: { round: "desc" } });
    expect(reviewResponseSchema.parse(saved.body)).toEqual({ reviewRunId: savedRun.id });
    const again = await postJson(`${gateway.url}${runnerPaths.taskReview(review.id)}`, body, reviewToken);
    expect(reviewResponseSchema.parse(again.body)).toEqual({ code: "not-in-review" });
    // Over the cap, and on a repo the run didn't review.
    const many = await postJson(`${gateway.url}${runnerPaths.taskReview(review.id)}`, { summary: "x", findings: Array.from({ length: 31 }, () => finding(pr.repoId)) }, reviewToken);
    expect(reviewResponseSchema.parse(many.body)).toEqual({ code: "invalid" });
  });

  it("F-100/c1: a head a person moves during the review ends it, and CI starts again on the new head", async () => {
    const task = await reviewed();
    const pr = firstPr(task);
    const review = await reviewTaskOf(task);
    const run = await h.db.reviewRun.findFirstOrThrow({ where: { reviewTaskId: review.id } });
    const moved = "c".repeat(40);
    h.jobs.jobs.length = 0;
    const result = await recordTaskPrHead({ db: h.db, jobs: h.jobs, notices: postgresChangeNotices, adapters: { codeHost: h.codeHost, secretStore: h.secretStore } }, { organizationId: h.world.organizationId, taskRepoId: pr.taskRepoId, headSha: moved });
    expect(result).toEqual({ moved: true, enqueued: true });
    expect((await h.db.reviewRun.findUniqueOrThrow({ where: { id: run.id } })).state).toBe("failed");
    expect(await stateOf(h, task.taskId)).toBe("in_review/ci_running");
    expect(recorded(h, "ci.evaluate").map((one) => jobPayloadSchemas["ci.evaluate"].parse(one))).toEqual([{ organizationId: h.world.organizationId, taskRepoId: pr.taskRepoId, headSha: moved }]);
    // The review of the old head can't be handed in now.
    const late = await submit(taskIdSchema.parse(review.id), [finding(pr.repoId)]);
    expect(late).toMatchObject({ ok: false, error: "not-in-review" });
  });
});

describe("F-111: a finding as a source", () => {
  it("F-111/c1: Remember this on a finding makes a proposal with the finding as its source", async () => {
    const task = await reviewed();
    const pr = firstPr(task);
    const review = await reviewTaskOf(task);
    const submitted = await submit(taskIdSchema.parse(review.id), [finding(pr.repoId, { title: "Use the logger", body: "This repo logs through `createLogger`, never `console.log`." })]);
    if (!submitted.ok) throw new Error(submitted.message);
    const row = await h.db.finding.findFirstOrThrow({ where: { reviewRunId: submitted.reviewRunId } });
    const scope: MemberScope = { organizationId: h.world.organizationId, memberId: memberIdSchema.parse(h.fixture.a.member.id), role: "member", projectRoles: new Map() };
    const proposed = await rememberFinding({ db: h.db, audit: postgresAuditLog, clock: h.clock, adapters: { secretStore: h.secretStore } }, scope, { findingId: findingIdSchema.parse(row.id) });
    if (!proposed.ok) throw new Error(proposed.message);
    const proposal = await h.db.memoryProposal.findUniqueOrThrow({ where: { id: proposed.proposalId } });
    expect(proposal).toMatchObject({ sourceKind: "ai_finding", sourceRef: row.id, taskId: task.taskId, projectId: h.world.projectId });
    expect(proposal.body).toContain("createLogger");
    // Another organization's member finds no such finding.
    const outsider: MemberScope = { organizationId: h.fixture.b.organization.id, memberId: memberIdSchema.parse(h.fixture.b.admin.id), role: "admin", projectRoles: new Map() };
    expect(await rememberFinding({ db: h.db, audit: postgresAuditLog, clock: h.clock, adapters: { secretStore: h.secretStore } }, outsider, { findingId: findingIdSchema.parse(row.id) })).toMatchObject({ ok: false, error: "not-found" });
  });
});

