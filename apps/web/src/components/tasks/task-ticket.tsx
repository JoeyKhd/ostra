"use client";

import { ChevronRightIcon, CircleAlertIcon, GitMergeIcon, PaperclipIcon, RotateCcwIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { CategorySquare } from "@/components/boards/jira-mapping";
import { TicketStatusIcon } from "@/components/inbox/ticket-icons";
import { PropGroup, PropRow } from "@/components/shell/page-frame";
import { TrackerMark, trackerMarkAt } from "@/components/trackers/tracker-mark";
import { Button, buttonVariants } from "@/components/ui/button";
import { NeedsYou } from "@/components/ui/needs-you";
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
  return minutes < 60 ? t("units.minutes", { n: minutes }) : t("units.hours", { n: Math.round(minutes / 60) });
};

const releaseReasonKey: Readonly<Record<string, MessageKey>> = {
  prs_closed: "taskPage.box.reason.prs_closed",
  idle_expired: "taskPage.box.reason.idle_expired",
  task_deleted: "taskPage.box.reason.task_deleted",
  requested: "taskPage.box.reason.requested",
  session_ended: "taskPage.box.reason.session_ended",
};

/** A ticket's tracker as `tasks.get` answers it (milestone 11, ticket-chips.md): its board's connection. */
export type TicketConnection = NonNullable<NonNullable<TaskDetail["ticket"]>["connection"]>;

/** The tracker a ticket came from, by name (task-ticket.md: `CALC-174 · from Linear`, Jira's `from Jira`). */
export const trackerName = (kind: TicketConnection["kind"]): string => {
  switch (kind) {
    case "linear":
      return t("taskPage.tracker.linear");
    case "jira":
      return t("taskPage.tracker.jira");
    default:
      return kind satisfies never;
  }
};

/**
 * The box's state and what follows it (milestone 10's Session group, parts.md part 15): `Idle` and
 * `stops in 11 min`, `Released` and `the PRs closed`; `null` when nothing follows.
 */
export const boxParts = (box: Box, now: number): { readonly state: string; readonly detail: string | null } => {
  switch (box.state) {
    case "starting":
      return { state: t("taskPage.box.starting"), detail: null };
    case "running":
      return { state: t("taskPage.box.running"), detail: null };
    case "idle":
      return { state: t("taskPage.box.idle"), detail: box.idleStopDueAt === null ? null : t("taskPage.box.stopsIn", { left: left(box.idleStopDueAt, now) }) };
    case "stopped":
      return { state: t("taskPage.box.stopped"), detail: null };
    case "released": {
      const key = box.releaseReason === null ? undefined : releaseReasonKey[box.releaseReason];
      return { state: t("taskPage.box.released"), detail: key === undefined ? null : t(key) };
    }
    case "failed":
      return { state: t("taskPage.box.failed"), detail: null };
    default:
      return box.state satisfies never;
  }
};

/** The box's state in words: `Idle · stops in 11 min`, `Released · the PRs closed`. */
export const boxText = (box: Box, now: number): string => {
  const { state, detail } = boxParts(box, now);
  return detail === null ? state : `${state} · ${detail}`;
};

/** The header's idle line: `Idle, the box stops in 11 min`, or nothing when the box isn't idle. */
export const idleHeader = (box: TaskDetail["box"], now: number): string | null =>
  box?.state === "idle" && box.idleStopDueAt !== null ? t("taskPage.box.idleHeader", { left: left(box.idleStopDueAt, now) }) : null;

const usd = (micro: number): string => `$${(micro / 1_000_000).toFixed(2)}`;

/** `$0.84 of $25.00`, or tokens when the model has no price. */
export const spendText = (spend: Spend): string =>
  spend.unit === "usd" ? t("taskPage.spendOf", { spent: usd(spend.spent), cap: usd(spend.cap) }) : t("taskPage.spendOf", { spent: formatTokens(spend.spent), cap: formatTokens(spend.cap) });

/**
 * The Spend row's value (m3/task-approval, "Tokens, Cache, Spend"): the spend, then ` of {cap}` in
 * `--muted`. Never amber at the cap: the needs-you block says so (task-limits.md).
 */
export const SpendValue = ({ spend }: { readonly spend: Spend }) => {
  const spent = spend.unit === "usd" ? usd(spend.spent) : formatTokens(spend.spent);
  const [, rest = ""] = spendText(spend).split(spent);
  return (
    <>
      <span className="font-mono">{spent}</span>
      <span className="text-muted">{rest}</span>
    </>
  );
};

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

/**
 * What a write's row says after its label (ticket-chips.md, "On Jira"): a move's `by Start progress`
 * (the transitions it took), a move that stayed put's line, or Jira's `remote link` for the task link.
 */
