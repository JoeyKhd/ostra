import { randomBytes } from "node:crypto";

import { silentLogger } from "@ostra/adapter-sdk";
import { ciLogEntriesSchema, jobPayloadSchemas } from "@ostra/domain";
import { blobIdSchema, connectionIdSchema, webhookDeliveryIdSchema } from "@ostra/protocol";
import type { GitSha } from "@ostra/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { githubWebhookHandler, reconcilePullRequests } from "../code-host/pull-requests.ts";
import type { PullRequestStateDeps } from "../code-host/pull-requests.ts";
import { checkRun, recorded, seedTaskInCi, startLoopHarness, stateOf } from "../testing/review-loop.ts";
import type { LoopHarness, LoopPr, LoopTask } from "../testing/review-loop.ts";
import type { WebhookDeliveryContext } from "../webhooks/process.ts";

// Milestone 6's ticket 16 (F-035, ADR 0058): CI on a task's PRs, read on the fake code host. Each
// verdict with ostra's own App's check left out; "no CI" at the deadline and the wait limit, with
// no webhook; a failed verdict's log tails stored as blobs, capped; a replayed hint writes nothing
// new; and the code task's sub-state following two PRs' verdicts.

let h: LoopHarness;
/** ostra's own App, by the connection's slug: its independent-review check is never CI. */
const OWN_SLUG = "ostra-test";

beforeAll(async () => {
  h = await startLoopHarness();
});

afterAll(async () => {
  await h.stop();
});

beforeEach(() => {
  h.jobs.jobs.length = 0;
  h.records.length = 0;
});

const ciRun = (pr: LoopPr, head: GitSha = pr.head) => h.db.ciRun.findUnique({ where: { taskRepoId_headSha: { taskRepoId: pr.taskRepoId, headSha: head } } });

const ciUpdates = async (task: LoopTask): Promise<number> => h.db.event.count({ where: { taskId: task.taskId, kind: "ci.updated" } });

const firstPr = (task: LoopTask): LoopPr => {
  const pr = task.prs[0];
  if (pr === undefined) throw new Error("the task has no PR");
  return pr;
};

const prDeps = (): PullRequestStateDeps => ({
  db: h.db,
  jobs: h.jobs,
  notices: { emitInTx: () => Promise.resolve() },
  audit: { recordInTx: () => Promise.resolve() },
  clock: h.clock,
  codeHost: h.codeHost,
  secretStore: h.secretStore,
  logger: silentLogger,
});

const delivery = async (event: string, payload: Record<string, unknown>): Promise<WebhookDeliveryContext> => {
  const connection = await h.db.connection.findFirstOrThrow({ where: { organizationId: h.world.organizationId, kind: "github" } });
  return {
    organizationId: h.world.organizationId,
    connectionId: connectionIdSchema.parse(connection.id),
    deliveryId: webhookDeliveryIdSchema.parse(randomBytes(8).toString("hex")),
    event,
    payload,
    receivedAt: Date.now(),
    logger: silentLogger,
  };
};

