import { needsYouReasonText, runningSegments } from "@/components/projects/task-row-words";
import type { TaskRow } from "@/components/projects/task-row-words";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// The panel's live tasks (F-147; app-shell.md, "A live task row"): a project's active tasks, and on
// Home the member's own, each as two lines. Pure, from the task list's and the board's existing
// queries: no endpoint of its own.

export type LiveMark = "amber" | "green" | "preparing" | "queued";

export type LiveTask = {
  readonly taskId: string;
  readonly key: string;
  readonly title: string;
  readonly mark: LiveMark;
  /** Line 2 after the key: the needs-you words (`--amber-text`), or what the agent does now. */
  readonly line: { readonly tone: "needs-you" | "plain"; readonly text: string };
};

type BoardCard = RouterOutputs["home"]["board"]["columns"][number]["cards"][number];
type NeedsYouReason = NonNullable<TaskRow["needsYouReason"]>;

const markOrder: Readonly<Record<LiveMark, number>> = { amber: 0, green: 1, preparing: 2, queued: 3 };

/** Needs you first, then running, preparing and queued; the list's own order inside each. */
export const liveOrder = (tasks: readonly LiveTask[]): readonly LiveTask[] =>
  tasks
    .map((task, at) => ({ task, at }))
    .sort((a, b) => markOrder[a.task.mark] - markOrder[b.task.mark] || a.at - b.at)
    .map(({ task }) => task);

/** What waits on the member, short: an approval, a question, or the reason in words. */
export const needsYouLine = (reason: NeedsYouReason | null): string => {
  if (reason === "approval") return t("shell.live.approval");
  if (reason === "question") return t("shell.live.question");
  return reason === null ? t("shell.live.needsYou") : needsYouReasonText(reason);
};

const plainText = (segments: readonly { readonly text: string }[]): string => segments.map((segment) => segment.text).join("");

/** A project's task, from `tasks.list`, when it's live: every driver's, needs you to queued. */
export const liveFromRow = (task: TaskRow): LiveTask | null => {
  const base = { taskId: task.id, key: task.key, title: task.title };
  switch (task.state) {
    case "needs_you":
      return { ...base, mark: "amber", line: { tone: "needs-you", text: needsYouLine(task.needsYouReason) } };
    case "awaiting_approval":
      return { ...base, mark: "amber", line: { tone: "needs-you", text: t("tasks.row.awaitingStart") } };
    case "running":
      return { ...base, mark: "green", line: { tone: "plain", text: plainText(runningSegments(task.doing)) } };
    case "preparing":
      return { ...base, mark: "preparing", line: { tone: "plain", text: t("tasks.row.preparing") } };
    case "queued":
      return { ...base, mark: "queued", line: { tone: "plain", text: t("tasks.row.queued") } };
    case "in_review":
    case "stopped":
    case "merged":
    case "done":
      return null;
    default:
      return task.state satisfies never;
  }
};

/** A card of Home's board (the needs-you and running columns) as a live row, or `null` for another kind. */
export const liveFromCard = (card: BoardCard): LiveTask | null => {
  const base = { taskId: card.taskId, key: card.key ?? card.taskId.slice(-7), title: card.title };
  switch (card.status.kind) {
    case "needs-you":
      return { ...base, mark: "amber", line: { tone: "needs-you", text: needsYouLine(card.status.reason) } };
    case "running":
      return { ...base, mark: "green", line: { tone: "plain", text: plainText(runningSegments(card.status.doing)) } };
    case "preparing":
      return { ...base, mark: "preparing", line: { tone: "plain", text: t("tasks.row.preparing") } };
    case "queued":
    case "in-review":
    case "finished":
      return null;
    default:
      return card.status satisfies never;
  }
};

/** The member's own live tasks on Home's panel: the cards they drive. */
export const yoursLive = (cards: readonly BoardCard[], memberId: string | null): readonly LiveTask[] =>
  liveOrder(cards.flatMap((card) => {
    if (memberId === null || card.driver?.memberId !== memberId) return [];
    const live = liveFromCard(card);
    return live === null ? [] : [live];
  }));

/** The project's live tasks, optionally only the member's (`Mine`). */
export const projectLive = (groups: RouterOutputs["tasks"]["list"], mine: string | null): readonly LiveTask[] =>
  liveOrder(groups.flatMap((group) => group.tasks).flatMap((task) => {
    if (mine !== null && task.driver?.memberId !== mine) return [];
    const live = liveFromRow(task);
    return live === null ? [] : [live];
  }));
