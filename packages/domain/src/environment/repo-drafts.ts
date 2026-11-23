import type { RepoFullName } from "@ostra/protocol";

import type { DetectedEnvironment } from "./detect.ts";

// F-112: a project's environment drafted from each of its repos' files. The environment holds one
// setup script, and every executor runs it once per repo, in that repo's folder, with `OSTRA_REPO`
// set to the repo's full name (ADR 0027, ADR 0038). So a draft over repos whose setups differ puts
// each repo's lines under its own name in a `case`, and a repo with nothing detected runs nothing.
// F-113: an onboarding proposal's scripts, one per repo, become the one script the same way.

/** One repo's detection, in the project's order. */
export type RepoDetection = { readonly fullName: RepoFullName; readonly detection: DetectedEnvironment };

/** What the environment row stores for a draft. */
export type EnvironmentDraft = { readonly baseImage: string | null; readonly setupScript: string | null };

const sameLines = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((line, index) => line === b[index]);

/** A `case` branch's pattern for a repo: its name single-quoted, so it's the name as one word whatever it holds. */
const repoPattern = (fullName: string): string => `  '${fullName.replaceAll("'", "'\\''")}')`;

/**
 * The stored draft from each repo's detection: the first repo's base image that names one, and one
 * setup script. When every repo detected the same lines (one repo, say), the script is those lines
 * as they are; otherwise each repo with lines gets its own branch of a `case` on `OSTRA_REPO`.
 */
export const draftFromRepos = (repos: readonly RepoDetection[]): EnvironmentDraft => {
  const baseImage = repos.find((repo) => repo.detection.baseImage !== null)?.detection.baseImage ?? null;
  const withLines = repos.filter((repo) => repo.detection.setupLines.length > 0);
  const [first] = withLines;
  if (first === undefined) {
    return { baseImage, setupScript: null };
  }
  if (withLines.length === repos.length && withLines.every((repo) => sameLines(repo.detection.setupLines, first.detection.setupLines))) {
    return { baseImage, setupScript: first.detection.setupScript };
  }
  const branches = withLines.flatMap((repo) => [repoPattern(repo.fullName), ...repo.detection.setupLines.map((line) => `    ${line}`), "    ;;"]);
  return { baseImage, setupScript: ["set -euo pipefail", 'case "$OSTRA_REPO" in', ...branches, "esac", ""].join("\n") };
};

/** One repo's own setup script, as a proposal hands it in: `null` or blank for none. */
export type RepoSetupScript = { readonly fullName: string; readonly setupScript: string | null };

/**
 * The environment's one setup script from each repo's own, in the project's order (F-113's
 * proposals). When every repo has the same script (one repo, say), it's that script as it is;
 * otherwise each repo with a script gets its own branch of a `case` on `OSTRA_REPO`, its lines as
 * written (not indented, so a heredoc in them still ends), and a repo without one runs nothing.
 * `null` when no repo has one.
 */
export const setupScriptFromRepos = (repos: readonly RepoSetupScript[]): string | null => {
  const scripts = repos.flatMap((repo) => (repo.setupScript === null || repo.setupScript.trim() === "" ? [] : [{ fullName: repo.fullName, script: repo.setupScript }]));
  const [first] = scripts;
  if (first === undefined) {
    return null;
  }
  if (scripts.length === repos.length && scripts.every((one) => one.script === first.script)) {
    return first.script;
  }
  const branches = scripts.flatMap((one) => [repoPattern(one.fullName), one.script.replace(/\s+$/u, ""), "    ;;"]);
  return ['case "$OSTRA_REPO" in', ...branches, "esac", ""].join("\n");
};

// ---------- a repo added after the environment was saved (F-112/c1, Q345 option (b)) ----------
//
// The saved environment keeps running as it is, and the new repo's draft waits beside it for a
// project admin: Apply, Edit first or Dismiss. What Apply would save is worked out on read, from the
// saved script as it is now and what detection found in the repo, so a draft older than the script
// shows the change against the script that runs today.

/** One line of the setup script Apply saves: kept as it is, or added by the draft. */
export type RepoDraftLine = { readonly kind: "same" | "add"; readonly text: string };

/**
 * What a new repo's draft does to the saved setup script:
 * - `case`: the saved script is a `case` on `OSTRA_REPO` without the repo, and gains its branch before `esac`;
 * - `plain`: the saved script runs in every repo, and becomes a `case`, the old script under each
 *   repo that ran it and the new lines under the new repo;
 * - `nothing`: detection found no setup lines in the repo, so there's nothing to add;
 * - `settled`: nothing to review: the saved plain script is detection's lines already, or its `case`
 *   has a branch for the repo already (someone saved it since).
 */
export type RepoDraftChange =
  | {
      readonly kind: "case" | "plain";
      readonly script: string;
      readonly lines: readonly RepoDraftLine[];
      /**
       * The other new repos a plain script made a `case` gives no branch, because their own drafts
       * wait to add one: they ran the saved lines until now, and set up nothing until theirs is
       * applied. Empty for a `case`, where they ran nothing already.
       */
      readonly leftOut: readonly string[];
    }
  | { readonly kind: "nothing" }
  | { readonly kind: "settled" };

export type RepoDraftChangeInput = {
  /** The saved setup script, `null` for none. */
  readonly savedScript: string | null;
  /** The new repo. */
  readonly fullName: string;
  /** Detection's setup lines for it. */
  readonly setupLines: readonly string[];
  /** The project's other repos in order that keep the lines they run today when a plain script becomes a `case`. */
  readonly otherRepos: readonly string[];
  /**
   * The project's other new repos whose own drafts wait to add their lines: a plain script made a
   * `case` gives them no branch (their own draft adds it), and the change names them.
   */
  readonly waitingRepos: readonly string[];
};

