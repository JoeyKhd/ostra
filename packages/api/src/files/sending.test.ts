import { readFile } from "node:fs/promises";
import path from "node:path";

import { Prisma } from "@ostra/db";
import { repoRoot } from "@ostra/db/dev";
import type { SeededMember } from "@ostra/db/testing";
import { RUNNER_NEEDS_UPGRADE_FOR_FILES } from "@ostra/domain";
import type { RecordedUpload } from "@ostra/domain";
import { clientMessageIdSchema, runnerIdSchema, steerBodySchema, taskEventSchema } from "@ostra/protocol";
import type { ClientMessageId, ModelId, ProjectId, RunnerId, TaskEventOf, TaskId } from "@ostra/protocol";
import { foldTaskEvents } from "@ostra/task-view";
import type { MessageFilesData } from "@ostra/task-view";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApiHarness, fakeCoreUploads, seedConnectionAndModel, seedLease, seedPersonalRunner, seedProject, seedTask, uploadThroughRoute } from "../testing/index.ts";
import type { ApiHarness, AppCaller, SeededTask } from "../testing/index.ts";

// Milestone 9's ticket 14 (F-148, F-150, ADR 0070): sending with files through the panel's own
// procedures, on a real database: `tasks.create` (words required, the maintainer's call),
// `tasks.send` (queue and interrupt, files alone allowed) and `tasks.reopen` bind the sender's own
// uploads to the message in its transaction, check the limits again, decide the images by the
// agent and the model, and put the files on the steer; a runner below minor 8 is refused with the
// box's words; the model's image input and an admin's "Reads images"; a document's text in the
// thread. Uploads go through the upload route, core faked at its port.

const KiB = 1024;
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

let harness: ApiHarness;
let projectId: ProjectId;
let modelId: ModelId;
let runnerId: RunnerId;
let profileId: string;
let docx: Uint8Array;
let counter = 0;

const orgA = () => harness.fixture.a.organization.id;
const newMessageId = (): ClientMessageId => clientMessageIdSchema.parse(`files-${String((counter += 1))}`);

beforeAll(async () => {
  harness = await createApiHarness({ files: { messageFilesMax: 2, messageFileMaxBytes: 64 * KiB } });
  const world = await seedConnectionAndModel(harness);
  modelId = world.modelId;
  projectId = (await seedProject(harness, world, "sending")).projectId;
  runnerId = await seedPersonalRunner(harness, harness.fixture.a.admin.id, "files-runner");
  await harness.test.db.runner.update({ where: { id: runnerId }, data: { minor: 8 } });
  // The built-in profile: OpenCode, which takes images in its prompt; its model sees them, as the catalog says.
  profileId = (await harness.test.db.agentProfile.findFirstOrThrow({ where: { organizationId: orgA(), adapter: "opencode" }, select: { id: true } })).id;
  await harness.test.db.model.update({ where: { id: modelId }, data: { catalogInputModalities: ["text", "image"], adminImageInput: null } });
  docx = new Uint8Array(await readFile(path.join(repoRoot, "e2e", "m9-attachments", "fixtures", "history-panel-spec.docx")));
});

afterAll(async () => {
  await harness.dispose();
});

beforeEach(() => {
  harness.fakes.outbox.clear();
});

const upload = (member: SeededMember, name: string, bytes: Uint8Array = PNG): Promise<RecordedUpload> => uploadThroughRoute(harness, member, projectId, { name, bytes });

/** A running task the member drives, its session on the built-in profile and model, held by a runner. */
const runningTask = async (runner: RunnerId = runnerId): Promise<SeededTask> => {
  const task = await seedTask(harness, { organizationId: orgA(), projectId, state: "running", driverMemberId: harness.fixture.a.member.id });
  await seedLease(harness, task, orgA(), projectId, runner);
  await harness.test.db.session.update({ where: { id: task.sessionId }, data: { agentProfileId: profileId, modelId } });
  await harness.test.db.task.update({ where: { id: task.taskId }, data: { agentProfileId: profileId } });
  return task;
};

