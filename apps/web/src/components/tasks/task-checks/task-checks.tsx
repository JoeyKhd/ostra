"use client";

import {
  ArrowUpRightIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  DownloadIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  LoaderCircleIcon,
  TimerOffIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react";
import Link from "next/link";
import { Collapsible } from "radix-ui";
import { Fragment, useState } from "react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { formatClock } from "@/lib/format";
import { t } from "@/lib/messages";

import { durationOf, fixHint, formatCheckDuration, isFailing, outputLabel, plainOutput, prLineWords, repoSectionsOf, shownLines, statusWord, summaryOf, turnRunning, turnTotalMs } from "./check-words";
import type { CheckRunView, CheckState, ChecksMarker, FixDelivery, PrDraftLine, RepoChecksSection, TurnChecksView } from "./check-words";

// The Checks tab (task-checks.md, F-054, ADR 0052): each turn's checks, newest first, with their
// output as plain text, "Ask the agent to fix" on the newest turn's failures, and the PR's draft
// line. `TaskChecksView` wires it to ticket 39's `tasks.checks` and `tasks.fixChecks`.

const iconClass = "size-4 shrink-0 stroke-[1.75]";

const StatusIcon = ({ status }: { readonly status: CheckState }) => {
  switch (status) {
    case "waiting":
      return <CircleDashedIcon aria-hidden className={cn(iconClass, "text-faint")} />;
    case "running":
      return <LoaderCircleIcon aria-hidden className={cn(iconClass, "text-muted motion-safe:animate-spin")} />;
    case "passed":
      return <CircleCheckIcon aria-hidden className={cn(iconClass, "text-green")} />;
    case "failed":
      return <CircleXIcon aria-hidden className={cn(iconClass, "text-red")} />;
    case "timed-out":
      return <TimerOffIcon aria-hidden className={cn(iconClass, "text-red")} />;
    case "error":
      return <TriangleAlertIcon aria-hidden className={cn(iconClass, "text-red")} />;
    default:
      return status satisfies never;
  }
};

const wordTone = (status: CheckState): string => {
  switch (status) {
    case "waiting":
      return "text-faint";
    case "running":
      return "text-muted";
    case "passed":
      return "text-green";
    case "failed":
    case "timed-out":
    case "error":
      return "text-red";
    default:
      return status satisfies never;
  }
};

/** The tab's marker after `Checks`: a green check, a red cross and count, or a spinner. */
export const ChecksTabMarker = ({ marker }: { readonly marker: ChecksMarker }) => {
  switch (marker.kind) {
    case "none":
      return null;
    case "running":
      return <LoaderCircleIcon aria-label={t("taskTabs.checksRunning")} className="size-[13px] stroke-[1.75] text-muted motion-safe:animate-spin" />;
    case "passed":
      return <CircleCheckIcon aria-label={t("taskTabs.checksPassed")} className="size-[13px] stroke-[1.75] text-green" />;
    case "failing":
      return (
        <span className="inline-flex items-center gap-1 text-red" aria-label={t("taskTabs.checksFailing", { n: marker.count })}>
          <CircleXIcon aria-hidden className="size-[13px] stroke-[1.75]" />
          <span aria-hidden className="font-mono text-xs">
            {marker.count}
          </span>
        </span>
      );
    default:
      return marker satisfies never;
  }
};

/** The PR's draft line: what the checks did to one repo's PR, with `Open on GitHub`. */
export const PrDraftRow = ({ line }: { readonly line: PrDraftLine }) => {
  const words = prLineWords(line);
  return (
    <div className="flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line py-2 text-ui" data-pr={line.number}>
      {line.state === "ready-by-ostra" ? (
        <GitPullRequestIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-green" />
      ) : (
        <GitPullRequestDraftIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-muted" />
      )}
      <span>
        <b className="font-semibold text-text">{words.bold}</b>
        <span className="text-muted">{words.rest}</span>
      </span>
      <a href={line.url} target="_blank" rel="noopener noreferrer" className="ml-1 inline-flex items-center gap-1 text-teal hover:underline">
        {t("checks.pr.open")}
        <ArrowUpRightIcon aria-hidden className="size-3 stroke-[1.75]" />
      </a>
    </div>
  );
};

/** A check's output: plain text, ANSI stripped, its last 40 lines until `Show all`. */
export const CheckOutput = ({ check }: { readonly check: CheckRunView }) => {
  const lines = plainOutput(check.outputTail);
  const [all, setAll] = useState(false);
  if (lines.length === 0) return <p className="pb-3 pl-[42px] text-xs text-faint">{t("checks.noOutput")}</p>;
  const shown = shownLines(lines, all);
  return (
    <div className="pb-3 pl-[42px]">
      <div className="mb-1.5 flex items-center gap-3 text-xs text-faint">
        {outputLabel(lines.length)}
        {shown.length < lines.length ? (
          <button
            type="button"
            className="text-teal hover:underline"
            onClick={() => {
              setAll(true);
            }}
          >
            {t("checks.showAll", { n: lines.length })}
          </button>
        ) : null}
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-surface px-3.5 py-3 font-mono text-xs leading-[1.6] text-muted" data-output={check.checkId}>
        {shown.join("\n")}
      </pre>
    </div>
  );
};

/** The fix row's state: ready to send, sending, sent at a time, or refused. */
export type FixState = { readonly kind: "idle" } | { readonly kind: "sending" } | { readonly kind: "sent"; readonly at: number } | { readonly kind: "refused"; readonly message: string };

export type FixRowProps = {
  readonly failing: number;
  readonly agent: string;
  readonly delivery: FixDelivery;
  readonly state: FixState;
  readonly downloadUrl: string | null;
  readonly onFix: () => void;
  readonly onTakeOver: () => void;
  readonly onSeeActivity: () => void;
};

/** `Ask the agent to fix`, the full output's download and the hint, after the last failing check. */
export const FixRow = ({ failing, agent, delivery, state, downloadUrl, onFix, onTakeOver, onSeeActivity }: FixRowProps) => (
  <div className="pb-3 pl-[42px]">
    <div className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-2">
      {state.kind === "sent" ? (
        <p className="text-xs text-muted">
          {t("checks.sent", { agent, time: formatClock(state.at) })}{" "}
          <button type="button" className="text-teal hover:underline" onClick={onSeeActivity}>
            {t("checks.seeActivity")}
          </button>
        </p>
      ) : (
        <Button variant="primary" disabled={delivery.kind === "not-driver" || state.kind === "sending"} onClick={onFix} data-action="fix-checks">
          <WrenchIcon aria-hidden />
          {state.kind === "sending" ? t("checks.sending") : t("checks.fixButton")}
        </Button>
      )}
      {downloadUrl === null ? (
        <span className="text-xs text-faint">{t("checks.notSaved")}</span>
      ) : (
        <a href={downloadUrl} download className="inline-flex items-center gap-1.5 text-ui text-teal hover:underline">
          <DownloadIcon aria-hidden className="size-[13px] stroke-[1.75]" />
          {t("checks.download")}
        </a>
      )}
      {state.kind === "sent" ? null : (
        <span className="text-xs text-faint">
          {fixHint(delivery, failing, agent)}
          {delivery.kind === "not-driver" ? (
            <>
              {" "}
              <button type="button" className="text-teal hover:underline" onClick={onTakeOver}>
                {t("checks.takeOver")}
              </button>
            </>
          ) : null}
        </span>
      )}
    </div>
    {state.kind === "refused" ? (
      <p role="alert" className="text-xs text-red">
        {state.message}
      </p>
    ) : null}
  </div>
);

const Chevron = ({ open }: { readonly open: boolean }) =>
  open ? <ChevronDownIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75] text-muted" /> : <ChevronRightIcon aria-hidden className="size-[14px] shrink-0 stroke-[1.75] text-muted" />;

