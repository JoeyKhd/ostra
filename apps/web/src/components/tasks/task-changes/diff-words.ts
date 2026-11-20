import { plural, t } from "@/lib/messages";

// The Changes tab's pure parts (task-changes.md, F-027, F-072, F-070, ADR 0051): the diff as the
// API returns it, the flat list of rows the virtualized view draws, the files column's short names,
// the behind sentence and the review bar's words.

/** A file's change, as the code host names it (ADR 0051). */
export type DiffFileStatus = "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";

/** One line of a hunk, with its numbers on both sides. Code: plain text, never interpreted. */
export type DiffLine =
  | { readonly kind: "context"; readonly old: number; readonly new: number; readonly text: string }
  | { readonly kind: "add"; readonly new: number; readonly text: string }
  | { readonly kind: "del"; readonly old: number; readonly text: string }
  | { readonly kind: "no-newline" };

export type DiffHunk = {
  /** `@@ -38,8 +38,14 @@ export const calculatorReducer`, as the host sent it. */
  readonly header: string;
  /** Unchanged lines between the previous hunk (or the file's start) and this one, when known. */
  readonly gapBefore: number | null;
  readonly lines: readonly DiffLine[];
};

/** What the diff shows for a file: its hunks, or why it doesn't draw them. */
export type DiffBody =
  | { readonly kind: "hunks"; readonly hunks: readonly DiffHunk[] }
  | { readonly kind: "too-large"; readonly url: string }
  | { readonly kind: "binary"; readonly url: string }
  | { readonly kind: "renamed-only" };

export type DiffFileView = {
  readonly path: string;
  readonly previousPath: string | null;
  readonly status: DiffFileStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly body: DiffBody;
};

/** One task repo's compare (ticket 38's `diff.get`). */
export type DiffRepoView = {
  readonly taskRepoId: string;
  readonly name: string;
  readonly branch: string;
  readonly base: string;
  readonly ahead: number;
  readonly behind: number;
  readonly headSha: string | null;
  readonly state:
    | { readonly kind: "not-pushed" }
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly files: readonly DiffFileView[]; readonly filesTruncated: { readonly shown: number; readonly url: string } | null };
};

/** A comment on a line: a sent one (any member sees it) or the viewer's own draft (ADR 0051). */
export type DiffCommentView = {
  readonly id: string;
  readonly taskRepoId: string;
  readonly path: string;
  readonly side: "old" | "new";
  readonly line: number;
  readonly headSha: string;
  readonly body: string;
  readonly state: "draft" | "sent";
  readonly author: string;
  readonly at: number;
  /** A later head changed the line: the line as it was, with its sign. */
  readonly outdated: { readonly sign: "+" | "-" | " "; readonly text: string } | null;
};

/**
 * Milestone 6 (F-100, F-102, ticket 35): an AI review's finding, where the review screen draws it:
 * on its line, before the line's comments; at its file's top when the diff doesn't show its line
 * (posted in the review's body); after the file's last hunk once a later push moved past it.
 */
export type DiffFindingView = {
  readonly id: string;
  readonly taskRepoId: string;
  readonly path: string;
  readonly side: "old" | "new";
  readonly line: number;
  readonly state: "open" | "resolved" | "outdated";
  /** The review round that found it: the newest round's findings come first on a line. */
  readonly round: number;
};

/** Where a comment field is open: a line of a file, or an existing draft being edited. */
export type CommentTarget = { readonly taskRepoId: string; readonly path: string; readonly side: "old" | "new"; readonly line: number };

export const sameTarget = (a: CommentTarget, b: CommentTarget): boolean => a.taskRepoId === b.taskRepoId && a.path === b.path && a.side === b.side && a.line === b.line;

/** A line's anchor: its new number, or its old one for a removed line. */
export const anchorOf = (line: DiffLine): { readonly side: "old" | "new"; readonly line: number } | null => {
  switch (line.kind) {
    case "context":
    case "add":
      return { side: "new", line: line.new };
    case "del":
      return { side: "old", line: line.old };
    case "no-newline":
      return null;
    default:
      return line satisfies never;
  }
};

