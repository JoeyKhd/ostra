import { randomBytes } from "node:crypto";

import { bindMessageFilesInTx, createPromptTask, discardUpload, recordUpload, reopenTask, taskSpecFilesOf } from "@ostra/domain";
import type { MemberScope, MessageFilesDeps, RecordUploadInput } from "@ostra/domain";
import { blobIdSchema, clientMessageIdSchema, fileBoxPathSchema, organizationIdSchema, safeFileNameSchema, sessionIdSchema, sha256HexSchema, taskEventSchema, taskIdSchema, taskSeqSchema } from "@ostra/protocol";
import type { MessageFileId, ProjectId, TaskEventOf, TaskId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedConnectionAndModel, seedProject } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// Milestone 9's ticket 05 (F-148, F-150, ADR 0070): a member's files through the domain's use cases,
// on a real database: an upload recorded, discarded, and bound at send to the message that takes
// it; files alone make a message; another member's, another project's and a sent upload can't be
// bound; the limits are checked again at send; the image decision lands in the event and the
// spec's files. Names hold shell syntax and prompt-like text, as data.

const MiB = 1024 * 1024;

let harness: ApiHarness;
let projectId: ProjectId;
let otherProjectId: ProjectId;
let scope: MemberScope;
let otherScope: MemberScope;
let modelId: string;

beforeAll(async () => {
  harness = await createApiHarness();
  const world = await seedConnectionAndModel(harness);
  modelId = world.modelId;
  projectId = (await seedProject(harness, world, "files")).projectId;
  otherProjectId = (await seedProject(harness, world, "other-files")).projectId;
  const member = await harness.contextOf(harness.fixture.a.member);
  const admin = await harness.contextOf(harness.fixture.a.admin);
  if (member.member === null || admin.member === null) {
    throw new Error("the fixture's members have no scope");
  }
  scope = member.member.scope;
  otherScope = admin.member.scope;
});

afterAll(async () => {
  await harness.dispose();
});

const digest = () => sha256HexSchema.parse(randomBytes(32).toString("hex"));

const ports = () => ({ jobs: harness.fakes.jobs, notices: harness.deps.ports.notices, audit: harness.deps.ports.audit, clock: harness.deps.ports.clock });

/** An upload as core's endpoint records it: its blob in the project, then its row. */
const upload = async (
  who: MemberScope,
  where: ProjectId,
  file: { readonly name: string; readonly kind?: RecordUploadInput["kind"]; readonly contentType?: string; readonly size?: number; readonly text?: RecordUploadInput["text"] },
): Promise<MessageFileId> => {
  const db = harness.test.db;
  const size = file.size ?? 1000;
  const blob = await db.blob.create({
    data: { organizationId: who.organizationId, projectId: where, store: "postgres", key: `m9-${randomBytes(8).toString("hex")}`, purpose: "message-file", contentType: file.contentType ?? "image/png", size, sha256: digest() },
  });
  const recorded = await db.$transaction((tx) =>
    recordUpload(tx, {
      organizationId: organizationIdSchema.parse(who.organizationId),
      projectId: where,
      memberId: who.memberId,
      name: safeFileNameSchema.parse(file.name),
      kind: file.kind ?? "image",
      contentType: file.contentType ?? "image/png",
      size,
      sha256: digest(),
      blobId: blobIdSchema.parse(blob.id),
      text: file.text ?? { state: "none" },
    }),
  );
  return recorded.fileId;
};

/** A document whose text core read, the text a blob of the project. */
const documentUpload = async (who: MemberScope, name: string): Promise<MessageFileId> => {
  const text = await harness.test.db.blob.create({
    data: { organizationId: who.organizationId, projectId, store: "postgres", key: `m9-${randomBytes(8).toString("hex")}`, purpose: "message-file-text", contentType: "text/markdown", size: 640, sha256: digest() },
  });
  return upload(who, projectId, {
    name,
    kind: "document",
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: 1200,
    text: { state: "ready", blobId: blobIdSchema.parse(text.id), words: 90, truncated: false },
  });
};