const messagesOf = async (taskId: TaskId): Promise<readonly (TaskEventOf<"user.message"> & { readonly seq: number })[]> =>
  (await harness.test.db.event.findMany({ where: { taskId, kind: "user.message" }, orderBy: { seq: "asc" } })).flatMap((row) => {
    const event = taskEventSchema.parse(row.payload);
    return event.kind === "user.message" ? [{ ...event, seq: row.seq }] : [];
  });

const steerOf = (messageId: ClientMessageId) => {
  const command = harness.fakes.outbox.commands.find((one) => one.kind === "steer" && Reflect.get(Object(one.body), "clientMessageId") === messageId);
  return command === undefined ? null : steerBodySchema.parse(command.body);
};

const codeOf = (call: Promise<unknown>): Promise<string> => call.then(() => "ok", (error: unknown) => (error instanceof TRPCError ? `${error.code}: ${error.message}` : "error"));

/** The thread's files of each message, as the panel folds the task's history. */
const threadFiles = async (caller: AppCaller, taskId: TaskId): Promise<MessageFilesData[]> => {
  const page = await caller.tasks.history({ taskId });
  return foldTaskEvents(page.events, []).flatMap((message) => message.parts.flatMap((part) => (part.type === "data-message-files" ? [part.data] : [])));
};

