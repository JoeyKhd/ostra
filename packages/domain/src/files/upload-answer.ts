import { fileTextFailureReasonSchema, fileTextStateSchema, messageFileIdSchema, messageFileKindSchema, safeFileNameSchema } from "@ostra/protocol";
import { z } from "zod";

// A member's upload as the message box sends it and reads the answer (F-148, ADR 0070, Q338,
// ticket 14): the web app's route, `POST /api/projects/<projectId>/files`, takes one file a request
// as `FormData` (`file`, and `taskId` on a task's page), checks the member, the project, the task
// and the limits, and hands the bytes to core's `POST /panel/v1/files`; it answers core's view of
// the stored file, or a refusal's code and words. Client-safe (zod and the protocol only), so the
// box's uploader parses the answer with the schema the server answers with
// (`@ostra/domain/file-uploads`). A file's name is the member's: never logged.

/** The form's field that holds the file. */
export const MESSAGE_FILE_FORM_FIELD = "file";

/** The form's field that names the task a file is for, on a task's page; missing on the new-task box. */
export const MESSAGE_FILE_TASK_FIELD = "taskId";

/** Where the message box uploads a file for a project: the web app's route. */
export const messageFileUploadPath = (projectId: string): string => `/api/projects/${encodeURIComponent(projectId)}/files`;

/**
 * What an upload answers when core stored it: the file as the tray shows it (its ID, safe name,
 * kind and detected type, size) and its text's state (`none`, `off`, `ready` with its words,
 * `failed` with the reader's reason). Core's `POST /panel/v1/files` answers the same.
 */
export const recordedUploadSchema = z.strictObject({
  fileId: messageFileIdSchema,
  name: safeFileNameSchema,
  kind: messageFileKindSchema,
  contentType: z.string().min(1).max(255),
  size: z.number().int().min(1),
  text: z.strictObject({
    state: fileTextStateSchema,
    reason: fileTextFailureReasonSchema.nullable(),
    words: z.number().int().nonnegative().nullable(),
  }),
});
export type RecordedUpload = z.infer<typeof recordedUploadSchema>;

/**
 * Why the route refused an upload, each a code the box words (ticket 15):
 * - `unauthorized`: not signed in; `forbidden`: the member may not send on the task, or the request
 *   didn't come from the panel's own pages;
 * - `not-found`: no such project or task for the member (another organization's, a restricted
 *   project's and an unknown one alike);
 * - `not-a-form`: the body isn't `multipart/form-data`; `no-file`: the form holds no file;
 * - `empty`: a file of no bytes; `too-large`: over `OSTRA_MESSAGE_FILE_MAX_MIB`, refused before
 *   core is asked (a declared `content-length` over it at once);
 * - `too-many-unsent`: the member holds as many unsent uploads in the project as they may;
 * - `bad-request`: a body that didn't arrive whole, or a name core couldn't read;
 * - `unavailable`: core, or its blob store, didn't take it: try again.
 */
export const uploadRefusalCodes = ["unauthorized", "forbidden", "not-found", "not-a-form", "no-file", "empty", "too-large", "too-many-unsent", "bad-request", "unavailable"] as const;
export type UploadRefusalCode = (typeof uploadRefusalCodes)[number];

/** A refused upload: its code and words for a person, never the file's name or content. */
export const uploadRefusalSchema = z.strictObject({ error: z.strictObject({ code: z.enum(uploadRefusalCodes), message: z.string().max(2000) }) });
export type UploadRefusal = z.infer<typeof uploadRefusalSchema>;
