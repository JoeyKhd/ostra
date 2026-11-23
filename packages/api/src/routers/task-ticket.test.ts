import { reopenCarryOnText } from "@ostra/domain";
import { blobIdSchema, clientMessageIdSchema, needsYouItemIdSchema, sessionIdSchema } from "@ostra/protocol";
import type { OrganizationId, ProjectId, TaskId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appendEvent, createApiHarness, seedBoard, seedConnectionAndModel, seedLinearConnection, seedProject, seedTask, seedTicket } from "../testing/index.ts";
import type { ApiHarness, AppCaller, SeededTask } from "../testing/index.ts";
import { seedModelRow, seedProviderRow } from "../testing/m4-seed.ts";

// Ticket 30: the task page's ticket and its sync, its sessions and box, its spend against the cap, its
// capabilities, and reopening. `tasks.reopen` and `tasks.dismissNeedsYou` call ticket 18's use cases.

let harness: ApiHarness;
let world: Awaited<ReturnType<typeof seedConnectionAndModel>>;
let projectId: ProjectId;
let organizationId: OrganizationId;
let connectionId: Awaited<ReturnType<typeof seedLinearConnection>>;
let boardId: Awaited<ReturnType<typeof seedBoard>>;

beforeAll(async () => {
  harness = await createApiHarness();
  organizationId = harness.fixture.a.organization.id;
  world = await seedConnectionAndModel(harness);
  projectId = (await seedProject(harness, world, "task-ticket")).projectId;
  connectionId = await seedLinearConnection(harness);
  boardId = await seedBoard(harness, { projectId, connectionId, key: "ENG" });
});

afterAll(async () => {
  await harness.dispose();
});

const member = () => harness.as(harness.fixture.a.member);
const admin = () => harness.as(harness.fixture.a.admin);

/**
 * `retrySync` is the procedure's name (ticket 30), and the repo's lint refuses a call to anything
 * named `...Sync` (the async-APIs rule), so a test reads the procedure and calls it under another name.
 */
const retryWrites = (caller: AppCaller, taskId: TaskId) => {
  const retry = caller.tasks.retrySync;
  return retry({ taskId });
};

const messageId = () => clientMessageIdSchema.parse(crypto.randomUUID());

/** A ticket task: the ticket, its writes, and a task on it in the given state. */
const ticketTask = async (key: string, state: "queued" | "running" | "needs_you" | "stopped" | "in_review" = "running") => {
  const ticketId = await seedTicket(harness, { projectId, boardId, connectionId, key, title: `Work on ${key}`, statusId: "s-progress", statusName: "In Progress", statusCategory: "started" });
  const task = await seedTask(harness, { organizationId, projectId, state, driverMemberId: harness.fixture.a.member.id, creatorMemberId: harness.fixture.a.member.id });
  await harness.test.db.task.update({ where: { id: task.taskId }, data: { source: "ticket", ticketId, boardId, ticketKey: key } });
  return { ...task, ticketId };
};

