import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "@ostra/adapter-sdk";
import { CI_FILES_DIR, runnerLimits, TICKET_FILES_DIR, ticketFileNameFor } from "@ostra/protocol";
import type { BlobId, LeaseEpoch, TaskId, TaskSpecContextFile, TicketFileSkipReason } from "@ostra/protocol";
import { sha256Of } from "../server/bulk.ts";
import type { ServerLink } from "./server-link.ts";

// The ticket's files in the workspace (F-064, ticket 26, spec section 11, item 9). Before the agent
// starts, each of the spec's `contextFiles` is downloaded through the bulk path (core fetched it
// from the tracker with the connection's token, so that token never reaches the box), checked
// against its size and digest, and written under `.ostra/ticket/` in the folder the agent's session
// opens on, so the prompt's relative path finds it. The name is made from the blob ID and the
// content type (`ticketFileNameFor`), never from the ticket's text, and only images and PDFs are
// written. Every repo's git excludes `.ostra/` (the executor writes the rule when it prepares the
// checkout), so the files never land in a commit or the hidden ref. A file that fails is skipped
// and named; the turn starts anyway. Nothing of a file's content, or its name in the tracker, is
// ever logged.

export type WrittenTicketFile = { readonly path: string; readonly blobId: BlobId };
export type SkippedTicketFile = { readonly blobId: BlobId; readonly reason: TicketFileSkipReason };

export type TicketFiles = { readonly files: readonly WrittenTicketFile[]; readonly skipped: readonly SkippedTicketFile[] };

export type WriteTicketFilesInput = {
  readonly link: Pick<ServerLink, "downloadBlob">;
  readonly taskId: TaskId;
  readonly leaseEpoch: LeaseEpoch;
  readonly files: readonly TaskSpecContextFile[];
  /** The folder the agent's session opens on: the files go in its `.ostra/ticket/`. */
  readonly sessionDir: string;
  readonly logger: Logger;
};

/** The ticket folder in the agent's session folder. */
export const ticketFilesDir = (sessionDir: string): string => path.join(sessionDir, ...TICKET_FILES_DIR.split("/"));

/** `target` is a file directly inside `dir`. */
const directlyInside = (dir: string, target: string): boolean => path.dirname(path.resolve(target)) === path.resolve(dir);

export const writeTicketFiles = async (input: WriteTicketFilesInput): Promise<TicketFiles> => {
  const dir = ticketFilesDir(input.sessionDir);
  const files: WrittenTicketFile[] = [];
  const skipped: SkippedTicketFile[] = [];
  const names = new Set<string>();
  const skip = (blobId: BlobId, reason: TicketFileSkipReason): void => {
    skipped.push({ blobId, reason });
    input.logger.warn("a ticket file was skipped", { blobId, reason });
  };
  for (const file of input.files.slice(0, runnerLimits.ticketFilesMax)) {
    const name = ticketFileNameFor(file.blobId, file.contentType);
    if (name === null) {
      skip(file.blobId, "type-not-allowed");
      continue;
    }
    const target = path.join(dir, name);
    if (!directlyInside(dir, target) || names.has(name)) {
      skip(file.blobId, "write-failed");
      continue;
    }
    const downloaded = await input.link.downloadBlob({
      taskId: input.taskId,
      leaseEpoch: input.leaseEpoch,
      blobId: file.blobId,
      maxBytes: Math.min(file.size, runnerLimits.ticketFileMaxBytes),
    });
    if (!downloaded.ok) {
      skip(file.blobId, "download-failed");
      continue;
    }
    const { bytes, sha256 } = downloaded.value;
    // The size from the spec, and the digest core named for what it sent: a copy that differs is never written.
    if (bytes.length !== file.size || sha256 === null || sha256Of(bytes) !== sha256) {
      skip(file.blobId, "digest-mismatch");
      continue;
    }
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(target, bytes, { mode: 0o644, flag: "w" });
    } catch {
      skip(file.blobId, "write-failed");
      continue;
    }
    names.add(name);
    files.push({ path: name, blobId: file.blobId });
  }
  input.logger.info("ticket files written", { written: files.length, skipped: skipped.length });
  return { files, skipped };
};

// ---------- a CI round's log tails (milestone 6, F-035, ticket 23) ----------
//
// A CI round's failing checks' log tails travel as `ci` context files (protocol minor 5): core
// fetched each with the App's token, so no code host credential reaches the box (ADR 0030). Each is
// written as `<blobId>.log`, the name the round's prompt gives, under `.ostra/ci/` in the folder the
// agent's session opens on, beside the ticket's files: every repo's git excludes `.ostra/`, so a log
// never lands in a commit or the hidden ref. Only plain text, at most 5 files of 64 KiB, each
// checked against its size and digest. A log's text is never logged.

/** The CI folder in the agent's session folder. */
export const ciFilesDir = (sessionDir: string): string => path.join(sessionDir, ...CI_FILES_DIR.split("/"));

/** A CI log's name in `CI_FILES_DIR`: the spec's own, which core named after the blob (`<blobId>.log`). */
const CI_LOG_NAME = /^[A-Za-z0-9-]+\.log$/;

export const writeCiFiles = async (input: WriteTicketFilesInput): Promise<TicketFiles> => {
  const dir = ciFilesDir(input.sessionDir);
  const files: WrittenTicketFile[] = [];
  const skipped: SkippedTicketFile[] = [];
  const skip = (blobId: BlobId, reason: TicketFileSkipReason): void => {
    skipped.push({ blobId, reason });
    input.logger.warn("a CI log file was skipped", { blobId, reason });
  };
  for (const file of input.files.slice(0, runnerLimits.ciLogChecksMax)) {
    if (!CI_LOG_NAME.test(file.path) || file.contentType.split(";")[0]?.trim().toLowerCase() !== "text/plain") {
      skip(file.blobId, "type-not-allowed");
      continue;
    }
    const target = path.join(dir, file.path);
    if (!directlyInside(dir, target) || files.some((written) => written.path === file.path)) {
      skip(file.blobId, "write-failed");
      continue;
    }
    const downloaded = await input.link.downloadBlob({
      taskId: input.taskId,
      leaseEpoch: input.leaseEpoch,
      blobId: file.blobId,
      maxBytes: Math.min(file.size, runnerLimits.ciLogTailMaxBytes),
    });
    if (!downloaded.ok) {
      skip(file.blobId, "download-failed");
      continue;
    }
    const { bytes, sha256 } = downloaded.value;
    if (bytes.length !== file.size || sha256 === null || sha256Of(bytes) !== sha256) {
      skip(file.blobId, "digest-mismatch");
      continue;
    }
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(target, bytes, { mode: 0o644, flag: "w" });
    } catch {
      skip(file.blobId, "write-failed");
      continue;
    }
    files.push({ path: file.path, blobId: file.blobId });
  }
  input.logger.info("CI log files written", { written: files.length, skipped: skipped.length });
  return { files, skipped };
};
