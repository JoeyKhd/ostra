import { z } from "zod";

import { noteIdSchema, proposalIdSchema } from "../ids.ts";
import { utf8ByteLength } from "../json.ts";
import { runnerLimits } from "../runner/limits.ts";

// Project memory's shapes (F-109, F-110, F-111, ADR 0044): what a note is, what the index lists,
// and what an agent proposes. ostra owns these, so every object refuses unknown fields. A note's
// text, a query and a proposal's text are never logged: the schemas below say so where they hold one.

/** What a note records (ADR 0044). */
export const memoryKindSchema = z.enum(["convention", "command", "gotcha", "decision", "preference", "term"]);
export type MemoryKind = z.infer<typeof memoryKindSchema>;

/** Whose a note is: the whole organization's, or one project's. */
export const memoryScopeSchema = z.enum(["organization", "project"]);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;

/**
 * How a session saw a note (ADR 0044, Q91): listed in the index, carried as an "always" note,
 * returned by a search and then read, or read. Only `search` and `read` move a note's last use.
 */
export const memoryUseViaSchema = z.enum(["index", "always", "search", "read"]);
export type MemoryUseVia = z.infer<typeof memoryUseViaSchema>;

/** What a proposal says about the note it relates to (ADR 0044, Q204). */
export const proposalRelationSchema = z.enum(["contradicts", "refines"]);
export type ProposalRelation = z.infer<typeof proposalRelationSchema>;

/** A note's title: one line, at most 120 characters. Never logged. */
export const memoryNoteTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(runnerLimits.memoryNoteTitleMaxChars)
  .regex(/^[^\r\n]+$/, "one line")
  .describe("A memory note's title. Never logged.");

/** A note's body: at most 4 KiB of UTF-8. Never logged. */
export const memoryNoteBodySchema = z
  .string()
  .trim()
  .min(1)
  .refine((body) => utf8ByteLength(body) <= runnerLimits.memoryNoteBodyMaxBytes, "at most 4 KiB")
  .describe("A memory note's body. Never logged.");

/** A note's version: 1 when saved, raised by every edit and merge (ADR 0044, Q91). */
export const memoryNoteVersionSchema = z.number().int().positive();

/** A note as an agent reads it with `memory_read`. Its text is never logged. */
export const memoryNoteSchema = z
  .strictObject({
    noteId: noteIdSchema,
    title: memoryNoteTitleSchema,
    body: memoryNoteBodySchema,
    kind: memoryKindSchema,
    scope: memoryScopeSchema,
    version: memoryNoteVersionSchema,
  })
  .describe("A memory note. Its title and body are never logged.");
export type MemoryNote = z.infer<typeof memoryNoteSchema>;

/** One line of the index: a note's ID, title, kind and scope, never its body. */
export const memoryIndexEntrySchema = z
  .strictObject({
    noteId: noteIdSchema,
    title: memoryNoteTitleSchema,
    kind: memoryKindSchema,
    scope: memoryScopeSchema,
  })
  .describe("One line of the memory index. Its title is never logged.");
export type MemoryIndexEntry = z.infer<typeof memoryIndexEntrySchema>;

/**
 * What an agent proposes with `memory_propose` (F-111). `relatesTo` and `relation` go together:
 * a proposal that contradicts or refines a note names it. Its text is never logged.
 */
export const memoryProposalInputSchema = z
  .strictObject({
    title: memoryNoteTitleSchema,
    body: memoryNoteBodySchema,
    kind: memoryKindSchema,
    scope: memoryScopeSchema,
    relatesTo: noteIdSchema.nullable(),
    relation: proposalRelationSchema.nullable(),
  })
  .refine((input) => (input.relatesTo === null) === (input.relation === null), {
    message: "a relation names the note it relates to",
    path: ["relation"],
  })
  .describe("A proposed memory note. Its title and body are never logged.");
export type MemoryProposalInput = z.infer<typeof memoryProposalInputSchema>;

/** The proposal core recorded: its ID, for the agent's answer and the thread. */
export const memoryProposalRefSchema = z.strictObject({ proposalId: proposalIdSchema });
export type MemoryProposalRef = z.infer<typeof memoryProposalRefSchema>;
