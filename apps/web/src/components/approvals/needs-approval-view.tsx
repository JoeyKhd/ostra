"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronUpIcon, InfoIcon, LoaderCircleIcon, ShieldOffIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import type { ProjectId } from "@ostra/protocol";

import { PageFrame, PageHeading, PropGroup, PropRow } from "@/components/shell/page-frame";
import { AlertDialog, AlertDialogContent } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatAge } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { ApprovalBlock, OpenTaskLink, poolOf, starterName } from "./approval-block";
import type { WaitingTask } from "./approval-block";

// A project's "Needs approval" (needs-approval.md, F-040, F-012): the outside tasks waiting for a
// member's answer, oldest first, one expanded at a time, and for an organization admin the project's
// "Outside tasks need approval" switch (read-only to everyone else).

const LIVE_MS = 10_000;
// The picture's proportions (needs-approval.webp): beside the panel, the title keeps about 180px at
// 1440. The build spec's `230px 170px 44px 140px` left it under 100px there.
// The double sidebar leaves the page 70px less than the target's single one: the fixed columns give
// some back, so a title like "Retry failed invoice exports" stays whole (needs-approval.webp).
const grid = "grid grid-cols-[84px_minmax(0,1fr)_auto] items-center gap-x-3 md:grid-cols-[72px_minmax(0,1fr)_164px_124px_36px_132px] md:gap-x-2.5";

