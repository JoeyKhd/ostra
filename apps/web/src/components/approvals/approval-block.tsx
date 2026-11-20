"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRightIcon, HandIcon, LoaderCircleIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

// An outside task's approval (needs-approval.md, F-040): who started it in Linear and why they count
// as outside, the ticket, the profile and the pool it runs on, and "Approve" or "Reject" with an
// optional reason. The same block on the project's Needs approval and on the task page's banner.

export type WaitingTask = RouterOutputs["tasks"]["needsApproval"]["tasks"][number];

export const kindWord = (kind: WaitingTask["kind"]): string => {
  switch (kind) {
    case "code":
      return t("approvals.kind.code");
    case "refine":
      return t("approvals.kind.refine");
    case "review":
      return t("approvals.kind.review");
    default:
      return kind satisfies never;
  }
};

/** Who started it: a Linear user's name, a rule's, or a member's. */
export const starterName = (task: WaitingTask): string => {
  switch (task.startedBy.kind) {
    case "outside":
      return task.startedBy.name;
    case "automation":
      return t("approvals.byRule", { name: task.startedBy.name });
    case "member":
      return task.startedBy.name ?? t("approvals.someone");
    default:
      return task.startedBy satisfies never;
  }
};

/** The pool it would run on: the project's first, as admission tries them in order. */
export const poolOf = (task: WaitingTask): string => task.pools[0] ?? t("approvals.anyPool");

type Answer = { readonly kind: "approved" | "rejected" };

export const ApprovalBlock = ({
  task,
  onAnswered,
  className,
  startRejecting = false,
  answered = null,
}: {
  readonly task: WaitingTask;
  readonly onAnswered?: (answer: Answer) => void;
  readonly className?: string;
  /** Opened by a collapsed row's Reject: the reason's input shows at once. */
  readonly startRejecting?: boolean;
  /** Answered from the collapsed row: the block shows the outcome. */
  readonly answered?: Answer["kind"] | null;
}) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [rejecting, setRejecting] = useState(startRejecting);
  const [reason, setReason] = useState("");
  const [own, setAnswer] = useState<Answer | null>(null);
  const answer = own ?? (answered === null ? null : { kind: answered });
  const settled = (kind: Answer["kind"]) => () => {
    setAnswer({ kind });
    onAnswered?.({ kind });
    void queryClient.invalidateQueries({ queryKey: trpc.tasks.pathKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.projects.pathKey() });
  };
  const approve = useMutation(trpc.tasks.approve.mutationOptions({ onSuccess: settled("approved") }));
  const reject = useMutation(trpc.tasks.reject.mutationOptions({ onSuccess: settled("rejected") }));
  const busy = approve.isPending || reject.isPending;
  const error = approve.error ?? reject.error;
  const key = task.ticket?.key ?? task.shortId;

  if (answer !== null) {
    return (
      <p className={cn("text-sm text-muted", className)} role="status" data-testid="approval-answered">
        {answer.kind === "approved" ? t("approvals.approved", { pool: poolOf(task) }) : t("approvals.rejected")}
      </p>
    );
  }
  return (
    <div className={cn("border-l-2 border-amber py-1 pl-3", className)} data-testid="approval-block">
      <p className="flex items-center gap-1.5 text-[13px] font-semibold text-amber-text">
        <HandIcon aria-hidden className="size-[14px] stroke-[1.75]" />
        {t("approvals.blockTitle")}
      </p>
      <p className="mt-1 text-[13px] text-text">
        {task.startedBy.kind === "automation"
          ? t("approvals.blockLineRule", { name: task.startedBy.name, key })
          : task.ticket === null
            ? t("approvals.blockLineNoTicket", { name: starterName(task), project: task.project.name })
            : t("approvals.blockLine", { name: starterName(task), key, project: task.project.name })}
      </p>
      <dl className="mt-2 grid grid-cols-[110px_minmax(0,1fr)] gap-y-1 text-[13px]">
        {task.ticket === null ? null : (
          <>
            <dt className="text-muted">{t("approvals.ticket")}</dt>
            <dd className="flex min-w-0 items-center gap-2">
              <span className="font-mono text-teal">{task.ticket.key}</span>
              <span className="truncate text-text">{task.ticket.title}</span>
              <a href={task.ticket.url} target="_blank" rel="noopener noreferrer" className="text-teal" aria-label={task.ticket.key}>
                <ArrowUpRightIcon aria-hidden className="size-[13px] stroke-[1.75]" />
              </a>
            </dd>
          </>
        )}
        <dt className="text-muted">{t("approvals.profile")}</dt>
        <dd className="truncate text-text">
          {task.profile?.name ?? "–"}
          <span className="text-faint">{t("approvals.profileNote", { project: task.project.name, kind: kindWord(task.kind) })}</span>
        </dd>
        <dt className="text-muted">{t("approvals.pool")}</dt>
        <dd className="truncate">
          <span className="font-mono text-text">{poolOf(task)}</span>
          <span className="text-faint">{t("approvals.poolNote")}</span>
        </dd>
      </dl>
      {rejecting ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Input
            aria-label={t("approvals.reasonLabel")}
            placeholder={t("approvals.reasonLabel")}
            maxLength={300}
            value={reason}
            onChange={(event) => { setReason(event.target.value); }}
            className="h-[28px] max-w-[360px] flex-1"
          />
          <Button size="sm" variant="danger" disabled={busy} onClick={() => { reject.mutate({ taskId: task.taskId, reason: reason.trim() === "" ? null : reason.trim() }); }}>
            {reject.isPending ? <LoaderCircleIcon className="animate-spin" /> : null}
            {t("approvals.reject")}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setRejecting(false); }}>{t("approvals.cancel")}</Button>
          <p className="w-full text-xs text-faint">{t("approvals.reasonNote")}</p>
        </div>
      ) : (
        <div className="mt-2.5 flex items-center gap-2">
          <Button disabled={busy} onClick={() => { setRejecting(true); }} className="h-7">{t("approvals.reject")}</Button>
          <Button variant="amber" disabled={busy} onClick={() => { approve.mutate({ taskId: task.taskId }); }} className="h-7">
            {approve.isPending ? <LoaderCircleIcon className="animate-spin" /> : null}
            {t("approvals.approve")}
          </Button>
        </div>
      )}
      {error === null ? null : <p role="alert" className="mt-2 text-[12.5px] text-red">{errorText(error)}</p>}
      <p className="mt-2 text-xs text-faint">{t("approvals.footnote", { project: task.project.name })}</p>
    </div>
  );
};

/** The task page's banner, while the task waits for approval: its block, from the project's list. */
export const AwaitingApprovalBanner = ({ task }: { readonly task: WaitingTask | undefined }) =>
  task === undefined ? null : (
    <div className="mt-3" data-testid="awaiting-banner">
      <ApprovalBlock task={task} />
    </div>
  );

/** "Started in Linear by {name}", on the task page's key line. */
export const StartedInLinear = ({ task }: { readonly task: WaitingTask | undefined }) =>
  task?.startedBy.kind === "outside" ? <span data-testid="started-in-linear">{t("approvals.startedBy", { name: task.startedBy.name })}</span> : null;

export const OpenTaskLink = ({ task }: { readonly task: WaitingTask }) => (
  <Link href={`/tasks/${task.taskId}`} className="font-mono text-[12.5px] text-faint hover:underline">
    {task.ticket?.key ?? task.shortId}
  </Link>
);
