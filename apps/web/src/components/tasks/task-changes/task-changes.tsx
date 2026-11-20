"use client";

import { ArrowUpIcon, ArrowUpRightIcon, GitMergeIcon, MessageSquareIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { formatClock } from "@/lib/format";
import { fillNodes, tNodes } from "@/lib/message-nodes";
import { plural, t } from "@/lib/messages";

import { DiffView } from "./diff-view";
import type { DiffActions, RememberResult, SaveResult } from "./diff-view";
import { MAX_SEND, aheadText, behindOf, commentCount, draftsOf, draftsTitle, fileKey, glyphOf, reviewHint, rowsOf, sendLabel, shortNames } from "./diff-words";
import type { BehindPart, CommentTarget, DiffCommentView, DiffRepoView, OpenField, SendDelivery } from "./diff-words";

// The Changes tab (task-changes.md; F-027, F-072, F-070, ADR 0051, ADR 0052): the behind line with
// "Update branch", the files column, ostra's own diff with line comments, and the review bar that
// sends the viewer's drafts as one message. The wiring (`diff.get`, `diff.comments.*`,
// `tasks.updateBranch`) passes its data and actions in.

const Code = ({ children }: { readonly children: ReactNode }) => <span className="font-mono text-[13.5px] text-text">{children}</span>;

/** A press's progress: what the button shows, and the line after it. */
export type PressState = { readonly kind: "idle" } | { readonly kind: "sending" } | { readonly kind: "sent"; readonly n: number } | { readonly kind: "refused"; readonly message: string };

// ---------- the behind line ----------

/** The behind sentence: one repo names its count, several list theirs. */
export const behindSentence = (parts: readonly BehindPart[]): ReactNode => {
  const [first] = parts;
  if (first === undefined) return null;
  if (parts.length === 1) {
    const text = plural(first.behind, "changes.behindOne.one", "changes.behindOne.other");
    return fillNodes(text, { repo: <Code>{first.repo}</Code>, base: <Code>{first.base}</Code> });
  }
  const list = parts.map((part, index) => (
    <span key={part.repo}>
      {index === 0 ? null : ", "}
      <Code>{part.repo}</Code> ({part.behind})
    </span>
  ));
  return tNodes("changes.behindSeveral", { count: parts.length, list });
};

export type UpdateBranchProps = {
  readonly state: PressState;
  /** `null` when the viewer may send; the driver's name when they may not. */
  readonly driver: string | null;
  readonly agent: string;
  readonly onUpdate: () => void;
  readonly onTakeOver: () => void;
};

export const BehindLine = ({ repos, lastPushAt, update }: { readonly repos: readonly DiffRepoView[]; readonly lastPushAt: number | null; readonly update: UpdateBranchProps }) => {
  const parts = behindOf(repos);
  const asOf = lastPushAt === null ? null : (
    <span className="ml-auto shrink-0 text-xs text-faint">
      {t("changes.asOf")}
      <span className="font-mono">{formatClock(lastPushAt)}</span>
    </span>
  );
  if (parts.length === 0) return <div className="flex h-7 items-center">{asOf}</div>;
  const base = parts[0]?.base ?? "";
  const sent = update.state.kind === "sent";
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1" data-behind>
      <span className="flex items-center gap-2 text-ui text-muted">
        <GitMergeIcon aria-hidden className="size-[15px] stroke-[1.75] text-muted" />
        <span>
          {behindSentence(parts)}
          {sent ? <span className="text-xs text-muted">{t("changes.updateAsked", { agent: update.agent })}</span> : null}
        </span>
      </span>
      {sent ? null : (
        <Button
          size="sm"
          className="h-7"
          title={t("changes.updateTitle", { base })}
          disabled={update.state.kind === "sending" || update.driver !== null}
          onClick={update.onUpdate}
        >
          <GitMergeIcon aria-hidden /> {update.state.kind === "sending" ? t("changes.updating") : t("changes.updateBranch")}
        </Button>
      )}
      {update.driver === null || sent ? null : (
        <span className="flex items-center gap-1 text-xs text-faint">
          {t("changes.driving", { name: update.driver })}
          <Button variant="link" className="text-xs font-normal" onClick={update.onTakeOver}>{t("changes.takeOver")}</Button>
        </span>
      )}
      {update.state.kind === "refused" ? <span role="alert" className="text-xs text-red">{update.state.message}</span> : null}
      {asOf}
    </div>
  );
};

