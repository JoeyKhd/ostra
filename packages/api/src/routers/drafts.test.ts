import { randomBytes } from "node:crypto";

import { ensureBuiltInKindProfilesInTx, saveDraft } from "@ostra/domain";
import { taskIdSchema } from "@ostra/protocol";
import type { BoardId, ConnectionId, OrganizationId, ProjectId, RefineDraft, TaskId, TicketId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedBoard, seedConnectionAndModel, seedLinearConnection, seedTicket } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// Milestone 6's ticket 27 (F-099): the drafts API through the panel's own procedures, against
// Postgres. The agent's version is stored as core's `submit_draft` endpoint stores it (the domain's
// `saveDraft`); everything after it goes through `drafts.*`.

let harness: ApiHarness;
let organizationId: OrganizationId;
let projectId: ProjectId;
let connectionId: ConnectionId;
let boardId: BoardId;

const draft = (over: Partial<RefineDraft> = {}): RefineDraft => ({
  description: "Make the footer fast.",
  acceptanceCriteria: ["The footer renders in under 1 s", "No layout shift"],
  edgeCases: ["A footer with no links"],
  openQuestions: ["Do we keep the old footer behind a flag?"],
  subTickets: [{ title: "Measure the footer", description: "Profile it first." }],
  ...over,
});

const codeOf = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run;
  } catch (error) {
    if (error instanceof TRPCError) return error.code;
    throw error;
  }
  return "OK";
};

/** A refine task on a ticket of the board, waiting on its draft, with the agent's first version. */
const refineTask = async (
  over: { readonly projectId?: ProjectId; readonly source?: "ticket" | "prompt"; readonly withDraft?: boolean } = {},
): Promise<{ readonly taskId: TaskId; readonly ticketId: TicketId | null }> => {
  const project = over.projectId ?? projectId;
  const source = over.source ?? "ticket";
  const board = project === projectId ? boardId : await seedBoard(harness, { projectId: project, connectionId, externalId: `team-${randomBytes(3).toString("hex")}` });
  const ticketId = source === "ticket" ? await seedTicket(harness, { projectId: project, boardId: board, connectionId }) : null;
  const row = await harness.test.db.task.create({
    data: {
      organizationId,
      projectId: project,
      kind: "refine",
      source,
      title: "Refine the footer",
      prompt: source === "prompt" ? "Refine the footer" : null,
      branchName: `ostra/${randomBytes(4).toString("hex")}-refine`,
      state: "needs_you",
      needsYouReason: "draft_ready",
      driverMemberId: harness.fixture.a.admin.id,
      ...(ticketId === null ? {} : { ticketId, boardId: board, ticketKey: "ENG-1" }),
    },
    select: { id: true },
  });
  const taskId = taskIdSchema.parse(row.id);
  if (over.withDraft ?? true) {
    const saved = await harness.test.db.$transaction((tx) => saveDraft({ tx, ...harness.deps.ports }, { organizationId, taskId, draft: draft() }));
    expect(saved).toMatchObject({ ok: true, version: 1 });
  }
  return { taskId, ticketId };
};

const png = (size: number): string => Buffer.alloc(size, 7).toString("base64");

beforeAll(async () => {
  harness = await createApiHarness();
  organizationId = harness.fixture.a.organization.id;
  projectId = harness.fixture.a.openProject.id;
  connectionId = await seedLinearConnection(harness);
  boardId = await seedBoard(harness, { projectId, connectionId });
  // The board as seeded, with a ready status for "Mark ready".
  await harness.test.db.board.update({
    where: { id: boardId },
    data: { statusMap: { open: ["s-backlog", "s-todo"], started: "s-progress", inReview: "s-review", done: "s-done", doneBy: "ostra", magicWord: "Closes", ready: "s-ready" } },
  });
});

afterAll(async () => {
  await harness.dispose();
});