describe("files alone make a message, sent with every kind of send (F-148/c1)", () => {
  it("F-148/c1: a message with files and no words is sent: its event holds the files, its steer carries them and the image", async () => {
    const member = harness.fixture.a.member;
    const task = await runningTask();
    const shot = await upload(member, "layout.png");
    const asMember = await harness.as(member);
    const messageId = newMessageId();
    expect(await asMember.tasks.send({ taskId: task.taskId, clientMessageId: messageId, text: "", fileIds: [shot.fileId] })).toMatchObject({ duplicate: false });
    const message = (await messagesOf(task.taskId)).at(-1);
    expect(message).toMatchObject({ text: "", files: [{ fileId: shot.fileId, name: "layout.png", kind: "image", origin: "member", asImage: true }], imagesNotSent: null });
    const steer = steerOf(messageId);
    expect(steer?.files?.map((file) => file.path)).toEqual([`attachments/${String(message?.seq)}/layout.png`]);
    expect(steer?.images).toEqual([shot.fileId]);
    // Neither words nor files is no message.
    expect(await codeOf(asMember.tasks.send({ taskId: task.taskId, clientMessageId: newMessageId(), text: "  " }))).toMatch(/^BAD_REQUEST/);
  });

  it("F-148/c1: files go with create (words required), send (queue and interrupt) and reopen (words optional)", async () => {
    const member = harness.fixture.a.member;
    const asMember = await harness.as(member);
    // A new task needs a few words even with files (the maintainer, the designs' choices 4.2).
    const mock = await upload(member, "mock.png");
    const spec = await upload(member, "spec.txt", new TextEncoder().encode("The panel lists the history, newest first."));
    expect(await codeOf(asMember.tasks.create({ projectId, prompt: "", fileIds: [mock.fileId, spec.fileId] }))).toMatch(/^BAD_REQUEST: Say in a few words/);
    expect(await harness.test.db.messageFile.count({ where: { id: { in: [mock.fileId, spec.fileId] }, state: "uploaded" } })).toBe(2);
    const created = await asMember.tasks.create({ projectId, prompt: "Match the mock", fileIds: [mock.fileId, spec.fileId] });
    expect((await messagesOf(created.taskId))[0]).toMatchObject({ text: "Match the mock", files: [{ fileId: mock.fileId }, { fileId: spec.fileId, kind: "text" }] });

    // A send, queued: its steer carries the file.
    const task = await runningTask();
    const queued = await upload(member, "queued.png");
    const queuedId = newMessageId();
    await asMember.tasks.send({ taskId: task.taskId, clientMessageId: queuedId, text: "Use this one", fileIds: [queued.fileId] });
    expect(steerOf(queuedId)).toMatchObject({ delivery: "queue", files: [{ fileId: queued.fileId }] });
    // Interrupt and send: the turn's cancel, then the message, its steer interrupting with the file.
    const urgent = await upload(member, "urgent.png");
    const urgentId = newMessageId();
    await asMember.tasks.send({ taskId: task.taskId, clientMessageId: urgentId, text: "", delivery: "interrupt", fileIds: [urgent.fileId] });
    const log = await harness.test.db.event.findMany({ where: { taskId: task.taskId }, orderBy: { seq: "asc" }, select: { kind: true } });
    expect(log.map((row) => row.kind).slice(-2)).toEqual(["turn.cancel_requested", "user.message"]);
    expect((await messagesOf(task.taskId)).at(-1)).toMatchObject({ delivery: "after-interrupt", files: [{ fileId: urgent.fileId }] });
    expect(steerOf(urgentId)).toMatchObject({ delivery: "interrupt", files: [{ fileId: urgent.fileId }] });

    // A reopen of a stopped task, with files and no words.
    await harness.test.db.session.updateMany({ where: { taskId: created.taskId }, data: { state: "ended", outcome: "without_changes", endedAt: new Date() } });
    await harness.test.db.task.update({ where: { id: created.taskId }, data: { state: "stopped", subState: null, stoppedReason: "requested" } });
    const again = await upload(member, "again.png");
    const reopened = await asMember.tasks.reopen({ taskId: created.taskId, clientMessageId: newMessageId(), fileIds: [again.fileId] });
    expect(reopened.sessionId).not.toBe("");
    expect((await messagesOf(created.taskId)).at(-1)).toMatchObject({ text: "", reopen: true, files: [{ fileId: again.fileId, name: "again.png" }] });
  });

  it("F-148/c1: a file another member uploaded can't be sent, and nothing is written", async () => {
    const { member, admin } = harness.fixture.a;
    const asMember = await harness.as(member);
    const theirs = await upload(admin, "theirs.png");
    const task = await runningTask();
    const before = (await messagesOf(task.taskId)).length;
    expect(await codeOf(asMember.tasks.send({ taskId: task.taskId, clientMessageId: newMessageId(), text: "Look", fileIds: [theirs.fileId] }))).toMatch(/^BAD_REQUEST/);
    expect(await codeOf(asMember.tasks.create({ projectId, prompt: "Look", fileIds: [theirs.fileId] }))).toMatch(/^BAD_REQUEST/);
    expect(await messagesOf(task.taskId)).toHaveLength(before);
    expect(harness.fakes.outbox.commands).toEqual([]);
    expect(await harness.test.db.messageFile.findUniqueOrThrow({ where: { id: theirs.fileId } })).toMatchObject({ state: "uploaded", taskId: null, memberId: admin.id });
  });
});

describe("the limits again at send (F-148/c2)", () => {
  it("F-148/c2: a send over a limit leaves out what's over, and the thread's message says so with its size", async () => {
    const member = harness.fixture.a.member;
    const asMember = await harness.as(member);
    const task = await runningTask();
    // The box keeps to two files; three are sent straight to the API.
    const files = [await upload(member, "one.png"), await upload(member, "two.png"), await upload(member, "three.png")];
    await asMember.tasks.send({ taskId: task.taskId, clientMessageId: newMessageId(), text: "All three", fileIds: files.map((file) => file.fileId) });
    const message = (await messagesOf(task.taskId)).at(-1);
    expect(message?.files?.map((file) => file.name)).toEqual(["one.png", "two.png"]);
    expect(message?.filesLeftOut).toEqual([{ name: "three.png", reason: "too-many", size: PNG.length }]);
    // The thread says so under the message, by name, with why and how big.
    const [thread] = (await threadFiles(asMember, task.taskId)).slice(-1);
    expect(thread?.leftOut).toEqual([{ name: "three.png", reason: "too-many", size: PNG.length }]);
    expect(thread?.files.map((file) => file.name)).toEqual(["one.png", "two.png"]);
    // What's left out stays the member's upload, for another message or the sweep.
    expect(await harness.test.db.messageFile.findUniqueOrThrow({ where: { id: files[2]?.fileId ?? "" } })).toMatchObject({ state: "uploaded", taskId: null });
  });
});