/** A summary's parts: failures first in red, passes in green, joined by faint dots. */
const SummaryParts = ({ checks }: { readonly checks: readonly CheckRunView[] }) =>
  summaryOf(checks).map((part, i) => (
    <Fragment key={part.text}>
      {i > 0 ? <span className="text-faint">·</span> : null}
      <span className={part.tone === "red" ? "text-red" : "text-green"}>{part.text}</span>
    </Fragment>
  ));

/**
 * A repo's heading in a turn of a task with several repos (F-098), as the Changes tab heads its
 * repos: the repo's name in mono, the commit its checks ran on, and its own summary. The checks
 * that ran at the workspace root come last, under their own heading.
 */
const RepoSectionHeading = ({ section }: { readonly section: RepoChecksSection }) => (
  <div className="flex h-8 items-center gap-2.5 border-t border-line" data-repo-section={section.repo ?? "workspace-root"}>
    <span aria-hidden className="w-4 shrink-0" />
    {section.repo === null ? (
      <span className="text-xs text-muted">{t("checks.workspaceRoot")}</span>
    ) : (
      <span className="min-w-0 truncate font-mono text-[12.5px] text-text" title={section.repo}>
        {section.repo}
      </span>
    )}
    {section.sha === null ? null : <span className="shrink-0 font-mono text-xs text-faint">{section.sha.slice(0, 7)}</span>}
    <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs">
      <SummaryParts checks={section.checks} />
    </span>
  </div>
);

