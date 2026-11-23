"use client";

import { Status } from "@/components/ui/status";
import { formatElapsed } from "@/lib/format";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

import { readOnlyKind } from "./task-properties";
import { stateTone } from "./task-words";

// Owner: ticket 15 (milestone 10, F-151: the status line, parts.md part 15). Ticket 09 moved it
// here from `task-view.tsx` unchanged, so ticket 15 can change it on its own.

type Task = RouterOutputs["tasks"]["get"];

/** The ` · ` between facts on a line, in `--faint`. */
const Sep = () => <span aria-hidden className="text-faint">·</span>;

/**
 * The status line under the title (task.md, "Header"): the state's dot and words, the activity,
 * a read-only kind's note, when it started (or stopped) and on which runner, and a reconnect.
 */
export const TaskStatusLine = ({ task, label, activity, stoppedAt, now, reconnecting }: {
  readonly task: Pick<Task, "state" | "kind" | "createdAt" | "runner">;
  /** The state's words (`Running`, `Needs you · question`, `Queued: no key for its model`). */
  readonly label: string;
  /** What the agent does now, or the box's idle line; `""` for nothing. */
  readonly activity: string;
  /** When a limit or a crash stopped the session, for `Stopped {age} ago`; `null` otherwise. */
  readonly stoppedAt: number | null;
  readonly now: number;
  /** The live stream is reconnecting. */
  readonly reconnecting: boolean;
}) => (
  <p className="flex flex-wrap items-center gap-x-2 text-body" data-testid="task-doing" data-state={task.state}>
    <Status tone={stateTone(task.state)}><span className="font-medium text-text">{label}</span></Status>
    {activity === "" ? null : <><Sep /><span className="text-muted">{activity}</span></>}
    {readOnlyKind(task.kind) ? <><Sep /><span className="text-muted" data-testid="task-read-only">{task.state === "done" ? t("draft.readOnlyDone") : t("draft.readOnly")}</span></> : null}
    <Sep />
    <span className="text-muted">
      {stoppedAt === null ? t("taskPage.started", { age: formatElapsed(task.createdAt, now) }) : t("taskPage.stoppedAgo", { age: formatElapsed(stoppedAt, now) })}
      {task.runner === null ? null : <> {t("taskPage.on")} <span className="font-mono text-ui text-faint">{task.runner.name}</span></>}
    </span>
    {reconnecting ? <><Sep /><span className="text-muted">{t("taskPage.reconnecting")}</span></> : null}
  </p>
);
