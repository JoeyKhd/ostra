import type { RepoFullName } from "@ostra/protocol";

import type { DetectedEnvironment } from "./detect.ts";

// F-112: a project's environment drafted from each of its repos' files. The environment holds one
// setup script, and every executor runs it once per repo, in that repo's folder, with `OSTRA_REPO`
// set to the repo's full name (ADR 0027, ADR 0038). So a draft over repos whose setups differ puts
// each repo's lines under its own name in a `case`, and a repo with nothing detected runs nothing.

/** One repo's detection, in the project's order. */
export type RepoDetection = { readonly fullName: RepoFullName; readonly detection: DetectedEnvironment };

/** What the environment row stores for a draft. */
export type EnvironmentDraft = { readonly baseImage: string | null; readonly setupScript: string | null };

const sameLines = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((line, index) => line === b[index]);

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
  // Each name single-quoted, so the pattern is the name as one word whatever it holds.
  const branches = withLines.flatMap((repo) => [`  '${repo.fullName.replaceAll("'", "'\\''")}')`, ...repo.detection.setupLines.map((line) => `    ${line}`), "    ;;"]);
  return { baseImage, setupScript: ["set -euo pipefail", 'case "$OSTRA_REPO" in', ...branches, "esac", ""].join("\n") };
};
