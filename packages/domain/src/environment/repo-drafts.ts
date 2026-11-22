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
