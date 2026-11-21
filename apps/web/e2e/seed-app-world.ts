// What the App tab's and the thread's pictures' spec needs (F-140, F-121, milestone 8's ticket 17):
// an admin with their own password; a project with a repo, its environment's two app processes (web
// the primary, api), three services (mailpit with a web UI), its screenshots after each turn, and a
// runner at protocol minor 7; a task whose turn took three screenshots of /history and a recording
// (real PNGs and a frame reel of real JPEGs, which the spec made in the browser), an earlier turn's
// after-turn screenshot to compare with, the app's lines and a box that stopped since; a port another
// task's agent announced and a member kept, waiting on an admin; and a refine task with a draft and
// a screenshot of its own for "Add to draft". Each picture is a blob of its task in the built-in
// store, read through core as the panel reads every blob. The throwaway e2e database only.
// Run as `node e2e/seed-app-world.ts '<json>'`; prints one JSON line.

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { hashPassword } from "better-auth/crypto";

import { createDb, notifyChannels } from "@ostra/db";
import { KEPT_COMMAND_PLACEHOLDER, postgresChangeNotices, recordAudit, saveDraft, seedMember, systemClock } from "@ostra/domain";
import {
  APP_LOG_CONTENT_TYPE,
  APP_RECORDING_CONTENT_TYPE,
  APP_SCREENSHOT_CONTENT_TYPE,
  encodeFrameReel,
  environmentIdSchema,
  environmentProposalSchema,
  organizationIdSchema,
  projectIdSchema,
  taskEventSchema,
  taskIdSchema,
} from "@ostra/protocol";
import type { TaskEvent } from "@ostra/protocol";
import { z } from "zod";

const args = z
  .strictObject({
    databaseUrl: z.string(),
    password: z.string(),
    tag: z.string().regex(/^[a-z0-9-]{1,24}$/),
    /** The pictures the spec took of the demo app: PNGs at three widths, an older one, and the recording's JPEG frames. */
    files: z.strictObject({ desktop: z.string(), tablet: z.string(), phone: z.string(), older: z.string(), refine: z.string(), frames: z.array(z.string()).min(2) }),
  })
  .parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

const username = `app-${args.tag}`;
const seeded = await seedMember({ db, hashPassword, env: { NODE_ENV: "test" } }, { username, email: `${username}@example.com`, password: args.password, role: "admin" });
if (!seeded.ok) throw new Error(`seeding ${username} failed: ${seeded.error}`);
await db.user.update({ where: { id: seeded.seeded.userId }, data: { name: "Alex Kim" } });
const admin = await db.member.findUniqueOrThrow({ where: { id: seeded.seeded.memberId } });
const organizationId = admin.organizationId;
const keeperName = `${username}-sam`;
const keeper = await seedMember({ db, hashPassword, env: { NODE_ENV: "test" } }, { username: keeperName, email: `${keeperName}@example.com`, password: args.password, role: "member" });
if (!keeper.ok) throw new Error(`seeding ${keeperName} failed: ${keeper.error}`);
await db.user.update({ where: { id: keeper.seeded.userId }, data: { name: "Sam Rivera" } });

// The repo's GitHub, as rows: the spec reads nothing from it (detection finds no file and says so).
const connection = await db.connection.create({ data: { organizationId, kind: "github", appId: `e2e-app-${args.tag}`, slug: `e2e-app-${args.tag}`, state: "active" } });
const installation = await db.codeHostInstallation.create({ data: { organizationId, connectionId: connection.id, installationId: `inst-${args.tag}`, accountLogin: "acme", accountKind: "organization" } });
const project = await db.project.create({ data: { organizationId, name: "calculator", slug: `calculator-${args.tag}`, access: "open" } });
const repo = await db.repo.create({
  data: { organizationId, projectId: project.id, connectionId: connection.id, installationId: installation.installationId, hostRepoId: `e2e-${args.tag}`, fullName: "acme/calculator-web", defaultBranch: "main", checkoutDir: "calculator-web" },
});
const environment = await db.environment.create({
  data: {
    organizationId,
    projectId: project.id,
    status: "saved",
    savedAt: new Date(Date.now() - 2 * 3_600_000),
    savedByMemberId: admin.id,
    setupScript: "pnpm install --frozen-lockfile",
    screenshotsAfterTurn: true,
    screenshotRoutes: ["/", "/history", "/settings"],
    screenshotWidths: ["desktop", "phone"],
  },
});
const place = { organizationId, projectId: project.id };
await db.appProcess.create({ data: { ...place, environmentId: environment.id, name: "web", repoId: repo.id, folder: ".", command: "pnpm dev", port: 5173, readyKind: "http", readyValue: "/", label: "Web", primary: true, position: 0 } });
await db.appProcess.create({ data: { ...place, environmentId: environment.id, name: "api", repoId: repo.id, folder: "api", command: "pnpm start:dev", port: 3001, readyKind: "http", readyValue: "/health", label: "API", primary: false, position: 1 } });
await db.service.create({ data: { ...place, environmentId: environment.id, name: "mailpit", image: "axllent/mailpit:1.21", port: 8025, variables: [], previewLabel: "Mail" } });
await db.service.create({ data: { ...place, environmentId: environment.id, name: "db", image: "postgres:17", port: 5432, variables: [] } });
await db.service.create({ data: { ...place, environmentId: environment.id, name: "redis", image: "redis:7", port: 6379, variables: [] } });

