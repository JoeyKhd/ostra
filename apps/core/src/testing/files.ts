import type { Logger } from "@ostra/adapter-sdk";
import type { FileSettings } from "@ostra/domain";

import { createDocumentTextReader } from "../files/text/index.ts";
import type { DocumentTextReader } from "../files/text/index.ts";

// Milestone 9's file settings and text reader for core's tests (spec section 9: a pool of one
// worker with a short timeout, so a test's documents read fast).

const MiB = 1024 * 1024;

/** The settings' defaults (spec section 5.6): 10 files of 10 MiB and 25 MiB a message, a ticket's 20 of 10 MiB and 50 MiB, text read. */
export const testFileSettings: FileSettings = {
  messageFilesMax: 10,
  messageFileMaxBytes: 10 * MiB,
  messageFilesTotalBytes: 25 * MiB,
  ticketFilesMax: 20,
  ticketFileMaxBytes: 10 * MiB,
  ticketFilesTotalBytes: 50 * MiB,
  textExtraction: true,
};

/** Core's text reader on one worker; close it after the file's tests. */
export const testTextReader = (logger: Logger, extraction = true): DocumentTextReader =>
  createDocumentTextReader({ extraction, logger, pool: { workers: 1, fileTimeoutMs: 10_000 } });

/** A reader for tests whose tickets hold no document: it reads nothing. */
export const noTextReader: Pick<DocumentTextReader, "read"> = { read: () => Promise.resolve({ state: "off" }) };