describe("a runner too old for files (F-148/c9)", () => {
  it("F-148/c9: a send with files to a minor-7 runner's session is refused with the box's words; one without files goes", async () => {
    const member = harness.fixture.a.member;
    const asMember = await harness.as(member);
    const old = runnerIdSchema.parse(await seedPersonalRunner(harness, harness.fixture.a.admin.id, "old-runner"));
    await harness.test.db.runner.update({ where: { id: old }, data: { minor: 7 } });
    const task = await runningTask(old);
    // The box knows before sending: the runner's name, for its note.
    expect((await asMember.tasks.get({ taskId: task.taskId })).messageFiles.oldRunner).toBe("old-runner");
    expect((await asMember.tasks.get({ taskId: (await runningTask()).taskId })).messageFiles.oldRunner).toBeNull();
    const shot = await upload(member, "for-old.png");
    const before = (await messagesOf(task.taskId)).length;
    expect(await codeOf(asMember.tasks.send({ taskId: task.taskId, clientMessageId: newMessageId(), text: "Look", fileIds: [shot.fileId] }))).toBe(`PRECONDITION_FAILED: ${RUNNER_NEEDS_UPGRADE_FOR_FILES}`);
    expect(await messagesOf(task.taskId)).toHaveLength(before);
    expect(harness.fakes.outbox.commands).toEqual([]);
    expect(await harness.test.db.messageFile.findUniqueOrThrow({ where: { id: shot.fileId } })).toMatchObject({ state: "uploaded", taskId: null });
    // Words alone still reach it.
    expect(await codeOf(asMember.tasks.send({ taskId: task.taskId, clientMessageId: newMessageId(), text: "Carry on" }))).toBe("ok");
  });
});

