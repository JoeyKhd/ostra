"use client";

import type { RunStep } from "@ostra/task-view";

import { t } from "@/lib/messages";

import type { StepLinkKind } from "./words";

// Owner: ticket 10 (milestone 10, F-151: one more level, parts.md part 6's `.out`). Ticket 09's
// stub, with its final props: what a step's link opens, as plain text (never markup) at the
// subject's x, 320px at most then it scrolls. Ticket 10 moves milestone 1's diff block here.

/** The text a step's link opens: a command's output, an edit's patch, a thought's words, a setup's log. */
const textOf = (step: RunStep, opens: StepLinkKind): string | null => {
  switch (step.kind) {
    case "command":
      return opens === "output" || opens === "details" ? (step.output ?? step.error ?? "") : null;
    case "edit":
      return opens === "diff" ? step.files.map((file) => file.patch ?? "").join("\n").trim() : (step.error ?? null);
    case "thought":
      return step.text;
    case "setup":
      return step.output.map((line) => line.text).join("");
    case "pr-text":
      return step.body;
    case "read":
    case "search":
    case "web-search":
    case "fetch":
    case "capture":
    case "subagent":
    case "ostra":
    case "tool":
    case "compaction":
    case "info":
      return step.error;
    default:
      return step satisfies never;
  }
};

/** What a step's link opened, under its row. */
export const StepOutput = ({ step, opens }: { readonly step: RunStep; readonly opens: StepLinkKind }) => {
  const text = textOf(step, opens);
  if (text === null) return null;
  return (
    <pre data-part="step-output" className="mb-1.5 ml-[94px] mt-0.5 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-surface px-3 py-2 font-mono text-[12.5px] leading-[1.6] text-muted">
      {text === "" ? t("task.tool.noOutput") : text}
    </pre>
  );
};
