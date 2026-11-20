"use client";

import { ArrowUpRightIcon, ChevronRightIcon, CircleAlertIcon, GitMergeIcon, PaperclipIcon, RotateCcwIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { TicketStatusIcon } from "@/components/inbox/ticket-icons";
import { PropGroup, PropRow } from "@/components/shell/page-frame";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { formatTokens } from "@/lib/format";
import { plural, t } from "@/lib/messages";
import type { MessageKey } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";
import { formatSize } from "@/task/marker-words";

// The task page's milestone 2 pieces (task-ticket.md, task-reopen.md, task-limits.md; ticket 36):
// the ticket line and what the agent got, the box and the spend, the sync steps, the limit or crash
// that stopped the session, the restore conflict, and which call the composer makes.

export type TaskDetail = RouterOutputs["tasks"]["get"];
type Box = NonNullable<TaskDetail["box"]>;
type Spend = TaskDetail["spend"];
type SyncWrite = TaskDetail["sync"][number];

/** `11 min`, `2 h`. */
const left = (at: number, now: number): string => {
  const minutes = Math.max(1, Math.round((at - now) / 60_000));
  return minutes < 60 ? `${String(minutes)} min` : `${String(Math.round(minutes / 60))} h`;
};

const releaseReasonKey: Readonly<Record<string, MessageKey>> = {
  prs_closed: "taskPage.box.reason.prs_closed",
  idle_expired: "taskPage.box.reason.idle_expired",
  task_deleted: "taskPage.box.reason.task_deleted",
  requested: "taskPage.box.reason.requested",
};

/** The box's state in words: `Idle · stops in 11 min`, `Released · the PRs closed`. */
export const boxText = (box: Box, now: number): string => {
  switch (box.state) {
    case "starting":
      return t("taskPage.box.starting");
    case "running":
      return t("taskPage.box.running");
    case "idle":
      return box.idleStopDueAt === null ? t("taskPage.box.idle") : t("taskPage.box.idleStops", { left: left(box.idleStopDueAt, now) });
    case "stopped":
      return t("taskPage.box.stopped");
    case "released": {
      const key = box.releaseReason === null ? undefined : releaseReasonKey[box.releaseReason];
      return key === undefined ? t("taskPage.box.released") : t("taskPage.box.releasedWhy", { reason: t(key) });
    }
    case "failed":
      return t("taskPage.box.failed");
    default:
      return box.state satisfies never;
  }
};

/** The header's idle line: `Idle, the box stops in 11 min`, or nothing when the box isn't idle. */
export const idleHeader = (box: TaskDetail["box"], now: number): string | null =>
  box?.state === "idle" && box.idleStopDueAt !== null ? t("taskPage.box.idleHeader", { left: left(box.idleStopDueAt, now) }) : null;

const usd = (micro: number): string => `$${(micro / 1_000_000).toFixed(2)}`;

/** `$0.84 of $25.00`, or tokens when the model has no price. */
export const spendText = (spend: Spend): string =>
  spend.unit === "usd" ? t("taskPage.spendOf", { spent: usd(spend.spent), cap: usd(spend.cap) }) : t("taskPage.spendOf", { spent: formatTokens(spend.spent), cap: formatTokens(spend.cap) });

/** The ticket line under the title: its status, and a link to it on Linear. */
export const TicketLine = ({ ticket }: { readonly ticket: NonNullable<TaskDetail["ticket"]> }) => (
  <p className="mt-3 flex flex-wrap items-center gap-2 text-body" data-testid="task-ticket">
    <span className="inline-flex h-[26px] items-center gap-1.5 rounded-md border border-line-2 px-2.5 text-ui text-muted">
      <TicketStatusIcon category={ticket.status.category} />
      {ticket.status.name ?? "–"}
    </span>
    {ticket.removed ? <span className="text-ui text-faint">{t("taskPage.ticketRemoved")}</span> : null}
    <a href={ticket.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-ui text-teal hover:underline">
      {t("taskPage.openInLinear")}
      <ArrowUpRightIcon aria-hidden className="size-[14px] stroke-[1.75]" />
    </a>
  </p>
);

/** "What the agent got": collapsed by default; the ticket's files when it has any. */
export const AgentGot = ({ files }: { readonly files: TaskDetail["contextFiles"] }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3" data-testid="agent-got">
      <button type="button" aria-expanded={open} onClick={() => { setOpen(!open); }} className="flex flex-wrap items-center gap-x-2.5 text-left text-ui">
        <ChevronRightIcon aria-hidden className={cn("size-[15px] stroke-[1.75] text-muted transition-transform", open && "rotate-90")} />
        <span className="font-semibold text-text">{t("taskPage.agentGot")}</span>
        <span className="text-muted">
          {t("taskPage.agentGotSummary")}
          {files.length === 0 ? "" : `, ${plural(files.length, "taskPage.agentGotFiles.one", "taskPage.agentGotFiles.other")}`}
        </span>
        <span className="text-faint">· {t("taskPage.agentGotTemplate")}</span>
      </button>
      {open && files.length > 0 ? (
        <ul className="mt-2 space-y-1 pl-[25px]">
          {files.map((file) => (
            <li key={file.blobId} className="flex items-center gap-2 text-ui text-muted">
              <PaperclipIcon aria-hidden className="size-[13px] stroke-[1.75]" />
              <span className="font-mono text-text">.ostra/ticket/{file.name}</span>
              <span className="font-mono text-xs text-faint">{formatSize(file.size)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
};

const syncKey: Readonly<Record<SyncWrite["kind"], MessageKey>> = {
  move: "taskPage.sync.move",
  comment: "taskPage.sync.comment",
  comment_update: "taskPage.sync.comment_update",
  link_pr: "taskPage.sync.link_pr",
  link_task: "taskPage.sync.link_task",
  create: "taskPage.sync.create",
};

const syncState: Readonly<Record<SyncWrite["state"], { readonly key: MessageKey; readonly tone: string }>> = {
  done: { key: "taskPage.sync.done", tone: "text-green" },
  pending: { key: "taskPage.sync.pending", tone: "text-faint" },
  failed: { key: "taskPage.sync.failed", tone: "text-red" },
};

/** The panel's Ticket and On Linear groups: the ticket, then one line per write with its state. */
export type TicketSync = Pick<TaskDetail, "ticket" | "sync"> & { readonly canRetry: boolean };

export const TicketProperties = ({ task, now, retry, createTicket }: {
  readonly task: TicketSync;
  readonly now: number;
  readonly retry: { readonly run: () => void; readonly pending: boolean };
  readonly createTicket: { readonly run: () => void; readonly pending: boolean; readonly error: string | null } | null;
}) => (
  <>
    {task.ticket === null ? (
      createTicket === null ? null : (
        <PropGroup title={t("taskPage.ticketGroup")}>
          <Button variant="link" className="h-auto px-0 text-ui" disabled={createTicket.pending} onClick={createTicket.run}>
            {createTicket.pending ? t("taskPage.creatingTicket") : t("taskPage.createTicket")}
          </Button>
          {createTicket.error === null ? null : <p role="alert" className="mt-1 text-sm text-red">{createTicket.error}</p>}
        </PropGroup>
      )
    ) : (
      <PropGroup title={t("taskPage.ticketGroup")}>
        <PropRow label={t("taskPage.ticketKey")}>
          <a href={task.ticket.url} target="_blank" rel="noopener noreferrer" className="font-mono text-teal hover:underline">
            {task.ticket.key}
          </a>
        </PropRow>
        <PropRow label={t("taskPage.ticketStatus")}>{task.ticket.status.name ?? "–"}</PropRow>
        <PropRow label={t("taskPage.synced")}>
          <span className="font-mono">{Math.max(0, Math.round((now - task.ticket.cachedAt) / 1000)) < 60 ? `${String(Math.max(0, Math.round((now - task.ticket.cachedAt) / 1000)))} s ago` : `${String(Math.round((now - task.ticket.cachedAt) / 60_000))} min ago`}</span>
        </PropRow>
      </PropGroup>
    )}
    {task.sync.length === 0 ? null : (
      <PropGroup title={t("taskPage.onLinear")}>
        <ul data-testid="sync-steps">
          {task.sync.map((write) => (
            <li key={write.id} className="flex min-h-[26px] items-center justify-between gap-3 text-ui" data-state={write.state}>
              <span className="truncate text-text" title={write.error ?? undefined}>{t(syncKey[write.kind])}</span>
              <span className={cn("shrink-0 text-sm", syncState[write.state].tone)}>{t(syncState[write.state].key)}</span>
            </li>
          ))}
        </ul>
        {task.canRetry ? (
          <Button variant="link" className="mt-1.5 h-auto px-0 text-ui" disabled={retry.pending} onClick={retry.run}>
            {retry.pending ? t("taskPage.sync.retrying") : t("taskPage.sync.retry")}
          </Button>
        ) : null}
      </PropGroup>
    )}
  </>
);

/** The limit or crash that stopped the session, as the needs-you block it raised, with its action. */
/** What the limit block reads: why the session stopped, the spend, and whether one click reopens it. */
export type LimitState = Pick<TaskDetail, "state" | "reason" | "limit" | "spend"> & { readonly lostBox: boolean; readonly reopenWithoutText: boolean };

export const limitStateOf = (task: TaskDetail): LimitState => ({
  state: task.state,
  reason: task.reason,
  limit: task.limit,
  spend: task.spend,
  lostBox: task.sessions[0]?.previousBox === "lost",
  reopenWithoutText: task.capabilities.reopenWithoutText,
});

export const LimitBlock = ({ task, reopen }: { readonly task: LimitState; readonly reopen: { readonly run: () => void; readonly pending: boolean; readonly error: string | null } }) => {
  const crashed = task.reason === "crashed";
  const what = crashed ? "crashed" : task.limit;
  if (what === null || task.state !== "needs_you") return null;
  const lost = crashed && task.lostBox;
  const body =
    what === "crashed"
      ? lost
        ? t("taskPage.limit.boxLostBody")
        : t("taskPage.limit.crashedBody")
      : what === "spend-cap"
        ? task.spend.unit === "usd"
          ? t("taskPage.limit.spend-capBody", { spent: usd(task.spend.spent), cap: usd(task.spend.cap) })
          : t("taskPage.limit.spend-capTokens", { spent: formatTokens(task.spend.spent), cap: formatTokens(task.spend.cap) })
        : t(`taskPage.limit.${what}Body`);
  return (
    <div role="region" aria-label={t("taskPage.limit.title", { what: t(`taskPage.limit.${what}`) })} className="mt-4 rounded-r-md border-l-(length:--rule-needs-you) border-amber bg-surface px-4 py-3" data-testid="limit-block" data-limit={what}>
      <div className="flex items-center gap-2 text-ui font-semibold text-amber-text">
        <CircleAlertIcon aria-hidden className="size-[14px] stroke-[1.75]" />
        {t("taskPage.limit.title", { what: t(`taskPage.limit.${what}`) })}
      </div>
      <p className="mt-1 text-body text-text">{body}</p>
      {task.reopenWithoutText ? (
        <Button variant="amber" className="mt-2.5" disabled={reopen.pending} onClick={reopen.run}>
          <RotateCcwIcon aria-hidden />
          {reopen.pending ? t("taskPage.limit.reopening") : t("taskPage.limit.reopen")}
        </Button>
      ) : null}
      {reopen.error === null ? null : <p role="alert" className="mt-2 text-sm text-red">{reopen.error}</p>}
    </div>
  );
};

/** A restore conflict waiting on the driver: show the saved work, or carry on without it. */
export const RestoreConflict = ({ savedWorkUrl, canAnswer, dismiss }: { readonly savedWorkUrl: string | null; readonly canAnswer: boolean; readonly dismiss: { readonly run: () => void; readonly pending: boolean } }) => (
  <div role="region" aria-label={t("taskPage.restoreConflict.title")} className={cn("mt-4 rounded-r-md bg-surface px-4 py-3", canAnswer ? "border-l-(length:--rule-needs-you) border-amber" : "border-l-2 border-line-2")} data-testid="restore-conflict">
    <div className={cn("flex items-center gap-2 text-ui font-semibold", canAnswer ? "text-amber-text" : "text-muted")}>
      <GitMergeIcon aria-hidden className="size-[14px] stroke-[1.75]" />
      {t("taskPage.restoreConflict.title")}
    </div>
    <p className="mt-1 text-body text-text">{t("taskPage.restoreConflict.body")}</p>
    {canAnswer ? (
      <div className="mt-2.5 flex flex-wrap gap-2">
        {savedWorkUrl === null ? null : (
          <a href={savedWorkUrl} target="_blank" rel="noopener noreferrer" className={buttonVariants()}>
            {t("taskPage.restoreConflict.show")}
          </a>
        )}
        <Button variant="amber" disabled={dismiss.pending} onClick={dismiss.run}>
          {t("taskPage.restoreConflict.dismiss")}
        </Button>
      </div>
    ) : null}
    <p className="mt-2 text-xs text-faint">{t("taskPage.restoreConflict.footnote")}</p>
  </div>
);

/** Which call the composer makes and what it says (task-reopen.md, "The composer: send or reopen"). */
export type ComposerMode =
  | { readonly kind: "send"; readonly hint: string | null }
  | { readonly kind: "reopen"; readonly hint: string }
  | { readonly kind: "merged"; readonly hint: string }
  | { readonly kind: "none" };

export type ComposerInput = Pick<TaskDetail, "state"> & { readonly send: boolean; readonly reopen: boolean; readonly boxState: Box["state"] | null };

export const composerInputOf = (task: TaskDetail): ComposerInput => ({ state: task.state, send: task.capabilities.send, reopen: task.capabilities.reopen, boxState: task.box?.state ?? null });

export const composerMode = (task: ComposerInput): ComposerMode => {
  if (task.send) return { kind: "send", hint: task.boxState === "idle" ? t("taskPage.composer.idleHint") : null };
  if (task.reopen) return { kind: "reopen", hint: t("taskPage.composer.reopenHint") };
  if (task.state === "merged") return { kind: "merged", hint: t("taskPage.composer.mergedHint") };
  return { kind: "none" };
};

/** The words of a reopen the server refused for a reason the page knows. */
export const reopenBlockedText = (blocked: TaskDetail["capabilities"]["reopenBlocked"]): string | null => {
  switch (blocked) {
    case "spend_cap":
      return t("taskPage.composer.spendCap");
    case "ticket_has_task":
      return t("taskPage.composer.ticketHasTask");
    case "merged_reopen_later":
      return t("taskPage.composer.mergedHint");
    case null:
      return null;
    default:
      return blocked satisfies never;
  }
};

/** A line of the header: the merged hint, with a link to the ticket in the Inbox when there is one. */
export const MergedHint = ({ inboxHref }: { readonly inboxHref: string | null }): ReactNode => (
  <p className="pt-3 text-sm text-faint" data-part="merged-hint">
    {t("taskPage.composer.mergedHint")}{" "}
    {inboxHref === null ? null : (
      <a href={inboxHref} className="text-teal hover:underline">
        {t("taskPage.composer.openInInbox")}
      </a>
    )}
  </p>
);
