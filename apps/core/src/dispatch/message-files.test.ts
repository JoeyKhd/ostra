import { randomBytes, randomUUID } from "node:crypto";

import { createLogger } from "@ostra/adapter-sdk";
import type { CatalogEntry, LogRecord } from "@ostra/adapter-sdk";
import { Prisma } from "@ostra/db";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import {
  createPromptTask,
  dispatchTask,
  dispatchWaitFromDb,
  messageFileLimits,
  postgresAuditLog,
  postgresChangeNotices,
  postgresCommandOutbox,
  recordUpload,
  reopenTask,
  sendMemberMessageInTx,
  syncProviderModels,
  systemClock,
} from "@ostra/domain";
import type { DispatchTaskResult, MemberScope, MessageFilesDeps, SendMemberMessageResult, SessionTimers, TaskSpecFilesCaps } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import {
  blobIdSchema,
  clientMessageIdSchema,
  encodeTaskSpecForMinor,
  isTaskOfferable,
  leaseEpochSchema,
  memberIdSchema,
  modelIdSchema,
  safeFileNameSchema,
  sha256HexSchema,
  steerBodySchema,
  taskEventSchema,
  taskNotOfferableWords,
  turnIdSchema,
} from "@ostra/protocol";
import type { ClientMessageId, InputModality, MessageFileId, ModelId, RunnerId, SessionId, TaskEventOf, TaskId, TaskSpec } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { agentTakesImages } from "../agents/prompt-images.ts";
import type { RunnerRef } from "../gateway/context.ts";
import { createIngest } from "../ingest/ingest.ts";
import type { Ingest } from "../ingest/ingest.ts";
import { createLiveTextWriter } from "../ingest/live-text.ts";
import type { LiveTextWriter } from "../ingest/live-text.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { drive } from "../testing/turns.ts";
import type { DrivenTask } from "../testing/turns.ts";
import { PROVIDER_TOKEN, seedOnlineRunner, seedWorld } from "../testing/world.ts";
import type { QueuedTask, World } from "../testing/world.ts";
import { applyOfferResultsInTx } from "./dispatcher.ts";
import { buildTaskSpec } from "./task-spec.ts";

// Milestone 9's ticket 11 (F-148, ADR 0070, Q335, Q340): a message's files in the task spec, the
// steer and the restore, against a real database, through core's dispatch and the domain's use
// cases, with fake runners at protocol minor 8 and minor 7. The spec carries every sent file of
// the task (a fresh box writes them all again), the first prompt's files and each pending
// message's, and the model's inputs; a steer carries its message's files with the images the
// decision picked; a minor-7 runner is never offered a task with files, nor sent a message with
// files. File names hold shell syntax and prompt-like text, as data, and reach no log line.

const MiB = 1024 * 1024;
const CAPS = { capMicroUsd: 25_000_000, capTokens: 10_000_000 } as const;
const SPEC_SETTINGS = { idleMinutes: 15, spendCap: CAPS } as const;
const turnId = turnIdSchema.parse("turn-1");

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let world: World;
let ingest: Ingest;
let liveText: LiveTextWriter;
let timers: SessionTimers;
let scope: MemberScope;
let modelId: ModelId;
/** Personal runners of the member: two at minor 8, one at minor 7. */
let first: RunnerRef;
let second: RunnerRef;
let old: RunnerRef;
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const modelProvider = new FakeModelProvider();
const records: LogRecord[] = [];
const logger = createLogger((record) => records.push(record));

