"use client";

import { useId, useState } from "react";
import type { KeyboardEvent } from "react";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import type { LibraryItemDetail } from "./library-model";

// An update's diff (F-145; app-targets/m8/library-update.md, item 8): the changed files on the
// left, each with its added and removed lines, and the open file's hunks on a 20px grid, the old
// and new line numbers, the sign and the text, long lines wrapping with a hanging indent. The text
// is the source's, shown as data. A server's update is its changed fields and tools instead.

type Update = NonNullable<LibraryItemDetail["update"]>;
type SkillDiff = Extract<NonNullable<Update["diff"]>, { readonly kind: "skill" }>["diff"];
type ServerDiff = Extract<NonNullable<Update["diff"]>, { readonly kind: "server" }>;
type FileDiff = SkillDiff["files"][number];
type Line = FileDiff["lines"][number];

/** A file's added and removed lines. */
export const lineCounts = (file: Pick<FileDiff, "lines">): { readonly added: number; readonly removed: number } => ({
  added: file.lines.filter((line) => line.kind === "add").length,
  removed: file.lines.filter((line) => line.kind === "del").length,
});

/** The diff's whole counts, for the update's head. */
export const diffCounts = (diff: SkillDiff): { readonly added: number; readonly removed: number } =>
  diff.files.reduce((total, file) => {
    const counts = lineCounts(file);
    return { added: total.added + counts.added, removed: total.removed + counts.removed };
  }, { added: 0, removed: 0 });

/** The lines in hunks: a new hunk where the line numbers jump. */
export const hunksOf = (lines: readonly Line[]): readonly (readonly Line[])[] => {
  const hunks: Line[][] = [];
  let previous: Line | null = null;
  for (const line of lines) {
    const jumped =
      previous === null ||
      (line.oldLine !== null && previous.oldLine !== null && line.oldLine > previous.oldLine + 1) ||
      (line.newLine !== null && previous.newLine !== null && line.newLine > previous.newLine + 1);
    if (jumped) hunks.push([]);
    hunks.at(-1)?.push(line);
    previous = line;
  }
  return hunks;
};

const hunkHead = (hunk: readonly Line[]): string => {
  const oldLines = hunk.filter((line) => line.oldLine !== null);
  const newLines = hunk.filter((line) => line.newLine !== null);
  return `@@ -${String(oldLines[0]?.oldLine ?? 0)},${String(oldLines.length)} +${String(newLines[0]?.newLine ?? 0)},${String(newLines.length)} @@`;
};

const DiffLine = ({ line, split }: { readonly line: Line; readonly split: boolean }) => (
  <div
    className={cn(
      "grid min-h-5 font-mono text-[12.5px] leading-5",
      split ? "grid-cols-[34px_34px_16px_minmax(0,1fr)]" : "grid-cols-[34px_16px_minmax(0,1fr)]",
      line.kind === "add" && "bg-diff-add",
      line.kind === "del" && "bg-diff-del",
    )}
    data-line={line.kind}
  >
    {split ? <span className="pr-1.5 text-right text-[11.5px] text-faint">{line.oldLine ?? ""}</span> : null}
    <span className="pr-1.5 text-right text-[11.5px] text-faint">{split ? (line.newLine ?? "") : (line.newLine ?? line.oldLine)}</span>
    <span className={cn("text-center", line.kind === "add" ? "text-green" : line.kind === "del" ? "text-red" : "text-faint")} aria-hidden>{line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}</span>
    <span className="whitespace-pre-wrap break-words pl-[calc(0.25rem+2ch)] -indent-[2ch] text-text-2">
      <span className="sr-only">{line.kind === "add" ? t("library.diff.added") : line.kind === "del" ? t("library.diff.removed") : ""}</span>
      {line.text}
    </span>
  </div>
);