export const NeedsApprovalView = ({ projectId, organizationAdmin }: { readonly projectId: ProjectId; readonly organizationAdmin: boolean }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const params = useSearchParams();
  const project = useQuery(trpc.projects.get.queryOptions({ projectId }));
  const list = useQuery({ ...trpc.tasks.needsApproval.queryOptions({ projectId }), refetchInterval: LIVE_MS });
  const [open, setOpen] = useState<string | null>(params.get("task"));
  // Answered here: kept on the page with their outcome until the next load, though the list drops them.
  const [answered, setAnswered] = useState<ReadonlyMap<string, { readonly kind: "approved" | "rejected"; readonly task: WaitingTask }>>(new Map());
  const [confirmOff, setConfirmOff] = useState(false);
  const setSwitch = useMutation(
    trpc.projects.setOutsideApproval.mutationOptions({
      onSuccess: () => {
        setConfirmOff(false);
        void queryClient.invalidateQueries({ queryKey: trpc.tasks.needsApproval.queryKey({ projectId }) });
      },
    }),
  );
  const projectName = project.data?.name ?? "";
  const listed = list.data?.tasks ?? [];
  const tasks = [...listed, ...[...answered.values()].map((one) => one.task).filter((task) => !listed.some((other) => other.taskId === task.taskId))].sort(
    (a, b) => a.createdAt - b.createdAt || a.taskId.localeCompare(b.taskId),
  );
  const expanded = open ?? tasks.find((task) => !answered.has(task.taskId))?.taskId ?? null;
  const approval = list.data?.outsideApproval ?? null;
  const pools = tasks[0]?.pools ?? [];

  const toggle = (on: boolean) => {
    if (!on) {
      setConfirmOff(true);
      return;
    }
    setSwitch.mutate({ projectId, on: true });
  };

  return (
    <PageFrame
      crumbs={[{ label: projectName, href: `/projects/${projectId}` }, { label: t("approvals.title") }]}
      properties={
        <div data-testid="approvals-panel">
          <PropGroup title={t("approvals.panel.outside")}>
            <PropRow label={t("approvals.panel.needApproval")} labelWidth={124}>
              {approval === null ? (
                <Skeleton className="h-[18px] w-8" />
              ) : (
                <Switch
                  checked={approval.on}
                  disabled={!organizationAdmin || setSwitch.isPending}
                  aria-label={t("approvals.panel.switchLabel", { project: projectName })}
                  onCheckedChange={toggle}
                  className="ml-auto"
                />
              )}
            </PropRow>
            <p className="mt-1 text-xs text-muted">{t("approvals.panel.switchNote")}</p>
            {organizationAdmin ? null : <p className="mt-1 text-xs text-faint">{t("approvals.panel.adminsOnly")}</p>}
            <PropRow label={t("approvals.panel.changed")} labelWidth={124}>
              {approval?.changedByName === null || approval === null ? <span className="text-faint">{t("approvals.panel.neverChanged")}</span> : approval.changedByName}
            </PropRow>
            {setSwitch.isError ? <p role="alert" className="mt-1 text-[12.5px] text-red">{errorText(setSwitch.error)}</p> : null}
          </PropGroup>
          <PropGroup title={t("approvals.panel.runsOn")}>
            <PropRow label={t("approvals.panel.pools")} labelWidth={124}>
              <span className="truncate font-mono">{pools.length === 0 ? t("approvals.panel.noPools") : pools.join(", ")}</span>
            </PropRow>
            <PropRow label={t("approvals.panel.personal")} labelWidth={124}>{t("approvals.panel.never")}</PropRow>
          </PropGroup>
        </div>
      }
    >
      <PageHeading title={t("approvals.title")} lede={t("approvals.lede", { project: projectName })} />
      {approval?.on === false ? (
        <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-muted" data-testid="approval-off">
          <ShieldOffIcon aria-hidden className="size-[13px] stroke-[1.75]" />
          {t("approvals.offLine", { project: projectName })}
        </p>
      ) : null}
      <div className="mt-4 flex h-9 items-end gap-5 border-b border-line">
        <span className="-mb-px flex items-center gap-2 border-b-2 border-text pb-2 text-ui font-medium text-text">
          {t("approvals.waiting")}
          <span className="font-mono text-xs text-faint" data-testid="approvals-count">{tasks.filter((task) => !answered.has(task.taskId)).length}</span>
        </span>
      </div>
      {list.isError ? (
        <p role="alert" className="mt-4 text-sm text-red">{errorText(list.error)}</p>
      ) : list.data === undefined ? (
        <div className="mt-3 flex flex-col gap-3" aria-busy>
          <Skeleton className="w-full" />
          <Skeleton className="w-full" />
          <Skeleton className="w-full" />
        </div>
      ) : (
        <>
          <div className={cn(grid, "h-7 border-b border-line text-[11.5px] font-medium text-faint")}>
            <span>{t("approvals.col.ticket")}</span>
            <span>{t("approvals.col.title")}</span>
            <span className="hidden md:block">{t("approvals.col.startedBy")}</span>
            <span className="hidden md:block">{t("approvals.col.runsOn")}</span>
            <span className="hidden md:block">{t("approvals.col.age")}</span>
            <span />
          </div>
          {tasks.length === 0 ? (
            <p className="h-10 pt-2.5 text-[13px] text-faint">{t("approvals.none", { project: projectName })}</p>
          ) : (
            <ul data-testid="approvals-list">
              {tasks.map((task) => (
                <ApprovalRow
                  key={task.taskId}
                  task={task}
                  expanded={expanded === task.taskId}
                  answered={answered.get(task.taskId)?.kind ?? null}
                  onToggle={() => { setOpen(expanded === task.taskId ? "" : task.taskId); }}
                  onAnswered={(kind) => { setAnswered((current) => new Map([...current, [task.taskId, { kind, task }]])); }}
                />
              ))}
            </ul>
          )}
          <p className="mt-5 flex items-center gap-1.5 text-xs text-faint">
            <InfoIcon aria-hidden className="size-[13px] stroke-[1.75]" />
            {t("approvals.rejectNote")}
          </p>
        </>
      )}
      <AlertDialog open={confirmOff} onOpenChange={setConfirmOff}>
        <AlertDialogContent
          title={t("approvals.offTitle")}
          body={t("approvals.offBody", { project: projectName })}
          cancel={t("approvals.cancel")}
          action={t("approvals.offAction")}
          onAction={() => { setSwitch.mutate({ projectId, on: false }); }}
          pending={{ busy: setSwitch.isPending, label: t("approvals.offAction"), error: setSwitch.isError ? errorText(setSwitch.error) : null }}
        />
      </AlertDialog>
    </PageFrame>
  );
};