/** The install's message limits, and core's own registry of agents that take images (OpenCode does). */
const FILES: MessageFilesDeps = {
  limits: messageFileLimits({ messageFilesMax: 10, messageFileMaxBytes: 10 * MiB, messageFilesTotalBytes: 25 * MiB }),
  agentTakesImages,
};

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  timers = { sessionMaxMs: 120 * 60_000, boxReleaseIdleMs: 14 * 24 * 3_600_000, cancelInTx: (tx, job, payload) => jobs.cancelInTx(tx, job, payload) };
  liveText = createLiveTextWriter({ db: test.db, logger });
  ingest = createIngest({ db: test.db, jobs, notices: postgresChangeNotices, clock: systemClock, liveText, logger, timers, outbox: postgresCommandOutbox });
  scope = { organizationId: fixture.a.organization.id, memberId: memberIdSchema.parse(fixture.a.member.id), role: "member", projectRoles: new Map() };
  modelId = modelIdSchema.parse((await test.db.agentProfile.findUniqueOrThrow({ where: { id: world.profileId } })).modelId);
  first = await seedOnlineRunner(test.db, world.organizationId, { kind: "personal", memberId: fixture.a.member.id }, 20);
  second = await seedOnlineRunner(test.db, world.organizationId, { kind: "personal", memberId: fixture.a.member.id }, 20);
  old = await seedOnlineRunner(test.db, world.organizationId, { kind: "personal", memberId: fixture.a.member.id }, 20);
  await setMinor(first, 8);
  await setMinor(second, 8);
  await setMinor(old, 7);
});