export const SkillDiffView = ({ diff, from, to }: { readonly diff: SkillDiff; readonly from: string; readonly to: string }) => {
  const id = useId();
  const [open, setOpen] = useState(diff.files[0]?.path ?? "");
  const [mode, setMode] = useState<"unified" | "split">("split");
  const file = diff.files.find((entry) => entry.path === open) ?? diff.files[0];
  const onListKey = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const at = diff.files.findIndex((entry) => entry.path === file?.path);
    const next = diff.files[event.key === "ArrowDown" ? at + 1 : at - 1];
    if (next === undefined) return;
    event.preventDefault();
    setOpen(next.path);
    document.getElementById(`${id}-file-${String(diff.files.indexOf(next))}`)?.focus();
  };
  const onDiffKey = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "n" && event.key !== "p") return;
    const heads = [...(event.currentTarget.querySelectorAll<HTMLElement>("[data-hunk]"))];
    const scroller = event.currentTarget;
    const top = scroller.scrollTop;
    const target = event.key === "n" ? heads.find((head) => head.offsetTop > top + 1) : [...heads].reverse().find((head) => head.offsetTop < top - 1);
    if (target === undefined) return;
    event.preventDefault();
    scroller.scrollTo({ top: target.offsetTop });
  };
  return (
    <div className="mt-3.5 overflow-hidden rounded-lg border border-line lg:grid lg:grid-cols-[226px_minmax(0,1fr)]" data-testid="update-diff">
      <div className="border-b border-line p-1.5 lg:border-b-0 lg:border-r">
        <p className="px-2 pb-1 pt-1.5 text-xs font-medium text-faint">{t("library.diff.filesChanged", { n: diff.files.length })}</p>
        <ul role="listbox" aria-label={t("library.diff.filesChanged", { n: diff.files.length })} onKeyDown={onListKey}>
          {diff.files.map((entry, index) => {
            const counts = lineCounts(entry);
            const selected = entry.path === file?.path;
            return (
              <li
                key={entry.path}
                id={`${id}-file-${String(index)}`}
                role="option"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => { setOpen(entry.path); }}
                onKeyDown={(event) => { if (event.key === "Enter") setOpen(entry.path); }}
                className={cn("flex h-[30px] cursor-pointer items-center gap-2 rounded-[6px] px-2 font-mono text-[12.5px] text-text-2", selected ? "bg-sel" : "hover:bg-hover")}
                data-diff-file={entry.path}
              >
                <span className="min-w-0 flex-1 truncate [direction:rtl] text-left" title={entry.path}><bdi>{entry.path}</bdi></span>
                {entry.change === "added" ? <span className="text-[12px] text-faint">{t("library.diff.addedFile")}</span> : entry.change === "removed" ? <span className="text-[12px] text-red">{t("library.diff.removedFile")}</span> : null}
                {counts.added > 0 ? <span className="text-[12px] text-green">{`+${String(counts.added)}`}</span> : null}
                {counts.removed > 0 ? <span className="text-[12px] text-red">{`−${String(counts.removed)}`}</span> : null}
              </li>
            );
          })}
        </ul>
      </div>
      <div className="min-w-0">
        <div className="flex h-[34px] items-center gap-2 border-b border-line bg-surface px-3">
          <span className="truncate font-mono text-sm text-text">{file?.path ?? ""}</span>
          <span className="shrink-0 font-mono text-[12px] text-faint">{`${from} → ${to}`}</span>
          <ToggleGroup type="single" value={mode} onValueChange={(value) => { if (value === "unified" || value === "split") setMode(value); }} aria-label={t("library.diff.layout")} className="ml-auto h-6 p-px">
            <ToggleGroupItem value="unified" className="px-2 text-[12px]">{t("library.diff.unified")}</ToggleGroupItem>
            <ToggleGroupItem value="split" className="px-2 text-[12px]">{t("library.diff.split")}</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div tabIndex={0} onKeyDown={onDiffKey} className="max-h-[520px] overflow-y-auto focus-visible:-outline-offset-2" aria-label={t("library.diff.label", { path: file?.path ?? "" })} data-testid="diff-lines">
          {file === undefined ? null : file.binary ? (
            <p className="px-3 py-2.5 font-mono text-[12.5px] text-faint">{t("library.diff.binary", { path: file.path })}</p>
          ) : (
            hunksOf(file.lines).map((hunk, index) => (
              <div key={index}>
                <div className="flex h-6 items-center bg-surface px-3 font-mono text-[12px] text-faint" data-hunk>{hunkHead(hunk)}</div>
                {hunk.map((line, at) => <DiffLine key={at} line={line} split={mode === "split"} />)}
              </div>
            ))
          )}
          {file?.truncated === true ? <p className="px-3 py-2 text-[12.5px] text-faint">{t("library.diff.truncated")}</p> : null}
        </div>
      </div>
    </div>
  );
};

/** A server's update: the fields that changed, and the tools added and removed. */
export const ServerDiffView = ({ diff }: { readonly diff: ServerDiff }) => {
  const rows: { readonly label: string; readonly from: string; readonly to: string }[] = [];
  if (diff.diff.version !== null) rows.push({ label: t("library.diff.version"), from: diff.diff.version.from, to: diff.diff.version.to });
  if (diff.diff.remoteUrl !== null) rows.push({ label: t("library.diff.remote"), from: diff.diff.remoteUrl.from, to: diff.diff.remoteUrl.to });
  if (diff.diff.description !== null) rows.push({ label: t("library.diff.description"), from: diff.diff.description.from ?? "—", to: diff.diff.description.to ?? "—" });
  const list = (label: string, names: readonly string[], tone: "add" | "del") =>
    names.length === 0 ? null : (
      <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-2 border-b border-line py-2 text-sm">
        <span className="text-muted">{label}</span>
        <span className="flex flex-wrap gap-1.5">{names.map((name) => <span key={name} className={cn("rounded-sm px-1.5 font-mono text-[12px] text-text-2", tone === "add" ? "bg-diff-add" : "bg-diff-del")}>{name}</span>)}</span>
      </div>
    );
  return (
    <div className="mt-3.5 rounded-lg border border-line px-3" data-testid="update-diff">
      {rows.map((row) => (
        <div key={row.label} className="grid grid-cols-[120px_minmax(0,1fr)] gap-2 border-b border-line py-2 text-sm">
          <span className="text-muted">{row.label}</span>
          <span className="min-w-0 font-mono text-[12.5px]">
            <span className="block break-all bg-diff-del px-1 text-text-2">{row.from}</span>
            <span className="block break-all bg-diff-add px-1 text-text-2">{row.to}</span>
          </span>
        </div>
      ))}
      {list(t("library.diff.headersAdded"), diff.diff.headers.added, "add")}
      {list(t("library.diff.headersRemoved"), diff.diff.headers.removed, "del")}
      {list(t("library.diff.toolsAdded"), diff.diff.tools.added, "add")}
      {list(t("library.diff.toolsRemoved"), diff.diff.tools.removed, "del")}
      {diff.missingInputs.length === 0 ? null : <p className="py-2 text-sm text-red">{t("library.diff.missingInputs", { names: diff.missingInputs.join(", ") })}</p>}
    </div>
  );
};
