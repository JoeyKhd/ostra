import { randomBytes, randomUUID } from "node:crypto";

import { mapMember } from "@ostra/db";
import type { SeededMember } from "@ostra/db/testing";
import { saveDraft } from "@ostra/domain";
import { APP_RECORDING_CONTENT_TYPE, clientMessageIdSchema, draftIdSchema, previewRefusalWords, taskIdSchema } from "@ostra/protocol";
import type { OrganizationId, ProjectId, RepoId, TaskId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { serveTaskAttachment } from "../services/attachment-download.ts";
import { createApiHarness, pngBytes, seedAttachment, seedConnectionAndModel, seedLease, seedPersonalRunner, seedProject, seedTask } from "../testing/index.ts";
import type { ApiHarness, AppCaller, SeededTask } from "../testing/index.ts";

// Milestone 8, ticket 16 (F-121; ADR 0043, ADR 0068): a task's screenshots and recordings through
// the panel's own procedures and its download route, on Postgres, in a restricted project. The rows
// are seeded as core's ingest stores them from `attachment.added`. Its member and an organization
// admin see them, each at its turn with the browser that took it; an organization member the project
// doesn't list and another organization's admin see none, and download none. A download is a file of
// its kind's fixed type, never a page. "Add to draft" puts a refine task's screenshot among its
// draft's images; a finding shows the review task's.

let harness: ApiHarness;
let organizationId: OrganizationId;
let projectId: ProjectId;
let repoId: RepoId;
let projectMember: SeededMember;
let outsider: SeededMember;

let unique = 0;
const label = (prefix: string): string => {
  unique += 1;
  return `${prefix}-${String(unique)}-${randomUUID().slice(0, 6)}`;
};

const seedMember = async (): Promise<SeededMember> => {
  const name = label("person");
  const user = await harness.test.db.user.create({ data: { id: randomUUID(), name, email: `${name}@example.com`, username: name } });
  return mapMember(await harness.test.db.member.create({ data: { id: randomUUID(), organizationId, userId: user.id, role: "member", createdAt: new Date() } }));
};

const outcomeOf = async (call: () => Promise<unknown>): Promise<string> => {
  try {
    await call();
    return "ok";
  } catch (error) {
    if (error instanceof TRPCError) {
      return error.code;
    }
    throw error;
  }
};

const as = (member: SeededMember): Promise<AppCaller> => harness.as(member);

const place = () => ({ organizationId, projectId });

/** A turn of the task's session, as the ingest opens one at `turn.started`. */
const seedTurn = async (task: SeededTask, ordinal: number): Promise<string> =>
  (await harness.test.db.turn.create({ data: { organizationId, projectId, taskId: task.taskId, sessionId: task.sessionId, ordinal, startSeq: ordinal * 10 } })).id;

/** A refine task waiting on its draft, with the agent's first version. */
const refineTask = async (): Promise<{ readonly taskId: TaskId; readonly draftId: string }> => {
  const row = await harness.test.db.task.create({
    data: { organizationId, projectId, kind: "refine", source: "prompt", title: "Refine the footer", prompt: "Refine the footer", branchName: `ostra/${randomBytes(4).toString("hex")}-refine`, state: "needs_you", needsYouReason: "draft_ready", driverMemberId: harness.fixture.a.admin.id },
    select: { id: true },
  });
  const taskId = taskIdSchema.parse(row.id);
  const saved = await harness.test.db.$transaction((tx) =>
    saveDraft({ tx, ...harness.deps.ports }, { organizationId, taskId, draft: { description: "Make the footer fast.", acceptanceCriteria: ["Under 1 s"], edgeCases: [], openQuestions: [], subTickets: [] } }),
  );
  if (!saved.ok) {
    throw new Error("no draft");
  }
  const draft = await harness.test.db.refineDraft.findFirstOrThrow({ where: { taskId }, orderBy: { version: "desc" }, select: { id: true } });
  return { taskId, draftId: draft.id };
};

beforeAll(async () => {
  harness = await createApiHarness();
  organizationId = harness.fixture.a.organization.id;
  const world = await seedConnectionAndModel(harness);
  const made = await seedProject(harness, world, label("attachments"));
  projectId = made.projectId;
  repoId = made.repoId;
  const admin = await as(harness.fixture.a.admin);
  await admin.projects.setAccess({ projectId, access: "restricted" });
  projectMember = await seedMember();
  outsider = await seedMember();
  await admin.projects.setMember({ projectId, memberId: projectMember.id, role: "member" });
}, 120_000);

afterAll(async () => {
  await harness.dispose();
});

describe("a task's screenshots and recordings (F-121)", () => {
  it("F-121/c4,c8: a member who can open the task lists its screenshots and recordings, each at its turn, with its kind, source, target, sizes, caption and the browser that took it", async () => {
    const task = await seedTask(harness, { ...place(), state: "running", driverMemberId: projectMember.id });
    const turn = await seedTurn(task, 2);
    const caption = "The settings page; $(rm -rf /) is the agent's text, not a command";
    const shot = await seedAttachment(harness, { ...place(), taskId: task.taskId }, { turnId: turn, caption });
    const reel = await seedAttachment(harness, { ...place(), taskId: task.taskId }, { kind: "recording", turnId: turn, bytes: new Uint8Array(300).fill(1) });
    const mine = await seedAttachment(harness, { ...place(), taskId: task.taskId }, { memberId: projectMember.id });

    const listed = await (await as(projectMember)).tasks.attachments({ taskId: task.taskId });
    expect(listed.attachments.map((attachment) => attachment.attachmentId)).toEqual([shot.attachmentId, reel.attachmentId, mine.attachmentId]);
    const [first, second, third] = listed.attachments;
    expect(typeof first?.createdAt).toBe("number");
    expect({ ...first, createdAt: 0 }).toEqual({
      attachmentId: shot.attachmentId,
      taskId: task.taskId,
      kind: "screenshot",
      source: "agent",
      target: { kind: "process", name: "web" },
      path: "/",
      width: 1440,
      height: 900,
      bytes: 64,
      contentType: "image/png",
      durationMs: null,
      frameCount: null,
      caption,
      browser: { name: "Chromium", version: "131.0.6778.85" },
      turn: { turnId: turn, ordinal: 2, startSeq: 20 },
      takenBy: null,
      inDraft: false,
      draftImageId: null,
      createdAt: 0,
      downloadPath: `/api/tasks/${task.taskId}/attachments/${shot.attachmentId}`,
    });
    expect(second).toMatchObject({ kind: "recording", source: "agent", bytes: 300, contentType: APP_RECORDING_CONTENT_TYPE, durationMs: 4_000, frameCount: 40, turn: { ordinal: 2 }, browser: { name: "Chromium" } });
    expect(third).toMatchObject({ source: "member", turn: null, takenBy: { memberId: projectMember.id } });
    expect(third?.takenBy?.name).toMatch(/^person-/);
    // An organization admin opens every project.
    expect((await (await as(harness.fixture.a.admin)).tasks.attachments({ taskId: task.taskId })).attachments).toHaveLength(3);
    // The caption is the agent's words: shown to the project's members, and in no log line.
    expect(JSON.stringify(harness.logs)).not.toContain("rm -rf");
  });

  it("F-121/c4: an organization member the restricted project doesn't list, and another organization's admin, see none of a task's attachments", async () => {
    const task = await seedTask(harness, { ...place(), state: "running", driverMemberId: projectMember.id });
    await seedAttachment(harness, { ...place(), taskId: task.taskId });
    expect(await outcomeOf(() => as(outsider).then((caller) => caller.tasks.attachments({ taskId: task.taskId })))).toBe("NOT_FOUND");
    expect(await outcomeOf(() => as(harness.fixture.b.admin).then((caller) => caller.tasks.attachments({ taskId: task.taskId })))).toBe("NOT_FOUND");
    expect(await outcomeOf(() => harness.anonymous().tasks.attachments({ taskId: task.taskId }))).toBe("UNAUTHORIZED");
  });

  it("F-121/c4: an attachment downloads as a file of its kind's fixed type, never as a page, and only for those who can open the task", async () => {
    const task = await seedTask(harness, { ...place(), state: "running", driverMemberId: projectMember.id });
    // Stored as a page would be: it still goes out as a PNG file.
    const bytes = pngBytes(128);
    const shot = await seedAttachment(harness, { ...place(), taskId: task.taskId }, { bytes, contentType: "text/html" });
    const reel = await seedAttachment(harness, { ...place(), taskId: task.taskId }, { kind: "recording" });
    const member = await harness.contextOf(projectMember);

    const response = await serveTaskAttachment(member, task.taskId, shot.attachmentId);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="screenshot-${shot.attachmentId}.png"`);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    const recording = await serveTaskAttachment(member, task.taskId, reel.attachmentId);
    expect(recording.headers.get("content-type")).toBe(APP_RECORDING_CONTENT_TYPE);
    expect(recording.headers.get("content-disposition")).toBe(`attachment; filename="recording-${reel.attachmentId}.reel"`);

    // Outside the project, another organization, another task's ID, an unknown one: the same 404. Signed out: 401.
    const other = await seedTask(harness, { ...place(), state: "running" });
    expect((await serveTaskAttachment(await harness.contextOf(outsider), task.taskId, shot.attachmentId)).status).toBe(404);
    expect((await serveTaskAttachment(await harness.contextOf(harness.fixture.b.admin), task.taskId, shot.attachmentId)).status).toBe(404);
    expect((await serveTaskAttachment(member, other.taskId, shot.attachmentId)).status).toBe(404);
    expect((await serveTaskAttachment(member, task.taskId, "no-such-attachment")).status).toBe(404);
    expect((await serveTaskAttachment({ ...member, user: null, member: null }, task.taskId, shot.attachmentId)).status).toBe(401);
    // A blob store that doesn't answer says so: the harness's stand-in for core can't reach an
    // S3-compatible store (core's own test reads one).
    await harness.test.db.blob.update({ where: { id: shot.blobId }, data: { store: "s3" } });
    const elsewhere = await serveTaskAttachment(member, task.taskId, shot.attachmentId);
    expect(elsewhere.status).toBe(503);
    expect(elsewhere.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("F-121/c11: a task whose runner is below protocol minor 7 says it needs upgrading for its app, and one at minor 7 doesn't", async () => {
    const task = await seedTask(harness, { ...place(), state: "running", driverMemberId: projectMember.id });
    const asMember = await as(projectMember);
    // No app process declared yet: nothing to say.
    expect((await asMember.tasks.attachments({ taskId: task.taskId })).app).toEqual({ kind: "no-app" });
    const environment = await harness.test.db.environment.findUniqueOrThrow({ where: { projectId }, select: { id: true } });
    await harness.test.db.appProcess.create({ data: { organizationId, projectId, environmentId: environment.id, repoId, name: "web", command: "pnpm dev", port: 5173, readyKind: "port", label: "Web", primary: true } });
    expect((await asMember.tasks.attachments({ taskId: task.taskId })).app).toEqual({ kind: "no-runner" });
    const runnerId = await seedPersonalRunner(harness, projectMember.id, label("old-runner"));
    await harness.test.db.runnerPresence.create({ data: { organizationId, runnerId, minor: 6, replicaId: "replica-1", connectionEpoch: 1, carrier: "websocket" } });
    await seedLease(harness, task, organizationId, projectId, runnerId);
    expect((await asMember.tasks.attachments({ taskId: task.taskId })).app).toEqual({ kind: "runner-needs-upgrade", words: previewRefusalWords("runner-needs-upgrade") });
    await harness.test.db.runnerPresence.update({ where: { runnerId }, data: { minor: 7 } });
    expect((await asMember.tasks.attachments({ taskId: task.taskId })).app).toEqual({ kind: "supported" });
    await harness.test.db.appProcess.deleteMany({ where: { projectId } });
  });

  it("F-121/c5: a turn's screenshot and recording are still listed and served after its box stops, after a reload, and after a reopen on a fresh box", async () => {
    const db = harness.test.db;
    const task = await seedTask(harness, { ...place(), state: "running", driverMemberId: projectMember.id });
    await seedLease(harness, task, organizationId, projectId, await seedPersonalRunner(harness, projectMember.id, label("first-box")));
    const firstBox = await db.box.findFirstOrThrow({ where: { taskId: task.taskId }, select: { id: true } });
    await db.session.update({ where: { id: task.sessionId }, data: { boxId: firstBox.id } });
    const firstTurn = await seedTurn(task, 1);
    const shotBytes = pngBytes(256);
    const reelBytes = new Uint8Array(400).fill(7);
    const shot = await seedAttachment(harness, { ...place(), taskId: task.taskId }, { turnId: firstTurn, bytes: shotBytes });
    const reel = await seedAttachment(harness, { ...place(), taskId: task.taskId }, { kind: "recording", turnId: firstTurn, bytes: reelBytes });
    const asMember = await as(projectMember);
    const member = await harness.contextOf(projectMember);
    /** The attachments as the task page lists them, and each one's bytes as its download serves them. */
    const seen = async () => {
      const listed = (await asMember.tasks.attachments({ taskId: task.taskId })).attachments;
      const served = await Promise.all(
        listed.map(async (attachment) => {
          const response = await serveTaskAttachment(member, task.taskId, attachment.attachmentId);
          return [attachment.attachmentId, response.status, Buffer.from(await response.arrayBuffer()).toString("hex")] as const;
        }),
      );
      return { listed: listed.map((attachment) => [attachment.attachmentId, attachment.kind, attachment.turn?.turnId ?? null] as const), served };
    };
    const firstTurns = [
      [shot.attachmentId, "screenshot", firstTurn],
      [reel.attachmentId, "recording", firstTurn],
    ];
    const firstBytes = [
      [shot.attachmentId, 200, Buffer.from(shotBytes).toString("hex")],
      [reel.attachmentId, 200, Buffer.from(reelBytes).toString("hex")],
    ];
    expect(await seen()).toEqual({ listed: firstTurns, served: firstBytes });

    // The box stops: its lease ends, the box is released, the session ends and the task stops.
    await db.lease.updateMany({ where: { taskId: task.taskId, state: "active" }, data: { state: "ended", endedAt: new Date(), endReason: "released" } });
    await db.box.update({ where: { id: firstBox.id }, data: { state: "released" } });
    await db.session.update({ where: { id: task.sessionId }, data: { state: "ended", outcome: "with_changes", endedAt: new Date() } });
    await db.task.update({ where: { id: task.taskId }, data: { state: "stopped", stoppedReason: "requested" } });
    expect(await seen()).toEqual({ listed: firstTurns, served: firstBytes });
    // A reload asks again, and gets the same.
    expect(await seen()).toEqual({ listed: firstTurns, served: firstBytes });

    // A reopen: a new session, which core places on a fresh box of another runner (the first box is gone).
    const { sessionId } = await asMember.tasks.reopen({ taskId: task.taskId, clientMessageId: clientMessageIdSchema.parse(randomUUID()), text: "Show the settings page again" });
    expect(sessionId).not.toBe(task.sessionId);
    const reopened = { taskId: task.taskId, sessionId };
    await seedLease(harness, reopened, organizationId, projectId, await seedPersonalRunner(harness, projectMember.id, label("fresh-box")), 2);
    const freshBox = await db.box.findFirstOrThrow({ where: { taskId: task.taskId, state: "ready" }, select: { id: true } });
    expect(freshBox.id).not.toBe(firstBox.id);
    await db.session.update({ where: { id: sessionId }, data: { boxId: freshBox.id, origin: "restored", state: "running" } });
    await db.task.update({ where: { id: task.taskId }, data: { state: "running", stoppedReason: null } });
    expect(await seen()).toEqual({ listed: firstTurns, served: firstBytes });

    // The fresh box's own turn adds its screenshot after them.
    const nextTurn = await seedTurn(reopened, 2);
    const next = await seedAttachment(harness, { ...place(), taskId: task.taskId }, { turnId: nextTurn });
    const after = await seen();
    expect(after.listed).toEqual([...firstTurns, [next.attachmentId, "screenshot", nextTurn]]);
    expect(after.served.slice(0, 2)).toEqual(firstBytes);
    expect(after.served[2]?.[1]).toBe(200);
  });
});

describe('"Add to draft" and a finding\'s screenshots (F-121)', () => {
  it('F-121/c7: "Add to draft" puts a refine task\'s screenshot among its draft\'s images for any member who can open it, once; a recording, a stale draft and anyone outside are refused', async () => {
    const refine = await refineTask();
    const shot = await seedAttachment(harness, { ...place(), taskId: refine.taskId });
    const reel = await seedAttachment(harness, { ...place(), taskId: refine.taskId }, { kind: "recording" });
    const draftId = draftIdSchema.parse(refine.draftId);
    const input = { taskId: refine.taskId, attachmentId: shot.attachmentId, draftId };

    expect(await outcomeOf(() => as(outsider).then((caller) => caller.tasks.attachmentToDraft(input)))).toBe("NOT_FOUND");
    expect(await outcomeOf(() => as(harness.fixture.b.admin).then((caller) => caller.tasks.attachmentToDraft(input)))).toBe("NOT_FOUND");
    expect(await harness.test.db.refineDraftImage.count({ where: { draftId } })).toBe(0);

    // The draft's owner is the organization admin who drives it; a project member who isn't may add one too (milestone 6's rule).
    const asMember = await as(projectMember);
    const added = await asMember.tasks.attachmentToDraft(input);
    expect(await asMember.tasks.attachmentToDraft(input)).toEqual(added);
    expect((await asMember.drafts.get({ taskId: refine.taskId, version: null })).draft?.images).toEqual([expect.objectContaining({ imageId: added.draftImageId, contentType: "image/png", size: 64 })]);
    const inDraft = (await asMember.tasks.attachments({ taskId: refine.taskId })).attachments.find((one) => one.attachmentId === shot.attachmentId);
    expect(inDraft?.inDraft).toBe(true);
    // Ticket 17: the draft image it became, so the draft shows the picture among its images.
    expect(inDraft?.draftImageId).not.toBeNull();
    // The draft's owner adds the next one.
    const second = await seedAttachment(harness, { ...place(), taskId: refine.taskId });
    await (await as(harness.fixture.a.admin)).tasks.attachmentToDraft({ ...input, attachmentId: second.attachmentId });
    expect(await harness.test.db.refineDraftImage.count({ where: { draftId } })).toBe(2);

    expect(await outcomeOf(() => asMember.tasks.attachmentToDraft({ ...input, attachmentId: reel.attachmentId }))).toBe("BAD_REQUEST");
    expect(await outcomeOf(() => asMember.tasks.attachmentToDraft({ ...input, draftId: draftIdSchema.parse(randomUUID()) }))).toBe("NOT_FOUND");
    // A code task has no draft to add to.
    const code = await seedTask(harness, { ...place(), state: "running" });
    const codeShot = await seedAttachment(harness, { ...place(), taskId: code.taskId });
    expect(await outcomeOf(() => asMember.tasks.attachmentToDraft({ taskId: code.taskId, attachmentId: codeShot.attachmentId, draftId }))).toBe("NOT_FOUND");
    // Another task's screenshot isn't this draft's.
    expect(await outcomeOf(() => asMember.tasks.attachmentToDraft({ ...input, attachmentId: codeShot.attachmentId }))).toBe("NOT_FOUND");
  });

  it("F-121/c7: a finding shows the review task's screenshots it names, and leaves out an ID that isn't one", async () => {
    const db = harness.test.db;
    const code = await seedTask(harness, { ...place(), state: "in_review", driverMemberId: projectMember.id, sessionState: "ended" });
    const review = await db.task.create({
      data: { organizationId, projectId, kind: "review", source: "prompt", title: "Review it", prompt: "Review the footer", branchName: `ostra/${randomBytes(4).toString("hex")}-review`, state: "done" },
      select: { id: true },
    });
    const reviewTaskId = taskIdSchema.parse(review.id);
    await db.session.create({ data: { organizationId, projectId, taskId: reviewTaskId, origin: "new", state: "ended", outcome: "with_changes", endedAt: new Date() } });
    const shot = await seedAttachment(harness, { ...place(), taskId: reviewTaskId }, { caption: "The footer overlaps the button" });
    // The code task's own screenshot: not the review's, so a finding can't name it.
    const codeShot = await seedAttachment(harness, { ...place(), taskId: code.taskId });
    const pr = await db.taskRepo.create({
      data: { organizationId, projectId, taskId: code.taskId, repoId, branchName: "ostra/footer", baseBranch: "main", state: "pr_open", prNumber: 12, prUrl: "https://github.com/ostra-test/test1/pull/12", prTitle: "Footer" },
      select: { id: true },
    });
    const run = await db.reviewRun.create({ data: { organizationId, projectId, codeTaskId: code.taskId, reviewTaskId, round: 1, state: "posted", summary: "One problem.", blocking: 1, postedAt: new Date() }, select: { id: true } });
    await db.finding.create({
      data: { organizationId, projectId, reviewRunId: run.id, taskRepoId: pr.id, path: "src/footer.tsx", line: 3, side: "new", severity: "blocking", title: "It overlaps", body: "See the screenshot.", attachmentIds: [shot.attachmentId, codeShot.attachmentId] },
    });
    await db.finding.create({ data: { organizationId, projectId, reviewRunId: run.id, taskRepoId: pr.id, path: "src/footer.tsx", line: 9, side: "new", severity: "nit", title: "A typo", body: "No picture." } });

    const screen = await (await as(projectMember)).review.screen({ taskId: code.taskId });
    const findings = screen.prs[0]?.findings ?? [];
    expect(findings.map((finding) => [finding.title, finding.attachments.map((attachment) => [attachment.attachmentId, attachment.taskId, attachment.caption])])).toEqual([
      ["It overlaps", [[shot.attachmentId, reviewTaskId, "The footer overlaps the button"]]],
      ["A typo", []],
    ]);
    expect(findings[0]?.attachments[0]?.downloadPath).toBe(`/api/tasks/${reviewTaskId}/attachments/${shot.attachmentId}`);
    expect(await outcomeOf(() => as(outsider).then((caller) => caller.review.screen({ taskId: code.taskId })))).toBe("NOT_FOUND");
  });
});