// The runner the boxes ran on, at protocol minor 7.
const runner = await db.runner.create({ data: { organizationId, kind: "personal", ownerMemberId: admin.id, name: "build-01", publicKey: `e2e-${randomUUID()}`, executor: "docker", capacity: 4, version: "0.8.0" } });
await db.runnerPresence.create({ data: { runnerId: runner.id, organizationId, replicaId: "e2e-seed", connectionEpoch: 1, carrier: "websocket", minor: 7 } });

/** A blob of a task in the built-in store, as core's blob service keeps it: its row and its chunks. */
const storeBlob = async (taskId: string, purpose: string, contentType: string, bytes: Uint8Array): Promise<string> => {
  const id = randomUUID();
  await db.blob.create({
    data: { id, ...place, taskId, store: "postgres", key: `postgres:${id}`, purpose, contentType, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
  });
  const chunk = 1024 * 1024;
  for (let at = 0, ordinal = 0; at < bytes.length; at += chunk, ordinal += 1) {
    await db.blobChunk.create({ data: { organizationId, blobId: id, ordinal, offset: at, bytes: Buffer.from(bytes.subarray(at, at + chunk)) } });
  }
  return id;
};

const pngSize = (bytes: Uint8Array): { readonly width: number; readonly height: number } => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
};

type Timed = { readonly at: number; readonly event: TaskEvent };

/** A task the admin drives, on build-01, its session ended and its box stopped. */
const makeTask = async (title: string, kind: "code" | "refine", state: "in_review" | "needs_you", reason: "draft_ready" | "environment_proposal" | null = null) => {
  const task = await db.task.create({
    data: {
      ...place,
      kind,
      source: "prompt",
      title,
      prompt: title,
      branchName: `ostra/${randomUUID().slice(0, 8)}-app`,
      state,
      ...(reason === null ? {} : { needsYouReason: reason }),
      ...(state === "in_review" ? { subState: "waiting_for_reviewer" as const } : {}),
      driverMemberId: admin.id,
      creatorMemberId: admin.id,
    },
  });
  const box = await db.box.create({ data: { ...place, taskId: task.id, runnerId: runner.id, executor: "docker", state: "stopped", readyAt: new Date(Date.now() - 30 * 60_000), stoppedAt: new Date() } });
  const session = await db.session.create({ data: { ...place, taskId: task.id, origin: "new", state: "ended", outcome: "with_changes", endedAt: new Date(), boxId: box.id } });
  return { taskId: task.id, sessionId: session.id };
};

/** Stores the events in order, each turn's row as core's ingest makes it, and returns the turns' row IDs by their event turn ID. */
const store = async (taskId: string, sessionId: string, events: readonly Timed[]): Promise<ReadonlyMap<string, string>> => {
  const turns = new Map<string, string>();
  // After what the server appended already (a refine task's saved draft is an event of its own).
  let seq = (await db.task.findUniqueOrThrow({ where: { id: taskId }, select: { eventSeq: true } })).eventSeq;
  for (const { at, event } of events) {
    seq += 1;
    await db.event.create({ data: { ...place, taskId, seq, sessionId, sessionSeq: event.kind === "user.message" ? null : seq, leaseEpoch: null, kind: event.kind, payload: event, occurredAt: new Date(at) } });
    if (event.kind === "turn.started") {
      const row = await db.turn.create({ data: { ...place, taskId, sessionId, ordinal: turns.size + 1, startSeq: seq, startedAt: new Date(at) } });
      turns.set(event.turnId, row.id);
    }
  }
  await db.task.update({ where: { id: taskId }, data: { eventSeq: seq } });
  await db.session.update({ where: { id: sessionId }, data: { ingestedSeq: seq } });
  await db.$executeRaw`SELECT pg_notify(${notifyChannels.taskEvents}, ${JSON.stringify({ taskId, seq })})`;
  return turns;
};