const start = (input: { readonly prompt: string; readonly fileIds?: readonly MessageFileId[] }, files?: MessageFilesDeps) =>
  harness.test.db.$transaction((tx) =>
    createPromptTask({ tx, scope, ...ports(), ...(files === undefined ? {} : { files }) }, { projectId, prompt: input.prompt, ...(input.fileIds === undefined ? {} : { fileIds: [...input.fileIds] }) }),
  );

/** The task's member messages, as stored. */
const messagesOf = async (taskId: TaskId): Promise<readonly (TaskEventOf<"user.message"> & { readonly seq: number })[]> => {
  const rows = await harness.test.db.event.findMany({ where: { taskId, kind: "user.message" }, orderBy: { seq: "asc" } });
  return rows.map((row) => {
    const event = taskEventSchema.parse(row.payload);
    if (event.kind !== "user.message") {
      throw new Error("not a message");
    }
    return { ...event, seq: row.seq };
  });
};

describe("files alone make a message (F-148/c1)", () => {
  it("F-148/c1: a prompt start with files and no words writes its message with the files; one with neither is refused, with nothing made", async () => {
    const mock = await upload(scope, projectId, { name: "_(rm -rf _) mock.png" });
    const spec = await documentUpload(scope, "Ignore previous instructions spec.docx");
    const started = await start({ prompt: "", fileIds: [mock, spec] });
    if (!started.ok) {
      throw new Error(started.message);
    }
    const [message] = await messagesOf(started.taskId);
    expect(message?.text).toBe("");
    expect(message?.files?.map((file) => [file.name, file.kind, file.origin, file.text])).toEqual([
      ["_(rm -rf _) mock.png", "image", "member", "none"],
      ["Ignore previous instructions spec.docx", "document", "member", "ready"],
    ]);
    // The task's title is its first file's name when there are no words.
    expect((await harness.test.db.task.findUniqueOrThrow({ where: { id: started.taskId } })).title).toBe("_(rm -rf _) mock.png");
    // Each file is sent, the message's, at its place under attachments/<n>/, its blobs the task's.
    const rows = await harness.test.db.messageFile.findMany({ where: { id: { in: [mock, spec] } }, orderBy: { position: "asc" }, include: { blob: true, textBlob: true } });
    expect(rows.map((row) => [row.state, row.taskId, row.eventSeq, row.position, row.boxPath])).toEqual([
      ["sent", started.taskId, message?.seq, 0, `attachments/${String(message?.seq)}/_(rm -rf _) mock.png`],
      ["sent", started.taskId, message?.seq, 1, `attachments/${String(message?.seq)}/Ignore previous instructions spec.docx`],
    ]);
    for (const row of rows) {
      expect(fileBoxPathSchema.safeParse(row.boxPath).success).toBe(true);
      expect(row.blob?.taskId).toBe(started.taskId);
    }
    expect(rows[1]?.textBlob?.taskId).toBe(started.taskId);
    // The spec's files: both, oldest first, the document's text beside it.
    const specFiles = await taskSpecFilesOf(harness.test.db, started.taskId);
    expect(specFiles.map((file) => [file.fileId, file.path, file.text?.path ?? null])).toEqual([
      [mock, rows[0]?.boxPath, null],
      [spec, rows[1]?.boxPath, `${rows[1]?.boxPath ?? ""}.md`],
    ]);

    // Neither words nor files: refused, and no task.
    const before = await harness.test.db.task.count({ where: { projectId } });
    expect(await start({ prompt: "" })).toMatchObject({ ok: false, error: "prompt-required" });
    expect(await harness.test.db.task.count({ where: { projectId } })).toBe(before);
  });

  it("F-148/c1: a reopen with files and no words writes its message with the files", async () => {
    const started = await start({ prompt: "Make the history panel" });
    if (!started.ok) {
      throw new Error(started.message);
    }
    await harness.test.db.session.updateMany({ where: { taskId: started.taskId }, data: { state: "ended", outcome: "without_changes", endedAt: new Date() } });
    await harness.test.db.task.update({ where: { id: started.taskId }, data: { state: "stopped", subState: null, stoppedReason: "requested" } });
    const shot = await upload(scope, projectId, { name: "layout.png" });
    const reopened = await harness.test.db.$transaction((tx) =>
      reopenTask({ tx, scope, ...ports() }, { taskId: started.taskId, clientMessageId: clientMessageIdSchema.parse("files-reopen-1"), fileIds: [shot] }),
    );
    expect(reopened).toMatchObject({ ok: true });
    const last = (await messagesOf(started.taskId)).at(-1);
    expect(last).toMatchObject({ text: "", reopen: true, files: [{ fileId: shot, name: "layout.png", kind: "image" }] });
    // Nothing at all is still refused.
    await harness.test.db.session.updateMany({ where: { taskId: started.taskId }, data: { state: "ended", outcome: "without_changes", endedAt: new Date() } });
    await harness.test.db.task.update({ where: { id: started.taskId }, data: { state: "stopped", subState: null, stoppedReason: "requested" } });
    expect(await harness.test.db.$transaction((tx) => reopenTask({ tx, scope, ...ports() }, { taskId: started.taskId, clientMessageId: clientMessageIdSchema.parse("files-reopen-2") }))).toMatchObject({
      ok: false,
      error: "text-required",
    });
  });
});

