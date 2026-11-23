import type { TaskKind } from "@ostra/protocol";
import type { LiveDoing } from "@ostra/task-view";

import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";
import { safeHref } from "@/task/renderers";
import { liveStepWords } from "@/task/thread/words";
import type { Segment } from "@/task/thread/words";

import { trackerName } from "./task-ticket";

// Owner: ticket 15 (milestone 10, F-151/c7, the README's choice 10, parts.md part 15). What a task's
// page says of itself by its kind: its tabs, its key line, title and crumb, and what a review
// task's top bar links to. A review task says only what a review does: it reads a code task's PR and
// writes a review, so it has no Changes or Checks, and it names the PR it reviews. Pure.

type Task = RouterOutputs["tasks"]["get"];

/** The task page's tabs. */
export type TaskTab = "activity" | "changes" | "checks" | "events" | "draft";

/**
 * The tabs a task's kind has (parts.md part 15): a code task `Activity`, `Changes`, `Checks`,
 * `Event log`; a refine task `Activity`, `Draft`, `Event log` (milestone 6); a review task
 * `Activity` and `Event log` only.
 */
export const tabsOf = (kind: TaskKind): readonly TaskTab[] => {
  switch (kind) {
    case "code":
      return ["activity", "changes", "checks", "events"];
    case "refine":
      return ["activity", "draft", "events"];
    case "review":
      return ["activity", "events"];
    default:
      return kind satisfies never;
  }
};

/**
 * The tab a page opens on: `?tab=` when the kind has that tab, else a refine task's draft while it
 * has one and no tab is named (ticket 34), else Activity. A `?tab=` naming a tab the kind hasn't
 * (a review task's `?tab=changes`) opens Activity.
 */
export const openTabOf = (kind: TaskKind, param: string | null, hasDraft: boolean): TaskTab => {
  const named = tabsOf(kind).find((tab) => tab === param);
  if (named !== undefined) return named;
  return kind === "refine" && param === null && hasDraft ? "draft" : "activity";
};

/** What a review task reviews, from `tasks.get`'s `review`, else its `reviewOf` before its first round. */
export type Reviewed = {
  readonly codeTask: { readonly id: string; readonly key: string; readonly title: string };
  /** The PR it reviews, `null` before the code task has one. */
  readonly prNumber: number | null;
  /** The reviewed PR's buttons for the top bar: the reviewed one, else each of the code task's. */
  readonly prs: readonly { readonly number: number; readonly href: string; readonly repo: string }[];
};

export const reviewedOf = (task: Pick<Task, "kind" | "review" | "reviewOf">): Reviewed | null => {
  if (task.kind !== "review" || task.reviewOf === null) return null;
  const codeTask = task.review?.codeTask ?? { id: task.reviewOf.taskId, key: task.reviewOf.key, title: task.reviewOf.title };
  const prNumber = task.review?.prNumber ?? task.reviewOf.prs[0]?.number ?? null;
  const prs = task.reviewOf.prs.flatMap((pr) => {
    const href = safeHref(pr.url);
    return href === null || (prNumber !== null && pr.number !== prNumber) ? [] : [{ number: pr.number, href, repo: pr.repo }];
  });
  return { codeTask, prNumber, prs };
};

/** The page's key line, title and crumb. */
export type Heading = {
  /** The key line's key, mono: the task's own, or a review's code task's (`CALC-192`). */
  readonly key: string;
  /** After ` · `: where it came from (`from a prompt`, `from Linear`), or `AI review`. */
  readonly source: string;
  readonly title: string;
  /** The breadcrumb's last item: the task's key, or a review's title. */
  readonly crumb: string;
};

/**
 * The key line, title and crumb (`s3.md`): a review task's `CALC-192 · AI review` and `Review of
 * PR #483` (its crumb too); any other task its key and source, its title and its key.
 */
export const headingOf = (task: Pick<Task, "key" | "title" | "kind" | "source" | "ticket" | "review" | "reviewOf">): Heading => {
  const reviewed = reviewedOf(task);
  if (reviewed !== null) {
    const title = reviewed.prNumber === null ? task.title : t("taskPage.reviewTitle", { n: reviewed.prNumber });
    return { key: reviewed.codeTask.key, source: t("taskPage.aiReview"), title, crumb: title };
  }
  const source = task.source === "prompt" ? t("taskPage.fromPrompt") : task.ticket === null ? t("taskPage.fromTicket") : t("taskPage.fromTracker", { tracker: trackerName(task.ticket.tracker) });
  return { key: task.key, source, title: task.title, crumb: task.key };
};

/** A path's last name: the status line says `Editing shortcuts.ts` where the live step says the path. */
const baseName = (path: string): string => path.split(/[\\/]/).filter((name) => name !== "").at(-1) ?? path;

/**
 * What the agent does now, on the status line while a turn runs (`s1.md`: `Running pnpm test
 * history`; `s5.md`: `Editing shortcuts.ts`): the live step's words (ticket 04's `task.doing.*`),
 * a file by its name. Empty when no step runs.
 */
export const statusDoingOf = (doing: LiveDoing | null): readonly Segment[] => {
  if (doing === null) return [];
  const short: LiveDoing =
    doing.kind === "editing" ? { ...doing, path: baseName(doing.path) } : doing.kind === "reading" && doing.path !== null ? { ...doing, path: baseName(doing.path) } : doing;
  return liveStepWords({ doing: short, done: 0, failed: 0, planStep: null, startedAt: null, waiting: null }, t, 0).doing;
};
