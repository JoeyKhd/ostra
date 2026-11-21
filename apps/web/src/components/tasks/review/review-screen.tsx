"use client";

import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRightIcon, CheckIcon, LoaderCircleIcon, UsersIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { findingIdSchema } from "@ostra/protocol";
import type { TaskId } from "@ostra/protocol";

import { GitHubMark } from "@/components/github/github-mark";
import { PageFrame, pageKeyLine, pageTitleGap, PropGroup, PropRow } from "@/components/shell/page-frame";
import { initials } from "@/components/shell/user-menu";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { UnderlineTabs } from "@/components/ui/underline-tabs";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import { safeHref } from "@/task/renderers";

import { ChangesTab } from "../task-changes/changes-tab";
import { middleTruncate } from "../task-changes/task-changes";
import type { DiffFindingView } from "../task-changes/diff-words";
import { FindingBlock } from "./finding-block";
import { aiReviewWords, ciWords, findingsSummary, reviewerStateWords, reviewRunningText, subStateWords, viewerReview } from "./review-words";
import type { ReviewFinding, ReviewPr, ReviewScreen as Screen } from "./review-words";

// The review screen (app-targets/m6/review-screen.md; F-102, F-100, F-111, ticket 35): a tab per
// pull request, its diff (milestone 3's Changes tab, reused) with the AI review's findings on their
// lines, "Fix this" (a draft comment, sent with the rest by "Send to agent") and "Remember this" (a
// memory proposal); beside it the ticket's acceptance criteria, the reviewers and the PR. Nothing
// here approves or merges: "Open on GitHub to approve" goes to the PR.

const Sep = () => <span aria-hidden className="text-faint">·</span>;

const Dot = ({ tone }: { readonly tone: "amber" | "muted" | "green" }) => (
  <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", tone === "amber" ? "bg-amber" : tone === "green" ? "bg-green" : "bg-muted")} />
);

/** The round line: where the loop is, the CI, the AI review and the automatic turns. */
const RoundLine = ({ screen, pr, meId }: { readonly screen: Screen; readonly pr: ReviewPr | undefined; readonly meId: string | null }) => {
  const viewer = viewerReview(screen.prs.filter((one) => one.state === "pr_open"), meId);
  const waiting = screen.subState === "waiting_for_reviewer";
  const stage =
    waiting && viewer === "to-review" ? (
      <><Dot tone="amber" /><span className="font-medium text-text">{t("review.line.yourReview")}</span></>
    ) : viewer === "approved" ? (
      <><Dot tone="green" /><span className="text-text">{t("review.line.youApproved")}</span></>
    ) : (
      <><Dot tone="muted" /><span className="text-muted">{subStateWords(screen.subState, screen.rounds) ?? t("review.line.inReview")}</span></>
    );
  const ci = ciWords(pr?.ci?.state ?? null);
  const ai = aiReviewWords(screen.aiReview, screen.reviewRuns);
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" data-testid="review-round-line">
      <span className="flex items-center gap-2">{stage}</span>
      {ci === null ? null : <><Sep /><span className="text-muted">{ci}</span></>}
      {ai === null ? null : <><Sep /><span className="text-muted">{ai}</span></>}
      <Sep />
      <span className="text-muted">
        {t("review.line.turns")} <span className="font-mono text-text">{t("review.line.turnsCount", { used: screen.rounds.automaticTurns.used, limit: screen.rounds.automaticTurns.limit })}</span>
      </span>
    </p>
  );
};

/** The ticket and its acceptance criteria: the applied draft's, else the ticket's own section. */
const criteriaFromText = (text: string | null): readonly string[] => {
  if (text === null) return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => /^#{1,6}\s+acceptance criteria\s*$/i.test(line.trim()));
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line.trim())) break;
    const item = /^\s*(?:[-*]|\d+\.)\s+(?:\[[ x]\]\s+)?(.+)$/.exec(line);
    if (item?.[1] !== undefined) out.push(item[1]);
  }
  return out;
};

