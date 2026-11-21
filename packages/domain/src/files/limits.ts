import type { FileLeftOutReason } from "@ostra/protocol";

// A message's and a ticket's limits (ADR 0070, Q331, spec section 5.4): too big or too many is
// left out with a note, never a failure. Files are taken in their order; each one over the size of
// one file is `too-big`, one past the count is `too-many`, and one that would take the total past
// its limit is `total-too-big`. Pure: the box checks as a file arrives, the server again at send.

/** The limits one message's or one read of a ticket's files keep to. */
export type FileLimits = {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
};

/** A file the limits weigh: its size, or `null` for a ticket's file whose size the tracker didn't say. */
export type WeighedFile = { readonly name: string; readonly size: number | null };

/** What the limits keep, and what they leave out with why, each in the order given. */
export type FilesChecked<F> = {
  readonly kept: readonly F[];
  readonly leftOut: readonly { readonly file: F; readonly name: string; readonly reason: Extract<FileLeftOutReason, "too-big" | "too-many" | "total-too-big"> }[];
};

const checkFiles = <F extends WeighedFile>(files: readonly F[], limits: FileLimits): FilesChecked<F> => {
  const kept: F[] = [];
  const leftOut: FilesChecked<F>["leftOut"][number][] = [];
  let total = 0;
  for (const file of files) {
    const size = file.size ?? 0;
    if (size > limits.maxFileBytes) {
      leftOut.push({ file, name: file.name, reason: "too-big" });
    } else if (kept.length >= limits.maxFiles) {
      leftOut.push({ file, name: file.name, reason: "too-many" });
    } else if (total + size > limits.maxTotalBytes) {
      leftOut.push({ file, name: file.name, reason: "total-too-big" });
    } else {
      kept.push(file);
      total += size;
    }
  }
  return { kept, leftOut };
};

/** A message's files against its limits (`OSTRA_MESSAGE_FILES_MAX`, `_FILE_MAX_MIB`, `_FILES_TOTAL_MIB`). */
export const checkMessageFiles = <F extends { readonly name: string; readonly size: number }>(files: readonly F[], limits: FileLimits): FilesChecked<F> =>
  checkFiles(files, limits);

/**
 * A ticket's files against the ticket's limits (`OSTRA_TICKET_FILES_MAX`, `_FILE_MAX_MIB`,
 * `_FILES_TOTAL_MIB`). A file whose size the tracker didn't say counts toward the number, and its
 * download is held to what's left (`downloadFile`'s `maxBytes`), then checked again as it arrived.
 */
export const checkTicketFiles = <F extends WeighedFile>(files: readonly F[], limits: FileLimits): FilesChecked<F> => checkFiles(files, limits);

/** The limits of a message's files, from the settings. */
export const messageFileLimits = (files: { readonly messageFilesMax: number; readonly messageFileMaxBytes: number; readonly messageFilesTotalBytes: number }): FileLimits => ({
  maxFiles: files.messageFilesMax,
  maxFileBytes: files.messageFileMaxBytes,
  maxTotalBytes: files.messageFilesTotalBytes,
});

/** The limits of one read of a ticket's files, from the settings. */
export const ticketFileLimits = (files: { readonly ticketFilesMax: number; readonly ticketFileMaxBytes: number; readonly ticketFilesTotalBytes: number }): FileLimits => ({
  maxFiles: files.ticketFilesMax,
  maxFileBytes: files.ticketFileMaxBytes,
  maxTotalBytes: files.ticketFilesTotalBytes,
});
