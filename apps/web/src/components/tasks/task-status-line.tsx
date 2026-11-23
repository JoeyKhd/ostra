"use client";

import { Fragment, useEffect, useState } from "react";
import type { ReactNode } from "react";

import { Status } from "@/components/ui/status";
import { formatElapsed } from "@/lib/format";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";
import { boxStatusWords, reviewStatusWords } from "@/task/thread/words";
import type { ReviewStatus, Segment } from "@/task/thread/words";

import { stateTone } from "./task-words";

// Owner: ticket 15 (milestone 10, F-151/c9: the status line, parts.md part 15, the README's choice
// 15). The state's dot and words, then `--muted` facts: what the agent does while a turn runs and
// `Started {age} ago on {runner}`; the sub-state's place (`PR #483`); a review task's round; and,
// when no turn runs, the box (`box idle, stops in 11 min`, `box stopped`, `box released`).

type Task = RouterOutputs["tasks"]["get"];

/** The ` · ` between facts on a line, in `--faint`. */
const Sep = () => <span aria-hidden className="text-faint">·</span>;

/**
 * How long until the status line's words change: at the next whole minute before the box's idle
 * stop (the minutes are rounded up, so `stops in 11 min` becomes `10` exactly ten minutes before
 * it), else in 30 s for the elapsed time.
 */
export const nextTickIn = (idleStopDueAt: number | null, now: number): number => {
  if (idleStopDueAt === null || idleStopDueAt <= now) return 30_000;
  const left = (idleStopDueAt - now) % 60_000;
  return left === 0 ? 60_000 : left;
};

/** The time now, ticking when the line's words change (`nextTickIn`). */
const useLineClock = (idleStopDueAt: number | null): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setTimeout(() => { setNow(Date.now()); }, nextTickIn(idleStopDueAt, now));
    return () => { clearTimeout(timer); };
  }, [idleStopDueAt, now]);
  return now;
};

/** What the agent does now (`Running pnpm test history`): its words, the subject mono 13px `--faint`. */
const Doing = ({ segments }: { readonly segments: readonly Segment[] }) => (
  <span className="text-muted" data-part="status-doing">
    {segments.map((segment, i) =>
      segment.mono ? (
        <span key={i} className="font-mono text-sm text-faint">{segment.text}</span>
      ) : (
        <Fragment key={i}>{segment.text}</Fragment>
      ),
    )}
  </span>
);

/**
 * The status line under the title (parts.md part 15): `● Running · Running pnpm test history ·
 * Started 4 min ago on build-fleet-03`, `● In review · CI running · PR #483 · box idle, stops in 11
 * min`, `● Done · round 2 of 3: nothing blocking, 1 nit · box released`. A refine task keeps its
 * read-only note (milestone 6); a limit or a crash says when it stopped (task-limits.md).
 */
export const TaskStatusLine = ({ task, label, running, doing, place, review, stoppedAt, reconnecting }: {
  readonly task: Pick<Task, "state" | "kind" | "createdAt" | "runner" | "box">;
  /** The state's words, with milestone 6's sub-state (`In review · CI running`, `Needs you · question`). */
  readonly label: string;
  /** A turn runs: the line says what it does and when it started, never the box. */
  readonly running: boolean;
  /** What the agent does now, while a turn runs; empty for nothing to say. */
  readonly doing: readonly Segment[];
  /** Where the sub-state is (`PR #483`); `null` outside review. */
  readonly place: string | null;
  /** A review task's round (`tasks.get`'s `review`); `null` on any other kind. */
  readonly review: ReviewStatus | null;
  /** When a limit or a crash stopped the session, for `Stopped {age} ago`; `null` otherwise. */
  readonly stoppedAt: number | null;
  /** The live stream is reconnecting. */
  readonly reconnecting: boolean;
}) => {
  const box = task.box;
  const now = useLineClock(box?.state === "idle" ? box.idleStopDueAt : null);
  const boxWords = running || stoppedAt !== null || box === null ? null : boxStatusWords(box, now, t);
  const facts: { readonly key: string; readonly node: ReactNode }[] = [];
  if (running && doing.length > 0) facts.push({ key: "doing", node: <Doing segments={doing} /> });
  if (place !== null) facts.push({ key: "place", node: <span className="text-muted" data-part="status-place">{place}</span> });
  if (review !== null) facts.push({ key: "round", node: <span className="text-muted" data-part="status-round">{reviewStatusWords(review, t)}</span> });
  if (task.kind === "refine") {
    facts.push({ key: "read-only", node: <span className="text-muted" data-testid="task-read-only">{task.state === "done" ? t("draft.readOnlyDone") : t("draft.readOnly")}</span> });
  }
  facts.push(
    boxWords === null
      ? {
          key: "when",
          node: (
            <span className="text-muted" data-part="status-started">
              {stoppedAt === null ? t("taskPage.started", { age: formatElapsed(task.createdAt, now) }) : t("taskPage.stoppedAgo", { age: formatElapsed(stoppedAt, now) })}
              {task.runner === null ? null : <> {t("taskPage.on")} <span className="font-mono text-sm text-faint">{task.runner.name}</span></>}
            </span>
          ),
        }
      : { key: "box", node: <span className="text-muted" data-part="status-box" data-box={box?.state}>{boxWords}</span> },
  );
  if (reconnecting) facts.push({ key: "reconnecting", node: <span className="text-muted">{t("taskPage.reconnecting")}</span> });
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-ui leading-[21px]" data-testid="task-doing" data-state={task.state}>
      <Status tone={stateTone(task.state)}><span className="font-medium text-text">{label}</span></Status>
      {facts.map((fact) => (
        <Fragment key={fact.key}>
          <Sep />
          {fact.node}
        </Fragment>
      ))}
    </p>
  );
};
