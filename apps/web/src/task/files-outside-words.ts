import type { FilesOutsideReposData } from "@ostra/task-view";

import { t } from "@/lib/messages";

// The thread's line for files the agent left outside every repo (Q133, milestone 2's ticket 44):
// what they are and what to do. ostra never moves them: a reply lets the agent.

/** "The agent left 2 files outside the repositories: notes.md, plan.txt. Reply to …", or that they're gone. */
export const filesOutsideText = (data: FilesOutsideReposData): string => {
  if (data.paths.length === 0) {
    return t("task.filesOutsideGone");
  }
  const total = data.paths.length + data.more;
  const listed = data.paths.join(", ");
  return t("task.filesOutside", {
    count: total === 1 ? t("task.filesOutsideOne") : t("task.filesOutsideMany", { n: total }),
    names: data.more > 0 ? t("task.filesOutsideMore", { names: listed, n: data.more }) : listed,
  });
};
