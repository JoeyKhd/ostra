import { cleanPrTitle } from "@ostra/protocol";
import type { RepoId } from "@ostra/protocol";

// F-078 (the maintainer's report, 2026-11-22: "why does the PR title not explain what the pr is about?
// and the commit message as well"): when the agent leaves work uncommitted, ostra commits it, and that
// commit says what it changed, never the task's title (a prompt task's is its first message). Each
// repo's message is made from what that repo's commit holds, deterministically: `Add ESSAY-lebanon.md`,
// `Update calculator.ts and history.ts`, `Add 1 file, update 3`. When the agent set the PR's title
// for the repo, that's the subject, and the files' summary is the body. A session that's ending as it
// shouldn't says so after the subject. The co-authors' trailers are added after the message, as before.
//
// The same summary titles a prompt task's PR when the agent gave no title and the branch has more
// than one commit (F-030/c2, `packages/domain`'s PR opener), from the files the code host compares.

/** One changed file, as ostra's leftover rule reads it. Paths are the repo's, with `/` between folders. */
export type FileChange =
  | { readonly kind: "add" | "update" | "delete"; readonly path: string }
  | { readonly kind: "rename"; readonly path: string; readonly from: string };

/** Why a session's work is committed before it ends as it should: said after the subject. */
export type LeftoverNote = "stopped" | "crashed" | "spend-cap";

const NOTE_WORDS: Readonly<Record<LeftoverNote, string>> = {
  stopped: "stopped: unfinished work",
  crashed: "crashed: unfinished work",
  "spend-cap": "spend cap reached: unfinished work",
};

/**
 * ostra's own commit of what the agent left uncommitted (F-078): each repo's message is made from
 * that repo's own commit by `leftoverCommitMessage`, at the moment it's committed.
 */
export type LeftoverCommit = {
  readonly kind: "leftover";
  /** The agent's PR title for a repo, when it set one (`set_pull_request_text`): that repo's subject. */
  readonly titles: readonly { readonly repoId: RepoId; readonly title: string }[];
  /** Why the session is ending early, or `null` when it ends as it should. */
  readonly note: LeftoverNote | null;
};

/** A summary's longest, in characters: a commit subject's. A summary of named files that's longer counts them. */
export const CHANGE_SUMMARY_MAX_CHARS = 72;

/** The most files a summary names; with more, it counts them. */
const NAMED_FILES_MAX = 3;

const ORDER = ["add", "update", "delete", "rename"] as const;
type ChangeKind = (typeof ORDER)[number];

const VERBS: Readonly<Record<ChangeKind, string>> = { add: "Add", update: "Update", delete: "Delete", rename: "Rename" };

/** A file's last segment. */
const baseName = (path: string): string => path.split("/").filter((part) => part !== "").at(-1) ?? path;

/** "a", "a and b", "a, b and c". */
const listed = (items: readonly string[]): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;

/** Clauses after the first start in lower case: "Add a.md, update b.ts". */
const joinClauses = (clauses: readonly string[]): string =>
  clauses.map((clause, index) => (index === 0 ? clause : `${clause.charAt(0).toLowerCase()}${clause.slice(1)}`)).join(", ");

/** One file's name in a summary: one clean line (a file name may hold a newline or a control character). */
const shown = (name: string): string => cleanPrTitle(name);

const groupsOf = (changes: readonly FileChange[]): readonly { readonly kind: ChangeKind; readonly items: readonly FileChange[] }[] =>
  ORDER.map((kind) => ({ kind, items: changes.filter((change) => change.kind === kind) })).filter((group) => group.items.length > 0);

