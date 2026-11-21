"use client";

import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpIcon, CheckIcon, LoaderCircleIcon } from "lucide-react";
import Link from "next/link";
import { TRPCClientError } from "@trpc/client";
import { useState } from "react";

import type { AgentProfileId, BulkStartId, ProjectId, TaskId } from "@ostra/protocol";

import { bulkReasonText } from "@/components/automations/automation-words";
import { waitReasonText } from "@/components/tasks/task-waiting-words";
import { taskStateText } from "@/components/tasks/task-words";
import type { TaskState } from "@/components/tasks/task-words";
import { PropRow } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import type { InboxTicket } from "./inbox-words";

// Starting many from the Inbox (inbox-bulk-start.md, F-107, F-077): the selection bar, and the
// panel that says what each ticked ticket will do, then streams what each one did. The tickets go
// to `inbox.startMany` as one bulk start (each in its own transaction, through the same gates as a
// single start); a ticked parent's code start goes to `tickets.startSubIssues`, which starts one
// task per sub-issue, since a parent never runs code itself.

export type BulkKind = "code" | "refine";

/** What starting a ticked ticket would do, from what the Inbox already knows. */
export type Plan =
  | { readonly kind: "start"; readonly tasks: 1 }
  | { readonly kind: "sub-issues"; readonly tasks: number }
  | { readonly kind: "skip"; readonly tasks: 0; readonly reason: "has-task" | "over-limit" | "no-leaf"; readonly count?: number };

export const planOf = (ticket: InboxTicket, kind: BulkKind): Plan => {
  if (ticket.task?.active === true) return { kind: "skip", tasks: 0, reason: "has-task" };
  if (kind === "code" && ticket.subIssues > 0) {
    if (ticket.codeStart.overLimit) return { kind: "skip", tasks: 0, reason: "over-limit", count: ticket.codeStart.tasks };
    if (ticket.codeStart.tasks === 0) return { kind: "skip", tasks: 0, reason: "no-leaf" };
    return { kind: "sub-issues", tasks: ticket.codeStart.tasks };
  }
  return { kind: "start", tasks: 1 };
};

/** The tasks the ticked tickets would start, skipped ones left out. */
export const plannedTasks = (tickets: readonly InboxTicket[], kind: BulkKind): number => tickets.reduce((sum, ticket) => sum + planOf(ticket, kind).tasks, 0);

type BulkItem = RouterOutputs["inbox"]["bulkStart"]["items"][number];
type ParentResult = RouterOutputs["tickets"]["startSubIssues"];

/** What a ticket's start did: a bulk item's outcome, or a parent's sub-issue starts. */
/** A task a start made: its state, and why it waits while it's queued (inbox-bulk-start.md's results). */
export type StartedTask = {
  readonly id: TaskId;
  readonly shortId: string;
  readonly state: TaskState | null;
  /** Why a queued task waits, in words; `null` when it doesn't, or the reason isn't known. */
  readonly waits: string | null;
};

export type Result =
  | { readonly kind: "pending" }
  | { readonly kind: "started"; readonly tasks: readonly StartedTask[] }
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

const shortIdOf = (id: string): string => id.replaceAll("-", "").slice(-8);

/** Why a bulk start's queued task waits, worded as the task page words it. */
const waitsOf = (task: NonNullable<BulkItem["task"]>, project: string): string | null =>
  task.state !== "queued" || task.wait === null
    ? null
    : waitReasonText(task.wait, { project, poolNames: task.poolName === null ? [] : [task.poolName], poolName: () => task.poolName ?? "", personal: null });

export const resultOfItem = (item: BulkItem, project: string): Result => {
  switch (item.state) {
    case "pending":
      return { kind: "pending" };
    case "started":
      return {
        kind: "started",
        tasks: item.task === null ? [] : [{ id: item.task.id, shortId: item.task.shortId, state: item.task.state, waits: waitsOf(item.task, project) }],
      };
    case "skipped":
      return { kind: "skipped", reason: bulkReasonText(item.reason) };
    case "failed":
      return { kind: "failed", reason: bulkReasonText(item.reason) };
    default:
      return item.state satisfies never;
  }
};