const browser = { name: "Chromium", version: "131.0.6778.85" };

/** A picture: its blob, its `attachment.added`, and the row core would store, once the turns are in. */
type Picture = {
  readonly attachmentId: string;
  readonly kind: "screenshot" | "recording";
  readonly source: "agent" | "after-turn";
  readonly blobId: string;
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly durationMs: number | null;
  readonly frameCount: number | null;
  readonly caption: string | null;
  readonly turnId: string;
  readonly at: number;
};

const pictureEvent = (picture: Picture): Timed => ({
  at: picture.at,
  event: taskEventSchema.parse({
    kind: "attachment.added",
    attachmentId: picture.attachmentId,
    attachmentKind: picture.kind,
    blobId: picture.blobId,
    source: picture.source,
    target: { process: "web" },
    path: picture.path,
    width: picture.width,
    height: picture.height,
    durationMs: picture.durationMs,
    frameCount: picture.frameCount,
    caption: picture.caption,
    browser,
    memberId: null,
    requestId: null,
  }),
});

const storeRows = async (taskId: string, pictures: readonly Picture[], turns: ReadonlyMap<string, string>): Promise<void> => {
  for (const picture of pictures) {
    await db.taskAttachment.create({
      data: {
        ...place,
        taskId,
        attachmentId: picture.attachmentId,
        kind: picture.kind,
        blobId: picture.blobId,
        source: picture.source === "after-turn" ? "after_turn" : "agent",
        targetKind: "process",
        targetName: "web",
        path: picture.path,
        width: picture.width,
        height: picture.height,
        durationMs: picture.durationMs,
        frameCount: picture.frameCount,
        caption: picture.caption,
        browserName: browser.name,
        browserVersion: browser.version,
        turnId: turns.get(picture.turnId) ?? null,
        createdAt: new Date(picture.at),
      },
    });
  }
};

const read = async (file: string): Promise<Uint8Array> => new Uint8Array(await readFile(file));

