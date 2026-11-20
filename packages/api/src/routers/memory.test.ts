import { diffCommentIdSchema, noteIdSchema, proposalIdSchema } from "@ostra/protocol";
import type { NoteId, ProposalId, TaskId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appendEvent, createApiHarness, seedConnectionAndModel, seedProject, seedTask } from "../testing/index.ts";
import type { ApiHarness, SeededTask } from "../testing/index.ts";

// F-109, F-110, F-111 (ticket 29; ADR 0044 amended): memory through the panel's API. Notes per
// scope with their access (a restricted project's notes are NOT_FOUND to a member who can't open
// it), a full-text search, a secret refusal that names the kind and never the value, a stale save's
// and a stale merge's CONFLICT, each decision of a proposal, "Remember this", and `tasks.memory`
// listing what the session's `MemoryUse` rows say.

let harness: ApiHarness;
/** A GitHub token's shape, which the scan refuses. Never a real one. */
const FAKE_TOKEN = `ghp_${"a1B2c3D4e5".repeat(4)}`;

const proposal = async (input: {
  readonly projectId: string | null;
  readonly title: string;
  readonly body: string;
  readonly taskId?: TaskId | null;
  readonly relatesTo?: NoteId | null;
}): Promise<ProposalId> => {
  const { a } = harness.fixture;
  const row = await harness.test.db.memoryProposal.create({
    data: {
      organizationId: a.organization.id,
      projectId: input.projectId,
      scope: input.projectId === null ? "organization" : "project",
      title: input.title,
      body: input.body,
      kind: "gotcha",
      sourceKind: "agent",
      taskId: input.taskId ?? null,
      relatesToNoteId: input.relatesTo ?? null,
      relation: input.relatesTo === undefined || input.relatesTo === null ? null : "refines",
    },
    select: { id: true },
  });
  return proposalIdSchema.parse(row.id);
};

beforeAll(async () => {
  harness = await createApiHarness();
});

afterAll(async () => {
  await harness.dispose();
});