/** One check's 40px row: chevron, status, name, command, word and duration. With several repos, its section names the repo. */
const CheckRowLine = ({ check, open, now }: { readonly check: CheckRunView; readonly open: boolean | null; readonly now: number }) => {
  const duration = durationOf(check, now);
  return (
    <>
      <span className="grid w-4 place-items-center">{open === null ? null : <Chevron open={open} />}</span>
      <StatusIcon status={check.status} />
      <span className="flex w-[150px] min-w-0 shrink-0 items-center gap-1.5 sm:w-auto sm:max-w-[220px]">
        <span className="truncate font-mono text-[12.5px] text-text" title={check.name}>
          {check.name}
        </span>
      </span>
      <span className="hidden min-w-0 flex-1 truncate font-mono text-xs text-faint md:block" title={check.command}>
        {check.command}
      </span>
      <span className={cn("ml-auto shrink-0 text-[12.5px] md:ml-0", wordTone(check.status))}>{statusWord(check)}</span>
      <span className="w-14 shrink-0 text-right font-mono text-xs text-faint">{duration ?? ""}</span>
    </>
  );
};

export type TurnSectionProps = {
  readonly turn: TurnChecksView;
  readonly newest: boolean;
  readonly now: number;
  /** Milestone 4 (F-098): the task's repos in the project's order; with several, the turn has a section per repo. */
  readonly repos: readonly string[];
  /** Only the newest turn with a failure gets the fix row. */
  readonly fix: Omit<FixRowProps, "failing" | "downloadUrl"> | null;
};

/** One turn: its header (the fold's button) and, open, its check rows, in a section per repo when the task has several. */
export const TurnSection = ({ turn, newest, now, repos, fix }: TurnSectionProps) => {
  const [open, setOpen] = useState(newest);
  const running = turnRunning(turn);
  const sections = repoSectionsOf(turn, repos);
  // The rows in the order they show: the fix row follows the last failing one there.
  const shown = sections === null ? turn.checks : sections.flatMap((section) => section.checks);
  const failing = shown.filter((check) => isFailing(check.status));
  const lastFailing = failing.at(-1)?.checkId ?? null;
  const [openChecks, setOpenChecks] = useState<ReadonlySet<string>>(() => new Set(failing.map((check) => check.checkId)));
  const rowsOf = (checks: readonly CheckRunView[]) =>
    checks.map((check) => {
      const hasOutput = check.status !== "waiting" && check.status !== "running";
      const checkOpen = openChecks.has(check.checkId);
      const showFix = fix !== null && check.checkId === lastFailing;
      const row = (
        <div className="flex h-10 items-center gap-2.5" data-check={check.name} data-status={check.status}>
          <CheckRowLine check={check} open={hasOutput ? checkOpen : null} now={now} />
        </div>
      );
      return (
        <div key={check.checkId} className="border-t border-line">
          {hasOutput ? (
            <Collapsible.Root
              open={checkOpen}
              onOpenChange={(next) => {
                setOpenChecks((current) => {
                  const updated = new Set(current);
                  if (next) updated.add(check.checkId);
                  else updated.delete(check.checkId);
                  return updated;
                });
              }}
            >
              <Collapsible.Trigger className="w-full text-left">{row}</Collapsible.Trigger>
              <Collapsible.Content>
                <CheckOutput check={check} />
              </Collapsible.Content>
            </Collapsible.Root>
          ) : (
            row
          )}
          {showFix ? <FixRow {...fix} failing={failing.length} downloadUrl={check.downloadUrl} /> : null}
        </div>
      );
    });
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="border-b border-line" data-turn={turn.turn}>
      <Collapsible.Trigger className="flex h-10 w-full items-center gap-2.5 text-left">
        <span className="grid w-4 place-items-center">
          <Chevron open={open} />
        </span>
        <span className="text-ui font-semibold text-text">{t("checks.turn", { n: turn.turn })}</span>
        <span className="ml-1 font-mono text-xs text-faint">
          {formatClock(turn.at)}
          {/* With several repos, each section names the commit its checks ran on. */}
          {sections !== null || turn.sha === null ? null : ` · ${turn.sha.slice(0, 7)}`}
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-[12.5px]">{running ? <span className="text-muted">{t("checks.running")}</span> : <SummaryParts checks={turn.checks} />}</span>
        {running ? null : <span className="ml-3 font-mono text-xs text-faint">{formatCheckDuration(turnTotalMs(turn))}</span>}
      </Collapsible.Trigger>
      <Collapsible.Content>
        {sections === null
          ? rowsOf(turn.checks)
          : sections.map((section) => (
              <div key={section.repo ?? ""} data-repo={section.repo ?? ""}>
                <RepoSectionHeading section={section} />
                {rowsOf(section.checks)}
              </div>
            ))}
      </Collapsible.Content>
    </Collapsible.Root>
  );
};


