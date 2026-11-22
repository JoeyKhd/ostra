"use client";

import { ArrowUpRightIcon, ChevronRightIcon, CircleCheckIcon, CircleIcon, CircleXIcon, GitMergeIcon, GitPullRequestClosedIcon, GitPullRequestIcon, PaperclipIcon, SlidersHorizontalIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { TicketStatusIcon } from "@/components/inbox/ticket-icons";
import { Sheet, SheetClose, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/cn";
import { formatClock } from "@/lib/format";
import { plural, t } from "@/lib/messages";
import type { MessageKey } from "@/lib/messages";
import { safeHref } from "@/task/renderers";
import { formatSize } from "@/task/marker-words";

import { reviewCheckText } from "./task-prs";
import { trackerName } from "./task-ticket";
import type { TaskDetail } from "./task-ticket";

// F-075, F-064, F-031 (m2's `phone-task` target): on a phone, a ticket task's Ticket, Sync on Linear
// and Pull requests come first, above the thread: what state the ticket is in, that the tracker is in
// step, and the PRs. Each is a section, a 13px title over 44px rows with a hairline under each (the
// target draws 40px; F-075's touch rule makes them 44). Under 640px only: wider, the header's ticket
// strip and the properties panel say the same. The properties panel doesn't stack under the thread
// there: a `Details` row, the Ticket section's last (a row of its own without a ticket), opens it
// as a bottom sheet.

type SyncWrite = TaskDetail["sync"][number];
type Repo = TaskDetail["repos"][number];

/** The steps' words, as the properties panel's On Linear group says them (task-ticket.md wins on copy). */
const syncStep: Readonly<Record<SyncWrite["kind"], MessageKey>> = {
  move: "taskPage.sync.move",
  comment: "taskPage.sync.comment",
  comment_update: "taskPage.sync.comment_update",
  link_pr: "taskPage.sync.link_pr",
  link_task: "taskPage.sync.link_task",
  create: "taskPage.sync.create",
};

const Section = ({ title, testId, children }: { readonly title: string; readonly testId: string; readonly children: ReactNode }) => (
  <section className="mt-5" data-testid={testId}>
    <h2 className="mb-0.5 text-sm font-semibold text-text">{title}</h2>
    <ul>{children}</ul>
  </section>
);

const rowClass = "flex min-h-11 items-center gap-3 border-b border-line py-2 text-ui";

/**
 * `Details` (phone-task.md, "What leaves the page at this width"): `sliders-horizontal`, the word and
 * `chevron-right`; it opens the properties panel as a bottom sheet, with its grab handle to close it.
 */
const DetailsRow = ({ details }: { readonly details: ReactNode }) => (
  <li className="border-b border-line">
    <Sheet>
      <SheetTrigger asChild>
        <button type="button" className="flex min-h-11 w-full items-center gap-3 py-2 text-left text-ui" data-action="task-details">
          <SlidersHorizontalIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-muted" />
          <span className="min-w-0 flex-1 text-text">{t("taskPage.phone.details")}</span>
          <ChevronRightIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-faint" />
        </button>
      </SheetTrigger>
      <SheetContent
        side="bottom"
        title={t("taskPage.phone.details")}
        closeButton={false}
        className="px-4 pt-6 pb-[max(16px,env(safe-area-inset-bottom))]"
        data-testid="task-details-sheet"
        // The sheet takes the focus, not its grab handle: a tap opened it, not a key.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
        }}
      >
        <SheetClose asChild>
          <button type="button" aria-label={t("common.close")} className="absolute left-1/2 top-0 grid h-5 w-14 -translate-x-1/2 place-items-center rounded-sm">
            <span aria-hidden className="h-1 w-9 rounded-sm bg-line-2" />
          </button>
        </SheetClose>
        {details}
      </SheetContent>
    </Sheet>
  </li>
);