export const syncDetail = (write: SyncWrite, kind: TicketConnection["kind"] | null): string | null => {
  if (write.move?.kind === "moved") return write.move.via.length === 0 ? null : t("taskPage.sync.by", { names: write.move.via.map((one) => one.name).join(", ") });
  if (write.move?.kind === "stays") return write.move.line;
  return kind === "jira" && write.kind === "link_task" ? t("taskPage.sync.remoteLink") : null;
};

/** The panel's Ticket and On <tracker> groups: the ticket, then one line per write with its state. */
export type TicketSync = Pick<TaskDetail, "ticket" | "sync"> & { readonly canRetry: boolean };

export const TicketProperties = ({ task, now, retry, createTicket, context = null }: {
  readonly task: TicketSync;
  readonly now: number;
  readonly retry: { readonly run: () => void; readonly pending: boolean };
  readonly createTicket: { readonly run: () => void; readonly pending: boolean; readonly error: string | null } | null;
  /** Milestone 9 (ticket 16): the `Context` row and "Send ticket updates", after `Synced`. */
  readonly context?: ReactNode;
}) => {
  // The ticket's tracker, for the group's title and the on-tracker rows (ticket-chips.md).
  const connection = task.ticket?.connection ?? null;
  return (
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
        {connection === null ? null : (
          // 16px, in its brand colour, as the rows' 14px wildcard would shrink it: ticket-chips.md.
          <div className="grid min-h-8 grid-cols-[92px_minmax(0,1fr)] items-center gap-2 text-ui">
            <span className="min-w-0 truncate text-muted">{t("taskPage.ticketTracker")}</span>
            <span className="flex min-w-0 items-center gap-[7px] text-text">
              <TrackerMark kind={connection.kind} size={trackerMarkAt.property.size} label={false} />
              <span className="shrink-0">{trackerName(connection.kind)}</span>
              <span className="truncate text-faint">· {connection.name}</span>
            </span>
          </div>
        )}
        <PropRow label={t("taskPage.ticketStatus")}>
          {connection?.kind === "jira" ? <CategorySquare category={task.ticket.status.category ?? "open"} /> : <TicketStatusIcon category={task.ticket.status.category} />}
          <span className="truncate">{task.ticket.status.name ?? "–"}</span>
        </PropRow>
        <PropRow label={t("taskPage.ticketBoard")}><span className="truncate">{task.ticket.board}</span></PropRow>
        {task.ticket.subIssues.count === 0 ? null : (
          <PropRow label={connection?.kind === "jira" ? t("taskPage.subTasks") : t("taskPage.subIssues")}>
            <span className="font-mono">{task.ticket.subIssues.count}</span>
            {task.ticket.subIssues.done === 0 ? null : <span className="text-faint">{t("taskPage.subTasksDone", { n: task.ticket.subIssues.done })}</span>}
          </PropRow>
        )}
        <PropRow label={t("taskPage.synced")}>
          <span className="font-mono">{Math.max(0, Math.round((now - task.ticket.cachedAt) / 1000)) < 60 ? t("taskPage.syncedSeconds", { n: Math.max(0, Math.round((now - task.ticket.cachedAt) / 1000)) }) : t("taskPage.syncedMinutes", { n: Math.round((now - task.ticket.cachedAt) / 60_000) })}</span>
        </PropRow>
        {context}
      </PropGroup>
    )}
    {task.sync.length === 0 ? null : (
      <PropGroup title={connection === null ? t("taskPage.ticketGroup") : t("taskPage.onTracker", { tracker: trackerName(connection.kind) })}>
        <ul data-testid="sync-steps">
          {task.sync.map((write) => {
            const detail = syncDetail(write, connection?.kind ?? null);
            return (
              <li key={write.id} className="flex min-h-[26px] items-center justify-between gap-3 text-ui" data-state={write.state}>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-text" title={write.error ?? undefined}>{t(syncKey[write.kind])}</span>
                  {detail === null ? null : <span className="truncate text-[12.5px] text-faint" title={detail}>{detail}</span>}
                </span>
                <span className={cn("shrink-0 text-sm", syncState[write.state].tone)}>{t(syncState[write.state].key)}</span>
              </li>
            );
          })}
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
};

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

/** The server setting that holds a task's cap, by its unit: names, not words. */
const capSetting = { usd: "OSTRA_TASK_SPEND_CAP_USD", tokens: "OSTRA_TASK_TOKEN_CAP" } as const;

export const LimitBlock = ({ task, reopen, className }: { readonly task: LimitState; readonly reopen: { readonly run: () => void; readonly pending: boolean; readonly error: string | null }; readonly className?: string }) => {
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
  // A card in the chat (2026-11-21): the shared needs-you block, at the end of the thread.
  return (
    <NeedsYou
      data-testid="limit-block"
      need="limit"
      data-limit={what}
      title={t("taskPage.limit.title", { what: t(`taskPage.limit.${what}`) })}
      icon={<CircleAlertIcon aria-hidden />}
      {...(className === undefined ? {} : { className })}
      {...(task.reopenWithoutText
        ? {
            actions: (
              <Button size="sm" variant="amber" className="h-7 max-sm:w-full" disabled={reopen.pending} onClick={reopen.run} data-action="reopen-limit">
                <RotateCcwIcon aria-hidden />
                {reopen.pending ? t("taskPage.limit.reopening") : t("taskPage.limit.reopen")}
              </Button>
            ),
          }
        : {})}
      {...(reopen.error === null ? {} : { footer: <span role="alert" className="text-red">{reopen.error}</span> })}
    >
      <p>{body}</p>
      {/* At the spend cap there's no Reopen: the detail says why, and who can change it (task-limits.md, state 3). */}
      {what === "spend-cap" && !task.reopenWithoutText ? (
        <p className="mt-1 text-sm text-muted" data-testid="limit-detail">
          {t("taskPage.limit.spend-capDetail", { setting: "\u0000" })
            .split("\u0000")
            .map((part, i) => (
              <span key={`${part}-${String(i)}`}>
                {i > 0 ? <code className="rounded-[5px] border border-line bg-surface px-1.5 py-px font-mono text-[11.5px] text-text">{capSetting[task.spend.unit]}</code> : null}
                {part}
              </span>
            ))}
        </p>
      ) : null}
    </NeedsYou>
  );
};

/** A restore conflict waiting on the driver: show the saved work, or carry on without it. */
export const RestoreConflict = ({ savedWorkUrl, canAnswer, dismiss, className }: { readonly savedWorkUrl: string | null; readonly canAnswer: boolean; readonly dismiss: { readonly run: () => void; readonly pending: boolean }; readonly className?: string }) => (
  <NeedsYou
    data-testid="restore-conflict"
    need="restore-conflict"
    tone={canAnswer ? "amber" : "quiet"}
    title={t("taskPage.restoreConflict.title")}
    icon={<GitMergeIcon aria-hidden />}
    {...(className === undefined ? {} : { className })}
    {...(canAnswer
      ? {
          actions: (
            <>
              {savedWorkUrl === null ? null : (
                <a href={savedWorkUrl} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants({ size: "sm" }), "h-7")}>
                  {t("taskPage.restoreConflict.show")}
                </a>
              )}
              <Button size="sm" variant="amber" className="h-7" disabled={dismiss.pending} onClick={dismiss.run}>
                {t("taskPage.restoreConflict.dismiss")}
              </Button>
            </>
          ),
        }
      : {})}
    footer={t("taskPage.restoreConflict.footnote")}
  >
    <p>{t("taskPage.restoreConflict.body")}</p>
  </NeedsYou>
);