describe("drafts (F-099, ticket 27)", () => {
  it("F-099: a member's version is saved after the agent's, with its source, and a stale one is refused", async () => {
    const { taskId } = await refineTask();
    const member = await harness.as(harness.fixture.a.member);
    const first = await member.drafts.get({ taskId, version: null });
    expect(first.latestVersion).toBe(1);
    expect(first.versions).toMatchObject([{ version: 1, source: "agent", editedBy: null }]);
    expect(first.draft?.fields).toEqual(draft());

    const saved = await member.drafts.save({ taskId, baseVersion: 1, fields: draft({ description: "Make the footer fast, and small." }) });
    expect(saved.version).toBe(2);
    const after = await member.drafts.get({ taskId, version: null });
    expect(after.versions).toMatchObject([
      { version: 1, source: "agent", editedBy: null },
      { version: 2, source: "member", editedBy: { memberId: harness.fixture.a.member.id } },
    ]);
    expect(after.draft).toMatchObject({ version: 2, source: "member", fields: { description: "Make the footer fast, and small." } });
    // The agent's version is still there to read.
    expect((await member.drafts.get({ taskId, version: 1 })).draft?.fields.description).toBe("Make the footer fast.");
    // Saved on a version that's no longer the latest: refused, nothing written.
    expect(await codeOf(member.drafts.save({ taskId, baseVersion: 1, fields: draft() }))).toBe("CONFLICT");
    expect(await harness.test.db.refineDraft.count({ where: { taskId } })).toBe(2);
    // The edit is audited.
    expect(await harness.test.db.auditEntry.count({ where: { entityId: taskId, action: "draft.edited", actorId: harness.fixture.a.member.id } })).toBe(1);
  });

  it("F-099: the preview is the description as the tracker will hold it, with the criteria in the tracker's own field where it has one", async () => {
    const { taskId } = await refineTask();
    const member = await harness.as(harness.fixture.a.member);
    // The harness's tracker is the Jira fake: the criteria go to their own field.
    const view = await member.drafts.get({ taskId, version: null });
    expect(view.preview?.description).toContain("Make the footer fast.");
    expect(view.preview?.description).toContain("## Edge cases\n- A footer with no links");
    expect(view.preview?.description).toContain("## Open questions");
    expect(view.preview?.description).not.toContain("## Acceptance criteria");
    expect(view.preview?.acceptanceCriteria).toBe("- The footer renders in under 1 s\n- No layout shift");
    expect(view.preview?.subTickets).toEqual([{ title: "Measure the footer", description: "Profile it first." }]);
    expect(view.readyStatus).toBe(true);
  });

  it("F-099: images over the limit are refused, by size and by count; one taken off makes room, and a member's version keeps them", async () => {
    const { taskId } = await refineTask();
    const member = await harness.as(harness.fixture.a.member);
    expect(await codeOf(member.drafts.addImage({ taskId, name: "huge.png", contentType: "image/png", data: png(10 * 1024 * 1024 + 1) }))).toBe("PAYLOAD_TOO_LARGE");
    expect(harness.uploads.filter((upload) => upload.purpose === "draft-image")).toHaveLength(0);

    // A draft that holds two at most.
    const context = await harness.contextOf(harness.fixture.a.member);
    const settings = context.deps.settings;
    const two = harness.callerFor({ ...context, deps: { ...context.deps, settings: { ...settings, team: { ...settings.team, draftImagesMax: 2 } } } });
    const a = await two.drafts.addImage({ taskId, name: "a.png", contentType: "image/png", data: png(16) });
    await two.drafts.addImage({ taskId, name: "b.png", contentType: "image/png", data: png(16) });
    expect(await codeOf(two.drafts.addImage({ taskId, name: "c.png", contentType: "image/png", data: png(16) }))).toBe("BAD_REQUEST");
    await two.drafts.removeImage({ taskId, imageId: a.imageId });
    await two.drafts.addImage({ taskId, name: "c.png", contentType: "image/png", data: png(16) });
    const view = await member.drafts.get({ taskId, version: null });
    expect(view.draft?.images.map((image) => image.name)).toEqual(["b.png", "c.png"]);
    expect(view.imagesMax).toBe(10);

    await member.drafts.save({ taskId, baseVersion: 1, fields: draft({ description: "With pictures." }) });
    expect((await member.drafts.get({ taskId, version: null })).draft?.images.map((image) => image.name)).toEqual(["b.png", "c.png"]);
  });

  it("F-099: Update ticket and Mark ready each happen once: the task is done, and every action after is refused", async () => {
    const member = await harness.as(harness.fixture.a.member);

    const applied = await refineTask();
    await member.drafts.save({ taskId: applied.taskId, baseVersion: 1, fields: draft({ description: "Edited." }) });
    expect(await codeOf(member.drafts.updateTicket({ taskId: applied.taskId, version: 1 }))).toBe("CONFLICT");
    harness.fakes.jobs.clear();
    await member.drafts.updateTicket({ taskId: applied.taskId, version: 2 });
    expect(await harness.test.db.task.findUniqueOrThrow({ where: { id: applied.taskId } })).toMatchObject({ state: "done" });
    expect(harness.fakes.jobs.jobs.filter((job) => job.job === "draft.apply")).toMatchObject([{ payload: { version: 2 } }]);
    expect(await harness.test.db.auditEntry.count({ where: { entityId: applied.taskId, action: "draft.applied", actorId: harness.fixture.a.member.id } })).toBe(1);
    expect((await member.drafts.get({ taskId: applied.taskId, version: null })).done).toBe(true);
    // Each called in turn, so no refusal is left unawaited.
    for (const again of [
      () => member.drafts.updateTicket({ taskId: applied.taskId, version: 2 }),
      () => member.drafts.markReady({ taskId: applied.taskId }),
      () => member.drafts.save({ taskId: applied.taskId, baseVersion: 2, fields: draft() }),
      () => member.drafts.addImage({ taskId: applied.taskId, name: "late.png", contentType: "image/png", data: png(16) }),
    ]) {
      expect(await codeOf(again())).toBe("PRECONDITION_FAILED");
    }
    expect(harness.fakes.jobs.jobs.filter((job) => job.job === "draft.apply")).toHaveLength(1);
    expect(await harness.test.db.auditEntry.count({ where: { entityId: applied.taskId, action: "draft.applied" } })).toBe(1);

    const ready = await refineTask();
    await member.drafts.markReady({ taskId: ready.taskId });
    expect(await harness.test.db.task.findUniqueOrThrow({ where: { id: ready.taskId } })).toMatchObject({ state: "done" });
    expect(await codeOf(member.drafts.markReady({ taskId: ready.taskId }))).toBe("PRECONDITION_FAILED");
    expect(await codeOf(member.drafts.updateTicket({ taskId: ready.taskId, version: 1 }))).toBe("PRECONDITION_FAILED");
    expect(await harness.test.db.ticketWrite.findMany({ where: { taskId: ready.taskId, kind: "move" }, select: { payload: true } })).toEqual([{ payload: { kind: "move", target: "ready" } }]);
    expect(await harness.test.db.auditEntry.count({ where: { entityId: ready.taskId, action: "draft.marked-ready" } })).toBe(1);
  });

  it("F-099: Create ticket makes one ticket from a prompt refine task's latest version, and a ticket's draft updates its ticket instead", async () => {
    const member = await harness.as(harness.fixture.a.member);
    const prompt = await refineTask({ source: "prompt" });
    expect(await codeOf(member.drafts.updateTicket({ taskId: prompt.taskId, version: 1 }))).toBe("PRECONDITION_FAILED");
    await member.drafts.createTicket({ taskId: prompt.taskId, version: 1, boardId });
    const writes = await harness.test.db.ticketWrite.findMany({ where: { taskId: prompt.taskId, kind: "create" }, select: { payload: true } });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.payload).toMatchObject({ kind: "create", title: "Refine the footer" });
    expect(JSON.stringify(writes[0]?.payload)).toContain("## Acceptance criteria");
    expect(await harness.test.db.refineDraft.findFirstOrThrow({ where: { taskId: prompt.taskId } })).toMatchObject({ appliedByMemberId: harness.fixture.a.member.id });
    expect(await harness.test.db.task.findUniqueOrThrow({ where: { id: prompt.taskId } })).toMatchObject({ state: "done" });
    expect(await codeOf(member.drafts.createTicket({ taskId: prompt.taskId, version: 1, boardId }))).toBe("PRECONDITION_FAILED");
    expect(await harness.test.db.ticketWrite.count({ where: { taskId: prompt.taskId, kind: "create" } })).toBe(1);
    expect(await harness.test.db.auditEntry.count({ where: { entityId: prompt.taskId, action: "draft.ticket-created" } })).toBe(1);

    const ticket = await refineTask();
    expect(await codeOf(member.drafts.createTicket({ taskId: ticket.taskId, version: 1, boardId }))).toBe("PRECONDITION_FAILED");
  });

  it("F-099: who may read, edit and apply a draft is who may open the project; another organization and a restricted project's outsiders get NOT_FOUND", async () => {
    const restricted = await refineTask({ projectId: harness.fixture.a.restrictedProject.id });
    const outsider = await harness.as(harness.fixture.a.member);
    const other = await harness.as(harness.fixture.b.admin);
    for (const caller of [outsider, other]) {
      expect(await codeOf(caller.drafts.get({ taskId: restricted.taskId, version: null }))).toBe("NOT_FOUND");
      expect(await codeOf(caller.drafts.save({ taskId: restricted.taskId, baseVersion: 1, fields: draft() }))).toBe("NOT_FOUND");
      expect(await codeOf(caller.drafts.updateTicket({ taskId: restricted.taskId, version: 1 }))).toBe("NOT_FOUND");
      expect(await codeOf(caller.drafts.markReady({ taskId: restricted.taskId }))).toBe("NOT_FOUND");
    }
    expect(await harness.test.db.refineDraft.count({ where: { taskId: restricted.taskId } })).toBe(1);
    // A member on the project who isn't the draft's owner (the driver is the admin) edits and applies it.
    const insider = await harness.as(harness.fixture.a.insider);
    expect((await insider.drafts.get({ taskId: restricted.taskId, version: null })).latestVersion).toBe(1);
    await insider.drafts.save({ taskId: restricted.taskId, baseVersion: 1, fields: draft({ description: "The insider's." }) });
    await insider.drafts.updateTicket({ taskId: restricted.taskId, version: 2 });
    expect(await harness.test.db.task.findUniqueOrThrow({ where: { id: restricted.taskId } })).toMatchObject({ state: "done" });
    // A code task has no draft.
    const code = await harness.test.db.task.create({
      data: { organizationId, projectId, kind: "code", source: "prompt", title: "Code", prompt: "Code", branchName: `ostra/${randomBytes(4).toString("hex")}-code`, state: "running" },
      select: { id: true },
    });
    expect(await codeOf(insider.drafts.get({ taskId: taskIdSchema.parse(code.id), version: null }))).toBe("NOT_FOUND");
  });

  it("F-099: the built-in Refine profile is edited through the panel's profile API, read-only and on the organization's model, and can't be archived", async () => {
    const world = await seedConnectionAndModel(harness);
    const profiles = await harness.test.db.$transaction((tx) => ensureBuiltInKindProfilesInTx(tx, organizationId));
    const admin = await harness.as(harness.fixture.a.admin);
    const before = await admin.agentProfiles.get({ profileId: profiles.refine });
    expect(before).toMatchObject({ name: "Refine", model: { id: world.modelId } });
    await admin.agentProfiles.save({
      profileId: profiles.refine,
      name: "Refine",
      adapter: "opencode",
      modelId: world.modelId,
      instructions: "Ask about the edge cases first.",
      approvalRules: [],
      planFirst: false,
      access: { kind: "everyone" },
      mcpServers: [],
      skills: [],
    });
    expect(await admin.agentProfiles.get({ profileId: profiles.refine })).toMatchObject({ instructions: "Ask about the edge cases first." });
    expect(await codeOf(admin.agentProfiles.archive({ profileId: profiles.refine }))).not.toBe("OK");
    expect(await harness.test.db.agentProfile.findUniqueOrThrow({ where: { id: profiles.refine } })).toMatchObject({ archivedAt: null, builtInKind: "refine" });
  });
});
