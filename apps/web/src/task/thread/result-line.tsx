"use client";

import { useQuery } from "@tanstack/react-query";
import { AppWindowIcon, CheckIcon, ChevronRightIcon, FilePenLineIcon, GitCommitHorizontalIcon, LightbulbIcon, ListChecksIcon, MessageSquareTextIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import type { PushedData, TurnResult } from "@ostra/task-view";

import { usePhone } from "@/components/tasks/take-it-local";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { SafeLink } from "../renderers";
import { isRunOpen, useRunOpen } from "./run-open";
import { Segments, toneClass } from "./segments";
import { useThreadParts } from "./thread-context";
import type { ThreadResults } from "./thread-context";
import { pushCheckWords, pushCommitWords, resultWords } from "./words";
import type { PushCheck, PushContext, PushRowWords, Segment } from "./words";

// Owner: ticket 14 (milestone 10, F-151: a result line, parts.md part 8). What a turn made, after
// its prose: a 14px icon `--faint`, one 14px `--faint` line with its subject `--text-2`, and either
// a chevron (it opens in place) or a teal link (it goes somewhere). A push opens its commit and the
// checks its turn ran in the box; a review goes to milestone 6's review screen, a draft to the Draft
// tab, the preview to the side pane, a memory to the project's proposals. Saving unfinished work to
// the hidden ref is bookkeeping, never a result: the fold keeps it for the turn's footer.

type LineResult = Exclude<TurnResult, { kind: "pr" }>;
type PushResult = Extract<TurnResult, { kind: "push" }>;

/**
 * Where a push went (parts.md part 8, choice 8): the push that opened its PR (the card under it,
 * `firstPr`), or a later push to a PR already open, said `Pushed {sha7}` with CI's verdict once it
 * says, and no second card. A push is later when its repo had a PR open before its turn started; a
 * push whose PR is still being opened, or never was, reads as a first push.
 */
export const pushContextOf = (push: PushedData, turnAt: number | null, results: ThreadResults | undefined): PushContext => {
  if (push.firstPr !== null || results === undefined) return { later: false, ci: null };
  const later = results.prsOf(push.repoId).some((pr) => turnAt === null || pr.openedAt <= turnAt);
  return { later, ci: later ? results.ciOnHead(push.repoId, push.headSha) : null };
};

const iconOf = (result: LineResult): ReactNode => {
  switch (result.kind) {
    case "push":
      return <GitCommitHorizontalIcon aria-hidden />;
    case "review":
      return <MessageSquareTextIcon aria-hidden />;
    case "draft":
      return <FilePenLineIcon aria-hidden />;
    case "preview":
      return <AppWindowIcon aria-hidden />;
    case "memory":
      return <LightbulbIcon aria-hidden />;
    default:
      return result satisfies never;
  }
};

const teal = "shrink-0 text-teal hover:underline";

/** Where a result's teal link goes: the preview's pane, the review screen, the Draft tab, the project's proposals. */
const actionOf = (result: Exclude<LineResult, PushResult>, label: string, taskId: string, results: ThreadResults | undefined): ReactNode => {
  switch (result.kind) {
    case "preview": {
      const { preview } = result;
      if (preview.port === null) return null;
      const query = new URLSearchParams({ pane: "preview", preview: `port-${String(preview.port)}`, ...(preview.path === null ? {} : { path: preview.path }) });
      return <Link href={`?${query.toString()}`} className={teal} data-action="show-preview">{label}</Link>;
    }
    case "review": {
      // Milestone 6's review screen; in a thread that doesn't know it, the review on the code host.
      const href = results?.reviewHref ?? null;
      if (href !== null) return <Link href={href} className={teal} data-action="open-review">{label}</Link>;
      const [post] = result.review.posted;
      return post === undefined ? null : <span className="shrink-0" data-action="open-review"><SafeLink href={post.url}>{label}</SafeLink></span>;
    }
    case "draft":
      return <Link href={`/tasks/${taskId}?tab=draft`} className={teal} data-action="open-draft">{label}</Link>;
    case "memory":
      return results === undefined ? null : (
        <Link href={`/projects/${results.projectId}/memory/proposals?proposal=${encodeURIComponent(result.memory.proposalId)}`} className={teal} data-action="review-memory">
          {label}
        </Link>
      );
    default:
      return result satisfies never;
  }
};

/** A review's words, its teal `PR #483` the PR's link on the code host. */
const ReviewWords = ({ segments, url }: { readonly segments: readonly Segment[]; readonly url: string | null }) => (
  <>
    {segments.map((segment, index) =>
      segment.tone === "teal" && url !== null ? (
        <SafeLink key={index} href={url}>{segment.text}</SafeLink>
      ) : (
        <span key={index} className={cn(toneClass(segment.tone), segment.mono && "font-mono text-[13px]")}>{segment.text}</span>
      ),
    )}
  </>
);

/** One row of the opened push, on the opened run's grid (`22px icon | 72px verb | subject`), 28px. */
const PushRow = ({ icon, words, href, kind }: { readonly icon: ReactNode; readonly words: PushRowWords; readonly href: string; readonly kind: "commit" | "check" }) => (
  <li data-push-row={kind} className="grid min-h-7 grid-cols-[22px_72px_minmax(0,1fr)] items-center text-ui">
    <span aria-hidden className="flex items-center text-faint [&_svg]:size-[14px] [&_svg]:stroke-[1.75]">{icon}</span>
    <span className="whitespace-nowrap text-muted">{words.verb}</span>
    <span className="flex min-w-0 items-baseline gap-2.5 whitespace-nowrap">
      <span className="min-w-0 truncate font-mono text-[13.5px] text-text-2"><Segments segments={words.subject} /></span>
      {words.result.length === 0 ? null : kind === "commit" ? (
        // How far the commit is ahead is words, not a figure: sans, as ostra's own tools' outcomes.
        <span data-part="step-result" className="shrink-0 text-[13.5px] text-faint"><Segments segments={words.result} /></span>
      ) : (
        // A check's result as a command's: mono 12.5px, 10px before a ` · `, `✓ passed` with the 12px check.
        <span data-part="step-result" className="shrink-0 whitespace-pre font-mono text-[12.5px] text-faint">
          {words.result.map((segment, index) =>
            segment.text.startsWith("✓ ") ? (
              <span key={index} className={cn("inline-flex items-center gap-[3px]", toneClass(segment.tone))}>
                <CheckIcon aria-hidden className="size-3" />
                <span className="sr-only">✓ </span>
                {segment.text.slice(2)}
              </span>
            ) : (
              <span key={index} className={cn(toneClass(segment.tone), segment.text === " · " && "ml-[2.5px]")}>{segment.text}</span>
            ),
          )}
        </span>
      )}
      {words.link === null ? null : (
        <Link href={href} aria-label={words.link.name} className="inline-flex shrink-0 items-center gap-px text-[12.5px] text-teal hover:underline">
          {words.link.label}
          <ChevronRightIcon aria-hidden className="size-3" />
        </Link>
      )}
    </span>
  </li>
);

/**
 * A push opened in place: its commit (how far ahead of its base, from the Changes tab's compare of
 * that head, `diff.get`) and the checks its turn ran in the box before it (the Checks tab's,
 * `tasks.checks`), each read only once the push is opened.
 */
const PushOpen = ({ push, id }: { readonly push: PushedData; readonly id: string }) => {
  const trpc = useTRPC();
  const { taskId } = useThreadParts().workspace;
  const diff = useQuery(trpc.diff.get.queryOptions({ taskId }));
  const checks = useQuery(trpc.tasks.checks.queryOptions({ taskId }));
  const compared = diff.data?.repos.find((repo) => repo.repoId === push.repoId && repo.headSha === push.headSha && repo.state === "ready");
  const commit = pushCommitWords(push.headSha, compared === undefined || compared.aheadBy === null ? null : { aheadBy: compared.aheadBy, base: compared.base }, t);
  // The turn whose checks ran on this head, and its runs in this repo or at the workspace's root.
  const turn = checks.data?.turns.find((one) => one.heads.some((head) => head.repoId === push.repoId && head.headSha === push.headSha));
  const timeoutOf = new Map((checks.data?.checks ?? []).map((check) => [check.checkId, check.timeoutSeconds * 1000] as const));
  const runs: readonly (PushCheck & { readonly id: string })[] = (turn?.runs ?? [])
    .filter((run) => run.repoId === null || run.repoId === push.repoId)
    .map((run) => ({ id: run.id, name: run.name, status: run.status, exitCode: run.exitCode, durationMs: run.durationMs, timeoutMs: timeoutOf.get(run.checkId) ?? 600_000 }));
  return (
    <div data-part="push-open" id={id} className="mb-2.5 ml-px border-l border-line-2 pl-3.5 pt-0.5">
      <ul role="list">
        <PushRow icon={<GitCommitHorizontalIcon />} words={commit} href={`/tasks/${taskId}?tab=changes`} kind="commit" />
        {runs.map((run) => <PushRow key={run.id} icon={<ListChecksIcon />} words={pushCheckWords(run, t)} href={`/tasks/${taskId}?tab=checks`} kind="check" />)}
      </ul>
    </div>
  );
};

/** A push's line: a button with its chevron, which opens its commit and its checks in place. */
const PushLine = ({ result, itemId, turnAt }: { readonly result: PushResult; readonly itemId: string; readonly turnAt: number | null }) => {
  const { results } = useThreadParts();
  const { state, store } = useRunOpen();
  // Open as a run is: per viewer, never saved, and still open as new events arrive (`run-open.ts`).
  const toggle = { id: itemId, steps: [] };
  const open = isRunOpen(state, toggle);
  const words = resultWords(result, t, pushContextOf(result.push, turnAt, results));
  const openId = `push-${itemId}`;
  const phone = usePhone();
  return (
    <div data-part="result" data-result="push" data-open={open ? "true" : "false"}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? openId : undefined}
        onClick={() => { store.toggleRun(toggle); }}
        className={cn(
          // s6.md: at 390 the push line wraps, its whole line the 44px tap target, the chevron after the last word.
          "my-1.5 -ml-1.5 flex min-h-7 max-w-full items-center gap-2 whitespace-nowrap rounded-md px-1.5 text-ui text-faint hover:bg-hover hover:text-muted [&>svg]:size-[14px] [&>svg]:shrink-0 [&>svg]:stroke-[1.75]",
          phone && "min-h-11 items-start whitespace-normal py-2",
          open && "text-muted",
        )}
      >
        {iconOf(result)}
        <span data-part="result-words" className={cn("min-w-0 truncate", phone && "whitespace-normal")}>
          <Segments segments={words.words} mono="font-mono text-[13px]" />
          {phone ? <ChevronRightIcon aria-hidden className={cn("ml-0.5 inline size-3.5 align-[-2px] text-faint", open && "rotate-90")} /> : null}
        </span>
        {phone ? null : <ChevronRightIcon aria-hidden className={cn("text-faint", open && "rotate-90")} />}
      </button>
      {open ? <PushOpen push={result.push} id={openId} /> : null}
    </div>
  );
};