/** The summary that names each file, by its name, or by its path where two names are alike. */
const namedSummary = (changes: readonly FileChange[]): string | null => {
  const names = changes.flatMap((change) => (change.kind === "rename" ? [change.from, change.path] : [change.path])).map(baseName);
  const usePaths = new Set(names).size < names.length;
  const nameOf = (path: string): string => shown(usePaths ? path : baseName(path));
  const clauses = groupsOf(changes).map(({ kind, items }) =>
    `${VERBS[kind]} ${listed(items.map((change) => (change.kind === "rename" ? `${nameOf(change.from)} to ${nameOf(change.path)}` : nameOf(change.path))))}`,
  );
  const summary = joinClauses(clauses);
  return summary.length <= CHANGE_SUMMARY_MAX_CHARS && changes.every((change) => nameOf(change.path) !== "") ? summary : null;
};

/** The summary that counts the files: "Update 12 files", "Add 1 file, update 3". */
const countedSummary = (changes: readonly FileChange[]): string =>
  joinClauses(
    groupsOf(changes).map(({ kind, items }, index) => {
      const count = String(items.length);
      return index === 0 ? `${VERBS[kind]} ${count} ${items.length === 1 ? "file" : "files"}` : `${VERBS[kind]} ${count}`;
    }),
  );

/**
 * What a set of changed files is, in one line of at most `CHANGE_SUMMARY_MAX_CHARS`: up to three
 * files by name (their paths when two share a name), more by count. Deterministic: the same files
 * in any order give the same summary.
 */
export const changeSummary = (changes: readonly FileChange[]): string => {
  const sorted = [...changes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (sorted.length === 0) {
    return "Update files";
  }
  return (sorted.length <= NAMED_FILES_MAX ? namedSummary(sorted) : null) ?? countedSummary(sorted);
};

/**
 * The changed files of `git diff --cached --name-status -z --find-renames`: a copy counts as an
 * added file, a type change or an unmerged path as an updated one.
 */
export const nameStatusChanges = (output: string): readonly FileChange[] => {
  const entries = output.split("\0");
  const changes: FileChange[] = [];
  let index = 0;
  while (index < entries.length) {
    const status = entries[index] ?? "";
    index += 1;
    if (status === "") {
      continue;
    }
    const letter = status.charAt(0);
    if (letter === "R" || letter === "C") {
      const from = entries[index] ?? "";
      const to = entries[index + 1] ?? "";
      index += 2;
      if (to !== "") {
        changes.push(letter === "R" && from !== "" ? { kind: "rename", path: to, from } : { kind: "add", path: to });
      }
      continue;
    }
    const path = entries[index] ?? "";
    index += 1;
    if (path !== "") {
      changes.push({ kind: letter === "A" ? "add" : letter === "D" ? "delete" : "update", path });
    }
  }
  return changes;
};

/**
 * One repo's message for ostra's leftover commit: the agent's PR title for the repo when it set
 * one, with the files' summary as the body, else the summary; and the ending's note after the
 * subject, `Add ESSAY-lebanon.md (stopped: unfinished work)`. The trailers are added after it.
 */
export const leftoverCommitMessage = (input: { readonly changes: readonly FileChange[]; readonly title: string | null; readonly note: LeftoverNote | null }): string => {
  const summary = changeSummary(input.changes);
  const title = input.title === null ? "" : cleanPrTitle(input.title);
  const note = input.note === null ? "" : ` (${NOTE_WORDS[input.note]})`;
  return title === "" ? `${summary}${note}` : `${title}${note}\n\n${summary}`;
};

/** A subject without the note `leftoverCommitMessage` put after it, for a PR titled from it. */
export const withoutLeftoverNote = (subject: string): string => {
  for (const words of Object.values(NOTE_WORDS)) {
    const suffix = ` (${words})`;
    if (subject.endsWith(suffix)) {
      return subject.slice(0, -suffix.length).trimEnd();
    }
  }
  return subject;
};

/** The message a repo's commit gets: a fixed one as it is, ostra's leftover rule made from the repo's own changes. */
export const commitMessageFor = (message: string | LeftoverCommit, repoId: RepoId, changes: readonly FileChange[]): string =>
  typeof message === "string"
    ? message
    : leftoverCommitMessage({ changes, title: message.titles.find((item) => item.repoId === repoId)?.title ?? null, note: message.note });