const resultOfParent = (result: ParentResult): Result => {
  if (result.result === "over-limit") return { kind: "skipped", reason: t("bulkStart.reason.overLimit", { n: result.count, max: result.max }) };
  if (result.result === "no-children") return { kind: "skipped", reason: t("bulkStart.reason.noLeaf") };
  const started = result.outcomes.flatMap((outcome) => (outcome.state === "started" && outcome.taskId !== null ? [{ id: outcome.taskId, shortId: shortIdOf(outcome.taskId), state: null, waits: null }] : []));
  if (started.length > 0) return { kind: "started", tasks: started };
  const reason = result.outcomes[0]?.reason ?? null;
  return result.outcomes.some((outcome) => outcome.state === "failed") ? { kind: "failed", reason: bulkReasonText(reason) } : { kind: "skipped", reason: bulkReasonText(reason) };
};

/** The bulk start's state: one press, its request key, and each ticket's result as it lands. */
export const useBulkStart = (projectId: ProjectId, projectName: string) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [bulkStartId, setBulkStartId] = useState<BulkStartId | null>(null);
  const [parents, setParents] = useState<ReadonlyMap<string, Result>>(new Map());
  const [pressed, setPressed] = useState<readonly string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bulk = useQuery({
    ...trpc.inbox.bulkStart.queryOptions(bulkStartId === null ? skipToken : { projectId, bulkStartId }),
    refetchInterval: (query) => (query.state.data?.done === true ? false : 1000),
  });
  const startMany = useMutation(trpc.inbox.startMany.mutationOptions());
  const startSubIssues = useMutation(trpc.tickets.startSubIssues.mutationOptions());

  const results = new Map<string, Result>(parents);
  for (const item of bulk.data?.items ?? []) results.set(String(item.ticket.id), resultOfItem(item, projectName));
  const waitingParents = pressed?.some((id) => !results.has(id)) ?? false;
  const done = pressed !== null && !waitingParents && (bulkStartId === null || bulk.data?.done === true);

  const start = async (tickets: readonly InboxTicket[], kind: BulkKind, agentProfileId: AgentProfileId | null) => {
    setError(null);
    setPressed(tickets.map((ticket) => String(ticket.id)));
    const parentsToStart = tickets.filter((ticket) => planOf(ticket, kind).kind === "sub-issues");
    const rest = tickets.filter((ticket) => planOf(ticket, kind).kind !== "sub-issues");
    try {
      if (rest.length > 0) {
        const made = await startMany.mutateAsync({ projectId, ticketIds: rest.map((ticket) => ticket.id), kind, agentProfileId, requestKey });
        setBulkStartId(made.bulkStartId);
      }
      for (const parent of parentsToStart) {
        const result = await startSubIssues.mutateAsync({ ticketId: parent.id, requestKey: `${requestKey}:${String(parent.id)}`, agentProfileId });
        setParents((current) => new Map([...current, [String(parent.id), resultOfParent(result)]]));
      }
    } catch (failure) {
      setError(failure instanceof TRPCClientError ? errorText(failure) : t("errors.unknown"));
      if (bulkStartId === null && parents.size === 0) setPressed(null);
    }
    void queryClient.invalidateQueries({ queryKey: trpc.inbox.pathKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.projects.pathKey() });
  };

  const reset = () => {
    setRequestKey(crypto.randomUUID());
    setBulkStartId(null);
    setParents(new Map());
    setPressed(null);
    setError(null);
  };

  return { start, reset, results, pressed, done, error, starting: pressed !== null && !done };
};

export type BulkStart = ReturnType<typeof useBulkStart>;

/** The kind and profile for all: one state for the bar's selects and the panel's. */
export const KindSelect = ({ value, onChange, disabled, className, labelled }: { readonly value: BulkKind; readonly onChange: (kind: BulkKind) => void; readonly disabled: boolean; readonly className?: string; readonly labelled?: boolean }) => (
  <Select value={value} disabled={disabled} onValueChange={(next) => { if (next === "code" || next === "refine") onChange(next); }}>
    <SelectTrigger className={cn("h-[30px] bg-surface", className)} aria-label={t("bulkStart.kind")}>
      {labelled === true ? <span className="text-muted">{t("bulkStart.kind")}</span> : null}
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="code">{t("bulkStart.code")}</SelectItem>
      <SelectItem value="refine">{t("bulkStart.refine")}</SelectItem>
    </SelectContent>
  </Select>
);