describe("F-035: the verdict", () => {
  it("F-035/c1: passed, failed and pending, with ostra's own check left out", async () => {
    const passing = await seedTaskInCi(h);
    const pr = firstPr(passing);
    checkRun(h, pr, "test", "success");
    // ostra's own independent-review check waits for an approval: it must never hold CI.
    checkRun(h, pr, "ostra/independent-review", "in_progress", { appSlug: OWN_SLUG });
    await h.drain(["ci.evaluate"]);
    expect((await ciRun(pr))?.state).toBe("passed");
    expect(await stateOf(h, passing.taskId)).toBe("in_review/ai_review");
    expect(recorded(h, "review.start").length).toBe(1);

    const failing = await seedTaskInCi(h);
    checkRun(h, firstPr(failing), "lint", "success");
    checkRun(h, firstPr(failing), "test", "failure", { log: "1 test failed" });
    checkRun(h, firstPr(failing), "ostra/independent-review", "success", { appSlug: OWN_SLUG });
    await h.drain(["ci.evaluate"]);
    const failed = await ciRun(firstPr(failing));
    expect(failed?.state).toBe("failed");
    // The stored checks are the others', by name and conclusion; ostra's own isn't among them.
    expect(JSON.stringify(failed?.checks)).not.toContain("independent-review");
    expect(recorded(h, "round.start").map((payload) => jobPayloadSchemas["round.start"].parse(payload).taskId)).toContain(failing.taskId);

    const waiting = await seedTaskInCi(h);
    checkRun(h, firstPr(waiting), "build", "in_progress");
    await h.drain(["ci.evaluate"]);
    expect((await ciRun(firstPr(waiting)))?.state).toBe("pending");
    expect(await stateOf(h, waiting.taskId)).toBe("in_review/ci_running");

    // A commit status counts too: `error` fails the head.
    const status = await seedTaskInCi(h);
    h.codeHost.ci.setStatus(firstPr(status).repo, firstPr(status).head, { context: "ci/jenkins", state: "error", description: "the job crashed", targetUrl: null });
    await h.drain(["ci.evaluate"]);
    expect((await ciRun(firstPr(status)))?.state).toBe("failed");
  });

  it("F-035/c1: no CI at the deadline, with no webhook, moves the task on", async () => {
    const task = await seedTaskInCi(h);
    await h.drain(["ci.evaluate"]);
    expect((await ciRun(firstPr(task)))?.state).toBe("pending");
    // The two delayed evaluations, at the "no CI" deadline and the wait limit.
    const delayed = h.jobs.jobs.filter((job) => job.job === "ci.evaluate").map((job) => [jobPayloadSchemas["ci.evaluate"].parse(job.payload).deadline, job.options?.startAfterMs]);
    expect(delayed).toEqual([
      ["none", 120_000],
      ["wait", 3_600_000],
    ]);
    h.clock.advance(120_000);
    await h.drain(["ci.evaluate"], { delayed: true });
    expect((await ciRun(firstPr(task)))?.state).toBe("none");
    expect(await stateOf(h, task.taskId)).toBe("in_review/ai_review");
  });

  it("F-035/c1: the wait limit: CI still running after it starts the AI review, with no fixing round", async () => {
    const task = await seedTaskInCi(h);
    checkRun(h, firstPr(task), "e2e", "in_progress");
    await h.drain(["ci.evaluate"]);
    expect((await ciRun(firstPr(task)))?.state).toBe("pending");
    h.clock.advance(60 * 60_000);
    await h.drain(["ci.evaluate"], { delayed: true });
    expect((await ciRun(firstPr(task)))?.state).toBe("timed_out");
    expect(await stateOf(h, task.taskId)).toBe("in_review/ai_review");
    expect(recorded(h, "round.start")).toEqual([]);
    const event = await h.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "ci.updated" }, orderBy: { seq: "desc" } });
    expect(event.payload).toMatchObject({ state: "timed_out" });
  });
});

describe("F-035: the logs", () => {
  it("F-035/c1: a failed verdict's log tails are stored as blobs, capped, at most five, and never logged", async () => {
    const task = await seedTaskInCi(h);
    const marker = `secret-log-line-${randomBytes(4).toString("hex")}`;
    for (let index = 0; index < 7; index += 1) {
      // 100 KiB each, its last line the one that matters.
      checkRun(h, firstPr(task), `job-${String(index)}`, "failure", { log: `${"x".repeat(100 * 1024)}\n${marker} in job ${String(index)}` });
    }
    await h.drain(["ci.evaluate"]);
    const run = await ciRun(firstPr(task));
    expect(run?.state).toBe("failed");
    expect(ciLogEntriesSchema.parse(run?.logBlobIds).length).toBe(5);
    const blobs = await h.db.blob.findMany({ where: { taskId: task.taskId, purpose: "ci-log" } });
    expect(blobs.length).toBe(5);
    for (const blob of blobs) {
      expect(blob.size).toBeLessThanOrEqual(64 * 1024);
      const read = await h.blobs.read(h.world.organizationId, blobIdSchema.parse(blob.id), task.taskId);
      if (!read.ok) throw new Error("the log blob couldn't be read");
      // The tail is kept: the end of the log, where the failure is.
      expect(new TextDecoder().decode(read.value.bytes)).toContain(marker);
    }
    // Neither a log line nor an event holds the log's text.
    expect(JSON.stringify(h.records)).not.toContain(marker);
    const events = await h.db.event.findMany({ where: { taskId: task.taskId } });
    expect(JSON.stringify(events.map((event) => event.payload))).not.toContain(marker);
  });
});

