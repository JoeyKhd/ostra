"use client";

import { useEffect, useRef } from "react";

import type { RunStep } from "@ostra/task-view";

import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { useToolPart } from "../task-context";
import type { StepLinkKind } from "./words";

// Owner: ticket 10 (milestone 10, F-151: one more level, parts.md part 6's `.out`). What a step's
// link opens, under its row at the subject's x: a command's output (plain text, 320px at most, then
// it scrolls; a running command's streams in and stays in view unless the member scrolled up), an
// edit's diff (milestone 1's block, moved here from `renderers.tsx`), a thought's whole text, a
// search's matches, a tool's input, the setup script's log, the PR's text, a failure's details.
// Agent output is untrusted: it's text, never markup, and nothing here loads anything.

/** The `.out` box: at the subject's x (94px in from the opened run's frame), `--surface`, mono 12.5px. */
const OUT = "mb-1.5 ml-[94px] mt-0.5 max-h-80 overflow-auto rounded-lg border border-line bg-surface font-mono text-[12.5px] leading-[1.6]";

// Terminal colours and cursor moves (CSI and OSC sequences), and every other control character but
// the newline and the tab, as milestone 3's checks strip them (`@ostra/domain`'s `outputLines`).
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** An output as plain text: no terminal colours, no control characters, `\n` line ends. */
export const plainOutput = (text: string): string => text.replace(/\r\n?/g, "\n").replace(ANSI, "").replace(CONTROL, "");

/** A line the output itself marks as failed (`✗ panel renders an empty history`): ostra colours nothing else. */
export const marksFailure = (line: string): boolean => /^\s*[✗✘×✕]/.test(line);

/**
 * A command's output, or any text a step opens, as plain text. `follow`: it's still coming (a
 * running command), so the box keeps its end in view, unless the member scrolled up in it.
 */
export const OutputBlock = ({ text, truncated = false, follow = false, className }: {
  readonly text: string;
  readonly truncated?: boolean;
  readonly follow?: boolean;
  readonly className?: string;
}) => {
  const box = useRef<HTMLPreElement>(null);
  const atEnd = useRef(true);
  const plain = plainOutput(text).replace(/\n+$/, "");
  useEffect(() => {
    const element = box.current;
    if (follow && atEnd.current && element !== null) element.scrollTop = element.scrollHeight;
  }, [follow, plain]);
  return (
    <pre
      ref={box}
      data-part="step-output"
      onScroll={(event) => {
        const element = event.currentTarget;
        atEnd.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 4;
      }}
      className={cn(OUT, "whitespace-pre-wrap break-words px-3 py-2 text-muted", className)}
    >
      {plain === "" ? t("task.tool.noOutput") : plain.split("\n").map((line, index) => (
        <span key={index} className={cn("block min-h-[1.6em]", marksFailure(line) && "text-red")}>{line}</span>
      ))}
      {truncated ? <span className="block text-faint">{t("task.tool.truncated")}</span> : null}
    </pre>
  );
};

type PatchLine = "add" | "del" | "hunk" | "header" | "context";

const patchLineOf = (line: string): PatchLine =>
  line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")
    ? "header"
    : line.startsWith("@@")
      ? "hunk"
      : line.startsWith("+")
        ? "add"
        : line.startsWith("-")
          ? "del"
          : "context";

/**
 * A unified diff, as text, never HTML (light-task.md, "Code and diffs"): added and removed lines on
 * their fills with a green `+` or a red `-` and the code in `--text`; headers `--muted`, hunks `--faint`.
 */
export const DiffBlock = ({ patch, className }: { readonly patch: string; readonly className?: string }) => (
  <pre data-part="step-diff" className={cn(OUT, "py-2 text-text", className)}>
    {patch.split("\n").map((line, i) => {
      const kind = patchLineOf(line);
      switch (kind) {
        case "add":
        case "del":
          return (
            <div key={i} data-line={kind} className={kind === "add" ? "bg-diff-add px-3" : "bg-diff-del px-3"}>
              <span className={kind === "add" ? "text-green" : "text-red"}>{line.charAt(0)}</span>
              {line.slice(1)}
            </div>
          );
        case "hunk":
        case "header":
          return (
            <div key={i} data-line={kind} className={kind === "hunk" ? "px-3 text-faint" : "px-3 text-muted"}>
              {line}
            </div>
          );
        case "context":
          return (
            <div key={i} data-line={kind} className="px-3">
              {line === "" ? " " : line}
            </div>
          );
        default:
          return kind satisfies never;
      }
    })}
  </pre>
);

/** A tool's input or output, which the agent shaped: a string as it is, anything else as indented JSON. */
const asText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    // A value JSON can't write (a cycle, a bigint): nothing readable to show.
    return "";
  }
};

/** A search's matches: its call's output, as the agent's tool gave it. */
const SearchResults = ({ toolCallId }: { readonly toolCallId: string }) => {
  const part = useToolPart(toolCallId);
  const output = part?.state === "output-available" ? part.output : null;
  return <OutputBlock text={asText(output)} />;
};

/** What a step's link opened, under its row. */
export const StepOutput = ({ step, opens }: { readonly step: RunStep; readonly opens: StepLinkKind }) => {
  switch (step.kind) {
    case "command":
      return <OutputBlock text={step.output ?? step.error ?? ""} truncated={step.truncated} follow={step.state === "running"} />;
    case "edit": {
      if (opens !== "diff") return <OutputBlock text={step.error ?? ""} />;
      return <DiffBlock patch={step.files.map((file) => file.patch ?? "").join("\n").trim()} />;
    }
    case "thought":
      // The whole thought, as the agent wrote it: 14px `--muted`, with the opened run's left line.
      return <p data-part="step-thought" className="mb-1.5 ml-[94px] mt-0.5 whitespace-pre-wrap break-words border-l border-line-2 pl-3.5 text-ui text-muted">{step.text}</p>;
    case "setup":
      return <OutputBlock text={step.output.map((line) => line.text).join("")} follow={step.state === "running"} />;
    case "pr-text":
      return <OutputBlock text={step.body ?? ""} />;
    case "search":
      return opens === "results" && step.toolCallId !== null ? <SearchResults toolCallId={step.toolCallId} /> : <OutputBlock text={step.error ?? ""} />;
    case "tool":
      return <OutputBlock text={opens === "input" ? asText(step.input) : (step.error ?? asText(step.output))} />;
    case "ostra":
      return <OutputBlock text={opens === "input" ? asText(step.input) : (step.error ?? "")} />;
    case "read":
    case "web-search":
    case "fetch":
    case "capture":
    case "subagent":
    case "compaction":
    case "info":
      return <OutputBlock text={step.error ?? ""} />;
    default:
      return step satisfies never;
  }
};