describe("notes", () => {
  it("F-109/c1,c2,c6: each procedure's access per scope: a restricted project's notes are NOT_FOUND to a member who can't open it", async () => {
    const { a, b } = harness.fixture;
    const insider = await harness.as(a.insider);
    const member = await harness.as(a.member);
    const saved = await insider.memory.save({
      noteId: null,
      expectedVersion: null,
      scope: "project",
      projectId: a.restrictedProject.id,
      title: "Restricted runbook",
      body: "Deploys go through the vault pipeline.",
      kind: "command",
      always: false,
    });
    const listed = await insider.memory.notes({ scope: "project", projectId: a.restrictedProject.id });
    expect(listed.notes.map((note) => note.noteId)).toContain(saved.noteId);
    await expect(member.memory.notes({ scope: "project", projectId: a.restrictedProject.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(member.memory.note({ noteId: saved.noteId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      member.memory.save({ noteId: null, expectedVersion: null, scope: "project", projectId: a.restrictedProject.id, title: "Mine", body: "Mine", kind: "term", always: false }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      member.memory.save({ noteId: saved.noteId, expectedVersion: 1, scope: "project", projectId: a.restrictedProject.id, title: "Edit", body: "Edit", kind: "term", always: false }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(member.memory.archive({ noteId: saved.noteId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(member.memory.proposals({ scope: "project", projectId: a.restrictedProject.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Another organization sees none of it.
    const other = await harness.as(b.admin);
    await expect(other.memory.note({ noteId: saved.noteId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(other.memory.notes({ scope: "project", projectId: a.restrictedProject.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(JSON.stringify(await other.memory.notes({ scope: "organization" }))).not.toContain(saved.noteId);

    // An organization note: any member writes and reads it; only its author or an admin archives it.
    const orgNote = await member.memory.save({
      noteId: null,
      expectedVersion: null,
      scope: "organization",
      projectId: null,
      title: "Commit style",
      body: "Use gitmoji and the imperative.",
      kind: "convention",
      always: true,
    });
    const asInsider = (await insider.memory.notes({ scope: "organization" })).notes.find((note) => note.noteId === orgNote.noteId);
    expect(asInsider).toMatchObject({ always: true, canArchive: false, author: { memberId: a.member.id }, version: 1, useCount: 0, lastUsedAt: null });
    await expect(insider.memory.archive({ noteId: orgNote.noteId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await (await harness.as(a.admin)).memory.archive({ noteId: orgNote.noteId });
    expect((await member.memory.notes({ scope: "organization" })).notes.map((note) => note.noteId)).not.toContain(orgNote.noteId);
    expect((await member.memory.notes({ scope: "organization", status: "archived" })).notes.map((note) => note.noteId)).toContain(orgNote.noteId);
    const audit = await harness.test.db.auditEntry.findMany({ where: { organizationId: a.organization.id, entityId: orgNote.noteId }, select: { action: true } });
    expect(audit.map((entry) => entry.action).sort()).toEqual(["memory.note-archived", "memory.note-created"]);
  });

  it("F-109/c1,c3: a search finds a scope's notes by their words, ranked, and nothing of another scope", async () => {
    const { a } = harness.fixture;
    const admin = await harness.as(a.admin);
    const save = (title: string, body: string, kind: "gotcha" | "command" = "gotcha") =>
      admin.memory.save({ noteId: null, expectedVersion: null, scope: "project", projectId: a.openProject.id, title, body, kind, always: false });
    const flaky = await save("Flaky payments test", "The payments integration test needs the stripe mock running first.");
    const other = await save("Lint before push", "Run pnpm lint before every push.", "command");
    await admin.memory.save({ noteId: null, expectedVersion: null, scope: "organization", projectId: null, title: "Payments owner", body: "Payments questions go to the billing team.", kind: "term", always: false });
    const found = await admin.memory.notes({ scope: "project", projectId: a.openProject.id, query: "payments stripe" });
    expect(found.notes.map((note) => note.noteId)).toEqual([flaky.noteId]);
    expect((await admin.memory.notes({ scope: "project", projectId: a.openProject.id, query: "lint" })).notes.map((note) => note.noteId)).toEqual([other.noteId]);
    expect((await admin.memory.notes({ scope: "project", projectId: a.openProject.id, kinds: ["command"] })).notes.map((note) => note.noteId)).toEqual([other.noteId]);
    expect((await admin.memory.notes({ scope: "project", projectId: a.openProject.id, query: "nothing-matches-this" })).notes).toEqual([]);
    // A query is data, never SQL.
    expect((await admin.memory.notes({ scope: "project", projectId: a.openProject.id, query: "'); DROP TABLE memory_note; --" })).notes).toEqual([]);
    expect(await harness.test.db.memoryNote.count()).toBeGreaterThan(0);
  });

  it("F-109/c4: a secret is refused as BAD_REQUEST naming its kind, never its value, and nothing is stored", async () => {
    const { a } = harness.fixture;
    const before = await harness.test.db.memoryNote.count();
    const error: unknown = await (await harness.as(a.member)).memory
      .save({ noteId: null, expectedVersion: null, scope: "project", projectId: a.openProject.id, title: "Token", body: `Use ${FAKE_TOKEN} for the API.`, kind: "command", always: false })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "BAD_REQUEST" });
    const text = error instanceof Error ? `${error.message} ${JSON.stringify(error)}` : "";
    expect(text).toContain("a GitHub token");
    expect(text).not.toContain(FAKE_TOKEN);
    expect(await harness.test.db.memoryNote.count()).toBe(before);
  });

  it("F-109/c3,c5: a stale save is a CONFLICT naming who saved which version, and the note keeps its versions", async () => {
    const { a } = harness.fixture;
    const admin = await harness.as(a.admin);
    const member = await harness.as(a.member);
    const base = { scope: "project" as const, projectId: a.openProject.id, kind: "decision" as const, always: false };
    const saved = await admin.memory.save({ ...base, noteId: null, expectedVersion: null, title: "Database", body: "Postgres only." });
    const second = await member.memory.save({ ...base, noteId: saved.noteId, expectedVersion: 1, title: "Database", body: "Postgres only, version 16." });
    expect(second.version).toBe(2);
    const stale = admin.memory.save({ ...base, noteId: saved.noteId, expectedVersion: 1, title: "Database", body: "Stale." });
    await expect(stale).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(stale).rejects.toThrow(/^Version 2 was saved by .+ since you opened this note\.$/);
    const note = await admin.memory.note({ noteId: saved.noteId });
    expect(note.versions.map((version) => [version.version, version.editedBy?.memberId])).toEqual([
      [2, a.member.id],
      [1, a.admin.id],
    ]);
    expect(note.body).toBe("Postgres only, version 16.");
  });
});

describe("proposals", () => {
  it("F-111/c2,c3,c4,c5: each decision: approve, approve and archive, merge (stale is CONFLICT), reject, and no second decision", async () => {
    const { a } = harness.fixture;
    const admin = await harness.as(a.admin);
    const member = await harness.as(a.member);
    const task = await seedTask(harness, { organizationId: a.organization.id, projectId: a.openProject.id, title: "Fix the flaky test" });
    const target = await admin.memory.save({ noteId: null, expectedVersion: null, scope: "project", projectId: a.openProject.id, title: "Test setup", body: "Start the mock server first.", kind: "gotcha", always: false });

    const toApprove = await proposal({ projectId: a.openProject.id, title: "Ports", body: "The mock listens on 4010.", taskId: task.taskId, relatesTo: target.noteId });
    const listed = await member.memory.proposals({ scope: "project", projectId: a.openProject.id });
    expect(listed.find((row) => row.proposalId === toApprove)).toMatchObject({
      state: "proposed",
      task: { taskId: task.taskId, title: "Fix the flaky test" },
      relatesTo: { noteId: target.noteId, relation: "refines" },
    });
    const opened = await member.memory.proposal({ proposalId: toApprove });
    expect(opened.related[0]).toMatchObject({ noteId: target.noteId, relation: "refines" });
    expect((await member.memory.notes({ scope: "project", projectId: a.openProject.id })).openProposals).toBeGreaterThanOrEqual(1);

    const approved = await member.memory.decide({ proposalId: toApprove, decision: "approve" });
    expect(approved.noteId).not.toBeNull();
    const approvedNote = await member.memory.note({ noteId: noteIdSchema.parse(approved.noteId) });
    expect(approvedNote).toMatchObject({ title: "Ports", source: { kind: "proposal", taskId: task.taskId }, version: 1 });
    await expect(member.memory.decide({ proposalId: toApprove, decision: "reject" })).rejects.toMatchObject({ code: "CONFLICT" });

    const replacing = await proposal({ projectId: a.openProject.id, title: "Ports, again", body: "The mock listens on 4011 now." });
    const replaced = await admin.memory.decide({ proposalId: replacing, decision: "approve_and_archive", archiveNoteId: noteIdSchema.parse(approved.noteId) });
    expect((await admin.memory.note({ noteId: noteIdSchema.parse(approved.noteId) })).status).toBe("archived");
    expect((await admin.memory.note({ noteId: noteIdSchema.parse(replaced.noteId) })).status).toBe("active");

    const toMerge = await proposal({ projectId: a.openProject.id, title: "Mock", body: "Use the mock's --quiet flag." });
    await expect(
      member.memory.decide({ proposalId: toMerge, decision: "merge", intoNoteId: target.noteId, expectedVersion: 2, title: "Test setup", body: "Merged." }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const merged = await member.memory.decide({ proposalId: toMerge, decision: "merge", intoNoteId: target.noteId, expectedVersion: 1, title: "Test setup", body: "Start the mock server first, with --quiet." });
    expect(merged.noteId).toBe(target.noteId);
    const mergedNote = await member.memory.note({ noteId: target.noteId });
    expect(mergedNote).toMatchObject({ version: 2, body: "Start the mock server first, with --quiet." });
    expect(mergedNote.versions[0]).toMatchObject({ version: 2, proposalId: toMerge, editedBy: { memberId: a.member.id } });

    const toReject = await proposal({ projectId: a.openProject.id, title: "Noise", body: "Not worth keeping." });
    expect(await member.memory.decide({ proposalId: toReject, decision: "reject" })).toEqual({ noteId: null });
    const states = await member.memory.proposals({ scope: "project", projectId: a.openProject.id });
    expect(Object.fromEntries(states.filter((row) => [toApprove, replacing, toMerge, toReject].includes(row.proposalId)).map((row) => [row.title, row.state]))).toEqual({
      Ports: "approved",
      "Ports, again": "approved",
      Mock: "merged",
      Noise: "rejected",
    });

    // A restricted project's proposal is NOT_FOUND to a member who can't open it.
    const hidden = await proposal({ projectId: a.restrictedProject.id, title: "Hidden", body: "Hidden." });
    await expect(member.memory.proposal({ proposalId: hidden })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(member.memory.decide({ proposalId: hidden, decision: "approve" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await harness.test.db.memoryProposal.findUniqueOrThrow({ where: { id: hidden }, select: { state: true } })).toEqual({ state: "proposed" });
  });

  it("F-111/c1: Remember this on a diff comment and on an accepted @ostra comment proposes a project note with the comment as its source", async () => {
    const { a } = harness.fixture;
    const member = await harness.as(a.member);
    const world = await seedConnectionAndModel(harness);
    const { projectId, repoId } = await seedProject(harness, world, "remember");
    const task: SeededTask = await seedTask(harness, { organizationId: a.organization.id, projectId, driverMemberId: a.member.id });
    const taskRepo = await harness.test.db.taskRepo.create({
      data: { organizationId: a.organization.id, projectId, taskId: task.taskId, repoId, branchName: "ostra/remember", baseBranch: "main" },
      select: { id: true },
    });
    const comment = await harness.test.db.diffComment.create({
      data: {
        organizationId: a.organization.id,
        projectId,
        taskId: task.taskId,
        taskRepoId: taskRepo.id,
        side: "new",
        memberId: a.member.id,
        path: "src/app.ts",
        line: 3,
        headSha: "a".repeat(40),
        body: "Always validate input with zod at the boundary.\nIt keeps types honest.",
      },
      select: { id: true },
    });
    const fromDiff = await member.memory.rememberThis({ source: { diffCommentId: diffCommentIdSchema.parse(comment.id) } });
    const diffRow = await harness.test.db.memoryProposal.findUniqueOrThrow({ where: { id: fromDiff.proposalId } });
    expect(diffRow).toMatchObject({ title: "Always validate input with zod at the boundary.", sourceKind: "diff_comment", sourceRef: comment.id, proposedByMemberId: a.member.id, scope: "project", projectId });

    const seq = await appendEvent(harness, task, { organizationId: a.organization.id, projectId }, {
      kind: "pr.comment_received",
      url: "https://github.com/ostra-test/test1/pull/7#issuecomment-1",
      login: "sam",
      path: null,
      line: null,
    });
    const fromPr = await member.memory.rememberThis({ source: { taskId: task.taskId, prCommentEventSeq: seq }, title: "Changelog", body: "Every PR adds a changelog line.", kind: "convention" });
    expect(await harness.test.db.memoryProposal.findUniqueOrThrow({ where: { id: fromPr.proposalId } })).toMatchObject({ sourceKind: "pr_comment", sourceRef: "https://github.com/ostra-test/test1/pull/7#issuecomment-1" });
    // A PR comment has no text of its own here: the member gives it.
    await expect(member.memory.rememberThis({ source: { taskId: task.taskId, prCommentEventSeq: seq } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // A secret in the edited text is refused, by kind.
    const secret = member.memory.rememberThis({ source: { taskId: task.taskId, prCommentEventSeq: seq }, title: "Key", body: `Token ${FAKE_TOKEN}` });
    await expect(secret).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(secret).rejects.toThrow(/a GitHub token/);
    // Someone who can't open the task's project gets NOT_FOUND.
    const hiddenTask = await seedTask(harness, { organizationId: a.organization.id, projectId: a.restrictedProject.id });
    const hiddenSeq = await appendEvent(harness, hiddenTask, { organizationId: a.organization.id, projectId: a.restrictedProject.id }, {
      kind: "pr.comment_received",
      url: "https://github.com/ostra-test/test1/pull/8#issuecomment-2",
      login: "sam",
      path: null,
      line: null,
    });
    await expect(member.memory.rememberThis({ source: { taskId: hiddenTask.taskId, prCommentEventSeq: hiddenSeq }, title: "x", body: "y" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("tasks.memory", () => {
  it("F-110/c4: tasks.memory lists what the session's MemoryUse rows say, and the proposals the task made", async () => {
    const { a } = harness.fixture;
    const admin = await harness.as(a.admin);
    const task = await seedTask(harness, { organizationId: a.organization.id, projectId: a.openProject.id });
    const note = await admin.memory.save({ noteId: null, expectedVersion: null, scope: "organization", projectId: null, title: "Use pnpm", body: "Never npm.", kind: "command", always: true });
    const other = await admin.memory.save({ noteId: null, expectedVersion: null, scope: "project", projectId: a.openProject.id, title: "Port 3000", body: "The web app listens on 3000.", kind: "gotcha", always: false });
    const at = new Date("2026-11-19T10:00:00Z");
    for (const [noteId, via, offset] of [
      [note.noteId, "index", 0],
      [other.noteId, "search", 1],
      [other.noteId, "read", 2],
    ] as const) {
      await harness.test.db.memoryUse.create({
        data: { organizationId: a.organization.id, projectId: a.openProject.id, taskId: task.taskId, sessionId: task.sessionId, noteId, via, at: new Date(at.getTime() + offset * 1000) },
      });
    }
    const proposed = await proposal({ projectId: a.openProject.id, title: "Learned", body: "The build needs Node 24.", taskId: task.taskId });
    const memory = await (await harness.as(a.member)).tasks.memory({ taskId: task.taskId });
    const { startedAt } = await harness.test.db.session.findUniqueOrThrow({ where: { id: task.sessionId }, select: { startedAt: true } });
    expect(memory.sessions).toEqual([
      {
        sessionId: task.sessionId,
        startedAt: startedAt.getTime(),
        uses: [
          { noteId: note.noteId, title: "Use pnpm", scope: "organization", via: "index", at: at.getTime() },
          { noteId: other.noteId, title: "Port 3000", scope: "project", via: "search", at: at.getTime() + 1000 },
          { noteId: other.noteId, title: "Port 3000", scope: "project", via: "read", at: at.getTime() + 2000 },
        ],
      },
    ]);
    expect(memory.proposals.map((row) => [row.proposalId, row.state])).toEqual([[proposed, "proposed"]]);
    // A restricted project's task: NOT_FOUND to a member who can't open it.
    const hidden = await seedTask(harness, { organizationId: a.organization.id, projectId: a.restrictedProject.id });
    await expect((await harness.as(a.member)).tasks.memory({ taskId: hidden.taskId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("the profile's closing turn", () => {
  it("F-111/c6: an agent profile's closing turn is switched on and off by its save, kept when a save leaves it out", async () => {
    const caller = await harness.as(harness.fixture.a.admin);
    const base = { adapter: "opencode", modelId: null, instructions: null, approvalRules: [], planFirst: false, access: { kind: "everyone" as const }, mcpServers: [], skills: [] };
    const created = await caller.agentProfiles.save({ ...base, name: "Learns", closingTurn: true });
    expect((await caller.agentProfiles.get({ profileId: created.profileId })).closingTurn).toBe(true);
    await caller.agentProfiles.save({ ...base, profileId: created.profileId, name: "Learns, renamed" });
    expect((await caller.agentProfiles.get({ profileId: created.profileId })).closingTurn).toBe(true);
    await caller.agentProfiles.save({ ...base, profileId: created.profileId, name: "Learns, renamed", closingTurn: false });
    expect((await caller.agentProfiles.get({ profileId: created.profileId })).closingTurn).toBe(false);
    expect(await harness.test.db.agentProfile.findUniqueOrThrow({ where: { id: created.profileId }, select: { closingTurn: true } })).toEqual({ closingTurn: false });
    const plain = await caller.agentProfiles.save({ ...base, name: "Plain" });
    expect((await caller.agentProfiles.get({ profileId: plain.profileId })).closingTurn).toBe(false);
    const edits = await harness.test.db.auditEntry.findMany({ where: { entityId: created.profileId, action: "agent-profile.updated" }, orderBy: { createdAt: "asc" }, select: { data: true } });
    const texts = edits.map((entry) => JSON.stringify(entry.data));
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('"closingTurn":true');
    expect(texts[0]).not.toContain("closingTurn,");
    expect(texts[1]).toContain('"closingTurn":false');
    expect(texts[1]).toMatch(/"changed":"[^"]*closingTurn/);
  });
});
