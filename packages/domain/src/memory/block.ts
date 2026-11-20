import type { MemberId, MemoryKind, MemoryScope, NoteId, TaskId, TaskSpecMemory } from "@ostra/protocol";
import { runnerLimits, utf8ByteLength } from "@ostra/protocol";

// The memory a session starts with (F-110, ADR 0044 amended, Q91): the "always" notes in full,
// then the index of the rest, then the standing instruction. Core renders it once into the spec's
// `memory.block`, and appends it to `agent.instructions` for a minor-2 runner. Pure.

/** Where a note came from, for its source line in the block (Q91, change 5). */
export type NoteSource =
  | { readonly kind: "member"; readonly memberName: string }
  | { readonly kind: "task"; readonly taskId: TaskId; readonly taskTitle: string }
  | { readonly kind: "diff_comment"; readonly memberName: string }
  | { readonly kind: "pr_comment"; readonly memberName: string }
  | { readonly kind: "proposal"; readonly approvedBy: string };

/** An approved, active note, as the index builder reads it. */
export type BlockNote = {
  readonly noteId: NoteId;
  readonly scope: MemoryScope;
  readonly kind: MemoryKind;
  readonly title: string;
  readonly body: string;
  readonly always: boolean;
  /** The last time a session read it (`memory_read`, or a search result then read); `null` if never. */
  readonly lastUsedAt: number | null;
  /** The last edit. */
  readonly updatedAt: number;
  readonly source: NoteSource;
  readonly authorMemberId: MemberId | null;
};

export type MemoryLimits = {
  readonly indexMaxNotes: number;
  readonly indexMaxBytes: number;
  readonly alwaysMaxBytes: number;
};

/** The working values (`OSTRA_MEMORY_INDEX_MAX_NOTES`, `OSTRA_MEMORY_INDEX_MAX_KIB`, `OSTRA_MEMORY_ALWAYS_MAX_KIB`). */
export const defaultMemoryLimits: MemoryLimits = {
  indexMaxNotes: runnerLimits.memoryIndexMaxNotes,
  indexMaxBytes: runnerLimits.memoryIndexMaxBytes,
  alwaysMaxBytes: runnerLimits.memoryAlwaysMaxBytes,
};

/**
 * The index's order (Q202, amended by Q91): project notes first, then organization notes; within
 * each, by last read, newest first; then the notes never read, by last edit, newest first. Ties
 * by ID, so the order is stable.
 */
export const compareForIndex = (x: BlockNote, y: BlockNote): number => {
  if (x.scope !== y.scope) {
    return x.scope === "project" ? -1 : 1;
  }
  if (x.lastUsedAt !== null && y.lastUsedAt !== null && x.lastUsedAt !== y.lastUsedAt) {
    return y.lastUsedAt - x.lastUsedAt;
  }
  if ((x.lastUsedAt === null) !== (y.lastUsedAt === null)) {
    return x.lastUsedAt === null ? 1 : -1;
  }
  if (x.updatedAt !== y.updatedAt) {
    return y.updatedAt - x.updatedAt;
  }
  return x.noteId < y.noteId ? -1 : x.noteId > y.noteId ? 1 : 0;
};

/** One index line: the kind, the title, the ID, the scope and where the note came from (ADR 0044, Q91 change 5). Never its body. */
const indexLine = (note: BlockNote): string => `- [${note.kind}] ${oneLine(note.title)} (id: ${note.noteId}, ${note.scope}, ${sourceLine(note.source)})`;

const oneLine = (text: string): string => text.replaceAll(/[\r\n\t]+/g, " ").trim();

export const sourceLine = (source: NoteSource): string => {
  switch (source.kind) {
    case "member":
      return `written by ${oneLine(source.memberName)}`;
    case "task":
      return `from task "${oneLine(source.taskTitle)}"`;
    case "diff_comment":
      return `from a diff comment by ${oneLine(source.memberName)}`;
    case "pr_comment":
      return `from a PR comment by ${oneLine(source.memberName)}`;
    case "proposal":
      return `proposed by an agent, approved by ${oneLine(source.approvedBy)}`;
    default:
      return source satisfies never;
  }
};

const alwaysEntry = (note: BlockNote): string =>
  `### ${oneLine(note.title)}\n_${note.kind}, ${note.scope} note, ${sourceLine(note.source)} (id: ${note.noteId})_\n\n${note.body.trim()}\n`;