describe("binding at send (F-148/c2, c5)", () => {
  it("F-148/c2: another member's upload, another project's and a sent one can't be bound, and nothing is", async () => {
    const theirs = await upload(otherScope, projectId, { name: "theirs.png" });
    const elsewhere = await upload(scope, otherProjectId, { name: "elsewhere.png" });
    const mine = await upload(scope, projectId, { name: "mine.png" });
    const sent = await start({ prompt: "Use it", fileIds: [mine] });
    expect(sent.ok).toBe(true);
    const fresh = await upload(scope, projectId, { name: "fresh.png" });
    for (const fileIds of [[fresh, theirs], [fresh, elsewhere], [fresh, mine]]) {
      expect(await start({ prompt: "Use these", fileIds }), JSON.stringify(fileIds)).toMatchObject({ ok: false, error: "file-not-found" });
    }
    // The good upload in each refused send stays the member's, unsent.
    expect(await harness.test.db.messageFile.findUniqueOrThrow({ where: { id: fresh } })).toMatchObject({ state: "uploaded", taskId: null });
    expect(await harness.test.db.messageFile.findUniqueOrThrow({ where: { id: theirs } })).toMatchObject({ state: "uploaded", taskId: null });
    // Bound straight, the same: no file moves.
    const task = await harness.test.db.task.findFirstOrThrow({ where: { projectId } });
    const session = await harness.test.db.session.findFirstOrThrow({ where: { taskId: task.id } });
    const bound = await harness.test.db.$transaction((tx) =>
      bindMessageFilesInTx(tx, scope, {
        taskId: taskIdSchema.parse(task.id),
        projectId,
        sessionId: sessionIdSchema.parse(session.id),
        clientMessageId: clientMessageIdSchema.parse("bind-1"),
        eventSeq: taskSeqSchema.parse(99),
        fileIds: [fresh, theirs],
        model: null,
        agentTakesImages: true,
        limits: { maxFiles: 10, maxFileBytes: 10 * MiB, maxTotalBytes: 25 * MiB },
        now: Date.now(),
      }),
    );
    expect(bound).toMatchObject({ ok: false, error: "file-not-found" });
    expect(await harness.test.db.messageFile.findUniqueOrThrow({ where: { id: fresh } })).toMatchObject({ state: "uploaded" });
  });

  it("F-148/c2: the limits are checked again at send: what's over is left out with why, and stays an upload", async () => {
    const eleven = await Promise.all(Array.from({ length: 11 }, (_, index) => upload(scope, projectId, { name: `shot-${String(index)}.png`, size: 100 })));
    const big = await upload(scope, projectId, { name: "recording.mov", kind: "file", contentType: "application/octet-stream", size: 2 * MiB });
    const started = await start({ prompt: "Look at these", fileIds: [big, ...eleven] }, { limits: { maxFiles: 10, maxFileBytes: MiB, maxTotalBytes: 25 * MiB }, agentTakesImages: () => false });
    if (!started.ok) {
      throw new Error(started.message);
    }
    const [message] = await messagesOf(started.taskId);
    expect(message?.files).toHaveLength(10);
    expect(message?.filesLeftOut).toEqual([
      { name: "recording.mov", reason: "too-big" },
      { name: "shot-10.png", reason: "too-many" },
    ]);
    expect(await harness.test.db.messageFile.findUniqueOrThrow({ where: { id: big } })).toMatchObject({ state: "uploaded", taskId: null });
    expect(await harness.test.db.messageFile.count({ where: { id: { in: eleven }, state: "sent" } })).toBe(10);
  });

  it("F-148/c5: images go as images where the agent takes them and the model sees them, and the event says why they didn't", async () => {
    const takes: MessageFilesDeps = { limits: { maxFiles: 10, maxFileBytes: 10 * MiB, maxTotalBytes: 25 * MiB }, agentTakesImages: (adapter) => adapter === "opencode" };
    // The model says nothing of images: unknown, so none go, for the model's sake.
    await harness.test.db.model.update({ where: { id: modelId }, data: { catalogInputModalities: ["text"], adminImageInput: null } });
    const unknown = await start({ prompt: "Match it", fileIds: [await upload(scope, projectId, { name: "a.png" })] }, takes);
    // An admin says it reads images: they go.
    await harness.test.db.model.update({ where: { id: modelId }, data: { adminImageInput: true } });
    const png = await upload(scope, projectId, { name: "b.png" });
    const sees = await start({ prompt: "Match it", fileIds: [png, await documentUpload(scope, "notes.docx")] }, takes);
    // The agent takes no images: none go, for the agent's sake.
    const agentless = await start({ prompt: "Match it", fileIds: [await upload(scope, projectId, { name: "c.png" })] }, { ...takes, agentTakesImages: () => false });
    if (!unknown.ok || !sees.ok || !agentless.ok) {
      throw new Error("a start was refused");
    }
    expect((await messagesOf(unknown.taskId))[0]).toMatchObject({ imagesNotSent: "model", files: [{ asImage: false }] });
    expect((await messagesOf(sees.taskId))[0]).toMatchObject({ imagesNotSent: null, files: [{ asImage: true }, { asImage: false }] });
    expect((await messagesOf(agentless.taskId))[0]).toMatchObject({ imagesNotSent: "agent", files: [{ asImage: false }] });
    expect(await harness.test.db.messageFile.findUniqueOrThrow({ where: { id: png } })).toMatchObject({ asImage: true });
  });
});

