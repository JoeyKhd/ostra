import { MESSAGE_FILE_FORM_FIELD, MESSAGE_FILE_TASK_FIELD, requireProjectAccess, unsentUploadsMax, unsentUploadsOfInTx } from "@ostra/domain";
import type { PanelFileErrorCode, UploadRefusal, UploadRefusalCode } from "@ostra/domain";
import { organizationIdSchema, projectIdSchema, taskIdSchema } from "@ostra/protocol";

import { waitsForReopen } from "../routers/task-reopen-state.ts";
import { PASSWORD_CHANGE_REQUIRED } from "../trpc/init.ts";
import type { Context } from "../trpc/context.ts";
import { fromPanelOrigin } from "./panel-origin.ts";

// A member's upload from the message box (F-148, ADR 0070, Q338, ticket 14):
// `POST /api/projects/<projectId>/files`, one file a request, as `FormData` (`file`, and `taskId`
// on a task's page). The web app checks, in order: a signed-in member who can open the project
// (another organization's, a restricted one's and an unknown one are the same 404), from the
// panel's own pages; with a task, one of the project's, that the member may send on (its driver,
// or anyone when it waits for a reopen, which takes the reopen's sender's files); the size against
// `OSTRA_MESSAGE_FILE_MAX_MIB` before reading on (a declared `content-length` over it at once);
// and the member's unsent uploads in the project. Then it hands the bytes to core
// (`MessageFileUploader`: the SHA-256 and the file token), and answers core's view of the stored
// file, or a refusal's code and words (`uploadRefusalSchema`). The bytes are the member's data:
// never read here as anything, never logged; nor is the file's name.

const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } as const;

/** Each refusal's HTTP status. */
const statusOf = {
  unauthorized: 401,
  forbidden: 403,
  "not-found": 404,
  "not-a-form": 415,
  "no-file": 400,
  empty: 400,
  "too-large": 413,
  "too-many-unsent": 409,
  "bad-request": 400,
  unavailable: 503,
} as const satisfies Record<UploadRefusalCode, number>;

const refuse = (code: UploadRefusalCode, message: string): Response => {
  const body: UploadRefusal = { error: { code, message } };
  return Response.json(body, { status: statusOf[code], headers: jsonHeaders });
};

/**
 * What a form adds to a file's bytes, at most: its boundaries, each part's headers (the file's
 * name among them) and the task's ID. A request declaring more than one file's limit and this is
 * refused before a byte is read. A working value.
 */
export const UPLOAD_FORM_OVERHEAD_BYTES = 64 * 1024;

const MiB = 1024 * 1024;

/** A limit in whole MiB, as the refusal says it. */
const mibText = (bytes: number): string => `${String(Math.floor(bytes / MiB))} MB`;