/** One result line; a push's turn starts at `turnAt` (whether its PR was open before it). */
export const ResultLine = ({ result, itemId, turnAt = null }: { readonly result: LineResult; readonly itemId: string; readonly turnAt?: number | null }) => {
  const { workspace, results } = useThreadParts();
  if (result.kind === "push") return <PushLine result={result} itemId={itemId} turnAt={turnAt} />;
  const words = resultWords(result, t);
  const reviewUrl = result.kind === "review" ? (result.review.posted[0]?.url ?? null) : null;
  return (
    <div data-part="result" data-result={result.kind} className="my-1.5 flex min-h-7 items-center gap-2 whitespace-nowrap text-ui text-faint max-sm:flex-wrap max-sm:whitespace-normal [&>svg]:size-[14px] [&>svg]:shrink-0 [&>svg]:stroke-[1.75]">
      {iconOf(result)}
      <span data-part="result-words" className="min-w-0 truncate max-sm:whitespace-normal">
        {result.kind === "review" ? <ReviewWords segments={words.words} url={reviewUrl} /> : <Segments segments={words.words} mono="font-mono text-[13px]" />}
      </span>
      {words.action === null ? null : <span className="ml-1 flex shrink-0">{actionOf(result, words.action.label, workspace.taskId, results)}</span>}
    </div>
  );
};