const TicketGroup = ({ ticket }: { readonly ticket: Screen["ticket"] }) => {
  const [all, setAll] = useState(false);
  if (ticket === null) {
    return (
      <PropGroup title={t("review.panel.ticket")}>
        <PropRow label={t("review.panel.ticket")}><span className="text-muted">{t("review.panel.none")}</span></PropRow>
        <p className="mt-1 text-sm text-faint">{t("review.panel.noTicket")}</p>
      </PropGroup>
    );
  }
  const criteria = ticket.acceptanceCriteria ?? criteriaFromText(ticket.description);
  const shown = all ? criteria : criteria.slice(0, 8);
  return (
    <PropGroup title={t("review.panel.ticket")}>
      <a href={safeHref(ticket.url) ?? "#"} target="_blank" rel="noopener noreferrer" className="font-mono text-ui text-teal hover:underline">{ticket.key}</a>
      <p className="mt-0.5 line-clamp-2 text-ui text-text">{ticket.title}</p>
      {criteria.length === 0 ? null : (
        <>
          <p className="mt-2 text-xs text-faint">{ticket.criteriaFrom === "draft" && ticket.acceptanceCriteria !== null ? t("review.panel.criteriaDraft") : t("review.panel.criteriaTicket")}</p>
          <ol className="mt-1.5 space-y-1.5" data-testid="review-criteria">
            {shown.map((item, index) => (
              <li key={`${String(index)}-${item}`} className="grid grid-cols-[20px_minmax(0,1fr)] text-ui text-text">
                <span className="font-mono text-xs leading-5 text-faint">{index + 1}</span>
                <span className="break-words">{item}</span>
              </li>
            ))}
          </ol>
          {criteria.length > 8 && !all ? (
            <button type="button" className="mt-1 text-sm text-muted hover:text-text" onClick={() => { setAll(true); }}>{t("review.panel.showMore", { n: criteria.length - 8 })}</button>
          ) : null}
        </>
      )}
    </PropGroup>
  );
};

const ReviewerRows = ({ pr, meId }: { readonly pr: ReviewPr; readonly meId: string | null }) => (
  <PropGroup title={t("review.panel.reviewers")}>
    {pr.reviewers.length === 0 ? (
      <p className="text-sm text-faint">{t("review.panel.nobody")}</p>
    ) : (
      <ul data-testid="review-reviewers">
        {pr.reviewers.map((reviewer, index) => {
          const name = reviewer.member?.name ?? (reviewer.team === null ? (reviewer.login ?? "") : `@${reviewer.team}`);
          return (
            <li key={`${String(index)}-${name}`} className="flex min-h-[30px] items-center gap-2 text-ui" title={reviewer.source} data-reviewer={name}>
              {reviewer.team === null ? (
                <span aria-hidden className="inline-grid size-5 shrink-0 place-items-center rounded-full bg-line-2 text-[9.5px] font-semibold text-text">{initials(name)}</span>
              ) : (
                <UsersIcon aria-hidden className="size-[15px] shrink-0 text-faint" />
              )}
              <span className={cn("min-w-0 truncate", reviewer.member === null ? "font-mono text-sm text-text" : "text-text")}>{name}</span>
              {reviewer.member !== null && reviewer.member.memberId === meId ? <span className="text-faint">{t("review.panel.you")}</span> : null}
              {reviewer.member === null && reviewer.team === null ? <span className="text-xs text-faint" title={t("review.panel.notLinkedHelp")}>{t("review.panel.notInOstra")}</span> : null}
              <span className={cn("ml-auto shrink-0 text-sm", reviewer.team !== null ? "text-faint" : reviewer.state === "approved" || reviewer.state === "changes_requested" ? "text-text" : "text-muted")}>
                {reviewer.state === "approved" ? <CheckIcon aria-hidden className="mr-1 inline size-[13px] text-green" /> : null}
                {reviewerStateWords(reviewer)}
              </span>
            </li>
          );
        })}
      </ul>
    )}
    <p className="mt-1.5 text-xs text-faint">{t("review.panel.onGithub")}</p>
  </PropGroup>
);

