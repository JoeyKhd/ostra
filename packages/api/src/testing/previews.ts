import { createHash, randomUUID } from "node:crypto";

import { APP_RECORDING_CONTENT_TYPE, APP_SCREENSHOT_CONTENT_TYPE, attachmentIdSchema, blobIdSchema, boxIdSchema, previewKeySchema } from "@ostra/protocol";
import type { AttachmentId, BlobId, BoxId, OrganizationId, PreviewKey, ProjectId, RunnerId, TaskId } from "@ostra/protocol";

import type { ApiHarness } from "./harness.ts";
import { seedPersonalRunner, seedTask } from "./world.ts";
import type { SeededTask } from "./world.ts";

// Milestone 8 (ticket 20): a task whose box can show a preview, as core leaves one once the runner
// took it: the environment's primary app process, a personal runner at protocol minor 7 that says
// it can show the browser view and the tunnel, a `ready` box on `host`, an active lease the runner
// accepted, and the task's session in that box.

export type PreviewableTask = SeededTask & {
  readonly boxId: BoxId;
  readonly runnerId: RunnerId;
  /** The primary app process's preview. */
  readonly key: PreviewKey;
};

let runners = 0;

export const seedPreviewableTask = async (
  harness: ApiHarness,
  input: {
    readonly organizationId: OrganizationId;
    readonly projectId: ProjectId;
    /** Whose personal runner holds the box. */
    readonly ownerMemberId: string;
    readonly driverMemberId?: string;
    /** The runner's protocol minor: 7 by default. */
    readonly minor?: number;
  },
): Promise<PreviewableTask> => {
  const db = harness.test.db;
  const { organizationId, projectId } = input;
  const environment = await db.environment.upsert({ where: { projectId }, create: { organizationId, projectId }, update: {}, select: { id: true } });
  // The project's primary app process, or a frontend made for it.
  let primary = await db.appProcess.findFirst({ where: { environmentId: environment.id, primary: true }, select: { name: true } });
  if (primary === null) {
    const repo = await db.repo.findFirstOrThrow({ where: { projectId, organizationId }, select: { id: true } });
    primary = await db.appProcess.create({
      data: { organizationId, projectId, environmentId: environment.id, repoId: repo.id, name: "web", command: "pnpm dev", port: 5173, readyKind: "http", readyValue: "/", label: "Web", primary: true },
      select: { name: true },
    });
  }
  runners += 1;
  const runnerId = await seedPersonalRunner(harness, input.ownerMemberId, `preview-runner-${String(runners)}-${String(Date.now())}`);
  await db.runner.update({ where: { id: runnerId }, data: { minor: input.minor ?? 7, preview: { stream: true, tunnel: true } } });
  const task = await seedTask(harness, { organizationId, projectId, state: "running", driverMemberId: input.driverMemberId ?? input.ownerMemberId, creatorMemberId: input.driverMemberId ?? input.ownerMemberId });
  const box = await db.box.create({ data: { organizationId, projectId, taskId: task.taskId, runnerId, executor: "host", state: "ready" }, select: { id: true } });
  await db.lease.create({ data: { organizationId, projectId, taskId: task.taskId, epoch: 1, runnerId, boxId: box.id, state: "active", acceptedAt: new Date() } });
  await db.session.update({ where: { id: task.sessionId }, data: { boxId: box.id } });
  await db.task.update({ where: { id: task.taskId }, data: { leaseEpoch: 1 } });
  return { ...task, boxId: boxIdSchema.parse(box.id), runnerId, key: previewKeySchema.parse(`app-${primary.name}`) };
};

// ---------- milestone 8, ticket 16: what core's ingest leaves of a task's app ----------

let attachments = 0;

/** A PNG's first bytes, then filler: what a screenshot's blob holds here. */
export const pngBytes = (size = 64): Uint8Array => {
  const bytes = new Uint8Array(size).fill(7);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
};

export type SeededAttachment = { readonly attachmentId: AttachmentId; readonly blobId: BlobId };

/**
 * A screenshot or a recording of a task, as core's ingest stores one from `attachment.added`: its
 * blob in the built-in store with its bytes (purpose and type of its kind), and its row.
 */
export const seedAttachment = async (
  harness: ApiHarness,
  task: { readonly taskId: TaskId; readonly organizationId: OrganizationId; readonly projectId: ProjectId },
  input: {
    readonly kind?: "screenshot" | "recording";
    readonly caption?: string | null;
    readonly turnId?: string | null;
    readonly memberId?: string | null;
    readonly bytes?: Uint8Array;
    /** The type the blob was stored with: its kind's, unless a test says otherwise. */
    readonly contentType?: string;
  } = {},
): Promise<SeededAttachment> => {
  const db = harness.test.db;
  const kind = input.kind ?? "screenshot";
  const bytes = input.bytes ?? pngBytes();
  attachments += 1;
  const attachmentId = attachmentIdSchema.parse(`att-${String(attachments)}-${randomUUID().slice(0, 8)}`);
  const blob = await db.blob.create({
    data: {
      organizationId: task.organizationId,
      projectId: task.projectId,
      taskId: task.taskId,
      store: "postgres",
      key: `app-${randomUUID()}`,
      purpose: kind === "screenshot" ? "app-screenshot" : "app-recording",
      contentType: input.contentType ?? (kind === "screenshot" ? APP_SCREENSHOT_CONTENT_TYPE : APP_RECORDING_CONTENT_TYPE),
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    select: { id: true },
  });
  await db.blobChunk.create({ data: { organizationId: task.organizationId, blobId: blob.id, ordinal: 0, offset: 0, bytes: Buffer.from(bytes) } });
  const member = input.memberId ?? null;
  await db.taskAttachment.create({
    data: {
      organizationId: task.organizationId,
      projectId: task.projectId,
      taskId: task.taskId,
      attachmentId,
      kind,
      blobId: blob.id,
      source: member === null ? "agent" : "member",
      targetKind: "process",
      targetName: "web",
      path: "/",
      width: 1440,
      height: 900,
      durationMs: kind === "recording" ? 4_000 : null,
      frameCount: kind === "recording" ? 40 : null,
      caption: input.caption ?? null,
      browserName: "Chromium",
      browserVersion: "131.0.6778.85",
      turnId: member === null ? (input.turnId ?? null) : null,
      memberId: member,
    },
  });
  return { attachmentId, blobId: blobIdSchema.parse(blob.id) };
};

/** A port the agent announced in a task with `show_preview`, as `preview.list` leaves it. */
export const seedAnnouncedPreview = async (
  harness: ApiHarness,
  task: { readonly taskId: TaskId; readonly organizationId: OrganizationId; readonly projectId: ProjectId },
  input: { readonly port: number; readonly label: string },
): Promise<PreviewKey> => {
  const key = previewKeySchema.parse(`port-${String(input.port)}`);
  await harness.test.db.taskPreview.create({ data: { organizationId: task.organizationId, projectId: task.projectId, taskId: task.taskId, key, port: input.port, label: input.label } });
  return key;
};
