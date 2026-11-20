"use client";

import { CircleCheckIcon, CircleDashedIcon, GitPullRequestIcon } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";
import type { MessageKey } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";
import { safeHref } from "@/task/renderers";

// F-098, F-104 (ticket 39; growing app-targets/m1/task): every PR of the task in its header, each with
// its repo, its state and `ostra/independent-review` on its newest head: "Waiting for an independent
// reviewer", "Only drivers approved", "Approved by Sam".

type TaskRepo = RouterOutputs["tasks"]["get"]["repos"][number];
type ReviewCheck = NonNullable<TaskRepo["pullRequests"][number]["reviewCheck"]>;

const REASON_WORDS: Readonly<Partial<Record<string, MessageKey>>> = {
  "no-approval": "taskPrs.review.waiting",
  "changes-requested": "taskPrs.review.changesRequested",
  "only-bots-approved": "taskPrs.review.onlyBots",
  "only-unlinked-approved": "taskPrs.review.onlyUnlinked",
  "only-drivers-approved": "taskPrs.review.onlyDrivers",
  "approval-is-stale": "taskPrs.review.stale",
};

/** The check's words: who approved, or why it waits. */
export const reviewCheckText = (check: ReviewCheck): string => {
  if (check.state === "passed") return t("taskPrs.review.approvedBy", { name: check.approver?.name ?? t("taskPage.someone") });
  const key = check.reason === null ? undefined : REASON_WORDS[check.reason];
  return t(key ?? "taskPrs.review.waiting");
};

/** The newest PR of each repo that has one, in the task's repo order. */
export const headerPrs = (repos: readonly TaskRepo[]) =>
  repos.flatMap((repo) => {
    const pr = repo.pullRequests.at(-1);
    return pr === undefined ? [] : [{ repo, pr }];
  });

export const TaskPrs = ({ repos }: { readonly repos: readonly TaskRepo[] }) => {
  const prs = headerPrs(repos);
  if (prs.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-col gap-1" data-testid="task-prs">
      {prs.map(({ repo, pr }) => {
        const href = safeHref(pr.url);
        const check = pr.reviewCheck;
        return (
          <li key={`${repo.repoId}:${String(pr.number)}`} className="flex flex-wrap items-center gap-x-2 text-ui" data-testid="task-pr" data-repo={repo.fullName}>
            <GitPullRequestIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75] text-faint" />
            <span className="font-mono text-muted">{repo.fullName}</span>
            {href === null ? <span className="font-mono">#{pr.number}</span> : <a href={href} target="_blank" rel="noopener noreferrer" className="font-mono text-teal hover:underline">#{pr.number}</a>}
            <span className={cn(pr.state === "merged" ? "text-green" : pr.state === "closed_unmerged" ? "text-faint" : "text-muted")} data-pr-state={pr.state}>{pr.draft ? t("taskPrs.draft") : t(`taskPrs.state.${pr.state}`)}</span>
            {check === null ? null : (
              <span className={cn("flex items-center gap-1", check.state === "passed" ? "text-green" : "text-muted")} data-testid="review-check" data-state={check.state}>
                {check.state === "passed" ? <CircleCheckIcon aria-hidden className="size-[13px]" /> : <CircleDashedIcon aria-hidden className="size-[13px]" />}
                {reviewCheckText(check)}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
};