const PrGroup = ({ pr, screen, driver }: { readonly pr: ReviewPr; readonly screen: Screen; readonly driver: string | null }) => {
  const href = pr.prUrl === null ? null : safeHref(pr.prUrl);
  const failing = pr.ci?.checks.filter((check) => check.conclusion !== null && !["success", "neutral", "skipped"].includes(check.conclusion)) ?? [];
  return (
    <PropGroup title={t("review.panel.thisPr")}>
      <PropRow label={t("review.panel.driver")}><span className="truncate">{driver ?? "–"}</span></PropRow>
      <PropRow label={t("review.panel.branch")}><span className="truncate font-mono text-sm" title={pr.branch}>{middleTruncate(pr.branch, 26)}</span></PropRow>
      <PropRow label={t("review.panel.head")}><span className="font-mono text-sm">{pr.headSha?.slice(0, 7) ?? "–"}</span></PropRow>
      <PropRow label={t("review.panel.ci")}>
        {pr.ci === null ? (
          <span className="text-faint">{t("review.ci.none")}</span>
        ) : pr.ci.state === "passed" ? (
          <><CheckIcon aria-hidden className="text-green" /><span>{t("review.panel.ciPassed", { n: pr.ci.checks.length })}</span></>
        ) : pr.ci.state === "failed" ? (
          <><XIcon aria-hidden className="text-red" /><span className="truncate">{t("review.panel.ciFailed", { checks: failing.map((check) => check.name).join(", ") })}</span></>
        ) : pr.ci.state === "pending" ? (
          <><LoaderCircleIcon aria-hidden className="animate-spin" /><span>{t("review.ci.running")}</span></>
        ) : (
          <span className="text-faint">{ciWords(pr.ci.state)}</span>
        )}
      </PropRow>
      <PropRow label={t("review.panel.aiReview")}><span className="truncate" data-testid="review-ai-summary">{findingsSummary(screen.aiReview, pr.findings)}</span></PropRow>
      <PropRow label={t("review.panel.pr")}>
        {href === null || pr.prNumber === null ? <span className="text-faint">–</span> : (
          <a href={href} target="_blank" rel="noopener noreferrer" className="font-mono text-teal hover:underline">#{pr.prNumber}</a>
        )}
        <span className="text-muted">· {pr.state === "merged" ? t("review.pr.merged") : pr.state === "closed_unmerged" ? t("review.pr.closed") : t("review.pr.open")}</span>
      </PropRow>
    </PropGroup>
  );
};

