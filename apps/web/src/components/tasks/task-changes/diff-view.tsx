"use client";

import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import type { Range } from "@tanstack/react-virtual";
import { ArrowUpRightIcon, BookmarkPlusIcon, ChevronDownIcon, ChevronRightIcon, MessageSquarePlusIcon, PencilIcon, Trash2Icon, UnfoldVerticalIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { formatClock } from "@/lib/format";
import { t } from "@/lib/messages";

import { COUNTER_FROM, MAX_COMMENT, anchorOf, estimateRow } from "./diff-words";
import type { CommentTarget, DiffCommentView, DiffLine, DiffRow } from "./diff-words";

// ostra's own unified diff (task-changes.md, "The diff view"; F-027, F-072, ADR 0051): one
// continuous, virtualized list of every file's header, hunks, lines and comments. Code and comment
// text are plain text, drawn as React text nodes: never markup.

const sha7 = (sha: string): string => sha.slice(0, 7);
const minus = "−";

/** What the field's save answered: saved, the line is gone from the latest diff, or refused. */
export type SaveResult = { readonly kind: "saved" } | { readonly kind: "line-gone" } | { readonly kind: "refused"; readonly message: string };

export type DiffActions = {
  readonly onOpen: (target: CommentTarget) => void;
  readonly onEdit: (comment: DiffCommentView) => void;
  readonly onCancel: () => void;
  readonly onSave: (target: CommentTarget, body: string, editing: DiffCommentView | null) => Promise<SaveResult>;
  readonly onDelete: (comment: DiffCommentView) => void;
  readonly onFold: (key: string) => void;
  /** F-111: "Remember this" on a sent comment proposes it as a project note; answers whether it went. */
  readonly onRemember?: (comment: DiffCommentView) => Promise<RememberResult>;
};

export type RememberResult = { readonly kind: "proposed" } | { readonly kind: "refused"; readonly message: string };

// ---------- the rows ----------

const FileHeader = ({ row, onFold }: { readonly row: Extract<DiffRow, { kind: "file" }>; readonly onFold: (key: string) => void }) => {
  const { file } = row;
  const Chevron = row.folded ? ChevronRightIcon : ChevronDownIcon;
  const note = row.folded && (file.body.kind === "too-large" || file.body.kind === "binary") ? file.body : null;
  return (
    <button
      type="button"
      aria-expanded={!row.folded}
      data-file={row.key}
      onClick={() => { onFold(row.key); }}
      className="flex h-[34px] w-full items-center gap-2 border-y border-line bg-surface px-3 text-left"
    >
      <Chevron aria-hidden className="size-3.5 shrink-0 stroke-[1.75] text-muted" />
      <span className="min-w-0 truncate font-mono text-[13.5px] font-medium text-text" title={file.path}>{file.path}</span>
      {file.previousPath === null ? null : <span className="min-w-0 truncate font-mono text-xs text-faint">← {file.previousPath}</span>}
      {file.body.kind === "binary" ? null : (
        <span className="shrink-0 font-mono text-xs">
          <span className="text-green">+{file.additions}</span> <span className="text-red">{minus}{file.deletions}</span>
        </span>
      )}
      {note === null ? null : <span className="ml-2 shrink-0 text-xs text-faint">{note.kind === "binary" ? t("changes.binaryRow") : t("changes.tooLargeRow")}</span>}
    </button>
  );
};

const NoteRow = ({ row }: { readonly row: Extract<DiffRow, { kind: "note" }> }) => {
  const text = (() => {
    switch (row.text) {
      case "too-large":
        return t("changes.tooLargeRow");
      case "binary":
        return t("changes.binaryRow");
      case "renamed-only":
        return t("changes.renamedRow");
      case "fetching":
        return t("changes.fetching");
      case "no-changes":
        return t("changes.noChanges", { base: row.base });
      default:
        return row.text satisfies never;
    }
  })();
  return (
    <div className="flex h-8 items-center gap-3 px-3 text-xs text-faint">
      {text}
      {row.url === null ? null : (
        <a href={row.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-teal hover:underline">
          {t("changes.openOnGitHub")} <ArrowUpRightIcon aria-hidden className="size-3" />
        </a>
      )}
    </div>
  );
};

const lineTone = (line: DiffLine): { readonly fill: string; readonly mark: string; readonly sign: string } => {
  switch (line.kind) {
    case "add":
      return { fill: "bg-diff-add", mark: "text-green", sign: "+" };
    case "del":
      return { fill: "bg-diff-del", mark: "text-red", sign: minus };
    case "context":
    case "no-newline":
      return { fill: "", mark: "text-faint", sign: "" };
    default:
      return line satisfies never;
  }
};

const LineRow = ({
  row,
  focused,
  canComment,
  onOpen,
}: {
  readonly row: Extract<DiffRow, { kind: "line" }>;
  readonly focused: boolean;
  readonly canComment: boolean;
  readonly onOpen: (target: CommentTarget) => void;
}) => {
  const { line } = row;
  if (line.kind === "no-newline") return <div className="flex h-[21px] items-center pl-[104px] text-xs text-faint">{t("changes.noNewline")}</div>;
  const tone = lineTone(line);
  const anchor = anchorOf(line);
  const oldNo = line.kind === "add" ? "" : String(line.old);
  const newNo = line.kind === "del" ? "" : String(line.new);
  const button =
    anchor === null || !canComment ? null : (
      <button
        type="button"
        tabIndex={-1}
        aria-label={t("changes.commentOn", { n: anchor.line })}
        onClick={() => { onOpen({ taskRepoId: row.taskRepoId, path: row.path, ...anchor }); }}
        className={cn(
          "absolute top-0.5 grid size-4 place-items-center rounded-[4px] bg-surface text-teal opacity-0 group-hover:opacity-100 group-focus:opacity-100",
          anchor.side === "new" ? "left-[60px]" : "left-[20px]",
        )}
      >
        <MessageSquarePlusIcon aria-hidden className="size-3 stroke-2" />
      </button>
    );
  return (
    <div
      role="row"
      tabIndex={focused ? 0 : -1}
      data-line={anchor === null ? undefined : `${anchor.side}:${String(anchor.line)}`}
      className={cn("group relative grid grid-cols-[40px_40px_16px_minmax(0,1fr)] font-mono text-[13px] leading-[21px] outline-offset-[-2px]", tone.fill)}
    >
      <span className={cn("select-none pr-2 text-right", line.kind === "context" ? "text-faint" : tone.mark)}>{oldNo}</span>
      <span className={cn("select-none pr-2 text-right", line.kind === "context" ? "text-faint" : tone.mark)}>{newNo}</span>
      <span aria-hidden className={cn("select-none", tone.mark)}>{tone.sign}</span>
      <span className="whitespace-pre-wrap pr-3 text-text [overflow-wrap:anywhere]">{line.text}</span>
      {button}
    </div>
  );
};

const Chip = ({ children, tone }: { readonly children: ReactNode; readonly tone: "muted" | "faint" }) => (
  <span className={cn("inline-flex h-[22px] items-center rounded-sm border border-line-2 px-2 text-xs", tone === "muted" ? "text-muted" : "text-faint")}>{children}</span>
);

/** A sent comment, the viewer's draft, or an outdated one: plain text under a 2px left rule. */
export const CommentBlock = ({ comment, onEdit, onDelete, onRemember }: { readonly comment: DiffCommentView; readonly onEdit: () => void; readonly onDelete: () => void; readonly onRemember?: (() => Promise<RememberResult>) | undefined }) => {
  const outdated = comment.outdated;
  const [remember, setRemember] = useState<RememberResult | "pending" | null>(null);
  const chip = outdated !== null ? t("changes.outdated") : comment.state === "sent" ? t("changes.sent") : t("changes.draft");
  return (
    <div className="py-1 pl-[104px] pr-3" data-comment={comment.id} data-state={outdated === null ? comment.state : "outdated"}>
      <div className="border-l-2 border-line-2 pl-3">
        <div className="flex h-7 items-center gap-2">
          <Avatar name={comment.author} className="size-5 text-[10px]" />
          <span className={cn("text-sm font-semibold", outdated === null ? "text-text" : "text-muted")}>{comment.author}</span>
          <span className="font-mono text-xs text-faint">{formatClock(comment.at)}</span>
          <Chip tone={outdated !== null || comment.state === "draft" ? "faint" : "muted"}>{chip}</Chip>
          {outdated === null ? null : <span className="font-mono text-xs text-faint">{t("changes.outdatedWhere", { n: comment.line, sha: sha7(comment.headSha) })}</span>}
          {comment.state === "draft" ? (
            <span className="ml-auto flex gap-1">
              <Tooltip content={t("changes.editDraft")}>
                <Button variant="ghost" size="icon" className="size-6" aria-label={t("changes.editDraft")} onClick={onEdit}>
                  <PencilIcon aria-hidden />
                </Button>
              </Tooltip>
              <Tooltip content={t("changes.deleteDraft")}>
                <Button variant="ghost" size="icon" className="size-6" aria-label={t("changes.deleteDraft")} onClick={onDelete}>
                  <Trash2Icon aria-hidden />
                </Button>
              </Tooltip>
            </span>
          ) : onRemember === undefined ? null : remember !== null && remember !== "pending" && remember.kind === "proposed" ? (
            <span className="ml-auto text-xs text-muted" data-testid="remembered">{t("changes.remembered")}</span>
          ) : (
            <Button
              variant="ghost"
              className="ml-auto h-6 px-2 text-xs"
              disabled={remember === "pending"}
              data-action="remember-this"
              onClick={() => {
                setRemember("pending");
                void onRemember().then(setRemember);
              }}
            >
              <BookmarkPlusIcon aria-hidden />
              {t("changes.rememberThis")}
            </Button>
          )}
        </div>
        {remember !== null && remember !== "pending" && remember.kind === "refused" ? <p role="alert" className="text-xs text-red">{remember.message}</p> : null}
        {outdated === null ? null : (
          <div className="whitespace-pre-wrap font-mono text-xs text-faint [overflow-wrap:anywhere]">
            {outdated.sign === "-" ? minus : outdated.sign} {outdated.text}
          </div>
        )}
        <p className={cn("whitespace-pre-wrap text-sm leading-normal [overflow-wrap:anywhere]", outdated === null ? "text-text" : "text-muted")}>{comment.body}</p>
      </div>
    </div>
  );
};

/** What `Esc` does in the field: an empty field cancels; a filled one asks for a second `Esc`. */
export const escapeStep = (text: string, armed: boolean): "cancel" | "arm" => (text.trim() === "" || armed ? "cancel" : "arm");

/** The open field: a new comment on a line, or a draft being edited. */
export const CommentField = ({
  target,
  editing,
  onSave,
  onCancel,
}: {
  readonly target: CommentTarget;
  readonly editing: DiffCommentView | null;
  readonly onSave: (target: CommentTarget, body: string, editing: DiffCommentView | null) => Promise<SaveResult>;
  readonly onCancel: () => void;
}) => {
  const [text, setText] = useState(editing?.body ?? "");
  const [saving, setSaving] = useState(false);
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooLong = text.length > MAX_COMMENT;
  const empty = text.trim() === "";
  const save = async () => {
    if (empty || tooLong || saving) return;
    setSaving(true);
    setError(null);
    const result = await onSave(target, text, editing);
    setSaving(false);
    switch (result.kind) {
      case "saved":
        return;
      case "line-gone":
        setError(t("changes.lineGone"));
        return;
      case "refused":
        setError(result.message);
        return;
      default:
        return result satisfies never;
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (escapeStep(text, armed) === "cancel") onCancel();
      else setArmed(true);
    } else if (armed) setArmed(false);
  };
  const rows = Math.min(8, Math.max(2, text.split("\n").length));
  return (
    <div className="py-2 pl-[104px] pr-3" data-field={`${target.side}:${String(target.line)}`}>
      <div className="focus-box rounded-lg border border-control-line bg-surface px-3 py-2.5">
        <textarea
          // The field opens on a press, so it takes the focus then (task-changes.md).
          autoFocus
          rows={rows}
          value={text}
          aria-label={t("changes.placeholder", { n: target.line })}
          placeholder={t("changes.placeholder", { n: target.line })}
          onChange={(event) => { setText(event.target.value); }}
          onKeyDown={onKeyDown}
          className="w-full resize-none bg-transparent text-sm leading-normal text-text outline-none placeholder:text-faint"
        />
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className="mr-auto text-xs text-faint">{t("changes.onlyYou")}</span>
          {text.length >= COUNTER_FROM ? (
            <span data-counter className={cn("font-mono text-xs", tooLong ? "text-red" : "text-faint")}>
              {t("changes.counter", { n: text.length.toLocaleString("en-US"), max: MAX_COMMENT.toLocaleString("en-US") })}
            </span>
          ) : null}
          <Button variant="ghost" size="sm" onClick={onCancel}>{t("common.cancel")}</Button>
          <Button size="sm" disabled={empty || tooLong || saving} onClick={() => { void save(); }}>
            {saving ? t("changes.savingDraft") : t("changes.saveDraft")}
          </Button>
        </div>
      </div>
      {error === null ? null : <p role="alert" className="mt-1.5 text-xs text-red">{error}</p>}
    </div>
  );
};

/** One row of the diff, as the virtualized list draws it. */
export const DiffRowView = ({
  row,
  focused,
  canComment,
  actions,
}: {
  readonly row: DiffRow;
  readonly focused: boolean;
  readonly canComment: boolean;
  readonly actions: DiffActions;
}) => {
  switch (row.kind) {
    case "file":
      return <FileHeader row={row} onFold={actions.onFold} />;
    case "note":
      return <NoteRow row={row} />;
    case "hunk":
      return <div className="flex h-6 items-center truncate bg-surface/60 px-3 font-mono text-xs text-faint">{row.header}</div>;
    case "gap":
      return (
        <div className="flex h-6 items-center gap-2 px-3 text-xs text-faint">
          <UnfoldVerticalIcon aria-hidden className="size-[13px] stroke-[1.75]" />
          {row.lines === 1 ? t("changes.unchanged.one", { n: row.lines }) : t("changes.unchanged.other", { n: row.lines })}
        </div>
      );
    case "line":
      return <LineRow row={row} focused={focused} canComment={canComment} onOpen={actions.onOpen} />;
    case "comment":
      return (
        <CommentBlock
          comment={row.comment}
          onEdit={() => { actions.onEdit(row.comment); }}
          onDelete={() => { actions.onDelete(row.comment); }}
          onRemember={actions.onRemember === undefined || row.comment.state !== "sent" ? undefined : () => actions.onRemember?.(row.comment) ?? Promise.resolve({ kind: "refused", message: "" })}
        />
      );
    case "field":
      return <CommentField key={row.key} target={row.target} editing={row.editing} onSave={actions.onSave} onCancel={actions.onCancel} />;
    case "outdated-label":
      return <div className="flex h-6 items-center pl-[104px] text-xs text-faint">{t("changes.outdatedComments")}</div>;
    default:
      return row satisfies never;
  }
};

// ---------- the list ----------

/** The index of the file header a row belongs to: the sticky header while that row is on top. */
export const fileHeaderOf = (rows: readonly DiffRow[], index: number): number | null => {
  for (let i = Math.min(index, rows.length - 1); i >= 0; i -= 1) if (rows[i]?.kind === "file") return i;
  return null;
};

/** The next or previous line row from `index`, for the diff's roving focus. */
export const nextLineIndex = (rows: readonly DiffRow[], index: number, step: 1 | -1): number | null => {
  for (let i = index + step; i >= 0 && i < rows.length; i += step) if (rows[i]?.kind === "line") return i;
  return null;
};

export type DiffViewProps = {
  readonly rows: readonly DiffRow[];
  readonly canComment: boolean;
  readonly actions: DiffActions;
  /** The file to scroll to: a new object on each files column press, so a second press scrolls again. */
  readonly scrollTo: { readonly key: string } | null;
  /** The file at the top of the diff changed: the files column moves its selection. */
  readonly onTopFile: (key: string) => void;
  /** The list's size before it's measured (the server render and the tests). */
  readonly initialHeight?: number;
};

export const DiffView = ({ rows, canComment, actions, scrollTo, onTopFile, initialHeight = 720 }: DiffViewProps) => {
  const parent = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const active = useRef<number | null>(null);
  const headerIndexes = useMemo(() => rows.flatMap((row, index) => (row.kind === "file" ? [index] : [])), [rows]);

  const rangeExtractor = useCallback(
    (range: Range) => {
      active.current = fileHeaderOf(rows, range.startIndex);
      const next = new Set([...(active.current === null ? [] : [active.current]), ...defaultRangeExtractor(range)]);
      return [...next].sort((a, b) => a - b);
    },
    [rows],
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parent.current,
    estimateSize: (index) => {
      const row = rows[index];
      return row === undefined ? 20 : estimateRow(row);
    },
    getItemKey: (index) => rows[index]?.key ?? index,
    rangeExtractor,
    overscan: 12,
    initialRect: { width: 596, height: initialHeight },
  });

  // Scroll only when a press asks (a new `scrollTo` each press), never when the rows change.
  const rowsNow = useRef(rows);
  rowsNow.current = rows;
  useEffect(() => {
    if (scrollTo === null) return;
    const index = rowsNow.current.findIndex((row) => row.kind === "file" && row.key === scrollTo.key);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "start" });
  }, [scrollTo, virtualizer]);

  const items = virtualizer.getVirtualItems();
  const topIndex = items.find((item) => item.index !== active.current)?.index ?? 0;
  const topHeader = fileHeaderOf(rows, topIndex);
  const topRow = topHeader === null ? undefined : rows[topHeader];
  const topKey = topRow?.key;
  useEffect(() => {
    if (topKey !== undefined) onTopFile(topKey);
  }, [topKey, onTopFile]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = focus ?? nextLineIndex(rows, -1, 1);
    if (from === null) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const next = nextLineIndex(rows, from, event.key === "ArrowDown" ? 1 : -1);
      if (next === null) return;
      event.preventDefault();
      setFocus(next);
      virtualizer.scrollToIndex(next, { align: "auto" });
      requestAnimationFrame(() => {
        parent.current?.querySelector<HTMLElement>(`[data-index="${String(next)}"] [role="row"]`)?.focus();
      });
    } else if (event.key === "c" && canComment && event.target instanceof HTMLElement && event.target.getAttribute("role") === "row") {
      const row = rows[from];
      if (row?.kind !== "line") return;
      const anchor = anchorOf(row.line);
      if (anchor === null) return;
      event.preventDefault();
      actions.onOpen({ taskRepoId: row.taskRepoId, path: row.path, ...anchor });
    }
  };
  const firstLine = useMemo(() => nextLineIndex(rows, -1, 1), [rows]);
  const focusIndex = focus ?? firstLine;

  return (
    <div
      ref={parent}
      role="grid"
      aria-label={t("changes.diffLabel")}
      aria-rowcount={rows.length}
      data-headers={headerIndexes.length}
      onKeyDown={onKeyDown}
      className="h-full min-h-0 overflow-y-auto overscroll-contain"
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => {
          const row = rows[item.index];
          if (row === undefined) return null;
          const sticky = item.index === active.current;
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className={cn("left-0 w-full", sticky ? "sticky top-0 z-10" : "absolute top-0")}
              style={sticky ? undefined : { transform: `translateY(${String(item.start)}px)` }}
            >
              <DiffRowView row={row} focused={item.index === focusIndex} canComment={canComment} actions={actions} />
            </div>
          );
        })}
      </div>
    </div>
  );
};