afterAll(async () => {
  await liveText.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

const setMinor = async (runner: RunnerRef, minor: number): Promise<void> => {
  await test.db.runnerPresence.update({ where: { runnerId: runner.runnerId }, data: { minor } });
};

const setOnline = async (runner: RunnerRef, online: boolean): Promise<void> => {
  await test.db.runnerPresence.update({ where: { runnerId: runner.runnerId }, data: { disconnectedAt: online ? null : new Date(), lastSeenAt: new Date() } });
};

/** The session's model row as the catalog sync and an admin leave it: models.dev's inputs, and "Reads images". */
const setModel = async (catalog: readonly InputModality[] | null, admin: boolean | null): Promise<void> => {
  await test.db.model.update({ where: { id: modelId }, data: { catalogInputModalities: catalog === null ? Prisma.DbNull : [...catalog], adminImageInput: admin } });
};

const digest = () => sha256HexSchema.parse(randomBytes(32).toString("hex"));

/** A member's upload, as core's endpoint records it: its blob of the project, a document's text beside it, then its row. */
const upload = async (name: string, kind: "image" | "document" | "file" = "image"): Promise<MessageFileId> => {
  const contentType = kind === "image" ? "image/png" : kind === "document" ? "application/pdf" : "application/octet-stream";
  const sha256 = digest();
  const blob = await test.db.blob.create({
    data: { organizationId: world.organizationId, projectId: world.projectId, store: "postgres", key: `m9-${randomUUID()}`, purpose: "message-file", contentType, size: 2048, sha256 },
  });
  const text =
    kind === "document"
      ? await test.db.blob.create({
          data: { organizationId: world.organizationId, projectId: world.projectId, store: "postgres", key: `m9-${randomUUID()}`, purpose: "message-file-text", contentType: "text/markdown", size: 300, sha256: digest() },
        })
      : null;
  const recorded = await test.db.$transaction((tx) =>
    recordUpload(tx, {
      organizationId: world.organizationId,
      projectId: world.projectId,
      memberId: scope.memberId,
      name: safeFileNameSchema.parse(name),
      kind,
      contentType,
      size: 2048,
      sha256,
      blobId: blobIdSchema.parse(blob.id),
      text: text === null ? { state: "none" } : { state: "ready", blobId: blobIdSchema.parse(text.id), words: 42, truncated: false },
    }),
  );
  return recorded.fileId;
};

/** A prompt task on the member's personal runner, its first message with its files. */
const start = async (prompt: string, fileIds: readonly MessageFileId[], runner: RunnerRef): Promise<QueuedTask> => {
  const started = await test.db.$transaction((tx) =>
    createPromptTask(
      { tx, scope, jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, files: FILES },
      { projectId: world.projectId, prompt, runnerId: runner.runnerId, fileIds: [...fileIds] },
    ),
  );
  if (!started.ok) {
    throw new Error(`start refused: ${started.error}`);
  }
  return { taskId: started.taskId, sessionId: started.sessionId, organizationId: world.organizationId };
};

const dispatch = async (taskId: TaskId, sessionId: SessionId): Promise<DispatchTaskResult> => {
  const { leaseEpoch } = await test.db.task.findUniqueOrThrow({ where: { id: taskId } });
  return test.db.$transaction((tx) =>
    dispatchTask(
      {
        tx,
        jobs,
        outbox: postgresCommandOutbox,
        notices: postgresChangeNotices,
        clock: systemClock,
        logger,
        personalSlots: 50,
        reopen: { agentImportsArchives: (adapter) => adapter === "opencode", archiveMaxBytes: 64 * MiB },
      },
      { organizationId: world.organizationId, taskId, sessionId, leaseEpoch: leaseEpochSchema.parse(leaseEpoch + 1) },
    ),
  );
};

const accept = async (taskId: TaskId, offered: DispatchTaskResult, runner: RunnerRef): Promise<void> => {
  if (!offered.ok) {
    throw new Error(`dispatch: ${offered.error}`);
  }
  const command = await test.db.command.findUniqueOrThrow({ where: { id: offered.commandId } });
  await test.db.$transaction((tx) =>
    applyOfferResultsInTx({ jobs, notices: postgresChangeNotices, clock: systemClock, logger }, tx, runner, [
      { commandId: offered.commandId, seq: command.seq, kind: "dispatch", body: command.body, taskId, result: "accepted", reason: null },
    ]),
  );
};

const specFor = async (taskId: TaskId, runnerId: RunnerId, taskFilesCaps?: TaskSpecFilesCaps): Promise<TaskSpec> => {
  const { leaseEpoch } = await test.db.task.findUniqueOrThrow({ where: { id: taskId } });
  const built = await buildTaskSpec(
    { db: test.db, codeHost, secretStore, settings: SPEC_SETTINGS, logger, ...(taskFilesCaps === undefined ? {} : { taskFilesCaps }) },
    { taskId, runnerId, leaseEpoch: leaseEpochSchema.parse(leaseEpoch) },
  );
  if (!built.ok) {
    throw new Error(`spec: ${built.error}`);
  }
  return built.spec;
};

/** A task started, dispatched to `runner` and accepted: its events go through core's ingest. */
const accepted = async (prompt: string, fileIds: readonly MessageFileId[], runner: RunnerRef): Promise<DrivenTask> => {
  const task = await start(prompt, fileIds, runner);
  const offered = await dispatch(task.taskId, task.sessionId);
  expect(offered).toMatchObject({ ok: true, runnerId: runner.runnerId });
  await accept(task.taskId, offered, runner);
  const { leaseEpoch } = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
  return drive(ingest, task, runner, leaseEpoch);
};

/** A task in its first turn: a session to steer into. */
const running = async (prompt: string, fileIds: readonly MessageFileId[], runner: RunnerRef): Promise<DrivenTask> => {
  const driven = await accepted(prompt, fileIds, runner);
  await driven.send({ kind: "turn.started", turnId });
  return driven;
};

/** The task's member messages, as stored. */
const messagesOf = async (taskId: TaskId): Promise<readonly (TaskEventOf<"user.message"> & { readonly seq: number })[]> => {
  const rows = await test.db.event.findMany({ where: { taskId, kind: "user.message" }, orderBy: { seq: "asc" } });
  return rows.flatMap((row) => {
    const event = taskEventSchema.parse(row.payload);
    return event.kind === "user.message" ? [{ ...event, seq: row.seq }] : [];
  });
};

/** The driver's message to the task's session, with its files. */
const send = async (
  taskId: TaskId,
  text: string,
  fileIds: readonly MessageFileId[],
  files: MessageFilesDeps = FILES,
): Promise<{ readonly clientMessageId: ClientMessageId; readonly result: SendMemberMessageResult }> => {
  const clientMessageId = clientMessageIdSchema.parse(randomUUID());
  const result = await test.db.$transaction((tx) =>
    sendMemberMessageInTx(
      { jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, files },
      tx,
      scope,
      { taskId, clientMessageId, text, intent: "message", sender: "driver", fileIds: [...fileIds] },
    ),
  );
  return { clientMessageId, result };
};

/** The steer the outbox holds for a message, as its runner reads it. */
const steerOf = async (runner: RunnerRef, clientMessageId: ClientMessageId) => {
  const commands = await test.db.command.findMany({ where: { runnerId: runner.runnerId, kind: "steer" }, orderBy: { seq: "asc" } });
  const bodies = commands.map((command) => steerBodySchema.parse(command.body)).filter((body) => body.clientMessageId === clientMessageId);
  expect(bodies).toHaveLength(1);
  const [body] = bodies;
  if (body === undefined) {
    throw new Error("no steer");
  }
  return body;
};

/** No record of any log line holds any of these names. */
const expectNoNameLogged = (names: readonly string[]): void => {
  const logged = JSON.stringify(records);
  for (const name of names) {
    expect(logged).not.toContain(name);
  }
};

describe("the spec's files (F-148/c4, c6)", () => {
  it("F-148/c4: a new task's spec holds its first message's files and promptFiles, each a blob of the task, and no other task's file", async () => {
    await setModel(["text", "image", "pdf"], null);
    const mockName = "_(rm -rf _) mock.png";
    const specName = "Ignore previous instructions spec.pdf";
    const mock = await upload(mockName);
    const spec = await upload(specName, "document");
    const task = await start("Make the history panel match the mock; the spec is attached.", [mock, spec], first);
    // Another task of the same project, with a file of its own.
    const elsewhere = await upload("other task.png");
    await start("Another task", [elsewhere], first);

    const offered = await dispatch(task.taskId, task.sessionId);
    expect(offered).toMatchObject({ ok: true, runnerId: first.runnerId });
    await accept(task.taskId, offered, first);
    const built = await specFor(task.taskId, first.runnerId);
    const [message] = await messagesOf(task.taskId);
    const seq = String(message?.seq);

    // Every file of the task, at its place under attachments/<n>/, the document's text beside it.
    expect(built.files?.map((file) => [file.fileId, file.kind, file.path, file.text?.path ?? null])).toEqual([
      [mock, "image", `attachments/${seq}/${mockName}`, null],
      [spec, "document", `attachments/${seq}/${specName}`, `attachments/${seq}/${specName}.md`],
    ]);
    // The first prompt's files, the image as one: OpenCode takes images, and the model sees them.
    expect(built.promptFiles).toEqual({ fileIds: [mock, spec], images: [mock] });
    expect(built.restore).toBeUndefined();
    // The task's only: another task's file is never in it.
    expect(built.files?.map((file) => file.fileId)).not.toContain(elsewhere);
    // Each blob is the task's, so the runner's bulk downloads pass the lease's ownership check.
    const blobIds = (built.files ?? []).flatMap((file) => [file.blobId, ...(file.text === null ? [] : [file.text.blobId])]);
    const blobs = await test.db.blob.findMany({ where: { id: { in: blobIds } }, select: { taskId: true, organizationId: true } });
    expect(blobs).toHaveLength(3);
    expect(blobs.every((blob) => blob.taskId === task.taskId && blob.organizationId === world.organizationId)).toBe(true);
    // A minor-8 runner reads the spec as built; a minor-7 one is never offered it.
    expect(encodeTaskSpecForMinor(built, 8)).toEqual(built);
    expect(isTaskOfferable(built, 7)).toEqual({ offerable: false, reason: "message-files", minMinor: 8 });
    expect(isTaskOfferable(built, 8)).toEqual({ offerable: true });
    expectNoNameLogged([mockName, specName]);
  });

  it("F-148/c6: a reopen on a fresh box holds every earlier file and the reopen's own, and each pending message keeps its files", async () => {
    await setModel(["text", "image"], null);
    const mock = await upload("mock.png");
    const sheet = await upload("data sheet.pdf", "document");
    const task = await accepted("Make the history panel", [mock, sheet], first);
    const before = await specFor(task.taskId, first.runnerId);
    // The first turn starts, and the box goes with its runner before it ends: the prompt is still owed.
    await task.send({ kind: "turn.started", turnId });
    await setOnline(first, false);
    try {
      await test.db.task.update({ where: { id: task.taskId }, data: { state: "stopped", subState: null, stoppedReason: "runner_lost" } });
      const later = await upload("later notes.pdf", "document");
      const reopened = await test.db.$transaction((tx) =>
        reopenTask(
          { tx, scope, jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, spendCap: CAPS, timers, files: FILES },
          { taskId: task.taskId, clientMessageId: clientMessageIdSchema.parse(randomUUID()), text: "Carry on, with these notes too.", fileIds: [later] },
        ),
      );
      if (!reopened.ok) {
        throw new Error(`reopen refused: ${reopened.error}`);
      }
      const offered = await dispatch(task.taskId, reopened.sessionId);
      // A fresh box on the member's other runner at minor 8.
      expect(offered).toMatchObject({ ok: true, runnerId: second.runnerId });
      expect((await test.db.session.findUniqueOrThrow({ where: { id: reopened.sessionId } })).origin).toBe("rebuilt");
      await accept(task.taskId, offered, second);
      const spec = await specFor(task.taskId, second.runnerId);

      // Every earlier file, at the place the agent saw it, then the reopen's own.
      const messages = await messagesOf(task.taskId);
      const reopening = messages.find((message) => message.reopen === true);
      expect(spec.files?.slice(0, 2)).toEqual(before.files);
      expect(spec.files?.map((file) => file.fileId)).toEqual([mock, sheet, later]);
      expect(spec.files?.[2]?.path).toBe(`attachments/${String(reopening?.seq)}/later notes.pdf`);
      expect(spec.files?.[2]?.text?.path).toBe(`attachments/${String(reopening?.seq)}/later notes.pdf.md`);
      // No first prompt: the owed prompt and the reopen's message are pending messages, each with its files.
      expect(spec.promptFiles).toBeUndefined();
      expect(spec.restore?.origin).toBe("rebuilt");
      expect(spec.restore?.pendingMessages).toEqual([
        { clientMessageId: messages[0]?.clientMessageId, text: "Make the history panel", files: { fileIds: [mock, sheet], images: [mock] } },
        { clientMessageId: reopening?.clientMessageId, text: "Carry on, with these notes too.", files: { fileIds: [later], images: [] } },
      ]);
      expect(isTaskOfferable(spec, 7)).toMatchObject({ offerable: false, reason: "message-files" });

      // A file whose blob retention took is never named: the spec and its prompts keep to the files left.
      await test.db.messageFile.update({ where: { id: sheet }, data: { blobId: null } });
      const fewer = await specFor(task.taskId, second.runnerId);
      expect(fewer.files?.map((file) => file.fileId)).toEqual([mock, later]);
      expect(fewer.restore?.pendingMessages[0]?.files).toEqual({ fileIds: [mock], images: [mock] });
    } finally {
      await setOnline(first, true);
    }
  });

  it("past the spec's caps the newest files stay: a reopen's own on a fresh box always, the oldest left out, the rest oldest first", async () => {
    await setModel(["text", "image"], null);
    const oldest = await upload("oldest.png");
    const older = await upload("older.png");
    const task = await accepted("Make the history panel", [oldest, older], first);
    // The first turn answers the first message, then the box goes with its runner.
    await task.send({ kind: "turn.started", turnId }, { kind: "turn.ended", turnId, stopReason: "end_turn" });
    await setOnline(first, false);
    try {
      await test.db.task.update({ where: { id: task.taskId }, data: { state: "stopped", subState: null, stoppedReason: "runner_lost" } });
      const notes = await upload("reopen notes.pdf", "document");
      const reopened = await test.db.$transaction((tx) =>
        reopenTask(
          { tx, scope, jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, spendCap: CAPS, timers, files: FILES },
          { taskId: task.taskId, clientMessageId: clientMessageIdSchema.parse(randomUUID()), text: "Carry on, with these notes.", fileIds: [notes] },
        ),
      );
      if (!reopened.ok) {
        throw new Error(`reopen refused: ${reopened.error}`);
      }
      const offered = await dispatch(task.taskId, reopened.sessionId);
      expect(offered).toMatchObject({ ok: true, runnerId: second.runnerId });
      expect((await test.db.session.findUniqueOrThrow({ where: { id: reopened.sessionId } })).origin).toBe("rebuilt");
      await accept(task.taskId, offered, second);
      const reopening = (await messagesOf(task.taskId)).find((message) => message.reopen === true);
      // Only the reopen's message is owed: the first turn answered the first.
      const owed = [{ clientMessageId: reopening?.clientMessageId, text: "Carry on, with these notes.", files: { fileIds: [notes], images: [] } }];

      // Within the caps, every file, oldest first.
      const all = await specFor(task.taskId, second.runnerId);
      expect(all.files?.map((file) => file.fileId)).toEqual([oldest, older, notes]);
      expect(all.restore?.pendingMessages).toEqual(owed);

      // Two files at most: the reopen's own stays, the newest earlier one with it, and the oldest is left out.
      const two = await specFor(task.taskId, second.runnerId, { maxFiles: 2, maxBytes: 512 * MiB });
      expect(two.files?.map((file) => file.fileId)).toEqual([older, notes]);
      expect(two.files?.[1]?.path).toBe(`attachments/${String(reopening?.seq)}/reopen notes.pdf`);
      expect(two.restore?.pendingMessages).toEqual(owed);

      // One file at most: the reopen's own still, written and named.
      const one = await specFor(task.taskId, second.runnerId, { maxFiles: 1, maxBytes: 512 * MiB });
      expect(one.files?.map((file) => file.fileId)).toEqual([notes]);
      expect(one.restore?.pendingMessages).toEqual(owed);

      // The bytes' cap the same way: room for the notes with their text, and one image (2 KiB each, the text 300 bytes).
      const bytes = await specFor(task.taskId, second.runnerId, { maxFiles: 500, maxBytes: 2048 + 300 + 2048 });
      expect(bytes.files?.map((file) => file.fileId)).toEqual([older, notes]);
      expect(bytes.restore?.pendingMessages).toEqual(owed);
    } finally {
      await setOnline(first, true);
    }
  });

  it("F-148/c4: what the runner wrote (`files.written`) is stored as it sent it, and changes no row", async () => {
    const shot = await upload("shot.png");
    const doc = await upload("brief.pdf", "document");
    const task = await accepted("Look at these", [shot, doc], first);
    const rows = () => test.db.messageFile.findMany({ where: { id: { in: [shot, doc] } }, orderBy: { position: "asc" } });
    const before = await rows();
    const written = { kind: "files.written", files: [{ fileId: shot, textWritten: false }], skipped: [{ fileId: doc, reason: "digest-mismatch" }], imagesSent: 0, imagesAsFiles: "agent-did-not-advertise" } satisfies TaskEventOf<"files.written">;
    await task.send(written);
    const stored = await test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "files.written" } });
    expect(stored.payload).toEqual(written);
    expect(await rows()).toEqual(before);
  });
});

