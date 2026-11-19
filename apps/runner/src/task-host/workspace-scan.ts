import { runnerLimits } from "@ostra/protocol";
import type { TaskSpec } from "@ostra/protocol";

// Files left outside every repo (Q133, milestone 2's ticket 44). The workspace holds the repos'
// checkouts side by side; a name beside them belongs to no repo, so no branch, hidden ref or PR
// carries it, and it goes when the box does. The task host lists the root after every turn and at
// a stop, and reports the names when the set changes. ostra never moves, commits, uploads or
// deletes them: a member's reply lets the agent move them. The names are content: never logged.

/** ostra's own entries in the workspace root, never reported: `.ostra/` holds the ticket's files (ticket 26). */
export const OSTRA_WORKSPACE_ENTRIES: readonly string[] = [".ostra"];

export type FilesOutsideRepos = { readonly paths: readonly string[]; readonly more: number };

/** The names in the root that aren't a repo's checkout or ostra's own: sorted, at most 50, and how many more. */
export const filesOutsideRepos = (names: readonly string[], spec: Pick<TaskSpec, "repos">): FilesOutsideRepos => {
  const owned = new Set<string>([...spec.repos.map((repo) => repo.checkoutDir), ...OSTRA_WORKSPACE_ENTRIES]);
  const left = [...new Set(names)].filter((name) => !owned.has(name)).sort();
  const max = runnerLimits.filesOutsideReposMax;
  return { paths: left.slice(0, max), more: Math.max(0, left.length - max) };
};

/** A key for the whole set, so a change is seen even past the first 50. */
export const outsideKey = (names: readonly string[], spec: Pick<TaskSpec, "repos">): string => {
  const { paths, more } = filesOutsideRepos(names, spec);
  return JSON.stringify([paths, more, [...new Set(names)].sort()]);
};