/** The request's body, up to `cap` bytes, or `null` when it is longer: it stops reading at the cap. */
const readCapped = async (request: Request, cap: number): Promise<Uint8Array<ArrayBuffer> | null> => {
  if (request.body === null) {
    return new Uint8Array();
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) {
      break;
    }
    // A request body's chunks are bytes; anything else is no file.
    const value: unknown = part.value;
    if (!(value instanceof Uint8Array)) {
      await reader.cancel();
      return null;
    }
    size += value.length;
    if (size > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
};

/** How a refusal of core's reads to the member: what they can do about it, or that ostra couldn't take it now. */
const coreRefusal = (code: PanelFileErrorCode, message: string): Response => {
  switch (code) {
    case "empty":
      return refuse("empty", "The file is empty");
    case "too-large":
      return refuse("too-large", "The file is over the limit for one file");
    case "too-many-unsent":
      return refuse("too-many-unsent", message);
    case "not-found":
      return refuse("not-found", "No such project");
    case "bad-request":
      return refuse("bad-request", "The file didn't arrive whole: try again");
    // The token, the size or the digest didn't match what the panel made: ostra's own fault, not the member's.
    case "unauthorized":
    case "size-mismatch":
    case "digest-mismatch":
    case "unavailable":
      return refuse("unavailable", "ostra couldn't store the file just now: try again");
    default:
      return code satisfies never;
  }
};

export const serveMessageFileUpload = async (ctx: Context, request: Request, projectIdText: string): Promise<Response> => {
  if (ctx.user === null) {
    return refuse("unauthorized", "Sign in first");
  }
  if (ctx.member === null) {
    return refuse("forbidden", "This account belongs to no organization");
  }
  if (ctx.user.mustChangePassword && !ctx.deps.settings.allowDefaultPassword) {
    return refuse("forbidden", PASSWORD_CHANGE_REQUIRED);
  }
  // From the panel's own pages only (milestone 8's ticket 25): a preview host's page sends nothing with the member's cookie.
  if (!fromPanelOrigin(request, ctx.deps.settings.publicUrl)) {
    return refuse("forbidden", "A change to ostra must come from ostra's own pages.");
  }
  const scope = ctx.member.scope;
  const { db, settings, logger } = ctx.deps;
  const projectId = projectIdSchema.safeParse(projectIdText);
  const project = projectId.success ? await db.project.findFirst({ where: { id: projectId.data, organizationId: scope.organizationId }, select: { id: true, access: true } }) : null;
  if (!projectId.success || project === null || !requireProjectAccess(scope, { id: projectId.data, organizationId: scope.organizationId, access: project.access }, "read").ok) {
    return refuse("not-found", "No such project");
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";")[0]?.trim().toLowerCase() !== "multipart/form-data") {
    return refuse("not-a-form", "Send the file as multipart/form-data");
  }
  // One file's limit, before a byte is read: a declared length over it is refused at once.
  const maxFileBytes = settings.files.messageFileMaxBytes;
  const tooLarge = (): Response => refuse("too-large", `The file is over ${mibText(maxFileBytes)}, the limit for one file`);
  const cap = maxFileBytes + UPLOAD_FORM_OVERHEAD_BYTES;
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > cap) {
    return tooLarge();
  }
  const body = await readCapped(request, cap);
  if (body === null) {
    return tooLarge();
  }
  let form: FormData;
  try {
    // The platform's parser reads a whole body into memory, which is why its types advise a
    // streaming one for servers: this body is already read, capped at one file and the form's overhead.
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- bounded above; no new dependency for one file a request
    form = await new Response(body, { headers: { "content-type": contentType } }).formData();
  } catch {
    return refuse("bad-request", "The form didn't read: send one file as multipart/form-data");
  }
  const file = form.get(MESSAGE_FILE_FORM_FIELD);
  if (!(file instanceof File)) {
    return refuse("no-file", "The form holds no file");
  }
  if (file.size > maxFileBytes) {
    return tooLarge();
  }
  if (file.size === 0) {
    return refuse("empty", "The file is empty");
  }
  const who = { organizationId: organizationIdSchema.parse(scope.organizationId), projectId: projectId.data, memberId: scope.memberId };
  // With a task: one of the project's, which the member may send on.
  const taskField = form.get(MESSAGE_FILE_TASK_FIELD);
  if (taskField !== null) {
    const taskId = typeof taskField === "string" ? taskIdSchema.safeParse(taskField) : null;
    const task =
      taskId?.success === true
        ? await db.task.findFirst({
            where: { id: taskId.data, organizationId: scope.organizationId, projectId: projectId.data },
            select: {
              driverMemberId: true,
              state: true,
              needsYouReason: true,
              repos: { where: { state: "merged" }, select: { id: true }, take: 1 },
              sessions: { orderBy: { startedAt: "desc" }, take: 1, select: { state: true } },
            },
          })
        : null;
    if (task === null) {
      return refuse("not-found", "No such task");
    }
    const reopens = waitsForReopen({ state: task.state, needsYouReason: task.needsYouReason, mergedRepo: task.repos.length > 0, sessionState: task.sessions[0]?.state ?? null });
    if (task.driverMemberId !== scope.memberId && !reopens) {
      return refuse("forbidden", "Only the driver can send files to this task. Take over first");
    }
  }
  const unsentCap = unsentUploadsMax({ maxFiles: settings.files.messageFilesMax });
  if ((await unsentUploadsOfInTx(db, who)) >= unsentCap) {
    return refuse("too-many-unsent", `You have ${String(unsentCap)} files waiting to be sent in this project: send or remove some first`);
  }
  const uploaded = await ctx.deps.fileUploader({ ...who, name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
  switch (uploaded.kind) {
    case "stored":
      return Response.json(uploaded.file, { status: 200, headers: jsonHeaders });
    case "refused":
      if (statusOfCore(uploaded.code) === "ours") {
        logger.warn("message-file.core-refused", { organizationId: who.organizationId, projectId: who.projectId, code: uploaded.code });
      }
      return coreRefusal(uploaded.code, uploaded.message);
    case "unavailable":
      return refuse("unavailable", "ostra couldn't store the file just now: try again");
    default:
      return uploaded satisfies never;
  }
};

/** Whether a refusal of core's is the member's to fix, or ostra's own (a token, a size or a digest the panel made). */
const statusOfCore = (code: PanelFileErrorCode): "member" | "ours" =>
  code === "unauthorized" || code === "size-mismatch" || code === "digest-mismatch" ? "ours" : "member";