export const ProfileSelect = ({
  projectId,
  kind,
  value,
  onChange,
  disabled,
  className,
  labelled,
}: {
  readonly projectId: ProjectId;
  readonly kind: BulkKind;
  readonly value: AgentProfileId | null;
  readonly onChange: (profile: AgentProfileId | null) => void;
  readonly disabled: boolean;
  readonly className?: string;
  readonly labelled?: boolean;
}) => {
  const trpc = useTRPC();
  const profiles = useQuery(trpc.agentProfiles.forStart.queryOptions({ projectId, kind }));
  return (
    <Select value={value ?? "default"} disabled={disabled} onValueChange={(next) => { onChange(next === "default" ? null : (profiles.data?.find((one) => one.profileId === next)?.profileId ?? null)); }}>
      <SelectTrigger className={cn("h-[30px] bg-surface", className)} aria-label={t("bulkStart.profile")}>
        {labelled === true ? <span className="text-muted">{t("bulkStart.profile")}</span> : null}
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="default">{t("bulkStart.defaultProfile")}</SelectItem>
        {(profiles.data ?? []).map((profile) => (
          <SelectItem key={profile.profileId} value={profile.profileId}>
            {profile.modelName === null ? profile.name : `${profile.name} · ${profile.modelName}`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

const startLabel = (bulk: BulkStart, tasks: number): string => {
  if (bulk.starting) {
    const decided = [...bulk.results.values()].filter((result) => result.kind !== "pending").length;
    return t("bulkStart.starting", { done: decided, n: bulk.pressed?.length ?? 0 });
  }
  return plural(tasks, "bulkStart.start.one", "bulkStart.start.other");
};

/** The selection bar, in place of the filter row while a ticket is ticked. */
export const SelectionBar = ({
  ticked,
  allTicked,
  max,
  kind,
  profile,
  projectId,
  bulk,
  onKind,
  onProfile,
  onClear,
  onStart,
}: {
  readonly ticked: readonly InboxTicket[];
  readonly allTicked: boolean;
  readonly max: number;
  readonly kind: BulkKind;
  readonly profile: AgentProfileId | null;
  readonly projectId: ProjectId;
  readonly bulk: BulkStart;
  readonly onKind: (kind: BulkKind) => void;
  readonly onProfile: (profile: AgentProfileId | null) => void;
  readonly onClear: () => void;
  readonly onStart: () => void;
}) => {
  const tasks = plannedTasks(ticked, kind);
  const over = ticked.length > max;
  const busy = bulk.pressed !== null;
  return (
    <div
      role="toolbar"
      aria-label={plural(ticked.length, "bulkStart.toolbar.one", "bulkStart.toolbar.other")}
      className="mt-[18px] flex min-h-11 flex-wrap items-center gap-2 rounded-lg border border-line-2 bg-surface py-1.5 pl-3 pr-2"
      data-testid="selection-bar"
    >
      <Checkbox tone="teal" checked={allTicked ? true : "indeterminate"} disabled={busy} onCheckedChange={onClear} aria-label={t("bulkStart.clear")} />
      <span className="text-[14px] font-medium text-text" data-testid="selection-count">{t("bulkStart.selected", { n: ticked.length })}</span>
      {over ? <span className="text-sm text-red">{t("bulkStart.overMax", { max })}</span> : null}
      <span className="text-faint">·</span>
      <Button variant="ghost" size="sm" disabled={busy} onClick={onClear}>{t("bulkStart.clear")}</Button>
      <div className="ml-auto flex flex-wrap items-center gap-2 max-md:w-full">
        <KindSelect value={kind} onChange={onKind} disabled={busy} labelled className="max-md:hidden" />
        <ProfileSelect projectId={projectId} kind={kind} value={profile} onChange={onProfile} disabled={busy} labelled className="max-w-[240px] max-md:hidden" />
        <Button variant="primary" disabled={over || tasks === 0 || busy} onClick={onStart} className="max-md:ml-auto" data-testid="bar-start">
          {bulk.starting ? <LoaderCircleIcon className="animate-spin" /> : <ArrowUpIcon />}
          {startLabel(bulk, tasks)}
        </Button>
      </div>
    </div>
  );
};

const PlanLine = ({ plan, ticket, kind }: { readonly plan: Plan; readonly ticket: InboxTicket; readonly kind: BulkKind }) => {
  switch (plan.kind) {
    case "start":
      return (
        <>
          <span className="block text-[14px] font-medium text-text">{t("bulkStart.plan.start")}</span>
          <span className="block text-sm text-muted">{kind === "code" ? t("bulkStart.plan.startReason") : t("bulkStart.plan.refineReason")}</span>
        </>
      );
    case "sub-issues":
      return (
        <>
          <span className="block text-[14px] font-medium text-text">{t("bulkStart.plan.subIssues", { n: plan.tasks })}</span>
          <span className="block text-sm text-muted">{t("bulkStart.plan.subIssuesReason")}</span>
        </>
      );
    case "skip":
      return (
        <>
          <span className="block text-[14px] font-medium text-muted">{t("bulkStart.plan.skipped")}</span>
          <span className="block text-sm text-muted">
            {plan.reason === "has-task" ? (
              <>
                {t("bulkStart.plan.hasTask")}{" "}
                {ticket.task === null ? null : <Link href={`/tasks/${ticket.task.id}`} className="font-mono text-teal hover:underline">{ticket.task.shortId}</Link>}
              </>
            ) : plan.reason === "over-limit" ? (
              t("bulkStart.reason.overLimit", { n: plan.count ?? 0, max: 50 })
            ) : (
              t("bulkStart.reason.noLeaf")
            )}
          </span>
        </>
      );
    default:
      return plan satisfies never;
  }
};

export const ResultLine = ({ result }: { readonly result: Result }) => {
  switch (result.kind) {
    case "pending":
      return <span className="block text-[14px] font-medium text-muted">{t("bulkStart.result.pending")}</span>;
    case "started": {
      const [only] = result.tasks;
      if (only !== undefined && result.tasks.length === 1) {
        // One task: `Started` with its state (`Running · 3f9c21ab`), or `Queued` with why it waits.
        const link = <Link href={`/tasks/${only.id}`} className="font-mono text-teal hover:underline">{only.shortId}</Link>;
        const queued = only.state === "queued";
        return (
          <>
            <span className="block text-[14px] font-medium text-text">{queued ? t("bulkStart.result.queued") : t("bulkStart.result.started.one")}</span>
            <span className="block text-sm text-muted" data-testid="bulk-task">
              {queued && only.waits !== null ? <>{link} · {only.waits}</> : only.state !== null && !queued ? <>{taskStateText(only.state)} · {link}</> : link}
            </span>
          </>
        );
      }
      return (
        <>
          <span className="block text-[14px] font-medium text-text">{plural(result.tasks.length, "bulkStart.result.started.one", "bulkStart.result.started.other")}</span>
          <span className="flex flex-wrap gap-x-2 text-sm">
            {result.tasks.map((task) => <Link key={task.id} href={`/tasks/${task.id}`} className="font-mono text-teal hover:underline">{task.shortId}</Link>)}
          </span>
        </>
      );
    }
    case "skipped":
      return (
        <>
          <span className="block text-[14px] font-medium text-muted">{t("bulkStart.plan.skipped")}</span>
          <span className="block text-sm text-muted">{result.reason}</span>
        </>
      );
    case "failed":
      return (
        <>
          <span className="block text-[14px] font-medium text-red">{t("bulkStart.result.failed")}</span>
          <span className="block text-sm text-red">{result.reason}</span>
        </>
      );
    default:
      return result satisfies never;
  }
};

/** The results' head: `Started 3 tasks from 3 tickets. 1 skipped.`, each count in its own number. */
export const doneHeadText = (startedTasks: number, startedTickets: number, skipped: number): string => {
  const head = t("bulkStart.doneHead", { tasks: plural(startedTasks, "bulkStart.tasks.one", "bulkStart.tasks.other"), tickets: plural(startedTickets, "bulkStart.tickets.one", "bulkStart.tickets.other") });
  return skipped === 0 ? head : `${head} ${t("bulkStart.doneSkipped", { n: skipped })}`;
};

/** The properties panel while tickets are ticked: the start for all, what each one does, and the results. */
export const BulkStartPanel = ({
  ticked,
  max,
  kind,
  profile,
  projectId,
  bulk,
  onKind,
  onProfile,
  onStart,
  onDone,
}: {
  readonly ticked: readonly InboxTicket[];
  readonly max: number;
  readonly kind: BulkKind;
  readonly profile: AgentProfileId | null;
  readonly projectId: ProjectId;
  readonly bulk: BulkStart;
  readonly onKind: (kind: BulkKind) => void;
  readonly onProfile: (profile: AgentProfileId | null) => void;
  readonly onStart: () => void;
  readonly onDone: () => void;
}) => {
  const tasks = plannedTasks(ticked, kind);
  const busy = bulk.pressed !== null;
  const results = [...bulk.results.values()];
  const startedTasks = results.reduce((sum, result) => sum + (result.kind === "started" ? result.tasks.length : 0), 0);
  const startedTickets = results.filter((result) => result.kind === "started").length;
  const skipped = results.filter((result) => result.kind === "skipped" || result.kind === "failed").length;
  return (
    <div data-testid="bulk-start">
      <h2 className="text-[17px] font-semibold text-text" data-testid="bulk-head">
        {bulk.done
          ? doneHeadText(startedTasks, startedTickets, skipped)
          : bulk.starting
            ? plural(tasks, "bulkStart.startingHead.one", "bulkStart.startingHead.other")
            : `${plural(ticked.length, "bulkStart.tickets.one", "bulkStart.tickets.other")}, ${plural(tasks, "bulkStart.tasks.one", "bulkStart.tasks.other")}`}
      </h2>
      <p className="mt-1 text-sm text-muted">{t("bulkStart.lede")}</p>
      <div className="mt-3.5 border-t border-line pt-3.5">
        <h3 className="mb-2 text-xs font-medium text-faint">{t("bulkStart.startGroup")}</h3>
        <PropRow label={t("bulkStart.kind")}>
          <KindSelect value={kind} onChange={onKind} disabled={busy} className="w-full" />
        </PropRow>
        <PropRow label={t("bulkStart.profile")}>
          <ProfileSelect projectId={projectId} kind={kind} value={profile} onChange={onProfile} disabled={busy} className="w-full" />
        </PropRow>
        <PropRow label={t("bulkStart.runOn")}>{t("bulkStart.pools")}</PropRow>
      </div>
      <div className="mt-3.5 border-t border-line pt-3.5">
        <h3 className="mb-1 text-xs font-medium text-faint">{t("bulkStart.whatEach")}</h3>
        <ul>
          {ticked.map((ticket) => {
            const result = bulk.results.get(String(ticket.id));
            return (
              <li key={ticket.id} className="grid min-h-12 grid-cols-[90px_minmax(0,1fr)] gap-2 border-b border-line py-1.5" data-testid="bulk-row" data-key={ticket.key}>
                <span className="pt-0.5 font-mono text-[13px] text-faint">{ticket.key}</span>
                <span className="min-w-0" data-testid="bulk-outcome">
                  {result === undefined ? <PlanLine plan={planOf(ticket, kind)} ticket={ticket} kind={kind} /> : <ResultLine result={result} />}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="mt-4">
        {bulk.done ? (
          <Button size="xl" className="w-full" onClick={onDone}>
            <CheckIcon /> {t("bulkStart.done")}
          </Button>
        ) : (
          <Button size="xl" variant="primary" className="w-full" disabled={ticked.length > max || tasks === 0 || busy} onClick={onStart} data-testid="panel-start">
            {bulk.starting ? <LoaderCircleIcon className="animate-spin" /> : <ArrowUpIcon />}
            {startLabel(bulk, tasks)}
          </Button>
        )}
        {bulk.error === null ? null : <p role="alert" className="mt-2 text-sm text-red">{bulk.error}</p>}
        <p className="mt-2 text-[12.5px] text-faint">{t("bulkStart.footnote", { max })}</p>
      </div>
    </div>
  );
};
