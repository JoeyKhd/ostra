import type { DbEnum, Tx } from "@ostra/db";
import { APP_RECORDING_CONTENT_TYPE, APP_SCREENSHOT_CONTENT_TYPE, organizationIdSchema, previewTargetKind, projectIdSchema, runnerLimits } from "@ostra/protocol";
import type { AttachmentKind, AttachmentSource, BlobUploadPurpose, OrganizationId, PreviewListItem, PreviewTarget, ProjectId, TaskId } from "@ostra/protocol";

import type { Ports } from "../ports.ts";
import type { RecordAttachment } from "../use-cases/m8-preview-signatures.ts";

// A task's screenshots and recordings, and the ports its agent announced (milestone 8, F-121, F-140,
// ADR 0068; ticket 15). The runner's `attachment.added` becomes a `TaskAttachment`, once per
// `attachmentId`, only for a blob of the task's own of the attachment's purpose; its `preview.list`
// keeps the task's announced `TaskPreview` rows; and a PR ostra writes names how many there are,
// linking to the task, never to a blob. Captions are the agent's words: never logged.

/** The blob purpose each kind is uploaded under (ADR 0043). */
export const attachmentBlobPurposes = {
  screenshot: "app-screenshot",
  recording: "app-recording",
} as const satisfies Readonly<Record<AttachmentKind, BlobUploadPurpose>>;

/** The content type each kind's blob has. */
export const attachmentContentTypes = {
  screenshot: APP_SCREENSHOT_CONTENT_TYPE,
  recording: APP_RECORDING_CONTENT_TYPE,
} as const satisfies Readonly<Record<AttachmentKind, string>>;

/** The largest blob each kind may be (working values, `limits.ts`). */
export const attachmentMaxBytes = {
  screenshot: runnerLimits.screenshotMaxBytes,
  recording: runnerLimits.recordingMaxBytes,
} as const satisfies Readonly<Record<AttachmentKind, number>>;

const sourceToDb = {
  agent: "agent",
  "after-turn": "after_turn",
  member: "member",
} as const satisfies Readonly<Record<AttachmentSource, DbEnum.AttachmentSource>>;

/** The task an attachment is recorded for. */
export type AttachmentTask = { readonly id: TaskId; readonly organizationId: OrganizationId; readonly projectId: ProjectId };

/** What `recordAttachment` takes, beside the task: the runner's event, with the turn it was taken in. */
export type AttachmentInput = Omit<Parameters<RecordAttachment>[1], "taskId" | "turnId"> & {
  /** The turn's row ID; `null` for a member's screenshot from the pane. */
  readonly turnId: string | null;
};

export type RecordAttachmentResult =
  | { readonly ok: true; readonly stored: boolean }
  | {
      readonly ok: false;
      /**
       * `blob-not-the-task-s`: no such blob, another task's, or not of the kind's purpose, type or
       * size. `limit-reached`: the turn's 20th is its last. `invalid`: a recording without its
       * length, a member's without its member. `not-found`: the member isn't the organization's.
       */
      readonly error: "not-found" | "blob-not-the-task-s" | "limit-reached" | "invalid";
      readonly message: string;
    };

/** Where a target's columns go: a process's or a service's name, or a port. */
const targetColumns = (target: PreviewTarget): { readonly targetKind: DbEnum.PreviewTargetKind; readonly targetName: string | null; readonly port: number | null } => {
  if ("process" in target) {
    return { targetKind: "process", targetName: target.process, port: null };
  }
  if ("port" in target) {
    return { targetKind: "port", targetName: null, port: target.port };
  }
  return { targetKind: previewTargetKind(target), targetName: target.service, port: null };
};

/**
 * The runner's `attachment.added`, in the ingest's transaction (ticket 15): a `TaskAttachment` once
 * per task and `attachmentId`, so a replayed event stores nothing twice. Refused for a blob that
 * isn't this task's, or isn't of the kind's purpose, content type and size, and past the turn's
 * 20 attachments. The event itself stays in the log either way; the thread shows the rows.
 */
