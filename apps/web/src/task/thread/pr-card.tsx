"use client";

import { GitPullRequestIcon } from "lucide-react";

import type { PullRequestData } from "@ostra/task-view";

import { t } from "@/lib/messages";

import { SafeLink } from "../renderers";
import { Segments } from "./segments";
import { ciLine, resultWords } from "./words";
import type { HeadCi } from "./words";

// Owner: ticket 14 (milestone 10, F-151: the PR card, parts.md part 10, choice 8). Ticket 09's stub,
// with its final props: once, under the push that opened it, the number as a link, the title,
// and the live CI line in jobs. Ticket 14 adds its size, a draft's and a merge's icons, and the
// AI review's tail.

export const PrCard = ({ pr, ci, aiReview = false }: { readonly pr: PullRequestData; readonly ci: HeadCi | null; readonly aiReview?: boolean }) => {
  const words = resultWords({ kind: "pr", pr }, t);
  const [number, ...title] = words.words;
  return (
    <div data-part="pr-card" className="mb-2.5 mt-1 max-w-[560px] rounded-[10px] border border-line-2 py-[9px] pl-3 pr-3.5">
      <div className="flex items-center gap-[9px] whitespace-nowrap text-body">
        <GitPullRequestIcon aria-hidden className="size-4 shrink-0 stroke-[1.75] text-green" />
        {number === undefined ? null : <span className="shrink-0 font-mono text-[13.5px]"><SafeLink href={pr.url}>{number.text}</SafeLink></span>}
        <span className="min-w-0 truncate font-medium"><Segments segments={title} /></span>
      </div>
      {ci === null ? null : (
        <div data-part="pr-ci" className="ml-[25px] mt-1 whitespace-nowrap text-[13.5px] text-muted">
          <Segments segments={ciLine(ci, t, { aiReview })} />
        </div>
      )}
    </div>
  );
};
