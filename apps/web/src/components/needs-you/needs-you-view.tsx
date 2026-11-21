"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCheckIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { approvalIdSchema, notificationIdSchema, taskIdSchema } from "@ostra/protocol";
import type { ApprovalDecision } from "@ostra/protocol";

import { needsYouRowKey } from "@/components/home/home-words";
import { RunnerApproval } from "@/components/runners/runner-approval";
import { PageFrame, PageHeading } from "@/components/shell/page-frame";
import { BudgetNoticeRows, useBudgetNotices } from "@/components/spend/budget-notices";
import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { DoneList, ListSkeleton, NeedsYouLede, NeedsYouTabs, OpenEmpty, OpenList, ReachPanel } from "./needs-you-list";
import type { AnswerResult, Answers, NeedsYouTab } from "./needs-you-list";
import { READ_AFTER_MS, toMarkRead } from "./needs-you-words";
import { PreviewShareRows, usePreviewShares } from "./preview-shares";
import { awaitingRunners, RunnerApprovalsBand } from "./runner-approvals";
import type { AnsweredBy, InlineAsk, NotificationView, Outcome, ReachView } from "./needs-you-words";

// Ticket 44 wired (needs-you.md; F-036, F-062): `notifications.list` drawn by the page's parts, the
// inline answers through `approvals.answer`, `plans.answer` and `questions.answer`, and the rows
// marked read after the Open tab has been on screen a moment.

type ApiRow = RouterOutputs["notifications"]["list"]["rows"][number];
type ApiView = ApiRow["view"];

const subjectText = (view: ApiView): string => {
  if (view.answer?.kind !== "approval") return "";
  return view.answer.subject?.value ?? "";
};

const byOf = (by: { readonly memberId: string; readonly name: string } | null, me: string | null): AnsweredBy =>
  by !== null && by.memberId === me ? { kind: "you" } : { kind: "member", name: by?.name ?? t("taskPage.someone") };

export const outcomeOf = (outcome: ApiView["outcome"], me: string | null): Outcome | null => {
  if (outcome === null) return null;
  switch (outcome.kind) {
    case "approved-once":
    case "approved-task":
    case "denied":
    case "plan-approved":
    case "answered":
      return { kind: outcome.kind, by: byOf(outcome.by, me) };
    case "plan-revised":
      return { kind: "answered", by: byOf(outcome.by, me) };
    case "approved-by-rule":
      return { kind: "by-rule" };
    case "expired":
    case "cancelled":
    case "closed":
      return { kind: outcome.kind };
    default:
      return outcome.kind satisfies never;
  }
};

const askOf = (view: ApiView, me: string | null): InlineAsk | null => {
  const answer = view.answer;
  if (answer === null || view.state !== "open") return null;
  switch (answer.kind) {
    case "approval":
      return answer.state !== "open"
        ? null
        : {
            kind: "approval",
            approvalId: answer.approvalId,
            agent: answer.agentName,
            summary: view.detail.reason === "approval" && view.detail.command !== null ? view.detail.command : subjectText(view),
            rule: answer.rule?.name ?? null,
            subject: subjectText(view),
            pattern: answer.forThisTask?.pattern ?? null,
          };
    case "plan":
      return {
        kind: "plan",
        planId: view.itemId ?? view.taskId,
        entries: answer.entries.map((entry) => ({ status: entry.status, text: entry.content })),
        driver: answer.canAnswer ? null : (answer.driver?.memberId === me ? null : (answer.driver?.name ?? t("taskPage.someone"))),
      };
    case "question":
      return {
        kind: "question",
        questionId: answer.questionId,
        question: answer.message,
        options: answer.fields[0]?.options ?? [],
        driver: answer.canAnswer ? null : (answer.driver?.name ?? t("taskPage.someone")),
      };
    default:
      return answer satisfies never;
  }
};

export const notificationViewOf = (row: ApiRow, me: string | null): NotificationView => {
  const failed = row.failedDeliveries.find((delivery) => delivery.state === "failed") ?? null;
  return {
    id: needsYouRowKey(row.view),
    notificationId: row.notificationId,
    taskId: row.view.taskId,
    key: row.view.key,
    title: row.view.title,
    project: row.view.project,
    at: row.view.since,
    read: row.read,
    detail: row.view.detail,
    ask: askOf(row.view, me),
    outcome: outcomeOf(row.view.outcome, me),
    deliveryFailed: failed === null ? null : { channel: failed.channel === "email" ? "email" : "ticket", error: failed.error },
  };
};

const lostRace = (cause: unknown): boolean => {
  if (typeof cause !== "object" || cause === null) return false;
  const data: unknown = Reflect.get(cause, "data");
  return typeof data === "object" && data !== null && Reflect.get(data, "code") === "CONFLICT";
};

const refusal = (cause: unknown): AnswerResult =>
  lostRace(cause) ? { kind: "lost-race", outcome: null } : { kind: "refused", message: cause instanceof Error ? cause.message : t("errors.unknown") };

