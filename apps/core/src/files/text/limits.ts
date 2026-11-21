import { runnerLimits } from "@ostra/protocol";

// The text out of documents (F-150, ADR 0070, Q334): every limit of the reader and its worker pool,
// in one place. Each is a working value (spec section 5.5): a measure under load may move it.

const MiB = 1024 * 1024;

/** What one read of a document may take: the zip's caps and the text's. Sent to the worker with each file. */
export type TextReadLimits = {
  /** The most entries an Office file's zip may hold, counted before anything is inflated. */
  readonly zipEntriesMax: number;
  /** The most bytes the parts read may inflate to, all together, by their declared sizes. */
  readonly zipInflatedBytesMax: number;
  /** A document's text beside it, all of it: ostra's first line and the cut's last line included. */
  readonly textMaxBytes: number;
};

/** The worker pool's limits. */
export type TextPoolLimits = {
  /** Workers in each core process. */
  readonly workers: number;
  /** Each worker's heap, in MiB: past it, the worker is stopped and the file refused as `too-big`. */
  readonly heapMiB: number;
  /** How long one file may take, from the moment a worker takes it; past it, `timeout`. */
  readonly fileTimeoutMs: number;
  /** How long a file may wait for a free worker; past it, `busy`. */
  readonly waitMs: number;
};

/** The reader's working values (spec section 5.5). */
export const textReadLimits: TextReadLimits = {
  zipEntriesMax: 2_000,
  zipInflatedBytesMax: 100 * MiB,
  textMaxBytes: runnerLimits.fileTextMaxBytes,
};

/** The pool's working values (spec section 5.5): two workers of 256 MiB, 30 s a file, 30 s of waiting. */
export const textPoolLimits: TextPoolLimits = {
  workers: 2,
  heapMiB: 256,
  fileTimeoutMs: 30_000,
  waitMs: 30_000,
};