// 1. The task whose turn took the pictures: "Add a history panel", its draft PR #486.
const history = await makeTask("Add a history panel", "code", "in_review");
await db.taskRepo.create({ data: { ...place, taskId: history.taskId, repoId: repo.id, branchName: "calc-192-history-panel", baseBranch: "main", state: "pr_open", headSha: "a".repeat(40), prNumber: 486, prUrl: "https://github.com/acme/calculator-web/pull/486", prTitle: "Add a history panel" } });
const t0 = Date.now() - 40 * 60_000;
const first = randomUUID();
const second = randomUUID();
const shot = async (n: string, file: string, at: number, turnId: string, source: Picture["source"], path = "/history"): Promise<Picture> => {
  const bytes = await read(file);
  const size = pngSize(bytes);
  return { attachmentId: `att-${n}-${args.tag}`, kind: "screenshot", source, blobId: await storeBlob(history.taskId, "app-screenshot", APP_SCREENSHOT_CONTENT_TYPE, bytes), path, width: size.width, height: size.height, durationMs: null, frameCount: null, caption: null, turnId, at };
};
const older = await shot("older", args.files.older, t0 + 60_000, first, "after-turn");
const desktop = await shot("desktop", args.files.desktop, t0 + 19 * 60_000, second, "agent");
const tablet = await shot("tablet", args.files.tablet, t0 + 19 * 60_000 + 4000, second, "agent");
const phone = await shot("phone", args.files.phone, t0 + 19 * 60_000 + 8000, second, "agent");
const frames = await Promise.all(args.files.frames.map(read));
const frameSize = { width: 1280, height: 800 };
const reel = encodeFrameReel({
  ...frameSize,
  durationMs: (frames.length - 1) * 400,
  steps: [
    { atMs: 0, step: { action: "goto", path: "/" } },
    { atMs: 400, step: { action: "fill", selector: "#amount", value: "1027.6 × 1.25" } },
    { atMs: 1200, step: { action: "click", target: { text: "Add" } } },
    { atMs: 2000, step: { action: "press", key: "F5" } },
  ],
  frames: frames.map((jpeg, index) => ({ atMs: index * 400, jpeg })),
});
const recording: Picture = {
  attachmentId: `att-rec-${args.tag}`,
  kind: "recording",
  source: "agent",
  blobId: await storeBlob(history.taskId, "app-recording", APP_RECORDING_CONTENT_TYPE, reel),
  path: "/",
  width: frameSize.width,
  height: frameSize.height,
  durationMs: (frames.length - 1) * 400,
  frameCount: frames.length,
  caption: "Add, reload, reuse a result",
  turnId: second,
  at: t0 + 20 * 60_000,
};
const apiLog = await storeBlob(history.taskId, "app-log", APP_LOG_CONTENT_TYPE, new TextEncoder().encode("> api@0.4.0 start:dev\n> node server.js\n\nError: listen EADDRINUSE: address already in use :::3001\n"));
/** The agent's call to a picture tool, around the picture's own event. */
const pictureCall = (picture: Picture, toolCallId: string, title: string): Timed[] => [
  { at: picture.at - 1000, event: taskEventSchema.parse({ kind: "tool.called", turnId: second, toolCallId, toolKind: "other", title, input: {} }) },
  pictureEvent(picture),
  { at: picture.at + 500, event: taskEventSchema.parse({ kind: "tool.completed", toolCallId, output: { text: `Saved as ${picture.attachmentId}` } }) },
];
const app = (at: number, name: string, port: number, state: string, extra: Record<string, unknown> = {}): Timed => ({
  at,
  event: taskEventSchema.parse({ kind: "app.process", name, port, state, exitCode: null, reason: null, logBlobId: null, ...extra }),
});
const at = (seconds: number): number => t0 + seconds * 1000;
const historyEvents: Timed[] = [
  { at: at(0), event: taskEventSchema.parse({ kind: "user.message", memberId: admin.id, clientMessageId: randomUUID(), text: "Add a history panel beside the calculator: the last 50 results, each reusable.", delivery: "immediate" }) },
  { at: at(2), event: taskEventSchema.parse({ kind: "turn.started", turnId: first }) },
  { at: at(30), event: taskEventSchema.parse({ kind: "agent.message", turnId: first, segmentId: "seg-1", text: "The panel lists the last 50 results." }) },
  { at: at(40), event: taskEventSchema.parse({ kind: "turn.ended", turnId: first, stopReason: "end_turn" }) },
  pictureEvent(older),
  { at: at(15 * 60), event: taskEventSchema.parse({ kind: "user.message", memberId: admin.id, clientMessageId: randomUUID(), text: "Check it at the three widths and record the round trip.", delivery: "immediate" }) },
  { at: at(15 * 60 + 2), event: taskEventSchema.parse({ kind: "turn.started", turnId: second }) },
  app(at(15 * 60 + 5), "api", 3001, "starting"),
  app(at(15 * 60 + 6), "api", 3001, "exited", { exitCode: 1, reason: "exited", logBlobId: apiLog }),
  app(at(15 * 60 + 20), "api", 3001, "starting"),
  app(at(15 * 60 + 23), "api", 3001, "ready"),
  app(at(15 * 60 + 24), "web", 5173, "starting"),
  app(at(15 * 60 + 30), "web", 5173, "ready"),
  { at: at(15 * 60 + 31), event: taskEventSchema.parse({ kind: "app.browser", browser: { available: true, ...browser } }) },
  { at: at(15 * 60 + 40), event: taskEventSchema.parse({ kind: "agent.message", turnId: second, segmentId: "seg-2", text: "The panel works. I checked it at the three widths calculator's environment names, and recorded the round trip: add, reload, reuse a result." }) },
  { at: at(15 * 60 + 50), event: taskEventSchema.parse({ kind: "tool.called", turnId: second, toolCallId: "edit-1", toolKind: "edit", title: "edit", input: { paths: ["src/history/panel.css"] } }) },
  { at: at(15 * 60 + 51), event: taskEventSchema.parse({ kind: "tool.completed", toolCallId: "edit-1", output: { files: [{ path: "src/history/panel.css", added: 22, removed: 4 }] } }) },
  ...pictureCall(desktop, "shot-1", "ostra_take_screenshot"),
  ...pictureCall(tablet, "shot-2", "ostra_take_screenshot"),
  ...pictureCall(phone, "shot-3", "ostra_take_screenshot"),
  ...pictureCall(recording, "rec-1", "ostra_record_app"),
  { at: recording.at + 2000, event: taskEventSchema.parse({ kind: "turn.ended", turnId: second, stopReason: "end_turn" }) },
  // The box stopped since: the processes with it, and the session.
  app(recording.at + 60_000, "web", 5173, "stopped", { reason: "box-stopped" }),
  app(recording.at + 60_000, "api", 3001, "stopped", { reason: "box-stopped" }),
  { at: recording.at + 61_000, event: taskEventSchema.parse({ kind: "session.ended", outcome: "with-changes", repos: [] }) },
];
const historyTurns = await store(history.taskId, history.sessionId, [...historyEvents].sort((a, b) => a.at - b.at));
await storeRows(history.taskId, [older, desktop, tablet, phone, recording], historyTurns);

