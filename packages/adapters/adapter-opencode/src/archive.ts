import { z } from "zod";

// OpenCode's session archive: what `opencode session export` prints and `session import` reads.
// A vendor format, so unknown fields are kept (AGENTS.md). Ported from
// spikes/can-a-session-move-to-a-fresh-box/src/lib/session-archive.ts. The archive holds the
// session's content: it is counted here and never logged.

const archiveSchema = z.looseObject({
  info: z.looseObject({
    id: z.string().min(1),
    projectID: z.string().optional(),
    // The old box's absolute path: why an import always passes `--directory` (spike 2, surprise 5).
    location: z.looseObject({ directory: z.string() }).optional(),
  }),
  messages: z.array(z.looseObject({ id: z.string(), type: z.string() })),
});

export type ArchiveSummary = {
  readonly agentSessionId: string;
  readonly bytes: number;
  readonly messages: number;
  /** Message count per `type` (user, assistant, idle, …). */
  readonly types: Readonly<Record<string, number>>;
};

/** Reads an archive's text into its session ID and counts. Throws when it isn't an OpenCode archive. */
export const summarizeArchive = (text: string): ArchiveSummary => {
  const parsed = archiveSchema.parse(JSON.parse(text));
  const types: Record<string, number> = {};
  for (const message of parsed.messages) {
    types[message.type] = (types[message.type] ?? 0) + 1;
  }
  return { agentSessionId: parsed.info.id, bytes: Buffer.byteLength(text, "utf8"), messages: parsed.messages.length, types };
};

/** What `opencode session import` prints on success. */
const IMPORTED = /Imported session:\s*(\S+)/;

/** The session ID an import printed, or `undefined` when it printed none. */
export const importedSessionId = (stdout: string): string | undefined => IMPORTED.exec(stdout)?.[1];