export const recordAttachmentInTx = async (
  deps: Pick<Ports, "notices">,
  tx: Tx,
  task: AttachmentTask,
  input: AttachmentInput,
): Promise<RecordAttachmentResult> => {
  const existing = await tx.taskAttachment.findUnique({ where: { taskId_attachmentId: { taskId: task.id, attachmentId: input.attachmentId } }, select: { id: true } });
  if (existing !== null) {
    return { ok: true, stored: false };
  }
  const blob = await tx.blob.findFirst({
    where: { id: input.blobId, organizationId: task.organizationId },
    select: { taskId: true, purpose: true, contentType: true, size: true },
  });
  if (blob?.taskId !== task.id) {
    return { ok: false, error: "blob-not-the-task-s", message: "The attachment's blob isn't one of this task's" };
  }
  if (blob.purpose !== attachmentBlobPurposes[input.kind] || blob.contentType !== attachmentContentTypes[input.kind] || blob.size > attachmentMaxBytes[input.kind]) {
    return { ok: false, error: "blob-not-the-task-s", message: `The attachment's blob isn't a ${input.kind} of this task's` };
  }
  const recording = input.kind === "recording";
  if (recording && (input.durationMs === null || input.frameCount === null)) {
    return { ok: false, error: "invalid", message: "A recording names its length and its frames" };
  }
  if (input.source === "member") {
    if (input.memberId === null) {
      return { ok: false, error: "invalid", message: "A member's screenshot names its member" };
    }
    const member = await tx.member.findFirst({ where: { id: input.memberId, organizationId: task.organizationId }, select: { id: true } });
    if (member === null) {
      return { ok: false, error: "not-found", message: "No such member" };
    }
  } else if (input.turnId !== null && (await tx.taskAttachment.count({ where: { taskId: task.id, turnId: input.turnId } })) >= runnerLimits.attachmentsPerTurnMax) {
    return { ok: false, error: "limit-reached", message: `A turn adds at most ${String(runnerLimits.attachmentsPerTurnMax)} screenshots and recordings` };
  }
  const created = await tx.taskAttachment.createMany({
    data: [
      {
        organizationId: task.organizationId,
        projectId: task.projectId,
        taskId: task.id,
        attachmentId: input.attachmentId,
        kind: input.kind,
        blobId: input.blobId,
        source: sourceToDb[input.source],
        ...targetColumns(input.target),
        path: input.path,
        width: input.width,
        height: input.height,
        durationMs: recording ? input.durationMs : null,
        frameCount: recording ? input.frameCount : null,
        caption: input.caption,
        browserName: input.browser.name,
        browserVersion: input.browser.version,
        turnId: input.source === "member" ? null : input.turnId,
        memberId: input.source === "member" ? input.memberId : null,
      },
    ],
    // Two batches racing for one attachment: the second stores nothing, as a replay doesn't.
    skipDuplicates: true,
  });
  if (created.count > 0) {
    await deps.notices.emitInTx(tx, { organizationId: task.organizationId, projectId: task.projectId, entity: "task", entityId: task.id });
  }
  return { ok: true, stored: created.count > 0 };
};

/** `RecordAttachment` (ticket 05's signature): the same, in a transaction of its own, with the task's latest turn. */
export const recordAttachment: RecordAttachment = (deps, input) =>
  deps.db.$transaction(async (tx): Promise<RecordAttachmentResult> => {
    const task = await tx.task.findUnique({ where: { id: input.taskId }, select: { id: true, organizationId: true, projectId: true } });
    if (task === null) {
      return { ok: false, error: "not-found", message: "No such task" };
    }
    return recordAttachmentInTx(
      deps,
      tx,
      { id: input.taskId, organizationId: organizationIdSchema.parse(task.organizationId), projectId: projectIdSchema.parse(task.projectId) },
      { ...input, turnId: input.turnId },
    );
  });