describe("F-035: hints and replays", () => {
  it("F-035/c1: a replayed webhook writes nothing new, and ostra's own check is no hint", async () => {
    const task = await seedTaskInCi(h);
    const pr = firstPr(task);
    h.jobs.jobs.length = 0;
    checkRun(h, pr, "test", "success");
    const hint = {
      action: "completed",
      installation: { id: 777 },
      repository: { id: `host-${pr.repo}`, full_name: pr.repo },
      check_run: { head_sha: pr.head, app: { slug: "github-actions" } },
    };
    const handler = githubWebhookHandler(prDeps());
    expect(await handler(await delivery("check_run", hint))).toEqual({ outcome: "processed" });
    await h.drain(["ci.evaluate"]);
    const first = await ciRun(pr);
    expect(first?.state).toBe("passed");
    const updates = await ciUpdates(task);
    const followed = await stateOf(h, task.taskId);

    // The same delivery again: evaluated, and nothing new is written.
    expect(await handler(await delivery("check_run", hint))).toEqual({ outcome: "processed" });
    expect(await h.drain(["ci.evaluate"])).toEqual(["ci.evaluate"]);
    const again = await ciRun(pr);
    expect(again?.updatedAt.getTime()).toBe(first?.updatedAt.getTime());
    expect(await ciUpdates(task)).toBe(updates);
    expect(await stateOf(h, task.taskId)).toBe(followed);
    expect(recorded(h, "review.start").length).toBe(1);

    // ostra's own App's check run is no hint at all.
    const own = { ...hint, check_run: { head_sha: pr.head, app: { slug: OWN_SLUG } } };
    const before = h.jobs.jobs.length;
    expect(await handler(await delivery("check_run", own))).toMatchObject({ outcome: "ignored" });
    expect(h.jobs.jobs.length).toBe(before);
  });

  it("F-035/c1: a PR's new head and the reconcile each ask for its CI, without the check events", async () => {
    const task = await seedTaskInCi(h);
    const pr = firstPr(task);
    h.jobs.jobs.length = 0;
    const connection = await h.db.connection.findFirstOrThrow({ where: { organizationId: h.world.organizationId, kind: "github" } });
    await reconcilePullRequests(prDeps(), { organizationId: h.world.organizationId, connectionId: connectionIdSchema.parse(connection.id) });
    expect(recorded(h, "ci.evaluate").map((payload) => jobPayloadSchemas["ci.evaluate"].parse(payload))).toContainEqual({ organizationId: h.world.organizationId, taskRepoId: pr.taskRepoId, headSha: pr.head });
  });
});

describe("F-035: two PRs", () => {
  it("F-035/c1: the sub-state follows two PRs' verdicts: both green moves on, one red asks for a CI round", async () => {
    const task = await seedTaskInCi(h, { repos: 2 });
    const [one, two] = task.prs;
    if (one === undefined || two === undefined) throw new Error("two PRs expected");
    checkRun(h, one, "test", "success");
    await h.drain(["ci.evaluate"]);
    // One PR green, the other with nothing yet: the task waits in "CI running".
    expect((await ciRun(one))?.state).toBe("passed");
    expect((await ciRun(two))?.state).toBe("pending");
    expect(await stateOf(h, task.taskId)).toBe("in_review/ci_running");
    // The second's CI passes: both green, the task moves on to the AI review.
    checkRun(h, two, "test", "success");
    h.jobs.record("ci.evaluate", { organizationId: task.organizationId, taskRepoId: two.taskRepoId, headSha: two.head });
    await h.drain(["ci.evaluate"]);
    expect((await ciRun(two))?.state).toBe("passed");
    expect(await stateOf(h, task.taskId)).toBe("in_review/ai_review");

    const red = await seedTaskInCi(h, { repos: 2 });
    const [redOne, redTwo] = red.prs;
    if (redOne === undefined || redTwo === undefined) throw new Error("two PRs expected");
    checkRun(h, redOne, "test", "success");
    checkRun(h, redTwo, "test", "failure");
    h.jobs.jobs.length = 0;
    h.jobs.record("ci.evaluate", { organizationId: red.organizationId, taskRepoId: redOne.taskRepoId, headSha: redOne.head });
    h.jobs.record("ci.evaluate", { organizationId: red.organizationId, taskRepoId: redTwo.taskRepoId, headSha: redTwo.head });
    await h.drain(["ci.evaluate"]);
    expect(recorded(h, "round.start").map((payload) => jobPayloadSchemas["round.start"].parse(payload))).toEqual([
      { organizationId: red.organizationId, taskId: red.taskId, kind: "ci", causeRef: `${redTwo.head}.1` },
    ]);
    await h.drain(["round.start"]);
    expect(await stateOf(h, red.taskId)).toBe("in_review/fixing_ci");
  });
});