// ---------- the rows ----------

/** A file's key across repos. */
export const fileKey = (taskRepoId: string, path: string): string => `${taskRepoId}:${path}`;

/** One row of the virtualized list (task-changes.md, "The diff view"). */
export type DiffRow =
  | { readonly kind: "file"; readonly key: string; readonly repo: DiffRepoView; readonly file: DiffFileView; readonly folded: boolean }
  | { readonly kind: "note"; readonly key: string; readonly text: "too-large" | "binary" | "renamed-only" | "fetching" | "no-changes"; readonly url: string | null; readonly base: string }
  | { readonly kind: "hunk"; readonly key: string; readonly header: string }
  | { readonly kind: "gap"; readonly key: string; readonly lines: number }
  | { readonly kind: "line"; readonly key: string; readonly taskRepoId: string; readonly path: string; readonly line: DiffLine }
  | { readonly kind: "comment"; readonly key: string; readonly comment: DiffCommentView }
  /** Ticket 35: an AI review's finding, and the label over a file's findings off its changed lines. */
  | { readonly kind: "finding"; readonly key: string; readonly finding: DiffFindingView }
  | { readonly kind: "findings-label"; readonly key: string }
  | { readonly kind: "field"; readonly key: string; readonly target: CommentTarget; readonly editing: DiffCommentView | null }
  | { readonly kind: "outdated-label"; readonly key: string };

/** The open field: a new comment on a line, or a draft being edited. */
export type OpenField = { readonly kind: "new"; readonly target: CommentTarget } | { readonly kind: "edit"; readonly comment: DiffCommentView } | null;

const targetOf = (comment: DiffCommentView): CommentTarget => ({ taskRepoId: comment.taskRepoId, path: comment.path, side: comment.side, line: comment.line });

/**
 * The flat rows: per repo, per file, its header, then (unless folded) its hunks with their lines,
 * each line followed by its sent comments, the viewer's drafts and the open field; then the file's
 * outdated comments under their label. A file the diff doesn't draw gets one note row.
 */
