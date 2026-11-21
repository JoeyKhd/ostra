import { randomUUID } from "node:crypto";

import { diffCommentIdSchema, noteIdSchema, projectIdSchema, proposalIdSchema } from "@ostra/protocol";
import type { MemoryKind, NoteId, ProjectId, ProposalId, TaskId } from "@ostra/protocol";
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

/** An open project of organization A with no notes yet, so a search's results are only the test's own. */
const freshProject = async (name: string): Promise<ProjectId> => {
  const row = await harness.test.db.project.create({
    data: { organizationId: harness.fixture.a.organization.id, name, slug: `${name}-${randomUUID().slice(0, 8)}`, access: "open" },
    select: { id: true },
  });
  return projectIdSchema.parse(row.id);
};

/** Organization A's admin saves a note in `projectId`, or in the organization's own memory for `null`. */
const saveNote = async (projectId: ProjectId | null, title: string, body: string, kind: MemoryKind = "convention"): Promise<NoteId> => {
  const admin = await harness.as(harness.fixture.a.admin);
  const saved = await admin.memory.save({ noteId: null, expectedVersion: null, ...(projectId === null ? { scope: "organization", projectId: null } : { scope: "project", projectId }), title, body, kind, always: false });
  return saved.noteId;
};

/** Notes that share a question's common words ("we", "do", "the", "a") and none of its meaningful ones. */
const COMMON_WORD_NOTES = [
  [
    "We do code review on every pull request",
    "Do not merge your own pull request. We ask for one approval, and the reviewer opens the app when the change is visual. Do it before the end of the day if you can.",
  ],
  ["How we cut a release", "We do releases on Tuesdays. First we run the changelog script, then we tag the commit and we push the tag. We do it before noon, and we do not do it on a Friday."],
] as const;

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

  it("F-109/c1,c3: the page's search ranks a question by its meaningful words, as memory_search does, and finds only the scope's notes", async () => {
    const { a, b } = harness.fixture;
    const member = await harness.as(a.member);
    const projectId = await freshProject("handbook");
    const apiTests = await saveNote(
      projectId,
      "Run the API tests with pnpm test:api",
      "The API tests need the dev database: start it with `pnpm dev:db`, then run `pnpm test:api` from the repo root.",
      "command",
    );
    const migration = await saveNote(
      projectId,
      "The migration fails on Windows without long paths",
      "Prisma's migrate step fails on Windows when the checkout's path is long. Turn long paths on (`git config core.longpaths true`), or clone closer to the drive's root.",
      "gotcha",
    );
    const lockfile = await saveNote(projectId, "CI installs from the lockfile", "CI runs `pnpm install --frozen-lockfile`. A package.json change without its pnpm-lock.yaml fails every later build.", "gotcha");
    for (const [title, body] of COMMON_WORD_NOTES) {
      await saveNote(projectId, title, body);
    }
    const search = async (query: string, status?: "active" | "archived"): Promise<readonly NoteId[]> =>
      (await member.memory.notes({ scope: "project", projectId, query, ...(status === undefined ? {} : { status }) })).notes.map((note) => note.noteId);

    // A question finds the note that answers it first, and its common words find nothing by themselves.
    expect((await search("how do we run the api tests"))[0]).toBe(apiTests);
    expect((await search("why does the migration fail on windows"))[0]).toBe(migration);
    expect((await search("can I clone it with long paths on Windows"))[0]).toBe(migration);
    expect(await search("how do we do it")).toEqual([]);
    // A flag and an identifier match as written, ahead of the notes that only share their words.
    expect((await search("pnpm install --frozen-lockfile fails"))[0]).toBe(lockfile);
    expect((await search("test:api"))[0]).toBe(apiTests);

    // Only the scope's notes, of the status asked for: the organization's own memory, a restricted
    // project's and another organization's notes hold the same words, and none of them is found here.
    const orgMigration = await saveNote(null, "Migrations on Windows need long paths too", "Every checkout on Windows needs core.longpaths, whichever repo it is.", "gotcha");
    const restricted = await (await harness.as(a.insider)).memory.save({
      noteId: null,
      expectedVersion: null,
      scope: "project",
      projectId: a.restrictedProject.id,
      title: "The migration fails on Windows",
      body: "Turn long paths on before the migration.",
      kind: "gotcha",
      always: false,
    });
    const elsewhere = await (await harness.as(b.admin)).memory.save({
      noteId: null,
      expectedVersion: null,
      scope: "organization",
      projectId: null,
      title: "The migration fails on Windows",
      body: "Turn long paths on before the migration.",
      kind: "gotcha",
      always: false,
    });
    const projectFound = await search("why does the migration fail on windows");
    // The lockfile's note says a build "fails": a meaningful word, so it's found too, below.
    expect(projectFound).toEqual([migration, lockfile]);
    const orgFound = (await member.memory.notes({ scope: "organization", query: "why does the migration fail on windows" })).notes.map((note) => note.noteId);
    expect(orgFound).toEqual([orgMigration]);
    expect([...projectFound, ...orgFound]).not.toContain(restricted.noteId);
    expect([...projectFound, ...orgFound]).not.toContain(elsewhere.noteId);
    await (await harness.as(a.admin)).memory.archive({ noteId: lockfile });
    expect(await search("pnpm install --frozen-lockfile fails")).not.toContain(lockfile);
    expect(await search("pnpm install --frozen-lockfile fails", "archived")).toEqual([lockfile]);
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

  it("F-111/c3: a proposal's related notes rank as memory_search does, and stay in the proposal's scope", async () => {
    const { a, b } = harness.fixture;
    const admin = await harness.as(a.admin);
    const projectId = await freshProject("keys");
    const apiKeys = await saveNote(projectId, "Where the API keys live", "The model provider's API key is in the secret store, never in a .env file. Ask an admin to rotate it.");
    const apiTests = await saveNote(
      projectId,
      "Run the API tests with pnpm test:api",
      "The API tests need the dev database: start it with `pnpm dev:db`, then run `pnpm test:api` from the repo root.",
      "command",
    );
    // Notes of the proposal's scope that share only its common words.
    for (const [title, body] of COMMON_WORD_NOTES) {
      await saveNote(projectId, title, body);
    }
    // Notes out of its scope that hold its very words: a restricted project's and another organization's.
    const restricted = await (await harness.as(a.insider)).memory.save({
      noteId: null,
      expectedVersion: null,
      scope: "project",
      projectId: a.restrictedProject.id,
      title: "Where the API keys live",
      body: "The API keys live in the secret store, not in a .env file.",
      kind: "convention",
      always: false,
    });
    const elsewhere = await (await harness.as(b.admin)).memory.save({
      noteId: null,
      expectedVersion: null,
      scope: "organization",
      projectId: null,
      title: "Where the API keys live",
      body: "The API keys live in the secret store, not in a .env file.",
      kind: "convention",
      always: false,
    });
    const proposed = await proposal({ projectId, title: "Where do the API keys live?", body: "In the secret store, not in a .env file." });
    const opened = await admin.memory.proposal({ proposalId: proposed });
    // The note that answers it first, then the one that shares a word; none for common words alone.
    expect(opened.related.map((note) => [note.noteId, note.relation])).toEqual([
      [apiKeys, null],
      [apiTests, null],
    ]);
    expect(opened.related.map((note) => note.noteId)).not.toContain(restricted.noteId);
    expect(opened.related.map((note) => note.noteId)).not.toContain(elsewhere.noteId);
    // A declared note comes first, and isn't ranked again.
    const declaring = await proposal({ projectId, title: "Where do the API keys live?", body: "In the secret store, not in a .env file.", relatesTo: apiKeys });
    expect((await admin.memory.proposal({ proposalId: declaring })).related.map((note) => [note.noteId, note.relation])).toEqual([
      [apiKeys, "refines"],
      [apiTests, null],
    ]);
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

describe("the note's and the proposal's panels (memory-note.md, memory-proposals.md)", () => {
  it("F-109: a note's Used counts the tasks that read it or found it by search, and a version from a proposal names its agent and task, when the viewer can open it", async () => {
    const { a } = harness.fixture;
    const admin = await harness.as(a.admin);
    const note = await admin.memory.save({ noteId: null, expectedVersion: null, scope: "organization", projectId: null, title: "Release notes", body: "Write them in the PR.", kind: "convention", always: false });
    const first = await seedTask(harness, { organizationId: a.organization.id, projectId: a.openProject.id });
    const second = await seedTask(harness, { organizationId: a.organization.id, projectId: a.openProject.id });
    const third = await seedTask(harness, { organizationId: a.organization.id, projectId: a.openProject.id });
    // Two tasks read it or found it (one of them twice); the third only had it in its index, which isn't a use.
    for (const [task, via] of [[first, "read"], [first, "search"], [second, "read"], [third, "index"]] as const) {
      await harness.test.db.memoryUse.create({ data: { organizationId: a.organization.id, projectId: a.openProject.id, taskId: task.taskId, sessionId: task.sessionId, noteId: note.noteId, via } });
    }
    expect((await admin.memory.note({ noteId: note.noteId })).usedInTasks).toBe(2);

    // A version merged from an agent's proposal of an open project's task names the agent and the task's key.
    const fromOpen = await proposal({ projectId: null, title: "Release notes", body: "Write them in the PR, under Changes.", taskId: first.taskId });
    await admin.memory.decide({ proposalId: fromOpen, decision: "merge", intoNoteId: note.noteId, expectedVersion: 1, title: "Release notes", body: "Write them in the PR, under Changes." });
    // One from a restricted project's task: its task isn't named to a member who can't open it.
    const hiddenTask = await seedTask(harness, { organizationId: a.organization.id, projectId: a.restrictedProject.id });
    const fromHidden = await proposal({ projectId: null, title: "Release notes", body: "Write them in the PR, under Changes, newest first.", taskId: hiddenTask.taskId });
    await admin.memory.decide({ proposalId: fromHidden, decision: "merge", intoNoteId: note.noteId, expectedVersion: 2, title: "Release notes", body: "Write them in the PR, under Changes, newest first." });

    const keyOf = (taskId: string): string => taskId.replaceAll("-", "").slice(-8);
    const seen = await (await harness.as(a.member)).memory.note({ noteId: note.noteId });
    expect(seen.versions.map((version) => [version.version, version.source])).toEqual([
      [3, { kind: "agent", agent: "OpenCode", by: null, task: null }],
      [2, { kind: "agent", agent: "OpenCode", by: null, task: { taskId: first.taskId, key: keyOf(first.taskId) } }],
      [1, null],
    ]);
    const insiders = await (await harness.as(a.insider)).memory.note({ noteId: note.noteId });
    expect(insiders.versions[0]?.source?.task).toEqual({ taskId: hiddenTask.taskId, key: keyOf(hiddenTask.taskId) });
  });

  it("F-111: a proposal's panel names its task's driver, its session's number, and the agent's proposals of the task's cap", async () => {
    const { a } = harness.fixture;
    const task = await seedTask(harness, { organizationId: a.organization.id, projectId: a.openProject.id, driverMemberId: a.member.id });
    const made = async (sourceKind: "agent" | "closing_turn" | "diff_comment", title: string): Promise<ProposalId> =>
      proposalIdSchema.parse(
        (
          await harness.test.db.memoryProposal.create({
            data: { organizationId: a.organization.id, projectId: a.openProject.id, scope: "project", title, body: title, kind: "gotcha", sourceKind, taskId: task.taskId, sessionId: task.sessionId, proposedByMemberId: sourceKind === "diff_comment" ? a.member.id : null },
            select: { id: true },
          })
        ).id,
      );
    const proposed = await made("agent", "The mock needs Node 24");
    await made("closing_turn", "Run the mock first");
    // A member's comment isn't the agent's, so it doesn't count against the task's cap.
    await made("diff_comment", "Name ports in the README");
    const opened = await (await harness.as(a.member)).memory.proposal({ proposalId: proposed });
    expect(opened.taskFacts).toEqual({ driver: { memberId: a.member.id, name: "member-a" }, session: 1, proposals: { made: 2, cap: 20 } });
    // A proposal with no task has none of these.
    const alone = await proposal({ projectId: a.openProject.id, title: "Alone", body: "No task." });
    expect((await (await harness.as(a.member)).memory.proposal({ proposalId: alone })).taskFacts).toBeNull();
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
