import { needsYouReasonText, runningSegments } from "@/components/projects/task-row-words";
import type { TaskRow } from "@/components/projects/task-row-words";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// The panel's live tasks (F-147; app-shell.md, "A live task row"): a project's active tasks, and on
// Home the member's own, each as two lines. Pure, from the task list's and the board's existing
// queries: no endpoint of its own. A follow-up (a code task's AI review, ADR 0059 amended
// 2026-11-21) is drawn under its code task, indented with its tag, never as a row of its own.

/** `in-review`: a code task that isn't live itself, drawn only to hold its follow-ups. */
export type LiveMark = "amber" | "green" | "preparing" | "queued" | "in-review";

export type LiveTask = {
  readonly taskId: string;
  readonly key: string;
  readonly title: string;
  readonly mark: LiveMark;
  /** Line 2 after the key: the needs-you words (`--amber-text`), or what the agent does now. */
  readonly line: { readonly tone: "needs-you" | "plain"; readonly text: string };
  /** `review` for a follow-up, drawn under its code task with that tag (F-147/c8); `null` for any other task. */
  readonly followUp: "review" | null;
  /** Milestone 11 (F-152/c4, ticket-chips.md "Sidebar, live"): the ticket's tracker, marked before its key; `null` for a task without one. */
  readonly connection: TicketConnection | null;
};

/** A task's ticket's tracker, as `tasks.list` answers it: its board's connection. */
type TicketConnection = NonNullable<TaskRow["connection"]>;

/**
 * A row of a live list and the follow-ups drawn under it. `context`: the task itself isn't live
 * (its PR is in review), and is drawn only so its follow-ups sit under it.
 */
export type LiveFamily = { readonly task: LiveTask; readonly followUps: readonly LiveTask[]; readonly context: boolean };

type BoardCard = RouterOutputs["home"]["board"]["columns"][number]["cards"][number];
type NeedsYouReason = NonNullable<TaskRow["needsYouReason"]>;

const markOrder: Readonly<Record<LiveMark, number>> = { amber: 0, green: 1, preparing: 2, queued: 3, "in-review": 4 };

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

/**
 * A running task's line: what the agent does now, or `Running` before its first event says. The
 * dot is hidden from a reader and is colour alone, so the words always name the state.
 */
export const runningLine = (doing: TaskRow["doing"]): string => plainText(runningSegments(doing)) || t("taskState.running");

/** A follow-up's tag: its kind, for a task that follows up another. */
const followUpOf = (kind: TaskRow["kind"], reviewOf: unknown): LiveTask["followUp"] => (kind === "review" && reviewOf !== null ? "review" : null);