export type BuiltIndex = {
  readonly always: readonly BlockNote[];
  readonly index: readonly BlockNote[];
  /** Notes left out by the limits: the "N more notes" line. */
  readonly omitted: number;
};

/**
 * Picks the "always" notes and the index within the limits. An "always" note that doesn't fit
 * its 8 KiB goes to the index instead, as any other note; the index is cut at its count and its
 * size, and what's cut is counted in `omitted`.
 */
export const buildMemoryIndex = (notes: readonly BlockNote[], limits: MemoryLimits = defaultMemoryLimits): BuiltIndex => {
  const ordered = [...notes].sort(compareForIndex);
  const always: BlockNote[] = [];
  let alwaysBytes = 0;
  const rest: BlockNote[] = [];
  for (const note of ordered) {
    const size = utf8ByteLength(alwaysEntry(note));
    if (note.always && alwaysBytes + size <= limits.alwaysMaxBytes) {
      always.push(note);
      alwaysBytes += size;
    } else {
      rest.push(note);
    }
  }
  const index: BlockNote[] = [];
  let indexBytes = 0;
  for (const note of rest) {
    const size = utf8ByteLength(indexLine(note)) + 1;
    if (index.length >= limits.indexMaxNotes || indexBytes + size > limits.indexMaxBytes) {
      break;
    }
    index.push(note);
    indexBytes += size;
  }
  return { always, index, omitted: rest.length - index.length };
};

/**
 * The standing instruction (ADR 0044, Q91): search before guessing a convention, propose what the
 * next task should know, and propose a contradiction instead of following a note the code
 * disagrees with.
 */
export const standingInstruction = (tools: boolean): string =>
  tools
    ? [
        "Before you guess at a convention, a command or a term, search memory with `memory_search`, and read a note with `memory_read`.",
        "When you learn something the next task in this project should know, propose a note with `memory_propose`. A member approves it before any agent sees it.",
        'When the code disagrees with a note, don\'t follow the note: propose a correction with `memory_propose` and `relation: "contradicts"`, naming the note.',
      ].join("\n")
    : "These notes are all the memory this agent can reach. When the code disagrees with a note, follow the code and say so in your summary.";

/** The block's text, and the IDs the runner reports in `memory.used`. */
export const renderMemoryBlock = (built: BuiltIndex, tools: boolean): TaskSpecMemory => {
  const parts: string[] = [
    "## Memory",
    "",
    "These are the organization's and the project's approved notes: facts members wrote or approved for agents working here. Each says where it came from.",
    "",
  ];
  if (built.always.length > 0) {
    parts.push("### Always", "", ...built.always.map(alwaysEntry), "");
  }
  if (built.index.length > 0) {
    parts.push("### Index", "", ...built.index.map(indexLine), "");
  }
  if (built.omitted > 0) {
    parts.push(
      tools ? `${String(built.omitted)} more notes: search with \`memory_search\`.` : `${String(built.omitted)} more notes aren't listed here.`,
      "",
    );
  }
  parts.push(standingInstruction(tools));
  return {
    block: parts.join("\n"),
    indexNoteIds: built.index.map((note) => note.noteId),
    alwaysNoteIds: built.always.map((note) => note.noteId),
    omitted: built.omitted,
    tools,
  };
};

/** For a minor-2 runner: the profile's instructions with the block appended (no tools). */
export const foldMemoryIntoInstructions = (instructions: string | null, memory: TaskSpecMemory): string =>
  instructions === null || instructions.trim() === "" ? memory.block : `${instructions.trimEnd()}\n\n${memory.block}`;

// ---------- the version check (ADR 0044, Q91 change 3) ----------

export type VersionCheck =
  | { readonly ok: true; readonly nextVersion: number }
  | { readonly ok: false; readonly code: "conflict"; readonly currentVersion: number; readonly savedBy: MemberId | null };

/**
 * An edit and a merge carry the version the member opened. Anything else than the note's current
 * version is a conflict, which says who saved the current one and which version it is.
 */
export const checkNoteVersion = (
  note: { readonly version: number; readonly lastEditedBy: MemberId | null },
  expectedVersion: number,
): VersionCheck =>
  expectedVersion === note.version
    ? { ok: true, nextVersion: note.version + 1 }
    : { ok: false, code: "conflict", currentVersion: note.version, savedBy: note.lastEditedBy };
