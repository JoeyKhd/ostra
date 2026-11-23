"use client";

import { useQuery } from "@tanstack/react-query";
import { GitMergeIcon, GitPullRequestClosedIcon, GitPullRequestDraftIcon, GitPullRequestIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { PullRequestData } from "@ostra/task-view";

import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";
import { useTRPC } from "@/lib/trpc";

import { safeHref } from "../renderers";
import { Segments, toneClass } from "./segments";
import { useThreadParts } from "./thread-context";
import type { ThreadPr } from "./thread-context";
import { ciLine, prSizeWords, resultWords } from "./words";
import type { HeadCi } from "./words";

// Owner: ticket 14 (milestone 10, F-151: the PR card, parts.md part 10, choice 8). Drawn once, under
// the result line of the push that opened it, cut to what isn't elsewhere (the top bar has the PR's
// button, the panel its branch): its state's icon, its number as a link, its title, its size, and
// under them the live CI line in jobs (part 13's words), which updates in place as `tasks.get`
// does. A later push to the same PR is one line, never a second card.

/** How the card's icon reads: open, a draft (ostra's, for a failed check, or a person's), merged, closed. */
export type PrLook = "open" | "draft" | "merged" | "closed";

export const prLookOf = (pr: ThreadPr | undefined): PrLook => {
  if (pr === undefined) return "open";
  switch (pr.state) {
    case "open":
      return pr.draft ? "draft" : "open";
    case "merged":
      return "merged";
    case "closed_unmerged":
      return "closed";
    default:
      return pr.state satisfies never;
  }
};

const iconOf = (look: PrLook): ReactNode => {
  const icon = "size-4 shrink-0 stroke-[1.75]";
  switch (look) {
    case "open":
      return <GitPullRequestIcon aria-hidden className={`${icon} text-green`} />;
    case "draft":
      return <GitPullRequestDraftIcon aria-hidden className={`${icon} text-muted`} />;
    case "merged":
      return <GitMergeIcon aria-hidden className={`${icon} text-green`} />;
    case "closed":
      return <GitPullRequestClosedIcon aria-hidden className={`${icon} text-muted`} />;
    default:
      return look satisfies never;
  }
};

type Diff = RouterOutputs["diff"]["get"];

/** The PR's size: its repo's files in the Changes tab's compare, added up; `null` before it's in, or when the host cut the list. */
export const prSizeOf = (diff: Diff | undefined, repoId: string): { readonly added: number; readonly removed: number } | null => {
  const repo = diff?.repos.find((one) => one.repoId === repoId);
  if (repo?.state !== "ready" || repo.filesTruncated) return null;
  return repo.files.reduce((sum, file) => ({ added: sum.added + file.additions, removed: sum.removed + file.deletions }), { added: 0, removed: 0 });
};

/** The CI line's spinner while CI runs: milestone 8's 11px ring, still with reduced motion. */
const Spinner = () => <span aria-hidden className="size-[11px] shrink-0 animate-spin rounded-full border-[1.75px] border-line-2 border-t-teal motion-reduce:animate-none" />;

export const PrCard = ({ pr, ci }: { readonly pr: PullRequestData; readonly ci: HeadCi | null }) => {
  const trpc = useTRPC();
  const { workspace, results } = useThreadParts();
  // The Changes tab's own query (one cache): a head not compared yet is fetched, and read again shortly.
  const diff = useQuery({ ...trpc.diff.get.queryOptions({ taskId: workspace.taskId }), refetchInterval: (query) => (query.state.data?.repos.some((repo) => repo.state === "loading") === true ? 3000 : false) });
  const size = prSizeOf(diff.data, pr.repoId);
  const look = prLookOf(results?.prsOf(pr.repoId).find((one) => one.number === pr.number));
  const words = resultWords({ kind: "pr", pr }, t);
  const [number, ...title] = words.words;
  const href = safeHref(pr.url);
  return (
    <div data-part="pr-card" data-pr-look={look} className="mb-2.5 mt-1 max-w-[560px] rounded-[10px] border border-line-2 py-[9px] pl-3 pr-3.5">
      <div className="flex items-center gap-[9px] whitespace-nowrap text-body">
        {iconOf(look)}
        <span className="sr-only">{t(`task.result.prState.${look}`)}</span>
        {number === undefined ? null : href === null ? (
          <span className="shrink-0 font-mono text-[13.5px] text-teal">{number.text}</span>
        ) : (
          <a href={href} target="_blank" rel="noopener noreferrer nofollow" aria-label={t("task.result.prLink", { n: pr.number })} className="shrink-0 font-mono text-[13.5px] text-teal hover:underline">
            {number.text}
          </a>
        )}
        <span className="min-w-0 truncate font-medium"><Segments segments={title} /></span>
        {size === null ? null : (
          // The added and removed lines 9px apart, as the row's own gap (parts.md part 10).
          <span data-part="pr-size" className="ml-auto flex shrink-0 gap-[9px] font-mono text-[12.5px]" title={t("task.result.prSize", { added: size.added, removed: size.removed })}>
            {prSizeWords(size).filter((segment) => segment.text.trim() !== "").map((segment) => <span key={segment.text} className={toneClass(segment.tone)}>{segment.text}</span>)}
          </span>
        )}
      </div>
      {ci === null ? null : (
        <div data-part="pr-ci" data-ci={ci.state} className="ml-[25px] mt-1 flex items-center gap-2 whitespace-nowrap text-[13.5px] text-muted max-sm:whitespace-normal">
          {ci.state === "running" ? <Spinner /> : null}
          <span className="min-w-0 truncate max-sm:whitespace-normal">
            {/* The AI review's tail sits 8px after the line, as the target's flex gap sets it. */}
            {ciLine(ci, t, { aiReview: results?.aiReview ?? false }).map((segment, index) => (
              <span key={index} className={cn(toneClass(segment.tone), segment.mono && "font-mono text-[13px]", segment.text === " · " && "ml-1")}>{segment.text}</span>
            ))}
          </span>
        </div>
      )}
    </div>
  );
};
