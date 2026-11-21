import type { MessageFileId, UserMessageFile } from "@ostra/protocol";

import type { MessageFileView } from "./ui-types.ts";

// A message's files as the thread draws them (F-148, F-150, ADR 0070, ticket 14). Pure: the fold
// and the panel's API (`tasks.files`, `tasks.ticketContext`) make every file's view here, so the
// thread, the Attachments group and "What the agent got" name the same route and the same facts.

/**
 * Where a message's file downloads: the web app's route, which checks the caller may open the
 * task and serves the file as an attachment (ADR 0070, section "Storage, serving and safety").
 */
export const messageFileDownloadPath = (taskId: string, fileId: string): string => `/api/tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(fileId)}`;

/**
 * A message's file as the thread draws it: what its `user.message` recorded, its download (`null`
 * when `gone`, its blob removed), and its text's words or reason (`null` when the message didn't
 * record them).
 */
export const messageFileViewOf = (taskId: string, file: UserMessageFile, gone: boolean): MessageFileView => {
  const { textWords, textReason, ...recorded } = file;
  return { ...recorded, downloadPath: gone ? null : messageFileDownloadPath(taskId, file.fileId), textWords: textWords ?? null, textReason: textReason ?? null };
};

/** The files whose blobs are gone, by ID (`FoldOptions.removedFiles`): none, by default. */
export const noRemovedFiles: ReadonlySet<MessageFileId> = new Set();

/** The query parameter of the task page that opens a message's file in the viewer (as `?attachment=` opens a capture). */
export const MESSAGE_FILE_LINK_PARAM = "file";

/** A link to a message's file, for the viewer's Copy link: the task page, opening the file (`/tasks/<taskId>?file=<fileId>`). */
export const messageFileLinkPath = (taskId: string, fileId: string): string => `/tasks/${encodeURIComponent(taskId)}?${MESSAGE_FILE_LINK_PARAM}=${encodeURIComponent(fileId)}`;