/** A project's task, from `tasks.list`, when it's live: every driver's, needs you to queued. */
export const liveFromRow = (task: TaskRow): LiveTask | null => {
  const base = { taskId: task.id, key: task.key, title: task.title, followUp: followUpOf(task.kind, task.reviewOf), connection: task.connection };
  switch (task.state) {
    case "needs_you":
      return { ...base, mark: "amber", line: { tone: "needs-you", text: needsYouLine(task.needsYouReason) } };
    case "awaiting_approval":
      return { ...base, mark: "amber", line: { tone: "needs-you", text: t("tasks.row.awaitingStart") } };
    case "running":
      return { ...base, mark: "green", line: { tone: "plain", text: runningLine(task.doing) } };
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
  const base = { taskId: card.taskId, key: card.key ?? card.taskId.slice(-7), title: card.title, followUp: followUpOf(card.kind, card.reviewOf), connection: card.connection };
  switch (card.status.kind) {
    case "needs-you":
      return { ...base, mark: "amber", line: { tone: "needs-you", text: needsYouLine(card.status.reason) } };
    case "running":
      return { ...base, mark: "green", line: { tone: "plain", text: runningLine(card.status.doing) } };
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

/** The row of a code task that isn't live, drawn only to hold its follow-ups: in review, as a rule. */
const contextRow = (task: { readonly taskId: string; readonly key: string; readonly title: string }, text: string = t("taskState.inReview")): LiveTask => ({
  ...task,
  mark: "in-review",
  line: { tone: "plain", text },
  followUp: null,
  connection: null,
});

/** A task's state in a word, for a code task drawn only to hold its follow-ups. */
const quietState = (state: TaskRow["state"]): string => {
  switch (state) {
    case "stopped":
      return t("taskState.stopped");
    case "merged":
      return t("taskState.merged");
    case "done":
      return t("taskState.done");
    case "in_review":
    case "needs_you":
    case "awaiting_approval":
    case "running":
    case "preparing":
    case "queued":
      return t("taskState.inReview");
    default:
      return state satisfies never;
  }
};

/** A live task, and the code task it follows up when it's a follow-up. */
export type LiveEntry = { readonly live: LiveTask; readonly parentId: string | null };

/**
 * The live list's rows (F-147/c8): each follow-up under its code task, which is drawn even when it
 * isn't live itself (`context`, from `parentRow`); a follow-up whose code task isn't known keeps a
 * row of its own, with its tag. Families come in the live order of their most urgent task.
 */
export const nestFollowUps = (entries: readonly LiveEntry[], parentRow: (taskId: string) => LiveTask | null): readonly LiveFamily[] => {
  const tops = entries.filter((entry) => entry.parentId === null).map((entry) => entry.live);
  const topIds = new Set(tops.map((task) => task.taskId));
  const under = new Map<string, LiveTask[]>();
  const orphans: LiveTask[] = [];
  const families: LiveFamily[] = [];
  for (const { live, parentId } of entries) {
    if (parentId === null) continue;
    const known = topIds.has(parentId) || under.has(parentId) || parentRow(parentId) !== null;
    if (!known) {
      orphans.push(live);
      continue;
    }
    under.set(parentId, [...(under.get(parentId) ?? []), live]);
  }
  for (const task of tops) {
    families.push({ task, followUps: liveOrder(under.get(task.taskId) ?? []), context: false });
  }
  for (const [parentId, followUps] of under) {
    const parent = topIds.has(parentId) ? null : parentRow(parentId);
    if (parent !== null) families.push({ task: parent, followUps: liveOrder(followUps), context: true });
  }
  for (const task of orphans) {
    families.push({ task, followUps: [], context: false });
  }
  // The most urgent task of each family places it; the order the entries came in breaks a tie.
  const rank = (family: LiveFamily): number => Math.min(...[...(family.context ? [] : [family.task]), ...family.followUps].map((task) => markOrder[task.mark]));
  const firstAt = (family: LiveFamily): number => entries.findIndex((entry) => entry.live.taskId === family.task.taskId || family.followUps.some((task) => task.taskId === entry.live.taskId));
  return families
    .map((family) => ({ family, rank: rank(family), at: firstAt(family) }))
    .sort((a, b) => a.rank - b.rank || a.at - b.at)
    .map(({ family }) => family);
};

/** How many live tasks the families hold: each live task once, never a code task drawn only for its follow-ups. */
export const liveCount = (families: readonly LiveFamily[]): number => families.reduce((sum, family) => sum + (family.context ? 0 : 1) + family.followUps.length, 0);

/** The member's own live tasks on Home's panel: the cards they drive, each follow-up under its code task. */
export const yoursLive = (cards: readonly BoardCard[], memberId: string | null): readonly LiveFamily[] => {
  const entries = cards.flatMap((card): LiveEntry[] => {
    if (memberId === null || card.driver?.memberId !== memberId) return [];
    const live = liveFromCard(card);
    return live === null ? [] : [{ live, parentId: live.followUp === null ? null : (card.reviewOf?.taskId ?? null) }];
  });
  const parents = new Map<string, NonNullable<BoardCard["reviewOf"]>>(cards.flatMap((card) => (card.reviewOf === null ? [] : [[card.reviewOf.taskId, card.reviewOf] as const])));
  return nestFollowUps(entries, (taskId) => {
    const card = cards.find((one) => one.taskId === taskId);
    const parent = parents.get(taskId);
    if (card !== undefined) return liveFromCard(card) ?? contextRow({ taskId, key: card.key ?? taskId.slice(-7), title: card.title });
    return parent === undefined ? null : contextRow({ taskId, key: parent.key ?? taskId.slice(-7), title: parent.title });
  });
};

/** The project's live tasks, optionally only the member's (`Mine`), each follow-up under its code task. */
export const projectLive = (groups: RouterOutputs["tasks"]["list"], mine: string | null): readonly LiveFamily[] => {
  const rows = groups.flatMap((group) => group.tasks);
  const entries = rows.flatMap((task): LiveEntry[] => {
    if (mine !== null && task.driver?.memberId !== mine) return [];
    const live = liveFromRow(task);
    return live === null ? [] : [{ live, parentId: live.followUp === null ? null : task.reviewOf }];
  });
  return nestFollowUps(entries, (taskId) => {
    const row = rows.find((one) => one.id === taskId);
    return row === undefined ? null : (liveFromRow(row) ?? contextRow({ taskId, key: row.key, title: row.title }, quietState(row.state)));
  });
};