/**
 * A row's action cell (needs-approval.md): a collapsed row answers in place, `Reject` (ghost, which
 * opens the row on its reason) and `Approve` (outline); an expanded row closes with `chevron-up`;
 * an answered one says so.
 */
export const RowActions = ({
  name,
  expanded,
  answered,
  busy,
  onToggle,
  onReject,
  onApprove,
}: {
  readonly name: string;
  readonly expanded: boolean;
  readonly answered: "approved" | "rejected" | null;
  readonly busy: boolean;
  readonly onToggle: () => void;
  readonly onReject: () => void;
  readonly onApprove: () => void;
}) => {
  if (answered !== null) return <span className="text-xs text-faint">{t("approvals.done")}</span>;
  if (expanded) {
    return (
      <Button variant="ghost" size="icon" className="size-7" aria-label={t("approvals.collapse", { key: name })} aria-expanded onClick={onToggle}>
        <ChevronUpIcon />
      </Button>
    );
  }
  return (
    <span className="flex items-center gap-2" data-testid="row-actions">
      <Button variant="ghost" size="sm" className="h-[26px]" disabled={busy} onClick={onReject} aria-label={t("approvals.rejectKey", { key: name })}>
        {t("approvals.reject")}
      </Button>
      <Button size="sm" className="h-[26px]" disabled={busy} onClick={onApprove} aria-label={t("approvals.approveKey", { key: name })}>
        {busy ? <LoaderCircleIcon className="animate-spin" /> : null}
        {t("approvals.approve")}
      </Button>
    </span>
  );
};

const ApprovalRow = ({
  task,
  expanded,
  answered,
  onToggle,
  onAnswered,
}: {
  readonly task: WaitingTask;
  readonly expanded: boolean;
  readonly answered: "approved" | "rejected" | null;
  readonly onToggle: () => void;
  readonly onAnswered: (kind: "approved" | "rejected") => void;
}) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [rejectFirst, setRejectFirst] = useState(false);
  const approve = useMutation(
    trpc.tasks.approve.mutationOptions({
      onSuccess: () => {
        onAnswered("approved");
        void queryClient.invalidateQueries({ queryKey: trpc.tasks.pathKey() });
        void queryClient.invalidateQueries({ queryKey: trpc.projects.pathKey() });
      },
    }),
  );
  const key = task.ticket?.key ?? task.shortId;
  return (
    <li className="border-b border-line" data-testid="approval-row" data-key={key}>
      <div className={cn(grid, "min-h-10 py-1")}>
        <OpenTaskLink task={task} />
        <span className="truncate text-[13px] font-medium text-text" title={task.title}>{task.title}</span>
        <span className="hidden truncate text-[13px] text-text md:block">
          {starterName(task)}
          {task.startedBy.kind === "outside" ? <span className="text-xs text-faint">{t("approvals.notMember")}</span> : null}
        </span>
        <span className="hidden truncate font-mono text-[12.5px] text-muted md:block">{`${task.profile?.name ?? "–"} · ${poolOf(task)}`}</span>
        <span className="hidden font-mono text-xs text-faint md:block" suppressHydrationWarning>{formatAge(task.createdAt)}</span>
        <span className="flex justify-end">
          <RowActions
            name={key}
            expanded={expanded}
            answered={answered}
            busy={approve.isPending}
            onToggle={() => { setRejectFirst(false); onToggle(); }}
            onReject={() => { setRejectFirst(true); onToggle(); }}
            onApprove={() => { approve.mutate({ taskId: task.taskId }); }}
          />
        </span>
      </div>
      {approve.isError ? <p role="alert" className="mb-2 text-[12.5px] text-red md:ml-[96px]">{errorText(approve.error)}</p> : null}
      {expanded || answered !== null ? <ApprovalBlock task={task} className="mb-3 md:ml-[96px]" startRejecting={rejectFirst} answered={answered} onAnswered={(answer) => { onAnswered(answer.kind); }} /> : null}
    </li>
  );
};