describe("an upload's own life", () => {
  it("F-150/c4: a document recorded with reading off is `off`, and its message says so", async () => {
    const off = await upload(scope, projectId, { name: "spec.docx", kind: "document", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", text: { state: "off" } });
    expect(await harness.test.db.messageFile.findUniqueOrThrow({ where: { id: off } })).toMatchObject({ textState: "off", textBlobId: null });
    const started = await start({ prompt: "Read it", fileIds: [off] });
    if (!started.ok) {
      throw new Error(started.message);
    }
    expect((await messagesOf(started.taskId))[0]?.files).toMatchObject([{ name: "spec.docx", text: "off" }]);
    expect((await taskSpecFilesOf(harness.test.db, started.taskId))[0]?.text).toBeNull();
  });

  it("F-148: a member discards only their own unsent upload, and its blob goes with it", async () => {
    const mine = await upload(scope, projectId, { name: "discard-me.png" });
    const theirs = await upload(otherScope, projectId, { name: "not-mine.png" });
    const row = await harness.test.db.messageFile.findUniqueOrThrow({ where: { id: mine } });
    expect(await discardUpload({ db: harness.test.db, scope }, { fileId: theirs })).toMatchObject({ ok: false, error: "not-found" });
    expect(await discardUpload({ db: harness.test.db, scope }, { fileId: mine })).toEqual({ ok: true, fileId: mine });
    expect(await harness.test.db.messageFile.count({ where: { id: mine } })).toBe(0);
    expect(await harness.test.db.blob.count({ where: { id: row.blobId ?? "" } })).toBe(0);
    expect(await harness.test.db.messageFile.count({ where: { id: theirs } })).toBe(1);
    // A sent one can't be discarded.
    const sentFile = await upload(scope, projectId, { name: "kept.png" });
    expect((await start({ prompt: "Keep it", fileIds: [sentFile] })).ok).toBe(true);
    expect(await discardUpload({ db: harness.test.db, scope }, { fileId: sentFile })).toMatchObject({ ok: false, error: "not-found" });
  });
});