// ---------- the ports the agent announced (`preview.list`) ----------

/**
 * The runner's `preview.list`, in the ingest's transaction: the task's announced previews as its
 * `TaskPreview` rows. Each announced port in the list is kept (its label, path and primary as the
 * list says, its first turn as it was); one the list no longer has goes, unless a member kept it
 * ("Keep it"), whose proposal points at it. The declared ones are the environment's, not stored.
 * A fresh box's first list has none of the old box's ports: they ended with it.
 */
export const recordAnnouncedPreviewsInTx = async (
  deps: Pick<Ports, "notices">,
  tx: Tx,
  task: AttachmentTask,
  previews: readonly PreviewListItem[],
  turnId: string | null,
): Promise<{ readonly kept: number; readonly removed: number }> => {
  const announced = previews.filter((item) => item.source === "announced").slice(0, runnerLimits.announcedPreviewsMax);
  for (const item of announced) {
    await tx.taskPreview.upsert({
      where: { taskId_key: { taskId: task.id, key: item.key } },
      create: {
        organizationId: task.organizationId,
        projectId: task.projectId,
        taskId: task.id,
        key: item.key,
        port: item.port,
        label: item.label,
        path: item.path,
        primary: item.primary,
        announcedInTurnId: turnId,
      },
      update: { port: item.port, label: item.label, path: item.path, primary: item.primary },
    });
  }
  const removed = await tx.taskPreview.deleteMany({ where: { taskId: task.id, keptProposalId: null, key: { notIn: announced.map((item) => item.key) } } });
  await deps.notices.emitInTx(tx, { organizationId: task.organizationId, projectId: task.projectId, entity: "task", entityId: task.id });
  return { kept: announced.length, removed: removed.count };
};

// ---------- the PR's line (F-121) ----------

/** The task's attachments in the panel: the task's page, at its attachments. A sign-in is needed (ADR 0043). */
export const taskAttachmentsUrl = (taskUrl: string): string => `${taskUrl}#attachments`;

/**
 * The PR's line (ADR 0068): "Screenshots: N in ostra", linking to the task's attachments. GitHub has
 * no API to put an image in a PR body and ostra's blob links need a sign-in, so it never names a
 * blob. A recording counts as one. `null` when the task has none.
 */
export const screenshotsLine = (count: number, taskUrl: string): string | null =>
  count <= 0 ? null : `Screenshots: [${String(count)} in ostra](${taskAttachmentsUrl(taskUrl)})`;

/** Whether a line is the screenshots line ostra writes. */
const isScreenshotsLine = (line: string): boolean => /^Screenshots: \[\d+ in ostra\]\(\S+#attachments\)$/.test(line.trim());

/**
 * A PR's description with its screenshots line replaced, or added right after ostra's "Opened by"
 * line (at the end when that's gone), or removed (`line: null`). Everything else is kept as it is.
 */
export const withScreenshotsLine = (body: string, line: string | null): string => {
  const lines = body.split("\n");
  const at = lines.findIndex(isScreenshotsLine);
  if (at !== -1) {
    if (line === null) {
      lines.splice(at, 1);
    } else {
      lines[at] = line;
    }
    return lines.join("\n");
  }
  if (line === null) {
    return body;
  }
  const opened = lines.findIndex((one) => one.startsWith("Opened by [ostra]("));
  if (opened === -1) {
    return `${body.replace(/\n+$/, "")}\n\n${line}\n`;
  }
  lines.splice(opened + 1, 0, line);
  return lines.join("\n");
};

/** The task's attachments, for its PR's line. */
export const taskAttachmentCount = (db: Pick<Tx, "taskAttachment">, taskId: TaskId): Promise<number> => db.taskAttachment.count({ where: { taskId } });