describe("the model's inputs and a steer's images (F-148/c5)", () => {
  it("F-148/c5: the spec's inputModalities are the session's model's: a catalog model with images, one without, a custom one, and an admin's word over each", async () => {
    const task = await start("Look at the mock", [], first);
    await accept(task.taskId, await dispatch(task.taskId, task.sessionId), first);
    const cases: readonly [readonly InputModality[] | null, boolean | null, readonly InputModality[]][] = [
      // A catalog model that sees images (and PDFs), and one that doesn't.
      [["text", "image", "pdf"], null, ["text", "image", "pdf"]],
      [["text"], null, ["text"]],
      // A custom model: the catalog says nothing, so text only.
      [null, null, ["text"]],
      // An admin's "Reads images" wins, either way.
      [["text", "image", "pdf"], false, ["text", "pdf"]],
      [["text"], true, ["text", "image"]],
      [null, true, ["text", "image"]],
      [null, false, ["text"]],
    ];
    for (const [catalog, admin, expected] of cases) {
      await setModel(catalog, admin);
      const spec = await specFor(task.taskId, first.runnerId);
      expect(spec.agent.inputModalities).toEqual(expected);
      // A minor-7 runner tells its agent nothing of them, as before.
      expect(encodeTaskSpecForMinor(spec, 7).agent.inputModalities).toBeUndefined();
    }
    await setModel(null, null);
  });

  it("F-148/c5: a steer carries its message's files, and its images follow the decision: the model's input, an admin's word, the agent", async () => {
    await setModel(["text", "image"], null);
    const task = await running("Build the history panel", [], first);
    const layout = await upload("layout.png");
    const notes = await upload("notes.pdf", "document");
    const sent = await send(task.taskId, "Use this layout instead.", [layout, notes]);
    expect(sent.result).toMatchObject({ ok: true, delivery: "steer" });
    const steer = await steerOf(first, sent.clientMessageId);
    const message = (await messagesOf(task.taskId)).find((event) => event.clientMessageId === sent.clientMessageId);
    const seq = String(message?.seq);
    expect(steer.files?.map((file) => [file.fileId, file.path, file.text?.path ?? null])).toEqual([
      [layout, `attachments/${seq}/layout.png`, null],
      [notes, `attachments/${seq}/notes.pdf`, `attachments/${seq}/notes.pdf.md`],
    ]);
    expect(steer.images).toEqual([layout]);
    expect(message?.files?.map((file) => [file.fileId, file.asImage])).toEqual([
      [layout, true],
      [notes, false],
    ]);
    expect(message?.imagesNotSent).toBeNull();

    // A model that can't see images: the image goes as a file only, and the event says why.
    await setModel(["text"], null);
    const blind = await upload("blind.png");
    const toBlind = await send(task.taskId, "", [blind]);
    expect((await steerOf(first, toBlind.clientMessageId)).images).toEqual([]);
    expect((await messagesOf(task.taskId)).find((event) => event.clientMessageId === toBlind.clientMessageId)?.imagesNotSent).toBe("model");

    // An admin says the model reads images: the next image goes as one.
    await setModel(["text"], true);
    const told = await upload("told.png");
    const toTold = await send(task.taskId, "This one too.", [told]);
    expect((await steerOf(first, toTold.clientMessageId)).images).toEqual([told]);

    // An agent that takes no images in its prompt: a file only, and the event says the agent.
    const plain = await upload("plain agent.png");
    const toPlain = await send(task.taskId, "And this.", [plain], { ...FILES, agentTakesImages: () => false });
    expect((await steerOf(first, toPlain.clientMessageId)).images).toEqual([]);
    expect((await messagesOf(task.taskId)).find((event) => event.clientMessageId === toPlain.clientMessageId)?.imagesNotSent).toBe("agent");
    await setModel(null, null);
  });

  it("F-148/c5: the catalog sync writes a model's inputs from models.dev on each sync, and never an admin's word", async () => {
    const entry = (inputModalities: readonly InputModality[] | null): CatalogEntry => ({
      catalogId: "dev-model-1",
      name: "Dev model",
      aliases: [],
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
      inputPricePerMTok: null,
      outputPricePerMTok: null,
      cacheReadPricePerMTok: null,
      cacheWritePricePerMTok: null,
      logoPath: null,
      reasoning: { supported: false },
      reasoningPriceDiffers: false,
      inputModalities,
    });
    modelProvider.endpoints.set("https://models.example/v1", { token: PROVIDER_TOKEN, models: [{ endpointModelId: "dev-model-1", displayName: "Dev model", contextWindow: 200_000 }] });
    const sync = (catalog: readonly CatalogEntry[]) =>
      syncProviderModels(
        { db: test.db, notices: postgresChangeNotices, clock: systemClock, adapters: { codeHost, secretStore, modelProvider }, catalog: () => Promise.resolve(catalog) },
        { organizationId: world.organizationId, providerId: world.providerId },
      );
    const row = () => test.db.model.findUniqueOrThrow({ where: { id: modelId }, select: { catalogInputModalities: true, adminImageInput: true } });
    await setModel(null, false);
    try {
      expect(await sync([entry(["text", "image", "pdf"])])).toMatchObject({ ok: true, matched: 1 });
      expect(await row()).toEqual({ catalogInputModalities: ["text", "image", "pdf"], adminImageInput: false });
      // The next sync writes what models.dev says now, and still leaves the admin's word.
      expect(await sync([entry(["text"])])).toMatchObject({ ok: true, matched: 1 });
      expect(await row()).toEqual({ catalogInputModalities: ["text"], adminImageInput: false });
      expect(await sync([entry(null)])).toMatchObject({ ok: true, matched: 1 });
      expect(await row()).toEqual({ catalogInputModalities: null, adminImageInput: false });
    } finally {
      await test.db.model.update({ where: { id: modelId }, data: { catalogId: null, catalogInputModalities: Prisma.DbNull, adminImageInput: null } });
    }
  });
});

