import type { TaskSpec } from "@ostra/protocol";

// Several repos side by side (F-098, ADR 0027 amended; milestone 4's ticket 21). Core appends the
// list of the task's repos, their folders and base branches to the agent's instructions (the
// domain's `renderReposForAgent`: a `## Repositories` section, one "- `dir/`: owner/name (base: …)"
// line per repo). Before anything is cloned the runner checks that the folders it will check out are
// the ones the agent is told about, and that no two repos share a folder: a mismatch would send the
// agent's edits to the wrong place, or outside every repo.

export type RepoFoldersCheck = { readonly ok: true } | { readonly ok: false; readonly error: string };

const HEADING = "## Repositories";
const LISTED = /^- `([^`/]+)\/`: /;

/** The folders the instructions' `## Repositories` section lists, in order; `null` when it has none. */
export const listedRepoFolders = (instructions: string | null): readonly string[] | null => {
  if (instructions === null) {
    return null;
  }
  const lines = instructions.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === HEADING);
  if (start < 0) {
    return null;
  }
  const folders: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) {
      break;
    }
    const match = LISTED.exec(line);
    if (match?.[1] !== undefined) {
      folders.push(match[1]);
    }
  }
  return folders;
};

/**
 * Whether the spec's repos can be checked out side by side as the agent is told: each in its own
 * folder (case aside, as Windows and macOS see them), and, when the instructions list the repos,
 * the same folders in the same order.
 */
export const checkRepoFolders = (spec: Pick<TaskSpec, "repos"> & { readonly agent: Pick<TaskSpec["agent"], "instructions"> }): RepoFoldersCheck => {
  const seen = new Set<string>();
  for (const repo of spec.repos) {
    const key = repo.checkoutDir.toLowerCase();
    if (seen.has(key)) {
      return { ok: false, error: `two of the task's repos share the folder ${repo.checkoutDir}` };
    }
    seen.add(key);
  }
  if (spec.repos.length < 2) {
    return { ok: true };
  }
  const listed = listedRepoFolders(spec.agent.instructions);
  if (listed === null) {
    return { ok: true };
  }
  const folders = spec.repos.map((repo) => repo.checkoutDir);
  if (listed.length !== folders.length || listed.some((folder, index) => folder !== folders[index])) {
    return { ok: false, error: `the agent's instructions list the folders ${listed.join(", ") || "(none)"}, but the task's repos are in ${folders.join(", ")}` };
  }
  return { ok: true };
};