export const NeedsYouView = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const me = useQuery(trpc.me.get.queryOptions());
  const [tab, setTab] = useState<NeedsYouTab>("open");
  const [doneCursor, setDoneCursor] = useState<string | null>(null);
  const open = useQuery({ ...trpc.notifications.list.queryOptions({ tab: "open" }), refetchInterval: 15_000 });
  const done = useQuery({ ...trpc.notifications.list.queryOptions(doneCursor === null ? { tab: "done" } : { tab: "done", cursor: doneCursor }), enabled: tab === "done" });
  const preferences = useQuery(trpc.notifications.preferences.get.queryOptions());
  const markRead = useMutation(trpc.notifications.markRead.mutationOptions());
  const approve = useMutation(trpc.approvals.answer.mutationOptions());
  const plan = useMutation(trpc.plans.answer.mutationOptions());
  const question = useMutation(trpc.questions.answer.mutationOptions());
  const memberId = me.data?.memberId ?? null;
  // F-037 (ticket 36): the member's budget notices this month, above the task rows.
  const budgetNotices = useBudgetNotices();
  const notices = budgetNotices.data ?? [];
  const markNotices = useMutation(trpc.notifications.markRead.mutationOptions({ onSettled: () => queryClient.invalidateQueries({ queryKey: trpc.notifications.budgetNotices.queryKey() }) }));
  const unreadNotices = notices.filter((notice) => !notice.read).map((notice) => notice.notificationId).join(",");
  useEffect(() => {
    if (tab !== "open" || unreadNotices === "") return undefined;
    const timer = setTimeout(() => { markNotices.mutate({ ids: unreadNotices.split(",").map((id) => notificationIdSchema.parse(id)) }); }, READ_AFTER_MS);
    return () => { clearTimeout(timer); };
    // markNotices' identity changes each render; the unread notices decide.
  }, [unreadNotices, tab]);
  // F-142: the previews shared with the member by name, read once they're on screen, as the notices are.
  const previewShares = usePreviewShares();
  const shares = previewShares.data ?? [];
  const markShares = useMutation(trpc.notifications.markRead.mutationOptions({ onSettled: () => queryClient.invalidateQueries({ queryKey: trpc.notifications.previewShares.queryKey() }) }));
  const unreadShares = shares.filter((share) => !share.read).map((share) => share.notificationId).join(",");
  useEffect(() => {
    if (tab !== "open" || unreadShares === "") return undefined;
    const timer = setTimeout(() => { markShares.mutate({ ids: unreadShares.split(",").map((id) => notificationIdSchema.parse(id)) }); }, READ_AFTER_MS);
    return () => { clearTimeout(timer); };
    // markShares' identity changes each render; the unread shares decide.
  }, [unreadShares, tab]);
  // Ticket 31 (F-091): an admin's runners waiting for approval, first in the list, answered in the panel.
  const admin = me.data?.organization?.role === "admin";
  const fleet = useQuery({ ...trpc.runners.list.queryOptions(), enabled: admin, refetchInterval: 15_000 });
  const awaiting = useMemo(() => awaitingRunners(fleet.data ?? []), [fleet.data]);
  const [selectedRunner, setSelectedRunner] = useState<string | null>(null);
  const [unreadAtLoad, setUnreadAtLoad] = useState<ReadonlySet<string> | null>(null);

  const rows = useMemo(() => (open.data?.rows ?? []).map((row) => notificationViewOf(row, memberId)), [open.data, memberId]);
  useEffect(() => {
    if (open.data !== undefined && unreadAtLoad === null) setUnreadAtLoad(new Set(rows.filter((row) => !row.read).map((row) => row.id)));
  }, [open.data, rows, unreadAtLoad]);
  // Rows on screen for a moment are read (needs-you.md, Reading).
  useEffect(() => {
    if (tab !== "open") return undefined;
    const ids = toMarkRead(rows);
    if (ids.length === 0) return undefined;
    const timer = setTimeout(() => { markRead.mutate({ ids: ids.map((id) => notificationIdSchema.parse(id)) }); }, READ_AFTER_MS);
    return () => { clearTimeout(timer); };
    // markRead's identity changes each render; the rows decide.
  }, [rows, tab]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.notifications.list.queryKey() });
  // needs-you.md, "Reading": `Mark all as read` marks every open notification read, clears the dots and hides itself.
  const markAll = useMutation(trpc.notifications.markRead.mutationOptions({ onSettled: () => Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: trpc.notifications.pathKey() })]) }));
  const openIds = [...rows.flatMap((row) => (row.notificationId === null ? [] : [row.notificationId])), ...notices.map((notice) => notice.notificationId), ...shares.map((share) => share.notificationId)];
  const showMarkAll = tab === "open" && (open.data?.unread ?? 0) > 0 && openIds.length > 0;
  const answers: Answers = {
    approval: async (_row, ask, answer) => {
      const decision: ApprovalDecision = answer.kind === "once" ? "allow_once" : answer.kind === "task" ? "allow_task" : "deny";
      try {
        await approve.mutateAsync({ approvalId: approvalIdSchema.parse(ask.approvalId), decision, ...(answer.kind === "deny" && answer.reason !== "" ? { reason: answer.reason } : {}) });
        void refresh();
        return { kind: "answered", outcome: { kind: answer.kind === "once" ? "approved-once" : answer.kind === "task" ? "approved-task" : "denied", by: { kind: "you" } } };
      } catch (cause) {
        void refresh();
        return refusal(cause);
      }
    },
    plan: async (row, ask, answer) => {
      try {
        const taskId = taskIdSchema.parse(row.taskId);
        if (answer.kind === "approve") {
          const source = open.data?.rows.find((one) => (one.view.itemId ?? one.view.taskId) === row.id)?.view.answer;
          const entries = source?.kind === "plan" ? source.entries : [];
          await plan.mutateAsync({ taskId, decision: "approve", entries: [...entries], message: source?.kind === "plan" ? source.message : "" });
        } else {
          await plan.mutateAsync({ taskId, decision: "revise", request: answer.message });
        }
        void refresh();
        return { kind: "answered", outcome: answer.kind === "approve" ? { kind: "plan-approved", by: { kind: "you" } } : { kind: "answered", by: { kind: "you" } } };
      } catch (cause) {
        return refusal(cause);
      }
    },
    question: async (row, ask, text) => {
      const source = open.data?.rows.find((one) => (one.view.itemId ?? one.view.taskId) === row.id)?.view.answer;
      const fields = source?.kind === "question" ? source.fields : [];
      try {
        await question.mutateAsync({ taskId: taskIdSchema.parse(row.taskId), questionId: ask.questionId, answers: Object.fromEntries(fields.map((field) => [field.id, text])) });
        void refresh();
        return { kind: "answered", outcome: { kind: "answered", by: { kind: "you" } } };
      } catch (cause) {
        return refusal(cause);
      }
    },
  };

  const prefs = preferences.data;
  const reach: ReachView | null =
    prefs === undefined
      ? null
      : {
          tracker: prefs.tracker?.name ?? null,
          ticketOff: prefs.choices.filter((choice) => choice.channel === "tracker").every((choice) => !choice.enabled),
          email: !prefs.emailOn
            ? { kind: "install-off" }
            : prefs.choices.filter((choice) => choice.channel === "email").every((choice) => !choice.enabled)
              ? { kind: "off" }
              : { kind: "on", address: prefs.emailAddress, delayMinutes: Math.max(0, Math.round(prefs.emailDelaySeconds / 60)) },
        };

  return (
    <PageFrame
      crumbs={[{ label: me.data?.organization?.name ?? t("shell.organization") }, { label: t("needsYouPage.pageTitle") }]}
      actions={
        showMarkAll ? (
          <Button
            variant="outline"
            disabled={markAll.isPending}
            onClick={() => {
              setUnreadAtLoad(new Set());
              markAll.mutate({ ids: openIds.slice(0, 200).map((id) => notificationIdSchema.parse(id)) });
            }}
          >
            <CheckCheckIcon className="stroke-[1.75]" /> {t("needsYouPage.markAll")}
          </Button>
        ) : null
      }
      wideProperties={selectedRunner !== null}
      properties={
        selectedRunner === null ? (
          <ReachPanel reach={reach} />
        ) : (
          <RunnerApproval key={selectedRunner} runnerId={selectedRunner} organization={me.data?.organization?.name ?? ""} now={Date.now()} />
        )
      }
    >
      <PageHeading title={t("needsYouPage.pageTitle")} lede={<NeedsYouLede unread={open.data?.unread ?? null} />} />
      <NeedsYouTabs tab={tab} onTab={setTab} openCount={open.data?.total ?? null} />
      <div className="mt-4" data-needs-you-tab={tab}>
        {tab === "open" ? (
          open.error !== null ? (
            <p role="alert" className="text-red">{errorText(open.error)}</p>
          ) : open.data === undefined ? (
            <ListSkeleton />
          ) : rows.length === 0 && notices.length === 0 && shares.length === 0 && awaiting.length === 0 ? (
            <OpenEmpty />
          ) : (
            <div className="flex flex-col gap-3">
              {awaiting.length === 0 ? null : <RunnerApprovalsBand runners={awaiting} selected={selectedRunner} onSelect={setSelectedRunner} now={fleet.dataUpdatedAt} />}
              <BudgetNoticeRows notices={notices} organizationAdmin={me.data?.organization?.role === "admin"} />
              <PreviewShareRows shares={shares} />
              {rows.length === 0 ? null : <OpenList rows={rows} now={open.dataUpdatedAt} answers={answers} unreadAtLoad={unreadAtLoad ?? new Set()} />}
            </div>
          )
        ) : (
          <DoneList
            rows={(done.data?.rows ?? []).map((row) => notificationViewOf(row, memberId))}
            now={done.dataUpdatedAt}
            hasMore={done.data?.nextCursor !== null && done.data?.nextCursor !== undefined}
            onMore={() => { setDoneCursor(done.data?.nextCursor ?? null); }}
          />
        )}
      </div>
    </PageFrame>
  );
};