describe("a minor-7 runner and files (F-148/c9)", () => {
  it("F-148/c9: a task with files isn't offered to a minor-7 runner, and the dispatch note says why; one without files is", async () => {
    const shot = await upload("mock.png");
    const task = await start("Match the mock", [shot], old);
    expect(await dispatch(task.taskId, task.sessionId)).toMatchObject({ ok: false, error: "no-runner", message: "needs-protocol" });
    const waiting = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    expect(waiting.state).toBe("queued");
    expect(dispatchWaitFromDb(waiting.dispatchWait)).toEqual({ code: "needs-protocol", minor: 8, reason: "message-files" });
    expect(waiting.dispatchNote).toBe(taskNotOfferableWords("message-files", 8));
    expect(waiting.dispatchNote).toBe("A task with files needs a runner at protocol 1.8 or later: update the runner.");
    expect(await test.db.lease.count({ where: { taskId: task.taskId } })).toBe(0);
    expect(await test.db.command.count({ where: { runnerId: old.runnerId, kind: "dispatch", taskId: task.taskId } })).toBe(0);

    // A task without files goes to it.
    const plain = await start("Nothing attached", [], old);
    expect(await dispatch(plain.taskId, plain.sessionId)).toMatchObject({ ok: true, runnerId: old.runnerId });

    // Upgraded to minor 8, the runner is offered the task with files.
    await setMinor(old, 8);
    try {
      expect(await dispatch(task.taskId, task.sessionId)).toMatchObject({ ok: true, runnerId: old.runnerId });
      expect(dispatchWaitFromDb((await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).dispatchWait)).toBeNull();
    } finally {
      await setMinor(old, 7);
    }
  });

  it("F-148/c9: a message with files to a session on a minor-7 runner is refused before anything is written", async () => {
    const task = await running("Nothing attached yet", [], old);
    const shot = await upload("screen.png");
    const events = await test.db.event.count({ where: { taskId: task.taskId } });
    const steers = await test.db.command.count({ where: { runnerId: old.runnerId, kind: "steer" } });
    const row = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    const sent = await send(task.taskId, "See this screenshot.", [shot]);
    expect(sent.result).toMatchObject({ ok: false, error: "runner-needs-upgrade" });
    // Nothing written: no message, no steer, the task's row as it was, and the file still the member's unsent upload.
    expect(await test.db.event.count({ where: { taskId: task.taskId } })).toBe(events);
    expect(await test.db.command.count({ where: { runnerId: old.runnerId, kind: "steer" } })).toBe(steers);
    expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toEqual(row);
    expect(await test.db.messageFile.findUniqueOrThrow({ where: { id: shot }, select: { state: true, taskId: true, eventSeq: true } })).toEqual({ state: "uploaded", taskId: null, eventSeq: null });
    // Words alone still go to it.
    const words = await send(task.taskId, "Words only, then.", []);
    expect(words.result).toMatchObject({ ok: true, delivery: "steer" });
    expect((await steerOf(old, words.clientMessageId)).files).toBeUndefined();
  });
});
