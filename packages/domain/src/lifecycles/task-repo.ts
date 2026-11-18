import { moveTo, refuse } from "./transition.ts";
import type { Transition } from "./transition.ts";

// A task repo's lifecycle (domain-model.md, "The task"; Q29, F-030): the task's branch and PR in
// one repo. A merged repo's next round gets a fresh branch and a new PR (F-066).

export type TaskRepoLifecycle =
  | { readonly state: "no_branch" }
  | { readonly state: "branch_pushed" }
  | { readonly state: "pr_open"; readonly prNumber: number }
  | { readonly state: "merged"; readonly prNumber: number }
  | { readonly state: "closed_unmerged"; readonly prNumber: number };

export type TaskRepoInput =
  | { readonly type: "pushed" }
  | { readonly type: "pr_opened"; readonly prNumber: number }
  | { readonly type: "pr_merged" }
  | { readonly type: "pr_closed" }
  | { readonly type: "pr_reopened" }
  /** The task reopened after this repo's PR merged: a fresh branch (F-066). */
  | { readonly type: "fresh_branch" };

export const transitionTaskRepo = (repo: TaskRepoLifecycle, input: TaskRepoInput): Transition<TaskRepoLifecycle> => {
  switch (input.type) {
    case "pushed":
      // Pushing again keeps the state: a PR that's open stays open.
      return repo.state === "no_branch" || repo.state === "branch_pushed"
        ? moveTo({ state: "branch_pushed" })
        : repo.state === "pr_open"
          ? moveTo(repo)
          : refuse(input, repo.state);
    case "pr_opened":
      return repo.state === "branch_pushed" ? moveTo({ state: "pr_open", prNumber: input.prNumber }) : refuse(input, repo.state);
    case "pr_merged":
      return repo.state === "pr_open" ? moveTo({ state: "merged", prNumber: repo.prNumber }) : refuse(input, repo.state);
    case "pr_closed":
      return repo.state === "pr_open"
        ? moveTo({ state: "closed_unmerged", prNumber: repo.prNumber })
        : refuse(input, repo.state);
    case "pr_reopened":
      return repo.state === "closed_unmerged" ? moveTo({ state: "pr_open", prNumber: repo.prNumber }) : refuse(input, repo.state);
    case "fresh_branch":
      return repo.state === "merged" ? moveTo({ state: "no_branch" }) : refuse(input, repo.state);
    default:
      return input satisfies never;
  }
};