export const ReviewScreen = ({ taskId }: { readonly taskId: TaskId }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  const params = useSearchParams();
  const screen = useQuery({ ...trpc.review.screen.queryOptions({ taskId }), refetchInterval: (query) => (query.state.data?.prs.some((pr) => pr.diffState === "loading") === true ? 3000 : 30_000) });
  const task = useQuery(trpc.tasks.get.queryOptions({ taskId }));
  const me = useQuery(trpc.me.get.queryOptions());
  const project = useQuery(trpc.projects.get.queryOptions(task.data === undefined ? skipToken : { projectId: task.data.projectId }));
  const comments = useQuery(trpc.diff.comments.list.queryOptions({ taskId }));
  const fix = useMutation(trpc.review.fixThis.mutationOptions({ onSettled: () => queryClient.invalidateQueries({ queryKey: trpc.diff.comments.list.queryKey({ taskId }) }) }));
  const remember = useMutation(trpc.review.rememberFinding.mutationOptions());
  const [proposals, setProposals] = useState<ReadonlyMap<string, string>>(new Map());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());

  const data = screen.data;
  const meId = me.data?.memberId ?? null;
  const prParam = params.get("pr");
  const pr = data?.prs.find((one) => one.taskRepoId === prParam) ?? data?.prs[0];
  const selectPr = useCallback(
    (taskRepoId: string) => {
      const query = new URLSearchParams(params.toString());
      query.set("pr", taskRepoId);
      router.replace(`/tasks/${taskId}/review?${query.toString()}`, { scroll: false });
    },
    [params, router, taskId],
  );
  const findingsById = useMemo(() => new Map<string, ReviewFinding>((pr?.findings ?? []).map((finding) => [finding.findingId, finding] as const)), [pr]);
  const findings: readonly DiffFindingView[] = useMemo(
    () => (pr?.findings ?? []).map((finding) => ({ id: finding.findingId, taskRepoId: pr?.taskRepoId ?? "", path: finding.path, line: finding.line, side: finding.side, state: finding.state, round: finding.round })),
    [pr],
  );
  const drafts = comments.data?.comments.filter((comment) => comment.state === "draft") ?? [];
  const projectName = project.data?.name ?? "";
  const fixedOf = (finding: ReviewFinding): boolean =>
    drafts.some((comment) => comment.taskRepoId === pr?.taskRepoId && comment.path === finding.path && comment.line === finding.line && comment.body.startsWith(finding.title.replaceAll(/[\r\n]+/g, " ")));

  const renderFinding = (view: DiffFindingView): ReactNode => {
    const finding = findingsById.get(view.id);
    if (finding === undefined) return null;
    const proposal = proposals.get(finding.findingId);
    return (
      <FindingBlock
        finding={finding}
        pictures={{ taskKey: task.data?.key ?? "", agentName: t("review.finding.ai") }}
        actions={{
          fixed: fixedOf(finding),
          proposalHref: proposal === undefined || task.data === undefined ? null : `/projects/${task.data.projectId}/memory/proposals?proposal=${encodeURIComponent(proposal)}`,
          projectName,
          canAct: true,
          prOpen: pr?.state === "pr_open",
          fixing: fix.isPending && fix.variables.findingId === finding.findingId,
          remembering: remember.isPending && remember.variables.findingId === finding.findingId,
          error: errors.get(finding.findingId) ?? null,
          onFix: () => {
            fix.mutate(
              { findingId: findingIdSchema.parse(finding.findingId) },
              { onError: (error) => { setErrors((now) => new Map([...now, [finding.findingId, errorText(error) ?? t("errors.unknown")]])); } },
            );
          },
          onRemember: () => {
            remember.mutate(
              { findingId: findingIdSchema.parse(finding.findingId) },
              {
                onSuccess: ({ proposalId }) => { setProposals((now) => new Map([...now, [finding.findingId, proposalId]])); },
                onError: (error) => { setErrors((now) => new Map([...now, [finding.findingId, errorText(error) ?? t("errors.unknown")]])); },
              },
            );
          },
        }}
      />
    );
  };

  const key = task.data?.key ?? "";
  const crumbs = [
    { label: projectName, href: task.data === undefined ? undefined : `/projects/${task.data.projectId}` },
    { label: t("shell.tasks"), href: task.data === undefined ? undefined : `/projects/${task.data.projectId}` },
    { label: key, href: `/tasks/${taskId}` },
    { label: t("review.crumb") },
  ].map((crumb) => (crumb.href === undefined ? { label: crumb.label } : { label: crumb.label, href: crumb.href }));
  const viewer = data === undefined ? "other" : viewerReview(data.prs, meId);
  const filesUrl = pr?.prUrl === null || pr?.prUrl === undefined ? null : safeHref(`${pr.prUrl}/files`);
  // A new review running on the PR: the findings shown are the last finished round's.
  const runningLine = data === undefined || pr === undefined ? null : reviewRunningText(data.reviewRuns, pr.repoId);

  return (
    <PageFrame
      padded={false}
      crumbs={crumbs}
      actions={
        filesUrl === null ? null : (
          <a href={filesUrl} target="_blank" rel="noopener noreferrer" className={buttonVariants()} data-action="open-on-github">
            <GitHubMark /> {viewer === "approved" ? t("review.openOnGithub") : t("review.openToApprove")} <ArrowUpRightIcon aria-hidden className="size-[13px]" />
          </a>
        )
      }
      properties={
        data === undefined || pr === undefined ? null : (
          <div data-testid="review-properties">
            <TicketGroup ticket={data.ticket} />
            <ReviewerRows pr={pr} meId={meId} />
            <PrGroup pr={pr} screen={data} driver={task.data?.driver?.name ?? null} />
          </div>
        )
      }
    >
      <div className="flex min-h-full flex-col px-4 pb-5 pt-6 sm:px-9 sm:pt-[26px] xl:h-full" data-testid="review-screen">
        <div className="shrink-0">
          <div className={pageKeyLine}>{key} · {task.data?.source === "prompt" ? t("taskPage.fromPrompt") : t("taskPage.fromTicket")}</div>
          <h1 className={cn("page-title break-words", pageTitleGap(true))}>{task.data?.title ?? data?.title ?? ""}</h1>
          {data === undefined ? <Skeleton className="h-4 w-[420px] max-w-full" /> : <RoundLine screen={data} pr={pr} meId={meId} />}
          {screen.error === null ? null : (
            <p role="alert" className="mt-3 text-red">
              {errorText(screen.error)}{" "}
              <button type="button" className="text-teal hover:underline" onClick={() => void screen.refetch()}>{t("review.tryAgain")}</button>
            </p>
          )}
          {data !== undefined && data.prs.length > 0 && pr !== undefined ? (
            <UnderlineTabs
              className="mt-4"
              label={t("review.prTabs")}
              idPrefix="review-pr"
              selected={pr.taskRepoId}
              onSelect={selectPr}
              tabs={data.prs.map((one) => ({
                id: one.taskRepoId,
                label: one.repo.split("/").at(-1) ?? one.repo,
                extra: (
                  <span className="flex items-center gap-1.5 font-mono text-xs text-faint">
                    {one.prNumber === null ? null : <span>#{one.prNumber}</span>}
                    <span title={t("review.filesChanged", { n: one.fileTree.length })}>{one.fileTree.length}</span>
                    {one.state === "merged" ? <span>{t("review.pr.merged")}</span> : one.state === "closed_unmerged" ? <span>{t("review.pr.closed")}</span> : null}
                  </span>
                ),
              }))}
            />
          ) : null}
        </div>
        {data?.prs.length === 0 ? (
          <p className="grid min-h-[240px] flex-1 place-items-center text-center text-body text-muted" data-testid="review-no-pr">
            <span>
              {t("review.noPr")} <Link href={`/tasks/${taskId}`} className="text-teal hover:underline">{t("review.backToTask")}</Link>
            </span>
          </p>
        ) : pr === undefined || task.data === undefined ? null : (
          <div className="min-h-0 flex-1">
            {runningLine === null ? null : <p className="mt-3 text-xs text-faint" data-testid="review-running">{runningLine}</p>}
            <ChangesTab
              key={pr.taskRepoId}
              taskId={taskId}
              agent={task.data.agent?.agentName ?? t("task.agent")}
              driver={task.data.driver?.name ?? null}
              isDriver={task.data.driver !== null && task.data.driver.memberId === meId}
              running={task.data.state === "running"}
              steersMidTurn={task.data.capabilities.steersMidTurn}
              sessionGoing={task.data.session !== null && ["starting", "running", "waiting", "idle"].includes(task.data.session.state)}
              onTakeOver={() => undefined}
              onSeeActivity={() => { router.push(`/tasks/${taskId}`); }}
              onlyRepo={pr.taskRepoId}
              findings={findings}
              renderFinding={renderFinding}
            />
          </div>
        )}
      </div>
    </PageFrame>
  );
};
