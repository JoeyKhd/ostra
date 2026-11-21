import type { Logger } from "@ostra/adapter-sdk";
import type { SafeFileName } from "@ostra/protocol";

import { documentKindOf } from "./kinds.ts";
import type { TextPoolLimits, TextReadLimits } from "./limits.ts";
import { createTextPool } from "./pool.ts";
import type { TextPoolStats } from "./pool.ts";
import type { ExtractedText } from "./result.ts";

// What core calls when a file comes in (F-150): a member's upload before it answers (ticket 10) and
// a ticket's file in the job that fetches it (ticket 12). A document, told by its detected type, has
// its text read in the worker pool; any other file has none to read; with
// `OSTRA_FILE_TEXT_EXTRACTION=false` no document is read and no worker ever starts (F-150/c4).

/**
 * A file's text as it came in: `none` (not a document ostra reads), `off` (the install reads no
 * text), or the reader's `ready` or `failed`. The states are the protocol's `FileTextState`s.
 */
export type DocumentText = { readonly state: "none" } | { readonly state: "off" } | ExtractedText;

/** One file as it comes in: its bytes, the type core detected from them (`fileTypeOf`), and its safe name. */
export type DocumentTextInput = {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  /** Never logged. */
  readonly name: SafeFileName;
};

export type DocumentTextReader = {
  /** Reads a file's text when it's a document. Never throws. */
  readonly read: (input: DocumentTextInput) => Promise<DocumentText>;
  readonly stats: () => TextPoolStats;
  readonly close: () => Promise<void>;
};

export type DocumentTextReaderOptions = {
  /** `OSTRA_FILE_TEXT_EXTRACTION` (the domain's `settings.files.textExtraction`). */
  readonly extraction: boolean;
  readonly logger: Logger;
  readonly pool?: Partial<TextPoolLimits>;
  readonly limits?: TextReadLimits;
};

const NO_POOL: TextPoolStats = { workers: 0, started: 0, replaced: 0, timeouts: 0, outOfMemory: 0, refusedCalls: 0 };

export const createDocumentTextReader = (options: DocumentTextReaderOptions): DocumentTextReader => {
  const pool = options.extraction
    ? createTextPool({ logger: options.logger.child({ component: "files.text" }), ...(options.pool === undefined ? {} : { pool: options.pool }), ...(options.limits === undefined ? {} : { limits: options.limits }) })
    : null;
  return {
    read: async (input) => {
      const kind = documentKindOf(input.contentType);
      if (kind === null) {
        return { state: "none" };
      }
      if (pool === null) {
        return { state: "off" };
      }
      return pool.read({ bytes: input.bytes, kind, name: input.name });
    },
    stats: () => pool?.stats() ?? NO_POOL,
    close: async () => {
      await pool?.close();
    },
  };
};