describe("a model's image input (F-148/c5)", () => {
  it("F-148/c5: model.imageInput for each case, on the task and the new task; an admin's override changes it and the images a send gives", async () => {
    const { member, admin } = harness.fixture.a;
    const asMember = await harness.as(member);
    const asAdmin = await harness.as(admin);
    const task = await runningTask();
    const inputs = async () => {
      const got = await asMember.tasks.get({ taskId: task.taskId });
      const choices = await asMember.tasks.runnerChoices({ projectId });
      return { task: got.messageFiles.model?.imageInput, profile: got.agent?.model?.imageInput, newTask: choices.model?.imageInput, takes: [got.messageFiles.agentTakesImages, choices.agentTakesImages] };
    };
    const setCatalog = (value: readonly string[] | null) =>
      harness.test.db.model.update({ where: { id: modelId }, data: { catalogInputModalities: value === null ? Prisma.DbNull : [...value], adminImageInput: null } });
    await setCatalog(["text", "image"]);
    expect(await inputs()).toEqual({ task: "yes", profile: "yes", newTask: "yes", takes: [true, true] });
    await setCatalog(["text"]);
    expect(await inputs()).toMatchObject({ task: "no", profile: "no", newTask: "no" });
    await setCatalog(null);
    expect(await inputs()).toMatchObject({ task: "unknown", profile: "unknown", newTask: "unknown" });
    // The model's name goes with it, for the box's note.
    expect((await asMember.tasks.get({ taskId: task.taskId })).messageFiles.model?.name).toBe("World model");

    // A member who isn't an organization admin can't set it, and it doesn't change.
    expect(await codeOf(asMember.providers.setModelImageInput({ modelId, imageInput: true }))).toMatch(/^FORBIDDEN/);
    expect(await inputs()).toMatchObject({ task: "unknown" });
    // An admin says the custom model reads images: it does, from the next message.
    expect(await asAdmin.providers.setModelImageInput({ modelId, imageInput: true })).toEqual({ changed: true, imageInput: "yes", catalogImageInput: "unknown", adminImageInput: true });
    expect(await inputs()).toMatchObject({ task: "yes", profile: "yes", newTask: "yes" });
    const seen = await upload(member, "seen.png");
    await asMember.tasks.send({ taskId: task.taskId, clientMessageId: newMessageId(), text: "", fileIds: [seen.fileId] });
    expect((await messagesOf(task.taskId)).at(-1)).toMatchObject({ files: [{ asImage: true }], imagesNotSent: null });
    const entry = await harness.test.db.auditEntry.findFirstOrThrow({ where: { action: "model.image-input-changed", entityId: modelId }, orderBy: { createdAt: "desc" } });
    expect(entry).toMatchObject({ actorId: admin.id, data: { from: "catalog", to: "reads-images" } });
    // The admin's "no" wins over a catalog that says yes.
    await harness.test.db.model.update({ where: { id: modelId }, data: { catalogInputModalities: ["text", "image"] } });
    await asAdmin.providers.setModelImageInput({ modelId, imageInput: false });
    expect(await inputs()).toMatchObject({ task: "no" });
    const unseen = await upload(member, "unseen.png");
    await asMember.tasks.send({ taskId: task.taskId, clientMessageId: newMessageId(), text: "", fileIds: [unseen.fileId] });
    expect((await messagesOf(task.taskId)).at(-1)).toMatchObject({ files: [{ asImage: false }], imagesNotSent: "model" });
    // The provider's models say what applies, what the catalog says and the admin's word.
    const provider = await harness.test.db.model.findUniqueOrThrow({ where: { id: modelId }, select: { providerId: true } });
    const listed = (await asAdmin.providers.models({ providerId: provider.providerId })).find((model) => model.id === modelId);
    expect(listed?.images).toEqual({ imageInput: "no", catalogImageInput: "yes", adminImageInput: false });
    // Cleared, the catalog's word applies again.
    expect(await asAdmin.providers.setModelImageInput({ modelId, imageInput: null })).toMatchObject({ changed: true, imageInput: "yes", adminImageInput: null });
    expect(await inputs()).toMatchObject({ task: "yes" });
  });
});

describe("a document's text in the thread (F-150/c1)", () => {
  it("F-150/c1: a document's file view says text: ready with its words, in the task's files and in the thread", async () => {
    const member = harness.fixture.a.member;
    const asMember = await harness.as(member);
    const reading = fakeCoreUploads(harness.test.db, { maxFiles: 2, textOf: () => ({ state: "ready", markdown: "# History panel\n\nMatch the mock.", words: 412 }) });
    const spec = await uploadThroughRoute(harness, member, projectId, { name: "history-panel-spec.docx", bytes: docx }, { uploader: reading.uploader });
    expect(spec).toMatchObject({ kind: "document", text: { state: "ready", words: 412, reason: null } });
    const created = await asMember.tasks.create({ projectId, prompt: "Build the panel the spec describes", fileIds: [spec.fileId] });
    const files = await asMember.tasks.files({ taskId: created.taskId });
    expect(files.files).toMatchObject([{ fileId: spec.fileId, name: "history-panel-spec.docx", kind: "document", text: "ready", textWords: 412, textReason: null, downloadPath: `/api/tasks/${created.taskId}/files/${spec.fileId}` }]);
    expect(files.people).toEqual({ images: 0, files: 1, bytes: docx.length, folders: [".ostra/attachments/"] });
    const [thread] = await threadFiles(asMember, created.taskId);
    expect(thread?.files).toMatchObject([{ fileId: spec.fileId, text: "ready", textWords: 412, textReason: null }]);
  });
});