export type ChecksBodyProps = {
  readonly load: { readonly kind: "loading" } | { readonly kind: "error"; readonly message: string; readonly retry: () => void } | { readonly kind: "ready"; readonly configured: boolean; readonly supported: boolean; readonly turns: readonly TurnChecksView[]; readonly prLines: readonly PrDraftLine[]; readonly repos: readonly string[] };
  readonly now: number;
  readonly environmentHref: string | null;
  readonly fix: Omit<FixRowProps, "failing" | "downloadUrl">;
};

const Footnote = ({ environmentHref }: { readonly environmentHref: string | null }) => (
  <p className="mt-4 text-xs text-faint">
    {t("checks.footnote")}
    {environmentHref === null ? null : (
      <>
        {" "}
        <Link href={environmentHref} className="text-teal hover:underline">
          {t("checks.edit")}
        </Link>
      </>
    )}
  </p>
);

/** The tab's body, in each of its states. */
export const ChecksBody = ({ load, now, environmentHref, fix }: ChecksBodyProps): ReactNode => {
  if (load.kind === "loading") {
    return (
      <div aria-busy className="mt-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex h-10 items-center gap-3 border-b border-line">
            <Skeleton className="size-4" />
            <Skeleton className="w-[120px]" />
            <Skeleton className="w-[240px]" />
          </div>
        ))}
      </div>
    );
  }
  if (load.kind === "error") {
    return (
      <p role="alert" className="mt-4 text-xs text-red">
        {t("checks.loadFailed", { error: load.message })}{" "}
        <button type="button" className="text-teal hover:underline" onClick={load.retry}>
          {t("checks.tryAgain")}
        </button>
      </p>
    );
  }
  if (!load.supported) return <p className="mt-6 text-ui text-muted">{t("checks.oldRunner")}</p>;
  if (!load.configured) {
    return (
      <div className="mx-auto mt-16 max-w-[420px] text-center">
        <p className="text-ui text-muted">{t("checks.none")}</p>
        <p className="mt-1.5 text-xs text-faint">
          {t("checks.noneBody")}
          {environmentHref === null ? null : (
            <>
              {" "}
              <Link href={environmentHref} className="text-teal hover:underline">
                {t("checks.add")}
              </Link>
            </>
          )}
        </p>
      </div>
    );
  }
  const newestWithFailure = load.turns[0]?.checks.some((check) => isFailing(check.status)) === true ? load.turns[0].turn : null;
  return (
    <div className="mt-2">
      {load.prLines.map((line) => (
        <PrDraftRow key={`${line.repo ?? ""}#${String(line.number)}`} line={line} />
      ))}
      {load.turns.length === 0 ? <p className="mt-4 text-ui text-muted">{t("checks.notYet")}</p> : null}
      {load.turns.map((turn, i) => (
        <TurnSection key={turn.turn} turn={turn} newest={i === 0} now={now} repos={load.repos} fix={turn.turn === newestWithFailure ? fix : null} />
      ))}
      <Footnote environmentHref={environmentHref} />
    </div>
  );
};
