"use client";

import { AppWindowIcon, CheckIcon, GitMergeIcon, GitPullRequestClosedIcon, GitPullRequestDraftIcon, GitPullRequestIcon, LinkIcon, Minimize2Icon, PanelRightIcon, ScanSearchIcon, SquareIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import type { TaskId } from "@ostra/protocol";

import { Button, buttonVariants } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";
import { safeHref } from "@/task/renderers";

import { TakeItLocal } from "./take-it-local";
import type { LocalLoad } from "./take-it-local";
import { prIsDraft } from "./task-properties";

// Owner: ticket 15 (milestone 10, F-151: a review task's top bar, parts.md part 15). Ticket 09 moved
// the task page's top-bar actions here from `task-view.tsx` unchanged, so ticket 15 can change them
// on its own.

type Task = RouterOutputs["tasks"]["get"];

/** The task page's side pane (task-preview.md): the preview, or the properties. */
export type SidePaneChoice = "preview" | "properties";

/** The ghost icon button left of the PR: copies the task's address. */
const CopyLink = () => {
  const [copied, setCopied] = useState(false);
  const label = copied ? t("taskPage.linkCopied") : t("taskPage.copyLink");
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      data-action="copy-link"
      onClick={() => {
        void navigator.clipboard.writeText(window.location.href).then(() => {
          setCopied(true);
          setTimeout(() => { setCopied(false); }, 1500);
        });
      }}
    >
      {copied ? <CheckIcon /> : <LinkIcon />}
    </Button>
  );
};

/** A PR the top bar links to: the repo's current one, with a safe address. */
type BarPr = { readonly number: number; readonly href: string; readonly state: "open" | "merged" | "closed"; readonly repo: string; readonly draft: boolean };

const PrStateIcon = ({ state }: { readonly state: BarPr["state"] }) => {
  const className = "size-[15px] shrink-0 stroke-[1.75] text-muted";
  switch (state) {
    case "open":
      return <GitPullRequestIcon aria-hidden className={className} />;
    case "merged":
      return <GitMergeIcon aria-hidden className={className} />;
    case "closed":
      return <GitPullRequestClosedIcon aria-hidden className={className} />;
    default:
      return state satisfies never;
  }
};

/**
 * The top bar's PR buttons (task.md): one per PR. At phone width several collapse into one
 * `PRs · n` button that opens a bottom sheet listing them (m2/phone-task.md, "Top bar"), so the
 * bar never scrolls sideways.
 */
const PrButtons = ({ prs }: { readonly prs: readonly BarPr[] }) => {
  const button = (pr: BarPr, className?: string) => (
    <a key={`${pr.repo}#${String(pr.number)}`} href={pr.href} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants(), className)}>
      {pr.draft ? <GitPullRequestDraftIcon /> : <GitPullRequestIcon />} {t("taskPage.prButton", { n: pr.number })}
    </a>
  );
  if (prs.length < 2) return <>{prs.map((pr) => button(pr))}</>;
  return (
    <>
      {prs.map((pr) => button(pr, "max-sm:hidden"))}
      <Sheet>
        <SheetTrigger asChild>
          <Button className="sm:hidden" data-action="task-prs">
            <GitPullRequestIcon aria-hidden /> {t("taskPage.prsButton", { n: prs.length })}
          </Button>
        </SheetTrigger>
        <SheetContent side="bottom" title={t("taskPage.prsTitle")} className="px-4 pb-6 pt-4">
          <h2 className="text-ui font-semibold text-text">{t("taskPage.prsTitle")}</h2>
          <ul className="mt-2">
            {prs.map((pr) => (
              <li key={`${pr.repo}#${String(pr.number)}`} className="flex h-10 items-center gap-2 border-b border-line text-ui last:border-b-0">
                <PrStateIcon state={pr.state} />
                <span className="min-w-0 truncate font-mono text-text">{pr.repo}</span>
                <a href={pr.href} target="_blank" rel="noopener noreferrer" className="shrink-0 font-mono text-teal hover:underline">#{pr.number}</a>
                <span className="ml-auto shrink-0 text-muted">{t(`taskPage.prState.${pr.state}`)}</span>
              </li>
            ))}
          </ul>
        </SheetContent>
      </Sheet>
    </>
  );
};

