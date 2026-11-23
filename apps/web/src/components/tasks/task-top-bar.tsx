"use client";

import { AppWindowIcon, ArrowUpRightIcon, CheckIcon, GitMergeIcon, GitPullRequestClosedIcon, GitPullRequestDraftIcon, GitPullRequestIcon, LinkIcon, Minimize2Icon, PanelRightIcon, SquareIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";


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
import type { Reviewed } from "./task-heading";
import { prIsDraft } from "./task-properties";

// Owner: ticket 15 (milestone 10, F-151/c7: a review task's top bar, the README's choice 10). Ticket
// 09 moved the task page's top-bar actions here from `task-view.tsx`. A code task's as each scene
// draws it (`Preview | Properties`, copy link, `PR #483`, `Take it local`, `Stop`); a review task's
// says only what a review does (`s3.md`: copy link, `Properties`, `Open the code task`, `PR #483`);
// a refine task has nothing to take local.

type Task = RouterOutputs["tasks"]["get"];

/** The task page's side pane (task-preview.md): the preview, or the properties. */
export type SidePaneChoice = "preview" | "properties";

/** A top-bar button's size (milestone 8's `.btn.sm`): 28px, 10px in, 13px. */
const barButton = "h-7 px-2.5 text-[13px]";

/** The ghost icon button left of the PR: copies the task's address. */
const CopyLink = () => {
  const [copied, setCopied] = useState(false);
  const label = copied ? t("taskPage.linkCopied") : t("taskPage.copyLink");
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7"
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
    <a key={`${pr.repo}#${String(pr.number)}`} href={pr.href} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants(), barButton, className)}>
      {pr.draft ? <GitPullRequestDraftIcon /> : <GitPullRequestIcon />} {t("taskPage.prButton", { n: pr.number })}
    </a>
  );
  if (prs.length < 2) return <>{prs.map((pr) => button(pr))}</>;
  return (
    <>
      {prs.map((pr) => button(pr, "max-sm:hidden"))}
      <Sheet>
        <SheetTrigger asChild>
          <Button className={cn(barButton, "sm:hidden")} data-action="task-prs">
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

/** A review task's `Properties` (`s3.md`): one toggle, pressed while the panel shows, since there's no app to preview. */
const PropertiesToggle = ({ on, onToggle }: { readonly on: boolean; readonly onToggle: () => void }) => (
  <Button
    aria-pressed={on}
    onClick={onToggle}
    data-action="properties-toggle"
    className={cn(barButton, "aria-pressed:bg-sel max-lg:hidden [&_svg]:stroke-[1.75]")}
  >
    <PanelRightIcon aria-hidden /> <span className="max-md:hidden">{t("task.preview.sideProperties")}</span>
  </Button>
);

/**
 * The task page's top-bar actions (task.md; task-preview.md; parts.md part 15): with the preview
 * expanded, the `esc` hint, Collapse and Stop. Otherwise a code task's `Preview | Properties`
 * toggle, the copy link, the review screen's button while a PR is open (milestone 6), the PR
 * buttons, `Take it local` and Stop; a review task's copy link, `Properties`, `Open the code task`,
 * the PR it reviews and Stop; a refine task's copy link and Stop. Stop shows while a session is
 * live (`capabilities.stop`), never once the task stopped.
 */
export const TaskTopBar = ({ task, expanded, side, onSide, onCollapse, stop, local, reviewed = null, properties = null }: {
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
  /** A review task's code task and the PR it reviews (`reviewedOf`); `null` on any other kind. */
  readonly reviewed?: Reviewed | null;
  /** A review task's `Properties` toggle: whether the panel shows, and its press; `null` without one. */
  readonly properties?: { readonly on: boolean; readonly onToggle: () => void } | null;
}) => {
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
  // s6.md: on a phone `Stop` and `Take it local` live in the composer's `…` menu, not the bar.
  const stopButton = task.capabilities.stop && !stopped ? (
    <Button className={cn(barButton, "max-sm:hidden")} data-action="stop" onClick={stop.run} disabled={stop.stopping || stop.pending} aria-label={stop.stopping ? t("taskPage.stopping") : t("taskPage.stop")}>
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
  ) : task.kind === "review" ? (
    <>
      <CopyLink />
      {properties === null ? null : <PropertiesToggle on={properties.on} onToggle={properties.onToggle} />}
      {reviewed === null ? null : (
        <Link
          href={`/tasks/${reviewed.codeTask.id}`}
          className={cn(buttonVariants(), barButton)}
          aria-label={t("review.followUp.openCodeTask")}
          title={t("taskPage.codeTaskTitle", { key: reviewed.codeTask.key, title: reviewed.codeTask.title })}
          data-action="open-code-task"
        >
          <ArrowUpRightIcon aria-hidden /> <span className="max-sm:hidden">{t("review.followUp.openCodeTask")}</span>
        </Link>
      )}
      <PrButtons prs={(reviewed?.prs ?? []).map((pr): BarPr => ({ ...pr, state: "open", draft: false }))} />
      {stopButton}
    </>
  ) : (
    <>
      {sideToggle}
      <CopyLink />

      <PrButtons prs={prs} />
      {task.kind === "code" ? (
        <span className="max-sm:hidden">
          <TakeItLocal pushed={task.repos.some((repo) => repo.headSha !== null)} load={local.load} onOpen={local.onOpen} />
        </span>
      ) : null}
      {stopButton}
    </>
  );
};