export const rowsOf = (
  repos: readonly DiffRepoView[],
  comments: readonly DiffCommentView[],
  folded: ReadonlySet<string>,
  open: OpenField,
  findings: readonly DiffFindingView[] = [],
): readonly DiffRow[] => {
  const rows: DiffRow[] = [];
  const byRound = (a: DiffFindingView, b: DiffFindingView) => b.round - a.round;
  const fieldFor = (target: CommentTarget, key: string) => {
    if (open === null) return;
    if (open.kind === "new" && sameTarget(open.target, target)) rows.push({ kind: "field", key: `${key}:field`, target, editing: null });
  };
  for (const repo of repos) {
    if (repo.state.kind !== "ready") {
      if (repo.state.kind === "loading") rows.push({ kind: "note", key: `${repo.taskRepoId}:fetching`, text: "fetching", url: null, base: repo.base });
      continue;
    }
    if (repo.state.files.length === 0) {
      rows.push({ kind: "note", key: `${repo.taskRepoId}:none`, text: "no-changes", url: null, base: repo.base });
      continue;
    }
    for (const file of repo.state.files) {
      const key = fileKey(repo.taskRepoId, file.path);
      const isFolded = folded.has(key);
      rows.push({ kind: "file", key, repo, file, folded: isFolded });
      if (isFolded) continue;
      const own = comments.filter((comment) => comment.taskRepoId === repo.taskRepoId && comment.path === file.path);
      const current = own.filter((comment) => comment.outdated === null);
      const outdated = own.filter((comment) => comment.outdated !== null);
      const fileFindings = findings.filter((finding) => finding.taskRepoId === repo.taskRepoId && finding.path === file.path).sort(byRound);
      const shownLines = new Set(file.body.kind === "hunks" ? file.body.hunks.flatMap((hunk) => hunk.lines.flatMap((line) => { const anchor = anchorOf(line); return anchor === null ? [] : [`${anchor.side}:${String(anchor.line)}`]; })) : []);
      const offDiff = fileFindings.filter((finding) => finding.state !== "outdated" && !shownLines.has(`${finding.side}:${String(finding.line)}`));
      if (offDiff.length > 0) {
        rows.push({ kind: "findings-label", key: `${key}:findings-off` });
        for (const finding of offDiff) rows.push({ kind: "finding", key: `${key}:f:${finding.id}`, finding });
      }
      const body = file.body;
      switch (body.kind) {
        case "too-large":
        case "binary":
          rows.push({ kind: "note", key: `${key}:note`, text: body.kind, url: body.url, base: repo.base });
          break;
        case "renamed-only":
          rows.push({ kind: "note", key: `${key}:note`, text: "renamed-only", url: null, base: repo.base });
          break;
        case "hunks":
          body.hunks.forEach((hunk, h) => {
            const hunkKey = `${key}:h${String(h)}`;
            if (hunk.gapBefore !== null && hunk.gapBefore > 0 && h > 0) rows.push({ kind: "gap", key: `${hunkKey}:gap`, lines: hunk.gapBefore });
            rows.push({ kind: "hunk", key: hunkKey, header: hunk.header });
            hunk.lines.forEach((line, l) => {
              const lineKey = `${hunkKey}:l${String(l)}`;
              rows.push({ kind: "line", key: lineKey, taskRepoId: repo.taskRepoId, path: file.path, line });
              const anchor = anchorOf(line);
              if (anchor === null) return;
              const target: CommentTarget = { taskRepoId: repo.taskRepoId, path: file.path, ...anchor };
              for (const finding of fileFindings) {
                if (finding.state !== "outdated" && finding.side === anchor.side && finding.line === anchor.line) rows.push({ kind: "finding", key: `${lineKey}:f:${finding.id}`, finding });
              }
              const here = current.filter((comment) => sameTarget(targetOf(comment), target));
              for (const comment of [...here.filter((c) => c.state === "sent"), ...here.filter((c) => c.state === "draft")]) {
                if (open?.kind === "edit" && open.comment.id === comment.id) rows.push({ kind: "field", key: `${lineKey}:edit:${comment.id}`, target, editing: comment });
                else rows.push({ kind: "comment", key: `${lineKey}:c:${comment.id}`, comment });
              }
              fieldFor(target, lineKey);
            });
          });
          break;
        default:
          return body satisfies never;
      }
      const outdatedFindings = fileFindings.filter((finding) => finding.state === "outdated");
      if (outdated.length > 0 || outdatedFindings.length > 0) {
        rows.push({ kind: "outdated-label", key: `${key}:outdated` });
        for (const finding of outdatedFindings) rows.push({ kind: "finding", key: `${key}:of:${finding.id}`, finding });
        for (const comment of outdated) {
          if (open?.kind === "edit" && open.comment.id === comment.id) rows.push({ kind: "field", key: `${key}:edit:${comment.id}`, target: targetOf(comment), editing: comment });
          else rows.push({ kind: "comment", key: `${key}:o:${comment.id}`, comment });
        }
      }
    }
  }
  return rows;
};

/** The row heights the virtualizer starts from (task-changes.md); comments and wrapped lines are measured. */
export const estimateRow = (row: DiffRow): number => {
  switch (row.kind) {
    case "file":
      return 34;
    case "note":
      return 32;
    case "hunk":
    case "gap":
    case "outdated-label":
      return 24;
    case "line":
      return 21;
    case "comment":
      return 64;
    case "finding":
      return 130;
    case "findings-label":
      return 24;
    case "field":
      return 120;
    default:
      return row satisfies never;
  }
};

// ---------- the files column ----------