/**
 * The task page's top-bar actions (task.md; task-preview.md): with the preview expanded, the `esc`
 * hint, Collapse and Stop; otherwise a code task's `Preview | Properties` toggle, the copy link,
 * `Take it local`, the review screen's button while a PR is open, the PR buttons and Stop.
 */
export const TaskTopBar = ({ task, expanded, side, onSide, onCollapse, stop, local }: {
  readonly task: Task;
  /** The preview fills the page (`&view=full`). */
  readonly expanded: boolean;
  /** The side pane shown, for a code task's toggle; `null` for a task with no preview. */
  readonly side: SidePaneChoice | null;
  readonly onSide: (side: SidePaneChoice) => void;
  readonly onCollapse: () => void;
  /** Stop's press: `stopping` from the press until the task stopped. */
  readonly stop: { readonly stopping: boolean; readonly pending: boolean; readonly run: () => void };
  /** `Take it local`: what it shows once opened, and its opening. */
  readonly local: { readonly load: LocalLoad; readonly onOpen: () => void };
}) => {
  const taskId: TaskId = task.id;
  const stopped = task.state === "stopped";
  const prs = task.repos.flatMap((repo): BarPr[] => {
    const href = repo.pr === null ? null : safeHref(repo.pr.url);
    return repo.pr === null || href === null ? [] : [{ number: repo.pr.number, href, state: repo.pr.state, repo: repo.fullName, draft: prIsDraft(repo) }];
  });
  const sideToggle = side === null ? null : (
    <ToggleGroup
      type="single"
      value={side}
      aria-label={t("task.preview.side")}
      onValueChange={(value) => { if (value === "preview" || value === "properties") onSide(value); }}
      className="h-7 max-lg:hidden"
      data-testid="side-pane-toggle"
    >
      <ToggleGroupItem value="preview" aria-label={t("task.preview.sidePreview")} className="flex items-center gap-1.5 px-2.5 text-[13px] [&_svg]:size-[15px] [&_svg]:stroke-[1.75]">
        <AppWindowIcon aria-hidden /> <span className="max-md:hidden">{t("task.preview.sidePreview")}</span>
      </ToggleGroupItem>
      <ToggleGroupItem value="properties" aria-label={t("task.preview.sideProperties")} className="flex items-center gap-1.5 px-2.5 text-[13px] [&_svg]:size-[15px] [&_svg]:stroke-[1.75]">
        <PanelRightIcon aria-hidden /> <span className="max-md:hidden">{t("task.preview.sideProperties")}</span>
      </ToggleGroupItem>
    </ToggleGroup>
  );
  const stopButton = task.capabilities.stop && !stopped ? (
    <Button data-action="stop" onClick={stop.run} disabled={stop.stopping || stop.pending} aria-label={stop.stopping ? t("taskPage.stopping") : t("taskPage.stop")}>
      <SquareIcon aria-hidden /> <span className="max-sm:hidden">{stop.stopping ? t("taskPage.stopping") : t("taskPage.stop")}</span>
    </Button>
  ) : null;
  return expanded ? (
    <>
      <span className="text-[13px] text-faint max-lg:hidden">{t("task.preview.press")}</span>
      <Kbd className="rounded-sm border border-line-2 px-1.5 py-0.5 max-lg:hidden">esc</Kbd>
      <Button onClick={onCollapse} data-action="collapse-preview">
        <Minimize2Icon aria-hidden /> <span className="max-sm:hidden">{t("task.preview.collapse")}</span>
      </Button>
      {stopButton}
    </>
  ) : (
    <>
      {sideToggle}
      <CopyLink />
      <TakeItLocal pushed={task.repos.some((repo) => repo.headSha !== null)} load={local.load} onOpen={local.onOpen} />
      {task.kind === "code" && task.repos.some((repo) => repo.pr?.state === "open") ? (
        <Link href={`/tasks/${taskId}/review`} className={buttonVariants()} aria-label={t("review.button")} data-action="open-review">
          <ScanSearchIcon aria-hidden /> <span className="max-sm:hidden">{t("review.button")}</span>
        </Link>
      ) : null}
      <PrButtons prs={prs} />
      {stopButton}
    </>
  );
};
