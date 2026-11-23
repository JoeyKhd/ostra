import { CheckIcon, CircleXIcon, TriangleAlertIcon } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { piecesOf, readbackFailure, readbackLines } from "./jira-words";
import type { JiraReadBack, ReadbackLine, Words } from "./jira-words";

// Step 2's "What ostra read back" (jira-connect.md, `jira-connect`, `jira-connect-states`): a
// 1px `--line-2` box, 8px radius, its head in 12px `--faint` with `just now`, then one line per
// check with a 14px icon: green `check`, or red `triangle-alert` (a warning: it still saves) or
// `circle-x` (refused). A list, announced when it arrives; a failed line is an alert.

/** A sentence with its values set: mono for Jira's own words (keys, names, codes), bold for a permission. */
export const Sentence = ({ words, monoClassName }: { readonly words: Words; readonly monoClassName?: string }) => (
  <>
    {piecesOf(words).map((piece, i) =>
      piece.look === "mono" ? (
        <code key={i} className={cn("font-mono text-[12.5px] text-text", monoClassName)}>
          {piece.text}
        </code>
      ) : piece.look === "strong" ? (
        <b key={i} className="font-medium text-text">
          {piece.text}
        </b>
      ) : (
        <span key={i}>{piece.text}</span>
      ),
    )}
  </>
);

const LineIcon = ({ outcome }: { readonly outcome: ReadbackLine["outcome"] }) => {
  switch (outcome) {
    case "ok":
      return <CheckIcon aria-hidden className="mt-[3px] size-[14px] stroke-2 text-green" />;
    case "warn":
      return <TriangleAlertIcon aria-hidden className="mt-[3px] size-[14px] stroke-[1.75] text-red" />;
    case "fail":
      return <CircleXIcon aria-hidden className="mt-[3px] size-[14px] stroke-[1.75] text-red" />;
    default:
      return outcome satisfies never;
  }
};

const Line = ({ line }: { readonly line: ReadbackLine }) => (
  <li
    data-outcome={line.outcome}
    data-check={line.id}
    className="grid grid-cols-[18px_minmax(0,1fr)] items-start gap-x-2 py-[5px] text-[13.5px] leading-normal text-text-2 [&+li]:border-t [&+li]:border-line"
  >
    <LineIcon outcome={line.outcome} />
    {/* A line that isn't green is an alert, inside its list item, so the list stays a list. */}
    <span role={line.outcome === "ok" ? undefined : "alert"} className="min-w-0 break-words">
      <Sentence words={line.words} />
      {line.note === null ? null : <span className="text-faint"> {line.note}</span>}
    </span>
  </li>
);

/** The read-back box: the four checks, or the one line of a refusal. */
export const Readback = ({ readBack }: { readonly readBack: JiraReadBack }) => {
  const lines = readBack.kind === "checked" ? readbackLines(readBack) : [readbackFailure(readBack)];
  return (
    <div data-testid="jira-readback" aria-live="polite" className="mt-3 max-w-[600px] rounded-lg border border-line-2 px-3 py-1.5">
      <div className="flex items-center gap-2 border-b border-line pb-1.5 pt-1 text-xs font-medium text-faint">
        <span>{t("trackers.jira.connect.readback.title")}</span>
        <span className="ml-auto font-normal">{t("trackers.jira.connect.readback.justNow")}</span>
      </div>
      <ul role="list" aria-label={t("trackers.jira.connect.readback.title")}>
        {lines.map((line) => (
          <Line key={line.id} line={line} />
        ))}
      </ul>
    </div>
  );
};