const CASE_LINE = /^case\s+"\$OSTRA_REPO"\s+in$/u;
const SET_LINE = /^set\s+-[A-Za-z]+(?:\s+[A-Za-z]+)*$/u;

/** The script's lines, its final newline left out. */
const scriptLines = (script: string): readonly string[] => script.replace(/\r\n/gu, "\n").replace(/\n+$/u, "").split("\n");

/** A `case` branch's patterns that name the repo: quoted either way, or bare. */
const namesRepo = (line: string, fullName: string): boolean => {
  const trimmed = line.trim();
  return trimmed === repoPattern(fullName).trim() || trimmed === `"${fullName}")` || trimmed === `${fullName})`;
};

/** The lines that do something: no blanks, no comments, no leading `set -…`. */
const workingLines = (lines: readonly string[]): readonly string[] => {
  const kept = lines.map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
  return kept[0] !== undefined && SET_LINE.test(kept[0]) ? kept.slice(1) : kept;
};

/** The new repo's branch, as `draftFromRepos` writes one. */
const branchOf = (fullName: string, setupLines: readonly string[]): readonly string[] => [repoPattern(fullName), ...setupLines.map((line) => `    ${line}`), "    ;;"];

export const repoDraftChange = (input: RepoDraftChangeInput): RepoDraftChange => {
  if (input.setupLines.length === 0) {
    return { kind: "nothing" };
  }
  const saved = input.savedScript === null || input.savedScript.trim() === "" ? [] : scriptLines(input.savedScript);
  const branch = branchOf(input.fullName, input.setupLines);
  const caseAt = saved.findIndex((line) => CASE_LINE.test(line.trim()));
  const esacAt = saved.findLastIndex((line) => line.trim() === "esac");
  if (caseAt >= 0 && esacAt > caseAt) {
    if (saved.slice(caseAt + 1, esacAt).some((line) => namesRepo(line, input.fullName))) {
      return { kind: "settled" };
    }
    const lines: RepoDraftLine[] = [
      ...saved.slice(0, esacAt).map((text) => ({ kind: "same" as const, text })),
      ...branch.map((text) => ({ kind: "add" as const, text })),
      ...saved.slice(esacAt).map((text) => ({ kind: "same" as const, text })),
    ];
    return { kind: "case", lines, script: `${lines.map((line) => line.text).join("\n")}\n`, leftOut: [] };
  }
  const working = workingLines(saved);
  if (working.length > 0 && working.length === input.setupLines.length && working.every((line, index) => line === input.setupLines[index]?.trim())) {
    return { kind: "settled" };
  }
  // A plain script: a leading `set -…` stays on top, and the rest goes under each repo that ran it, as written.
  const [first] = saved;
  const hoisted = first !== undefined && SET_LINE.test(first.trim()) ? [first] : [];
  const body = saved.slice(hoisted.length);
  // A script without `set -…` gets none: Apply changes where its lines run, not how they run.
  const lines: RepoDraftLine[] = hoisted.map((text) => ({ kind: "same" as const, text }));
  lines.push({ kind: "add", text: 'case "$OSTRA_REPO" in' });
  const ranLines = workingLines(body).length > 0;
  if (ranLines) {
    for (const [index, repo] of input.otherRepos.entries()) {
      lines.push({ kind: "add", text: repoPattern(repo) });
      // The old lines stay where they were for the first repo, and are added under each other one.
      lines.push(...body.map((text) => ({ kind: index === 0 ? ("same" as const) : ("add" as const), text })));
      lines.push({ kind: "add", text: "    ;;" });
    }
  }
  lines.push(...branch.map((text) => ({ kind: "add" as const, text })), { kind: "add", text: "esac" });
  // A repo left out loses lines only when the saved script ran some.
  return { kind: "plain", lines, script: `${lines.map((line) => line.text).join("\n")}\n`, leftOut: ranLines ? input.waitingRepos : [] };
};

/** A language detection can name for a repo, from its tools or the command its setup starts with. */
export type RepoLanguage = "node" | "python" | "rust" | "go" | "ruby";

const languageOfCommand: Readonly<Record<string, RepoLanguage>> = {
  corepack: "node",
  pnpm: "node",
  npm: "node",
  yarn: "node",
  bun: "node",
  uv: "python",
  pip: "python",
  poetry: "python",
  cargo: "rust",
  go: "go",
  bundle: "ruby",
};

/** The tool a line runs, when it's one detection writes: `pnpm` for `pnpm install`; `corepack` names none. */
const toolOf = (line: string): string | null => {
  const [word] = line.trim().split(/\s+/u);
  return word === undefined || word === "corepack" || !Object.hasOwn(languageOfCommand, word) ? null : word;
};

/** The first tool a script's lines run that detection knows, e.g. `pnpm`; `null` when none. */
export const setupToolOf = (lines: readonly string[]): string | null => {
  for (const line of lines) {
    const tool = toolOf(line);
    if (tool !== null) {
      return tool;
    }
  }
  return null;
};

/** The repo's language, from the command its setup lines run first. */
export const setupLanguageOf = (lines: readonly string[]): RepoLanguage | null => {
  const tool = setupToolOf(lines);
  return tool === null ? null : (languageOfCommand[tool] ?? null);
};