// ---------- the files column ----------

export const FilesColumn = ({
  repos,
  comments,
  selected,
  onSelect,
}: {
  readonly repos: readonly DiffRepoView[];
  readonly comments: readonly DiffCommentView[];
  readonly selected: string | null;
  readonly onSelect: (key: string) => void;
}) => (
  <nav aria-label={t("changes.files")} className="h-full min-h-0 overflow-y-auto pr-2">
    {repos.map((repo, index) => {
      const files = repo.state.kind === "ready" ? repo.state.files : [];
      const names = shortNames(files.map((file) => file.path));
      return (
        <section key={repo.taskRepoId} className={cn("pt-2", index > 0 && "mt-4 border-t border-line pt-4")} data-repo={repo.name}>
          <h3 className="font-mono text-[13.5px] font-medium text-text">{repo.name}</h3>
          <p className="truncate font-mono text-xs text-faint" title={repo.branch}>
            {middleTruncate(repo.branch, 22)} → {repo.base}
          </p>
          <p className="text-xs text-faint">
            {aheadText(repo)}
            {repo.headSha === null ? null : <> · <span className="font-mono">{repo.headSha.slice(0, 7)}</span></>}
          </p>
          {repo.state.kind === "ready" && repo.state.filesTruncated !== null ? (
            <p className="mt-1 text-xs text-faint">
              {t("changes.filesTruncated", { n: repo.state.filesTruncated.shown })}{" "}
              <a href={repo.state.filesTruncated.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-teal hover:underline">
                {t("changes.seeAll")} <ArrowUpRightIcon aria-hidden className="size-3" />
              </a>
            </p>
          ) : null}
          <ul className="mt-2">
            {files.map((file) => {
              const key = fileKey(repo.taskRepoId, file.path);
              const count = commentCount(comments, repo.taskRepoId, file.path);
              return (
                <li key={key}>
                  <button
                    type="button"
                    aria-current={selected === key ? "true" : undefined}
                    title={file.path}
                    data-file-row={file.path}
                    onClick={() => { onSelect(key); }}
                    className={cn("flex h-[28px] w-full items-center gap-1 rounded-sm px-1.5 text-left font-mono text-[12.5px] text-text-2 hover:bg-sel", selected === key && "bg-sel text-text")}
                  >
                    <span className="w-4 shrink-0 text-muted">{glyphOf(file.status)}</span>
                    <span className="min-w-0 flex-1 truncate">{names.get(file.path) ?? file.path}</span>
                    {file.body.kind === "binary" ? (
                      <span className="shrink-0 text-faint">{t("changes.binary")}</span>
                    ) : file.body.kind === "too-large" ? (
                      <span className="shrink-0 text-faint">{t("changes.tooLarge")}</span>
                    ) : (
                      <span className="shrink-0">
                        <span className="text-green">+{file.additions}</span> <span className="text-red">{"−"}{file.deletions}</span>
                      </span>
                    )}
                    {count === 0 ? null : (
                      <span className="ml-1 flex shrink-0 items-center gap-0.5 text-faint" aria-label={plural(count, "changes.commentsOnFile.one", "changes.commentsOnFile.other")}>
                        <MessageSquareIcon aria-hidden className="size-[13px] stroke-[1.75]" />
                        {count}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      );
    })}
  </nav>
);

/** `ostra/calc-174-9f3c…`: the branch's start and end, with the middle cut. */
export const middleTruncate = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const keep = max - 1;
  const head = Math.ceil(keep * 0.7);
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
};

// ---------- the review bar ----------

export type ReviewProps = {
  readonly delivery: SendDelivery;
  readonly agent: string;
  readonly state: PressState;
  readonly onSend: (drafts: readonly DiffCommentView[]) => void;
  readonly onTakeOver: () => void;
  readonly onSeeActivity: () => void;
};

/** How long "Sent" and "Draft deleted" hold their place. */
export const NOTICE_MS = 6000;

export const ReviewBar = ({ drafts, review }: { readonly drafts: readonly DiffCommentView[]; readonly review: ReviewProps }) => {
  if (review.state.kind === "sent")
    return (
      <p className="flex h-[52px] items-center gap-1 text-xs text-muted" role="status">
        {plural(review.state.n, "changes.review.sentLine.one", "changes.review.sentLine.other")}
        <Button variant="link" className="text-xs font-normal" onClick={review.onSeeActivity}>{t("changes.review.seeActivity")}</Button>
      </p>
    );
  if (drafts.length === 0) return null;
  const title = draftsTitle(drafts);
  const notDriver = review.delivery.kind === "not-driver";
  const tooMany = drafts.length > MAX_SEND;
  return (
    <div data-review-bar>
      <div className="flex min-h-[52px] flex-wrap items-center gap-3 rounded-lg border border-line-2 bg-surface px-3.5 py-2.5">
        <MessageSquareIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-muted" />
        <div className="min-w-0 flex-1">
          <p className="text-sm">
            <span className="font-semibold text-text">{title.count}</span>
            <span className="text-muted">{title.files}</span>
          </p>
          <p className="text-xs text-faint">
            {reviewHint(review.delivery, review.agent)}
            {notDriver ? (
              <>
                {" "}
                <Button variant="link" className="text-xs font-normal" onClick={review.onTakeOver}>{t("changes.takeOver")}</Button>
              </>
            ) : null}
          </p>
        </div>
        <Button variant="primary" disabled={notDriver || tooMany || review.state.kind === "sending"} onClick={() => { review.onSend(drafts); }}>
          <ArrowUpIcon aria-hidden /> {review.state.kind === "sending" ? t("changes.review.sending") : sendLabel(drafts.length)}
        </Button>
      </div>
      {tooMany ? <p role="alert" className="mt-1.5 text-xs text-red">{t("changes.review.tooMany")}</p> : null}
      {review.state.kind === "refused" ? <p role="alert" className="mt-1.5 text-xs text-red">{review.state.message}</p> : null}
    </div>
  );
};

// ---------- the tab ----------

export type ChangesLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly error: string; readonly retry: () => void }
  | { readonly kind: "ready"; readonly repos: readonly DiffRepoView[]; readonly lastPushAt: number | null };

export type ChangesBodyProps = {
  readonly load: ChangesLoad;
  readonly comments: readonly DiffCommentView[];
  /** The viewer may write comments (they can open the task; drafts are theirs). */
  readonly canComment: boolean;
  readonly update: UpdateBranchProps;
  readonly review: ReviewProps;
  readonly onSave: (target: CommentTarget, body: string, editing: DiffCommentView | null) => Promise<SaveResult>;
  readonly onDelete: (comment: DiffCommentView) => void;
  readonly onUndoDelete: (comment: DiffCommentView) => void;
  /** F-111: "Remember this" on a sent comment. */
  readonly onRemember?: (comment: DiffCommentView) => Promise<RememberResult>;
  /** The list's size before it's measured (the tests). */
  readonly initialHeight?: number;
};

const LoadingBody = () => (
  <div className="flex gap-4 pt-10" aria-busy>
    <div className="w-[220px] space-y-3">
      {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-4 w-full" />)}
    </div>
    <div className="flex-1 space-y-3 border-l border-line pl-4">
      {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-4 w-full" />)}
    </div>
  </div>
);

export const ChangesBody = ({ load, comments, canComment, update, review, onSave, onDelete, onUndoDelete, onRemember, initialHeight }: ChangesBodyProps) => {
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<OpenField>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [scrollTo, setScrollTo] = useState<{ readonly key: string } | null>(null);
  const [deleted, setDeleted] = useState<DiffCommentView | null>(null);

  useEffect(() => {
    if (deleted === null) return;
    const timer = setTimeout(() => { setDeleted(null); }, NOTICE_MS);
    return () => { clearTimeout(timer); };
  }, [deleted]);

  const repos = load.kind === "ready" ? load.repos : [];
  const rows = useMemo(() => rowsOf(repos, comments, folded, open), [repos, comments, folded, open]);
  const drafts = draftsOf(comments);
  const onTopFile = useCallback((key: string) => { setSelected(key); }, []);

  const actions: DiffActions = {
    onOpen: (target) => { setOpen({ kind: "new", target }); },
    onEdit: (comment) => { setOpen({ kind: "edit", comment }); },
    ...(onRemember === undefined ? {} : { onRemember }),
    onCancel: () => { setOpen(null); },
    onSave: async (target, body, editing) => {
      const result = await onSave(target, body, editing);
      if (result.kind === "saved") setOpen(null);
      return result;
    },
    onDelete: (comment) => {
      setDeleted(comment);
      onDelete(comment);
    },
    onFold: (key) => {
      setFolded((now) => {
        const next = new Set(now);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
  };

  switch (load.kind) {
    case "loading":
      return <LoadingBody />;
    case "failed":
      return (
        <p role="alert" className="mt-4 text-xs text-red">
          {t("changes.loadFailed", { error: load.error })}{" "}
          <Button variant="link" className="text-xs font-normal" onClick={load.retry}>{t("changes.tryAgain")}</Button>
        </p>
      );
    case "ready":
      break;
    default:
      return load satisfies never;
  }

  if (repos.every((repo) => repo.state.kind === "not-pushed"))
    return <p className="grid min-h-[240px] flex-1 place-items-center text-center text-sm text-muted">{t("changes.nothingPushed")}</p>;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-changes>
      <div className="mt-3">
        <BehindLine repos={repos} lastPushAt={load.lastPushAt} update={update} />
      </div>
      <div className="mt-3 flex min-h-[320px] flex-1 flex-col gap-3 md:flex-row md:gap-0">
        <div className="max-h-[220px] shrink-0 md:max-h-none md:w-[220px]">
          <FilesColumn
            repos={repos}
            comments={comments}
            selected={selected}
            onSelect={(key) => {
              setSelected(key);
              setScrollTo({ key });
            }}
          />
        </div>
        <div className="min-h-[320px] min-w-0 flex-1 md:border-l md:border-line">
          <DiffView
            rows={rows}
            canComment={canComment}
            actions={actions}
            scrollTo={scrollTo}
            onTopFile={onTopFile}
            {...(initialHeight === undefined ? {} : { initialHeight })}
          />
        </div>
      </div>
      <div className="mt-3 shrink-0">
        {deleted === null ? null : (
          <p className="mb-2 flex items-center gap-1 text-xs text-muted" role="status">
            {t("changes.deleted")}
            <Button variant="link" className="text-xs font-normal" onClick={() => { onUndoDelete(deleted); setDeleted(null); }}>
              {t("changes.undo")}
            </Button>
          </p>
        )}
        <ReviewBar drafts={drafts} review={review} />
      </div>
    </div>
  );
};

/** The tab's count after `Changes`: the changed files across the task's repos, or none. */
export const ChangesTabCount = ({ count }: { readonly count: number | null }) =>
  count === null || count === 0 ? null : <span className="font-mono text-xs text-faint">{count}</span>;