/** Which call the composer makes and what it says (task-reopen.md, "The composer: send or reopen"). */
export type ComposerMode =
  | { readonly kind: "send"; readonly hint: string | null }
  /** `inBox`: it carries on in the task's idle box (`capabilities.reopenInBox`), so it reads as a send (milestone 10, `s2.md`). */
  | { readonly kind: "reopen"; readonly hint: string; readonly inBox: boolean }
  | { readonly kind: "merged"; readonly hint: string }
  | { readonly kind: "none" };

export type ComposerInput = Pick<TaskDetail, "state"> & { readonly send: boolean; readonly reopen: boolean; readonly reopenInBox?: boolean; readonly boxState: Box["state"] | null };

export const composerInputOf = (task: TaskDetail): ComposerInput => ({
  state: task.state,
  send: task.capabilities.send,
  reopen: task.capabilities.reopen,
  reopenInBox: task.capabilities.reopenInBox,
  boxState: task.box?.state ?? null,
});

export const composerMode = (task: ComposerInput): ComposerMode => {
  if (task.send) return { kind: "send", hint: task.boxState === "idle" ? t("taskPage.composer.idleHint") : null };
  if (task.reopen) return task.reopenInBox === true ? { kind: "reopen", hint: t("taskPage.composer.idleHint"), inBox: true } : { kind: "reopen", hint: t("taskPage.composer.reopenHint"), inBox: false };
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

/**
 * The composer at the spend cap (task-limits.md, "Composer"): drawn but disabled, a `--line` edge,
 * the placeholder saying why, and `Reopen` at 40%, until an admin raises the cap.
 */
export const SpendCapComposer = () => (
  <div className="shrink-0 pt-3" data-part="composer-blocked">
    <div className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3.5 py-3">
      <textarea
        disabled
        rows={2}
        aria-label={t("task.composer.label")}
        placeholder={t("taskPage.composer.spendCapPlaceholder")}
        className="block min-w-0 flex-1 resize-none bg-transparent text-body placeholder:text-faint disabled:cursor-not-allowed"
      />
      <Button variant="primary" aria-disabled className="pointer-events-none self-end opacity-40" tabIndex={-1}>
        <RotateCcwIcon aria-hidden />
        {t("taskPage.composer.reopen")}
      </Button>
    </div>
  </div>
);

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
