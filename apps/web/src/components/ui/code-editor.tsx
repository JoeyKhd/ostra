"use client";

import type { Ref } from "react";

import { cn } from "@/lib/cn";

// One code editor for the panel (ticket 37, "Decided 2026-11-19"): a `textarea` laid over a mirror
// that draws the gutter of line numbers and, as an option, the ticket template's two-tone `{{…}}`
// highlight. Each logical line is one row of the mirror, so a long line wraps under itself and its
// number stays beside its first row. The textarea's own text is transparent; the caret shows.

const TAG = /(\{\{[^}]*\}\})/;

/** The template's highlight: every `{{…}}` tag in `--text`, the literal text in `--muted`. */
const highlightLine = (line: string) =>
  line.split(TAG).map((part, i) =>
    part === "" ? null : (
      <span key={`${String(i)}-${part}`} className={i % 2 === 1 ? "text-text" : "text-muted"}>
        {part}
      </span>
    ),
  );

export type CodeEditorProps = {
  readonly id?: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly readOnly?: boolean;
  /** Colour `{{…}}` tags (the ticket template). Without it the text is plain `--text`. */
  readonly highlightTags?: boolean;
  /** Line numbers (1-based) changed since the last save: a 2px `--line-2` bar at the gutter's left edge. */
  readonly changedLines?: ReadonlySet<number>;
  /** A line the validator refused: its number turns `--red`. */
  readonly errorLine?: number | null;
  readonly minLines?: number;
  readonly placeholder?: string;
  readonly describedBy?: string;
  readonly textareaRef?: Ref<HTMLTextAreaElement>;
  readonly className?: string;
};

export const CodeEditor = ({
  id,
  label,
  value,
  onChange,
  readOnly = false,
  highlightTags = false,
  changedLines,
  errorLine = null,
  minLines = 3,
  placeholder,
  describedBy,
  textareaRef,
  className,
}: CodeEditorProps) => {
  const lines = value.split("\n");
  const rows = lines.length < minLines ? [...lines, ...Array.from({ length: minLines - lines.length }, () => null)] : lines;
  return (
    <div className={cn("focus-box relative rounded-lg border border-control-line bg-surface py-2.5 font-mono text-ui leading-5 focus-within:border-faint", className)} data-testid="code-editor">
      <div aria-hidden className="select-none">
        {rows.map((line, i) => {
          const n = i + 1;
          return (
            <div key={n} className="relative grid grid-cols-[48px_minmax(0,1fr)]">
              {line !== null && changedLines?.has(n) === true ? <span data-changed className="absolute inset-y-0 left-0 w-0.5 bg-line-2" /> : null}
              <span className={cn("pr-3.5 text-right", n === errorLine ? "text-red" : "text-faint")}>{line === null ? "" : n}</span>
              <span className={cn("whitespace-pre-wrap break-words pr-3.5", !highlightTags && "text-text")}>
                {line === null || line === "" ? "​" : highlightTags ? highlightLine(line) : line}
              </span>
            </div>
          );
        })}
      </div>
      <textarea
        ref={textareaRef}
        id={id}
        aria-label={label}
        aria-describedby={describedBy}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        readOnly={readOnly}
        placeholder={placeholder}
        value={value}
        onChange={(e) => { onChange(e.target.value); }}
        className="absolute inset-y-2.5 left-12 right-0 resize-none overflow-hidden whitespace-pre-wrap break-words bg-transparent pr-3.5 text-transparent caret-text outline-none placeholder:text-faint selection:bg-line-2 selection:text-transparent"
      />
    </div>
  );
};