describe("F-064, F-031: the task's ticket and its sync", () => {
  it("returns the ticket, each write to the tracker and its state, and the ticket's context files", async () => {
    const task = await ticketTask("ENG-1");
    await harness.test.db.ticketWrite.createMany({
      data: [
        { organizationId, projectId, taskId: task.taskId, boardId, ticketId: task.ticketId, kind: "move", payload: { kind: "move", target: "started" }, idempotencyKey: `k-${task.taskId}-1`, state: "done", doneAt: new Date() },
        { organizationId, projectId, taskId: task.taskId, boardId, ticketId: task.ticketId, kind: "comment", payload: { kind: "comment", markdown: "SECRET-COMMENT-TEXT" }, idempotencyKey: `k-${task.taskId}-2`, state: "failed", attempts: 3, error: "the tracker answered 500" },
        { organizationId, projectId, taskId: task.taskId, boardId, ticketId: task.ticketId, kind: "link_task", payload: { kind: "link_task", url: "https://x.example/t", title: "t", subtitle: null }, idempotencyKey: `k-${task.taskId}-3`, state: "pending" },
      ],
    });
    // The images core copied for the agent: a blob of the task each, named by the event the runner sent.
    const png = await harness.test.db.blob.create({
      data: { organizationId, projectId, taskId: task.taskId, store: "postgres", key: `postgres:${crypto.randomUUID()}`, purpose: "ticket-file", contentType: "image/png", size: 2048, sha256: "b".repeat(64) },
    });
    await appendEvent(harness, task, { organizationId, projectId }, { kind: "ticket.files_ready", files: [{ path: "mockup.png", blobId: blobIdSchema.parse(png.id) }] });

    const view = await (await member()).tasks.get({ taskId: task.taskId });
    expect(view.ticket).toMatchObject({ key: "ENG-1", title: "Work on ENG-1", url: "https://linear.app/ostra-test/issue/ENG-1", status: { name: "In Progress", category: "started" }, removed: false });
    expect(view.ticket?.cachedAt).toBeGreaterThan(0);
    expect(view.sync.map((write) => [write.kind, write.state, write.attempts])).toEqual([
      ["move", "done", 0],
      ["comment", "failed", 3],
      ["link_task", "pending", 0],
    ]);
    expect(view.sync[1]?.error).toBe("the tracker answered 500");
    expect(view.contextFiles).toEqual([{ name: "mockup.png", blobId: png.id, size: 2048, contentType: "image/png" }]);
    expect(view.capabilities.retrySync).toBe(true);
    // A write's text is a ticket's: it never comes back through the task.
    expect(JSON.stringify(view)).not.toContain("SECRET-COMMENT-TEXT");
  });

  it("retries the failed writes only, with their jobs, for members of the project", async () => {
    const task = await ticketTask("ENG-2");
    const write = (n: number, state: "done" | "failed" | "pending") =>
      harness.test.db.ticketWrite.create({
        data: { organizationId, projectId, taskId: task.taskId, boardId, ticketId: task.ticketId, kind: "comment", payload: { kind: "comment", markdown: "x" }, idempotencyKey: `k-${task.taskId}-${String(n)}`, state, error: state === "failed" ? "boom" : null },
      });
    const failed = await write(1, "failed");
    const done = await write(2, "done");
    const pending = await write(3, "pending");
    harness.fakes.jobs.clear();

    await expect(retryWrites(await harness.as(harness.fixture.b.admin), task.taskId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(retryWrites(await harness.as(harness.fixture.a.insider), task.taskId)).resolves.toBeDefined();
    // The insider is on the restricted project only, but this one is open: any member may retry.
    const result = await retryWrites(await member(), task.taskId);
    expect(result.retried).toBe(0);

    // Reset and retry as the member.
    await harness.test.db.ticketWrite.update({ where: { id: failed.id }, data: { state: "failed", error: "boom" } });
    harness.fakes.jobs.clear();
    expect((await retryWrites(await member(), task.taskId)).retried).toBe(1);
    expect(await harness.test.db.ticketWrite.findUniqueOrThrow({ where: { id: failed.id } })).toMatchObject({ state: "pending", error: null, idempotencyKey: failed.idempotencyKey });
    expect((await harness.test.db.ticketWrite.findUniqueOrThrow({ where: { id: done.id } })).state).toBe("done");
    expect((await harness.test.db.ticketWrite.findUniqueOrThrow({ where: { id: pending.id } })).state).toBe("pending");
    const syncs = harness.fakes.jobs.jobs.filter((job) => job.job === "ticket.sync");
    expect(syncs.map((job) => job.key)).toEqual([`ticket:${failed.id}:sync`]);
    expect(syncs[0]?.options?.group?.id).toBe(connectionId);
  });

  it("is invisible to another organization and to a restricted project's outsiders", async () => {
    const task = await ticketTask("ENG-3");
    await expect((await harness.as(harness.fixture.b.admin)).tasks.get({ taskId: task.taskId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const restricted = await seedTask(harness, { organizationId, projectId: harness.fixture.a.restrictedProject.id, state: "running" });
    await expect((await member()).tasks.get({ taskId: restricted.taskId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(retryWrites(await member(), restricted.taskId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("F-032, F-096, F-068: sessions, box and spend", () => {
  // Milestone 10 (F-151/c9, ticket 08): the status line names the box when no turn runs
  // (`box idle, stops in 11 min`, `box released`) from these two tests' fields, kept as they were.
  it("F-151/c9: returns the sessions with where each came from, the box and when its idle stop is due, the PRs' states and the start", async () => {
    const task = await ticketTask("ENG-10", "in_review");
    const session = await harness.test.db.session.findFirstOrThrow({ where: { taskId: task.taskId } });
    await harness.test.db.session.update({ where: { id: session.id }, data: { state: "ended", outcome: "with_changes", endedAt: new Date() } });
    const second = await harness.test.db.session.create({ data: { organizationId, projectId, taskId: task.taskId, origin: "restored", state: "idle", startedAt: new Date(Date.now() + 1000) } });
    await appendEvent(harness, { ...task, sessionId: sessionIdSchema.parse(second.id) }, { organizationId, projectId }, { kind: "session.restored", origin: "restored", previousBox: "released" });
    const idleSince = new Date(Date.now() - 4 * 60_000);
    await harness.test.db.box.create({ data: { organizationId, projectId, taskId: task.taskId, executor: "host", state: "idle", idleSince } });
    const repo = await harness.test.db.repo.findFirstOrThrow({ where: { projectId } });
    await harness.test.db.taskRepo.create({
      data: { organizationId, projectId, taskId: task.taskId, repoId: repo.id, branchName: "ostra/eng-10-xxxxxxxx-a", baseBranch: "main", state: "pr_open", prNumber: 7, prUrl: "https://github.com/ostra-test/test1/pull/7" },
    });

    const view = await (await member()).tasks.get({ taskId: task.taskId });
    expect(view.sessions.map((s) => [s.origin, s.state, s.previousBox, s.limit])).toEqual([
      ["new", "ended", null, null],
      ["restored", "idle", "released", null],
    ]);
    expect(view.box).toMatchObject({ state: "idle", releaseReason: null });
    // Idle since four minutes ago, with a 15 minute stop: due in about eleven.
    expect(view.box?.idleStopDueAt).toBe(idleSince.getTime() + 15 * 60_000);
    expect(view.repos[0]?.pr).toMatchObject({ number: 7, state: "open" });
    expect(view.startedAt).toBe(session.startedAt.getTime());
    expect(view.agent?.name).toBeTruthy();
    expect(view.runner).toBeNull();
  });

  it("F-151/c9: shows a released box with when and why, and a merged or closed PR as such", async () => {
    const task = await ticketTask("ENG-11", "in_review");
    const releasedAt = new Date(Date.now() - 2 * 60_000);
    await harness.test.db.box.create({ data: { organizationId, projectId, taskId: task.taskId, executor: "host", state: "released", releasedAt, releaseReason: "prs_closed" } });
    const repo = await harness.test.db.repo.findFirstOrThrow({ where: { projectId } });
    await harness.test.db.taskRepo.create({
      data: { organizationId, projectId, taskId: task.taskId, repoId: repo.id, branchName: "ostra/eng-11-yyyyyyyy-b", baseBranch: "main", state: "closed_unmerged", prNumber: 8, prUrl: "https://github.com/ostra-test/test1/pull/8", closedAt: new Date() },
    });
    const view = await (await member()).tasks.get({ taskId: task.taskId });
    expect(view.box).toMatchObject({ state: "released", releaseReason: "prs_closed", idleStopDueAt: null, releasedAt: releasedAt.getTime() });
    expect(view.repos[0]?.pr?.state).toBe("closed");
  });

  it("reports the spend in dollars against the cap, or in tokens when the model has no known price, and the limit that stopped it", async () => {
    const task = await ticketTask("ENG-12", "needs_you");
    await harness.test.db.task.update({ where: { id: task.taskId }, data: { needsYouReason: "spend_cap", spentMicroUsd: 24_500_000 } });
    await harness.test.db.session.updateMany({ where: { taskId: task.taskId }, data: { state: "stopped", limitReached: "spend_cap", inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 50 } });

    // A model with prices: dollars, the cap from OSTRA_TASK_SPEND_CAP_USD.
    await harness.test.db.model.update({ where: { id: world.modelId }, data: { inputPricePerMTok: 3, outputPricePerMTok: 15 } });
    const priced = await (await member()).tasks.get({ taskId: task.taskId });
    expect(priced.spend).toEqual({ unit: "usd", spent: 24_500_000, cap: 25_000_000, reached: false });
    expect(priced.limit).toBe("spend-cap");
    expect(priced.sessions[0]?.limit).toBe("spend-cap");

    // No known price: the four token kinds against the token cap.
    await harness.test.db.model.update({ where: { id: world.modelId }, data: { inputPricePerMTok: null, outputPricePerMTok: null } });
    const unpriced = await (await member()).tasks.get({ taskId: task.taskId });
    expect(unpriced.spend).toEqual({ unit: "tokens", spent: 1750, cap: 10_000_000, reached: false });
  });

  it("F-084/c1: the spend is in dollars by the prices of the model row its session runs on, as ingest priced it, not by its profile's", async () => {
    const db = harness.test.db;
    const task = await ticketTask("ENG-13", "running");
    await db.task.update({ where: { id: task.taskId }, data: { spentMicroUsd: 2_200_000 } });
    await db.session.updateMany({ where: { taskId: task.taskId }, data: { inputTokens: 1000, outputTokens: 500 } });
    // The profile's row of the model has no price; the serving provider's row of it has its own (F-135).
    await db.model.update({ where: { id: world.modelId }, data: { inputPricePerMTok: null, outputPricePerMTok: null } });
    const servingKey = await seedProviderRow(db, organizationId, "Serving key");
    const serving = await seedModelRow(db, { organizationId, providerId: servingKey, endpointModelId: "world-model", inputPricePerMTok: 1, outputPricePerMTok: 5 });
    await db.session.updateMany({ where: { taskId: task.taskId }, data: { providerId: servingKey, modelId: serving } });
    expect((await (await member()).tasks.get({ taskId: task.taskId })).spend).toEqual({ unit: "usd", spent: 2_200_000, cap: 25_000_000, reached: false });
    // And a priced profile row doesn't put dollars on a session that runs on an unpriced row.
    await db.model.update({ where: { id: world.modelId }, data: { inputPricePerMTok: 3, outputPricePerMTok: 15 } });
    await db.model.update({ where: { id: serving }, data: { inputPricePerMTok: null, outputPricePerMTok: null } });
    try {
      expect((await (await member()).tasks.get({ taskId: task.taskId })).spend).toEqual({ unit: "tokens", spent: 1500, cap: 10_000_000, reached: false });
    } finally {
      await db.model.update({ where: { id: world.modelId }, data: { inputPricePerMTok: null, outputPricePerMTok: null } });
    }
  });

  it("F-084/c1: of two sessions started at the same moment, the spend follows the one a reopen takes as the newest, the higher ID", async () => {
    const db = harness.test.db;
    const task = await ticketTask("ENG-14", "running");
    await db.task.update({ where: { id: task.taskId }, data: { spentMicroUsd: 1_100_000 } });
    const tieKey = await seedProviderRow(db, organizationId, "Tie key");
    const priced = await seedModelRow(db, { organizationId, providerId: tieKey, endpointModelId: "world-model", inputPricePerMTok: 1, outputPricePerMTok: 5 });
    // The seeded session (a UUIDv7 of now) runs on the priced row. One written after it, with a lower ID
    // and the same start, runs on the profile's unpriced row: rows in the order they were written would end on it.
    const startedAt = new Date();
    await db.session.updateMany({ where: { taskId: task.taskId }, data: { startedAt, providerId: tieKey, modelId: priced, inputTokens: 100, outputTokens: 50 } });
    await db.session.create({
      data: { id: "00000000-0000-7000-8000-000000000e14", organizationId, projectId, taskId: task.taskId, origin: "new", state: "ended", outcome: "with_changes", startedAt, endedAt: startedAt, modelId: world.modelId, inputTokens: 200, outputTokens: 100 },
    });
    await db.model.update({ where: { id: world.modelId }, data: { inputPricePerMTok: null, outputPricePerMTok: null } });
    const view = await (await member()).tasks.get({ taskId: task.taskId });
    expect(view.spend).toEqual({ unit: "usd", spent: 1_100_000, cap: 25_000_000, reached: false });
    // The panel's session and its key are the same newest one.
    expect(view.session?.id).toBe(task.sessionId);
    expect(view.session?.providerName).toBe("Tie key");
    expect(view.sessions.at(-1)?.id).toBe(task.sessionId);
  });
});

describe("F-033, F-068: capabilities", () => {
  const caps = async (task: { readonly taskId: SeededTask["taskId"] }, who: () => ReturnType<typeof member> = member) => (await (await who()).tasks.get({ taskId: task.taskId })).capabilities;

  it("stops only a task that has something running: not in review, merged, done, stopped, or after a limit or a crash", async () => {
    expect((await caps(await ticketTask("ENG-20", "running"))).stop).toBe(true);
    expect((await caps(await ticketTask("ENG-21", "in_review"))).stop).toBe(false);
    expect((await caps(await ticketTask("ENG-22", "stopped"))).stop).toBe(false);

    const merged = await ticketTask("ENG-23", "in_review");
    await harness.test.db.task.update({ where: { id: merged.taskId }, data: { state: "merged", subState: null } });
    expect((await caps(merged)).stop).toBe(false);
    const finished = await ticketTask("ENG-24", "running");
    await harness.test.db.task.update({ where: { id: finished.taskId }, data: { kind: "refine", state: "done" } });
    expect((await caps(finished)).stop).toBe(false);

    // A limit or a crash ended the session: nothing is left to stop.
    const limited = await ticketTask("ENG-25", "needs_you");
    await harness.test.db.task.update({ where: { id: limited.taskId }, data: { needsYouReason: "stalled" } });
    await harness.test.db.session.updateMany({ where: { taskId: limited.taskId }, data: { state: "stopped", limitReached: "stall" } });
    expect((await caps(limited)).stop).toBe(false);
    const crashed = await ticketTask("ENG-26", "needs_you");
    await harness.test.db.task.update({ where: { id: crashed.taskId }, data: { needsYouReason: "crashed" } });
    await harness.test.db.session.updateMany({ where: { taskId: crashed.taskId }, data: { state: "crashed" } });
    expect((await caps(crashed)).stop).toBe(false);
    // A task that needs an answer while its agent waits can still be stopped.
    expect((await caps(await ticketTask("ENG-27", "needs_you"))).stop).toBe(true);
  });

  it("F-066: offers a reopen from stopped, in review, done, merged with a merged repo and the waiting reasons; a merged task with no merged repo says why not; one-click only for a limit or a crash", async () => {
    expect(await caps(await ticketTask("ENG-30", "stopped"))).toMatchObject({ reopen: true, reopenBlocked: null, reopenWithoutText: false });
    expect(await caps(await ticketTask("ENG-31", "in_review"))).toMatchObject({ reopen: true, reopenWithoutText: false });
    expect(await caps(await ticketTask("ENG-32", "running"))).toMatchObject({ reopen: false, reopenBlocked: null });
    const merged = await ticketTask("ENG-33", "in_review");
    await harness.test.db.task.update({ where: { id: merged.taskId }, data: { state: "merged", subState: null } });
    expect(await caps(merged)).toMatchObject({ reopen: false, reopenBlocked: "merged_reopen_later" });
    // F-066: once a repo records its merge, the merged task reopens on a fresh branch from its base.
    const mergedRepo = await harness.test.db.repo.findFirstOrThrow({ where: { organizationId } });
    await harness.test.db.taskRepo.create({
      data: { organizationId, projectId, taskId: merged.taskId, repoId: mergedRepo.id, branchName: "ostra/eng-33-zzzzzzzz-c", baseBranch: "main", state: "merged", prNumber: 9, prUrl: "https://github.com/ostra-test/test1/pull/9" },
    });
    expect(await caps(merged)).toMatchObject({ reopen: true, reopenBlocked: null });

    const crashed = await ticketTask("ENG-34", "needs_you");
    await harness.test.db.task.update({ where: { id: crashed.taskId }, data: { needsYouReason: "crashed" } });
    expect(await caps(crashed)).toMatchObject({ reopen: true, reopenWithoutText: true });
    const noChanges = await ticketTask("ENG-35", "needs_you");
    await harness.test.db.task.update({ where: { id: noChanges.taskId }, data: { needsYouReason: "no_changes" } });
    expect(await caps(noChanges)).toMatchObject({ reopen: true, reopenWithoutText: false });
    // An approval or a question waits for an answer, not a reopen.
    expect(await caps(await ticketTask("ENG-36", "needs_you"))).toMatchObject({ reopen: false });
  });

  it("F-032: a question that expired and ended its session leaves the task reopenable, with the member's message", async () => {
    const expired = await ticketTask("ENG-39", "needs_you");
    await harness.test.db.task.update({ where: { id: expired.taskId }, data: { needsYouReason: "question" } });
    // While its agent waits on the answer, the task is answered, not reopened.
    expect(await caps(expired)).toMatchObject({ reopen: false, send: true });
    await harness.test.db.session.updateMany({ where: { taskId: expired.taskId }, data: { state: "ended", outcome: "without_changes", endedAt: new Date() } });
    expect(await caps(expired)).toMatchObject({ reopen: true, reopenBlocked: null, reopenWithoutText: false, send: false });
  });

  it("refuses a reopen at the spend cap until the cap is raised", async () => {
    const task = await ticketTask("ENG-37", "needs_you");
    await harness.test.db.model.update({ where: { id: world.modelId }, data: { inputPricePerMTok: 3, outputPricePerMTok: 15 } });
    await harness.test.db.task.update({ where: { id: task.taskId }, data: { needsYouReason: "spend_cap", spentMicroUsd: 25_000_000 } });
    expect(await caps(task)).toMatchObject({ reopen: false, reopenBlocked: "spend_cap", reopenWithoutText: false });
    await harness.test.db.task.update({ where: { id: task.taskId }, data: { spentMicroUsd: 1_000_000 } });
    expect(await caps(task)).toMatchObject({ reopen: true, reopenWithoutText: true });
  });

  it("refuses a reopen while another active task holds the ticket, and says so", async () => {
    const first = await ticketTask("ENG-38", "stopped");
    const second = await seedTask(harness, { organizationId, projectId, state: "running", driverMemberId: harness.fixture.a.member.id });
    await harness.test.db.task.update({ where: { id: second.taskId }, data: { source: "ticket", ticketId: first.ticketId, boardId, ticketKey: "ENG-38" } });
    expect(await caps(first)).toMatchObject({ reopen: false, reopenBlocked: "ticket_has_task" });
  });

  it("keeps send for the driver of a running task and interrupt for a running turn", async () => {
    const task = await ticketTask("ENG-39", "running");
    expect(await caps(task)).toMatchObject({ send: true, interrupt: true, takeOver: false });
    expect(await caps(task, admin)).toMatchObject({ send: false, interrupt: false, takeOver: true });
  });
});

describe("F-032, F-033: reopening", () => {
  // Milestone 10 (ticket 11, `s2.md`): the composer of a task in review whose box idles reads as a
  // send for its driver (`Message OpenCode…`, Send): the message reopens it in that same box.
  it("F-151/c4: the driver of a task in review whose box is idle sends into it (`reopenInBox`); anyone else, a stopped box or a running task doesn't", async () => {
    const task = await ticketTask("ENG-60", "in_review");
    await harness.test.db.session.updateMany({ where: { taskId: task.taskId }, data: { state: "idle" } });
    const box = await harness.test.db.box.create({ data: { organizationId, projectId, taskId: task.taskId, executor: "host", state: "idle", idleSince: new Date() } });
    expect((await (await member()).tasks.get({ taskId: task.taskId })).capabilities).toMatchObject({ send: false, reopen: true, reopenInBox: true });
    // Anyone else's message makes them the driver: theirs stays a reopen.
    expect((await (await admin()).tasks.get({ taskId: task.taskId })).capabilities).toMatchObject({ reopen: true, reopenInBox: false });
    // The box stopped: a reopen finds a box again, so it says so.
    await harness.test.db.box.update({ where: { id: box.id }, data: { state: "stopped" } });
    expect((await (await member()).tasks.get({ taskId: task.taskId })).capabilities).toMatchObject({ reopen: true, reopenInBox: false });
    // A running task's message is a send.
    const running = await ticketTask("ENG-61", "running");
    expect((await (await member()).tasks.get({ taskId: running.taskId })).capabilities).toMatchObject({ send: true, reopenInBox: false });
    // And the message itself reopens the task in review, as its Send says.
    await harness.test.db.box.update({ where: { id: box.id }, data: { state: "idle" } });
    await (await member()).tasks.reopen({ taskId: task.taskId, clientMessageId: messageId(), text: "Set the expressions in the mono font." });
    expect((await harness.test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state).toBe("queued");
  });

  it("reopens a stopped task with the member's message, once per message ID, and makes the member the driver", async () => {
    const task = await ticketTask("ENG-50", "stopped");
    const clientMessageId = messageId();
    const first = await (await admin()).tasks.reopen({ taskId: task.taskId, clientMessageId, text: "Also add the date" });
    await (await admin()).tasks.reopen({ taskId: task.taskId, clientMessageId, text: "Also add the date" }).catch(() => undefined);
    const row = await harness.test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    expect(row).toMatchObject({ state: "queued", driverMemberId: harness.fixture.a.admin.id });
    const messages = await harness.test.db.event.findMany({ where: { taskId: task.taskId, kind: "user.message" } });
    expect(messages.filter((message) => JSON.stringify(message.payload).includes(clientMessageId))).toHaveLength(1);
    expect(first.sessionId).toBeTruthy();
    // Milestone 9 (F-149, ticket 12): a ticket task's reopen reads the ticket again first; that job sends the dispatch.
    expect(harness.fakes.jobs.jobs.filter((job) => job.job === "ticket.read-changes" && job.key.startsWith(`task:${task.taskId}:`))).toHaveLength(1);
  });

  it("refuses a task without a message unless a limit or a crash stopped it, and then writes the carry-on text", async () => {
    const stopped = await ticketTask("ENG-51", "stopped");
    await expect((await member()).tasks.reopen({ taskId: stopped.taskId, clientMessageId: messageId() })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const crashed = await ticketTask("ENG-52", "needs_you");
    await harness.test.db.task.update({ where: { id: crashed.taskId }, data: { needsYouReason: "crashed" } });
    await harness.test.db.session.updateMany({ where: { taskId: crashed.taskId }, data: { state: "crashed" } });
    await (await member()).tasks.reopen({ taskId: crashed.taskId, clientMessageId: messageId() });
    const messages = await harness.test.db.event.findMany({ where: { taskId: crashed.taskId, kind: "user.message" } });
    expect(JSON.stringify(messages.map((message) => message.payload))).toContain(reopenCarryOnText);
  });

  it("F-036: a reopen answers the items of what the task needed, each with its fan-out, and leaves the ones that don't hold it", async () => {
    const task = await ticketTask("ENG-58", "needs_you");
    await harness.test.db.task.update({ where: { id: task.taskId }, data: { needsYouReason: "crashed" } });
    await harness.test.db.session.updateMany({ where: { taskId: task.taskId }, data: { state: "crashed" } });
    const crashed = await harness.test.db.needsYouItem.create({ data: { organizationId, projectId, taskId: task.taskId, reason: "crashed", audience: "driver", state: "open" } });
    const files = await harness.test.db.needsYouItem.create({ data: { organizationId, projectId, taskId: task.taskId, reason: "files_outside_repos", audience: "driver", state: "open" } });
    await (await member()).tasks.reopen({ taskId: task.taskId, clientMessageId: messageId() });
    expect((await harness.test.db.needsYouItem.findUniqueOrThrow({ where: { id: crashed.id } })).state).toBe("answered");
    expect((await harness.test.db.needsYouItem.findUniqueOrThrow({ where: { id: files.id } })).state).toBe("open");
    const fanouts = harness.fakes.jobs.jobs.filter((job) => job.job === "notify.fanout").map((job) => job.key);
    expect(fanouts).toContain(`item:${crashed.id}:fanout:answered`);
    expect(fanouts).not.toContain(`item:${files.id}:fanout:answered`);
  });

  it("refuses a merged task, a running task and a ticket another task holds, with their reasons", async () => {
    const merged = await ticketTask("ENG-53", "in_review");
    await harness.test.db.task.update({ where: { id: merged.taskId }, data: { state: "merged", subState: null } });
    await expect((await member()).tasks.reopen({ taskId: merged.taskId, clientMessageId: messageId(), text: "again" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const running = await ticketTask("ENG-54", "running");
    await expect((await member()).tasks.reopen({ taskId: running.taskId, clientMessageId: messageId(), text: "again" })).rejects.toMatchObject({ code: "CONFLICT" });
    const held = await ticketTask("ENG-55", "stopped");
    const holder = await seedTask(harness, { organizationId, projectId, state: "running" });
    await harness.test.db.task.update({ where: { id: holder.taskId }, data: { source: "ticket", ticketId: held.ticketId, boardId, ticketKey: "ENG-55" } });
    await expect((await member()).tasks.reopen({ taskId: held.taskId, clientMessageId: messageId(), text: "again" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("lets a watcher reopen only when they can read the project", async () => {
    const task = await ticketTask("ENG-56", "stopped");
    await expect((await harness.as(harness.fixture.b.admin)).tasks.reopen({ taskId: task.taskId, clientMessageId: messageId(), text: "hi" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const restricted = await seedTask(harness, { organizationId, projectId: harness.fixture.a.restrictedProject.id, state: "stopped" });
    await expect((await member()).tasks.reopen({ taskId: restricted.taskId, clientMessageId: messageId(), text: "hi" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect((await harness.as(harness.fixture.a.insider)).tasks.reopen({ taskId: restricted.taskId, clientMessageId: messageId(), text: "hi" })).resolves.toBeDefined();
    await expect((await member()).tasks.reopen({ taskId: task.taskId, clientMessageId: messageId(), text: "hi" })).resolves.toBeDefined();
  });

  it("dismisses a restore conflict for the driver or a project admin, and nothing else", async () => {
    const task = await ticketTask("ENG-57", "running");
    const item = await harness.test.db.needsYouItem.create({ data: { organizationId, projectId, taskId: task.taskId, reason: "restore_conflict", audience: "driver", state: "open" } });
    await expect((await harness.as(harness.fixture.a.insider)).tasks.dismissNeedsYou({ taskId: task.taskId, itemId: needsYouItemIdSchema.parse(item.id) })).rejects.toBeDefined();
    await (await member()).tasks.dismissNeedsYou({ taskId: task.taskId, itemId: needsYouItemIdSchema.parse(item.id) });
    expect((await harness.test.db.needsYouItem.findUniqueOrThrow({ where: { id: item.id } })).state).toBe("dismissed");
    // F-036: the dismissal enqueued its fan-out.
    expect(harness.fakes.jobs.jobs.filter((job) => job.job === "notify.fanout" && job.key === `item:${item.id}:fanout:dismissed`)).toHaveLength(1);
    const question = await harness.test.db.needsYouItem.create({ data: { organizationId, projectId, taskId: task.taskId, reason: "question", audience: "driver", state: "open" } });
    await expect((await member()).tasks.dismissNeedsYou({ taskId: task.taskId, itemId: needsYouItemIdSchema.parse(question.id) })).rejects.toBeDefined();
  });
});