/** The Ticket section: its status on the tracker with a link to it, what the agent got, which opens, and Details. */
const TicketSection = ({ ticket, files, details, agentGot }: { readonly ticket: NonNullable<TaskDetail["ticket"]>; readonly files: TaskDetail["contextFiles"]; readonly details: ReactNode; readonly agentGot: boolean }) => {
  const [open, setOpen] = useState(false);
  const tracker = trackerName(ticket.tracker);
  const href = safeHref(ticket.url);
  return (
    <Section title={t("taskPage.ticketGroup")} testId="phone-ticket">
      <li className={rowClass}>
        <TicketStatusIcon category={ticket.status.category} className="size-[15px] shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate text-text">
          {ticket.removed ? t("taskPage.ticketRemoved") : t("taskPage.phone.statusOn", { status: ticket.status.name ?? "–", tracker })}
        </span>
        {href === null ? null : (
          <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0 items-center gap-1 text-teal hover:underline">
            {t("taskPage.phone.openIn", { tracker })}
            <ArrowUpRightIcon aria-hidden className="size-[14px] stroke-[1.75]" />
          </a>
        )}
      </li>
      {agentGot ? <li className="border-b border-line">
        <button type="button" aria-expanded={open} onClick={() => { setOpen(!open); }} className="flex min-h-11 w-full items-center gap-3 py-2 text-left text-ui" data-testid="phone-agent-got">
          <ChevronRightIcon aria-hidden className={cn("size-[15px] shrink-0 stroke-[1.75] text-muted transition-transform", open && "rotate-90")} />
          <span className="shrink-0 text-text">{t("taskPage.agentGot")}</span>
          <span className="min-w-0 flex-1 truncate text-right text-xs text-faint">
            {t("taskPage.agentGotSummary")}
            {files.length === 0 ? "" : `, ${plural(files.length, "taskPage.agentGotFiles.one", "taskPage.agentGotFiles.other")}`}
          </span>
        </button>
        {open ? (
          <div className="mb-2.5 ml-[27px] rounded-lg border border-line bg-surface px-3 py-2 text-sm text-muted">
            <p>{t("taskPage.agentGotTemplate")}</p>
            {files.length === 0 ? null : (
              <ul className="mt-1.5 space-y-1">
                {files.map((file) => (
                  <li key={file.blobId} className="flex min-w-0 items-center gap-2">
                    <PaperclipIcon aria-hidden className="size-[13px] shrink-0 stroke-[1.75]" />
                    <span className="min-w-0 truncate font-mono text-text">{file.name}</span>
                    <span className="shrink-0 font-mono text-xs text-faint">{formatSize(file.size)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </li> : null}
      <DetailsRow details={details} />
    </Section>
  );
};

const SyncMark = ({ state }: { readonly state: SyncWrite["state"] }) => {
  const mark = "mt-[2px] size-[15px] shrink-0 stroke-[1.75] self-start";
  switch (state) {
    case "done":
      return <CircleCheckIcon aria-hidden className={cn(mark, "text-green")} />;
    case "pending":
      return <CircleIcon aria-hidden className={cn(mark, "text-faint")} />;
    case "failed":
      return <CircleXIcon aria-hidden className={cn(mark, "text-red")} />;
    default:
      return state satisfies never;
  }
};

/**
 * Sync on Linear: one row per write to the tracker, its mark (done in green, pending in `--faint`,
 * failed in red), its step, and on the right when it landed, or `Retry sync` on a failed one.
 */
const SyncSection = ({ tracker, sync, retry }: {
  readonly tracker: string;
  readonly sync: readonly SyncWrite[];
  readonly retry: { readonly run: () => void; readonly pending: boolean } | null;
}) => (
  <Section title={t("taskPage.phone.syncOn", { tracker })} testId="phone-sync">
    {sync.map((write) => {
      const at = write.doneAt ?? write.createdAt;
      return (
        <li key={write.id} className={rowClass} data-state={write.state}>
          <SyncMark state={write.state} />
          <span className={cn("min-w-0 flex-1", write.state === "pending" ? "text-muted" : "text-text")}>
            {t(syncStep[write.kind])}
            <span className={cn(write.state === "failed" ? "text-red" : "text-faint")}> · {t(`taskPage.sync.${write.state}`)}</span>
          </span>
          {write.state === "failed" && retry !== null ? (
            <button type="button" className="-my-2 min-h-11 shrink-0 text-teal hover:underline disabled:text-faint" disabled={retry.pending} onClick={retry.run}>
              {retry.pending ? t("taskPage.sync.retrying") : t("taskPage.sync.retry")}
            </button>
          ) : (
            <span className="shrink-0 font-mono text-xs text-faint">{formatClock(at)}</span>
          )}
        </li>
      );
    })}
  </Section>
);

/** A PR's mark by its state: open, merged, or closed without merging. */
const PrMark = ({ state }: { readonly state: Repo["pullRequests"][number]["state"] }) => {
  const mark = "size-[15px] shrink-0 stroke-[1.75] text-muted";
  switch (state) {
    case "open":
      return <GitPullRequestIcon aria-hidden className={mark} />;
    case "merged":
      return <GitMergeIcon aria-hidden className={mark} />;
    case "closed_unmerged":
      return <GitPullRequestClosedIcon aria-hidden className={mark} />;
    default:
      return state satisfies never;
  }
};

/** Pull requests: each repo the task changes, with its newest PR's number and state, or `None yet`. */
const PrSection = ({ repos }: { readonly repos: readonly Repo[] }) => (
  <Section title={t("taskPage.phone.pullRequests")} testId="phone-prs">
    {repos.map((repo) => {
      const pr = repo.pullRequests.at(-1);
      const href = pr === undefined ? null : safeHref(pr.url);
      return (
        <li key={repo.repoId} className={cn(rowClass, "flex-wrap gap-y-0.5")} data-repo={repo.fullName}>
          {pr === undefined ? <GitPullRequestIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-faint" /> : <PrMark state={pr.state} />}
          <span className="flex min-w-0 flex-1 items-center gap-2.5">
            <span className="min-w-0 truncate font-mono text-[13px] text-text">{repo.fullName}</span>
            {pr === undefined ? null : href === null ? (
              <span className="shrink-0 font-mono text-[13px]">#{pr.number}</span>
            ) : (
              <a href={href} target="_blank" rel="noopener noreferrer" className="shrink-0 font-mono text-[13px] text-teal hover:underline">#{pr.number}</a>
            )}
          </span>
          <span className={cn("shrink-0", pr === undefined ? "text-faint" : "text-muted")} data-pr-state={pr?.state}>
            {pr === undefined ? t("taskPage.phone.noPrYet") : pr.draft ? t("taskPrs.draft") : t(`taskPrs.state.${pr.state}`)}
          </span>
          {pr?.reviewCheck === null || pr?.reviewCheck === undefined ? null : (
            <span className="basis-full pl-[27px] text-xs text-muted" data-testid="phone-review-check">{reviewCheckText(pr.reviewCheck)}</span>
          )}
        </li>
      );
    })}
  </Section>
);

/**
 * The phone's sections above the thread, in the target's order: Ticket (a ticket task), Sync on
 * Linear (once something was written), Pull requests (once the task has a repo). A prompt task has
 * only Pull requests; a refine task writes nothing it shows here (its draft is its own tab).
 * `details` is the properties panel, which the `Details` row opens: the Ticket section's last row,
 * or, with no ticket, a row of its own under the sections.
 */
export const PhoneTaskSections = ({ task, retry, details, agentGotInThread = false }: {
  readonly task: Pick<TaskDetail, "ticket" | "sync" | "repos" | "contextFiles" | "kind"> & { readonly canRetry: boolean };
  readonly retry: { readonly run: () => void; readonly pending: boolean };
  readonly details: ReactNode;
  /** Milestone 9 (ticket 16): "What the agent got" is the thread's first message, so the section leaves its row out. */
  readonly agentGotInThread?: boolean;
}) => {
  const refine = task.kind === "refine";
  return (
    <div className="sm:hidden" data-testid="phone-task-sections">
      {task.ticket === null ? null : <TicketSection ticket={task.ticket} files={task.contextFiles} details={details} agentGot={!agentGotInThread} />}
      {task.ticket === null || refine || task.sync.length === 0 ? null : (
        <SyncSection tracker={trackerName(task.ticket.tracker)} sync={task.sync} retry={task.canRetry ? retry : null} />
      )}
      {refine || task.repos.length === 0 ? null : <PrSection repos={task.repos} />}
      {task.ticket === null ? (
        <ul className="mt-4 border-t border-line">
          <DetailsRow details={details} />
        </ul>
      ) : null}
    </div>
  );
};