// 2. A port another task's agent announced, kept by Sam Rivera: a proposal waiting on an admin.
// Its task waits on the proposal its member made, as "Keep it" leaves it.
const storybook = await makeTask("Add a storybook", "code", "needs_you", "environment_proposal");
const taskPreview = await db.taskPreview.create({ data: { ...place, taskId: storybook.taskId, key: "port-6006", port: 6006, label: "Storybook" } });
const body = environmentProposalSchema.parse({
  repos: [{ repoId: repo.id, setupScript: "pnpm install --frozen-lockfile", checks: [], variableNames: [] }],
  services: [
    { name: "mailpit", image: "axllent/mailpit:1.21", port: 8025, healthCheck: null, variableNames: [], preview: { label: "Mail" } },
    { name: "db", image: "postgres:17", port: 5432, healthCheck: null, variableNames: [], preview: null },
    { name: "redis", image: "redis:7", port: 6379, healthCheck: null, variableNames: [], preview: null },
  ],
  notes: "Kept from a task: the agent announced port 6006.",
  appProcesses: [{ name: "storybook", repoId: repo.id, folder: ".", command: KEPT_COMMAND_PLACEHOLDER, port: 6006, ready: { kind: "port" }, label: "Storybook", primary: false, hostRewrite: true }],
});
const kept = await db.environmentProposal.create({ data: { ...place, environmentId: environment.id, taskId: storybook.taskId, body, notes: body.notes, state: "proposed", source: "kept", createdAt: new Date(Date.now() - 20 * 60_000) } });
await db.taskPreview.update({ where: { id: taskPreview.id }, data: { keptProposalId: kept.id } });
await db.$transaction((tx) => recordAudit(tx, { organizationId: organizationIdSchema.parse(organizationId), projectId: projectIdSchema.parse(project.id), actor: { kind: "member", id: keeper.seeded.memberId }, actorName: "Sam Rivera", action: "environment.app-process-kept", entity: "environment", entityId: environmentIdSchema.parse(environment.id), data: { proposalId: kept.id, taskId: storybook.taskId, port: 6006, name: "storybook" } }));

// 3. A refine task with a draft, and a screenshot of its own box.
const refine = await makeTask("Refine: show the app's version", "refine", "needs_you", "draft_ready");
await db.$transaction((tx) =>
  saveDraft(
    { tx, notices: postgresChangeNotices, clock: systemClock, jobs: { enqueueInTx: () => Promise.resolve() }, audit: { recordInTx: () => Promise.resolve() } },
    {
      organizationId: organizationIdSchema.parse(organizationId),
      taskId: taskIdSchema.parse(refine.taskId),
      draft: { description: "Show the app's version in the footer.", acceptanceCriteria: ["The footer shows the version"], edgeCases: [], openQuestions: [], subTickets: [] },
    },
  ),
);
const refineTurn = randomUUID();
const refineBytes = await read(args.files.refine);
const refineSize = pngSize(refineBytes);
const refineShot: Picture = {
  attachmentId: `att-refine-${args.tag}`,
  kind: "screenshot",
  source: "agent",
  blobId: await storeBlob(refine.taskId, "app-screenshot", APP_SCREENSHOT_CONTENT_TYPE, refineBytes),
  path: "/",
  width: refineSize.width,
  height: refineSize.height,
  durationMs: null,
  frameCount: null,
  caption: "The footer as it is now.",
  turnId: refineTurn,
  at: Date.now() - 5 * 60_000,
};
const refineTurns = await store(refine.taskId, refine.sessionId, [
  { at: refineShot.at - 60_000, event: taskEventSchema.parse({ kind: "user.message", memberId: admin.id, clientMessageId: randomUUID(), text: "Draft the version ticket.", delivery: "immediate" }) },
  { at: refineShot.at - 50_000, event: taskEventSchema.parse({ kind: "turn.started", turnId: refineTurn }) },
  pictureEvent(refineShot),
  { at: refineShot.at + 5000, event: taskEventSchema.parse({ kind: "turn.ended", turnId: refineTurn, stopReason: "end_turn" }) },
]);
await storeRows(refine.taskId, [refineShot], refineTurns);

process.stdout.write(
  `${JSON.stringify({
    username,
    projectId: project.id,
    historyTaskId: history.taskId,
    refineTaskId: refine.taskId,
    keptProposalId: kept.id,
    pictures: { desktop: desktop.attachmentId, tablet: tablet.attachmentId, phone: phone.attachmentId, recording: recording.attachmentId, older: older.attachmentId, refine: refineShot.attachmentId },
  })}\n`,
);
await db.$disconnect();
