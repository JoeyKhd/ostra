import type { TaskSpec } from "@ostra/protocol";

/**
 * The folder the agent starts in, and the project it opens its session on (F-016, F-025).
 *
 * The workspace holds the repos side by side. With one repo, the agent works inside that repo's
 * checkout: a relative path in a prompt ("create docs/numbers.md") then lands in the repo, where
 * the work is committed, and not at the workspace root, where it would be lost. With several repos
 * the agent starts at the root, and the task spec's instructions name each repo's folder.
 *
 * `workspaceDir` is the executor's own path (the box's, as the agent sees it): the folder joins on
 * with the separator that path uses, so a Linux box path stays a Linux path on a Windows host.
 */
export const agentCwd = (workspaceDir: string, repos: TaskSpec["repos"]): string => {
  const [only, ...others] = repos;
  if (only === undefined || others.length > 0) {
    return workspaceDir;
  }
  const separator = workspaceDir.includes("\\") ? "\\" : "/";
  return `${workspaceDir.replace(/[\\/]+$/u, "")}${separator}${only.checkoutDir}`;
};