/** A status glyph: `M`, `A`, `D`, `R`, `C`. */
export const glyphOf = (status: DiffFileStatus): string => {
  switch (status) {
    case "added":
      return "A";
    case "removed":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "modified":
    case "changed":
    case "unchanged":
      return "M";
    default:
      return status satisfies never;
  }
};

/**
 * The files column's names: the basename, or, when two changed files share one, the shortest
 * parent path that tells them apart (`history/store.ts`).
 */
export const shortNames = (paths: readonly string[]): ReadonlyMap<string, string> => {
  const parts = new Map(paths.map((path) => [path, path.split("/")]));
  const names = new Map<string, string>();
  for (const path of paths) {
    const segments = parts.get(path) ?? [path];
    let depth = 1;
    for (;;) {
      const name = segments.slice(-depth).join("/");
      const clash = paths.some((other) => other !== path && (parts.get(other) ?? []).slice(-depth).join("/") === name);
      if (!clash || depth >= segments.length) {
        names.set(path, name);
        break;
      }
      depth += 1;
    }
  }
  return names;
};

/** `3 ahead · 2 behind` or `1 ahead · up to date with main`. */
export const aheadText = (repo: DiffRepoView): string =>
  repo.behind > 0 ? t("changes.aheadBehind", { ahead: repo.ahead, behind: repo.behind }) : t("changes.aheadUpToDate", { ahead: repo.ahead, base: repo.base });

/** The changed files across the task's repos, for the tab's count; `null` while any loads. */
export const changedFiles = (repos: readonly DiffRepoView[]): number | null => {
  let total = 0;
  for (const repo of repos) {
    if (repo.state.kind === "loading") return null;
    if (repo.state.kind === "ready") total += repo.state.files.length;
  }
  return total;
};

/** Comments the viewer sees on a file: their drafts and every sent one. */
export const commentCount = (comments: readonly DiffCommentView[], taskRepoId: string, path: string): number =>
  comments.filter((comment) => comment.taskRepoId === taskRepoId && comment.path === path).length;

// ---------- behind, and the review bar ----------

export type BehindPart = { readonly repo: string; readonly behind: number; readonly base: string };

export const behindOf = (repos: readonly DiffRepoView[]): readonly BehindPart[] => repos.filter((repo) => repo.behind > 0).map((repo) => ({ repo: repo.name, behind: repo.behind, base: repo.base }));

/** Who may send, and how a send goes (the composer's rule, ticket 22). */
export type SendDelivery = { readonly kind: "idle" } | { readonly kind: "steer" } | { readonly kind: "after-turn" } | { readonly kind: "reopen" } | { readonly kind: "not-driver"; readonly driver: string };

export const reviewHint = (delivery: SendDelivery, agent: string): string => {
  switch (delivery.kind) {
    case "idle":
      return t("changes.review.idle");
    case "steer":
      return t("changes.review.steer", { agent });
    case "after-turn":
      return t("changes.review.afterTurn");
    case "reopen":
      return t("changes.review.reopen");
    case "not-driver":
      return t("changes.review.notDriver", { name: delivery.driver });
    default:
      return delivery satisfies never;
  }
};

/** The most comments one message carries (ticket 22). */
export const MAX_SEND = 50;
/** The longest a comment may be, and where its counter shows. */
export const MAX_COMMENT = 4000;
export const COUNTER_FROM = 3600;

export const draftsOf = (comments: readonly DiffCommentView[]): readonly DiffCommentView[] => comments.filter((comment) => comment.state === "draft");

export const draftsTitle = (drafts: readonly DiffCommentView[]): { readonly count: string; readonly files: string } => {
  const files = new Set(drafts.map((draft) => fileKey(draft.taskRepoId, draft.path))).size;
  return {
    count: plural(drafts.length, "changes.review.drafts.one", "changes.review.drafts.other"),
    files: plural(files, "changes.review.files.one", "changes.review.files.other"),
  };
};

export const sendLabel = (n: number): string => plural(n, "changes.review.send.one", "changes.review.send.other");
