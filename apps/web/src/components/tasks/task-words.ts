import type { TaskActivity } from "@ostra/task-view";

import type { Tone } from "@/components/ui/status";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// A task's state and what its agent is doing, in the panel's words (domain-model.md).

export type TaskState = RouterOutputs["tasks"]["get"]["state"];
export type TaskGroup = RouterOutputs["tasks"]["list"][number]["group"];
type Doing = NonNullable<RouterOutputs["tasks"]["list"][number]["tasks"][number]["doing"]>;

export const taskStateText = (state: TaskState): string => {
  switch (state) {
    case "queued":
      return t("taskState.queued");
    case "preparing":
      return t("taskState.preparing");
    case "running":
      return t("taskState.running");
    case "awaiting_approval":
      return t("taskState.awaitingApproval");
    case "needs_you":
      return t("taskState.needsYou");
    case "in_review":
      return t("taskState.inReview");
    case "stopped":
      return t("taskState.stopped");
    case "merged":
      return t("taskState.merged");
    case "done":
      return t("taskState.done");
    default:
      return state satisfies never;
  }
};

type TaskReason = RouterOutputs["tasks"]["get"]["reason"];

/** The reasons the thread itself shows as an amber block: the header names them, without a note. */
export const shownInThread = (reason: TaskReason): boolean => reason === "approval" || reason === "question";

/**
 * A task's state for its header and properties (task.md, "Header status line"): needs-you states
 * name what waits when it's an approval or a question, `Needs you · approval`.
 */
export const taskStateLine = (state: TaskState, reason: TaskReason): string => {
  if (state === "needs_you" && reason === "approval") return t("taskState.needsYouApproval");
  if (state === "needs_you" && reason === "question") return t("taskState.needsYouQuestion");
  return taskStateText(state);
};

/** Activity that only repeats the state (waiting on an approval or an answer) isn't said twice. */
export const headerActivity = (activity: TaskActivity): string =>
  activity.kind === "waiting-approval" || activity.kind === "waiting-answer" ? "" : activityText(activity);

/** Amber means only "needs you" (app-design.md, the colour table). */
export const stateTone = (state: TaskState): Tone => {
  switch (state) {
    case "needs_you":
    case "awaiting_approval":
      return "amber";
    case "running":
    case "preparing":
      return "teal";
    case "in_review":
    case "merged":
    case "done":
      return "green";
    case "queued":
    case "stopped":
      return "grey";
    default:
      return state satisfies never;
  }
};

export const groupText = (group: TaskGroup): string => {
  switch (group) {
    case "needs-you":
      return t("taskGroup.needsYou");
    case "running":
      return t("taskGroup.running");
    case "queued":
      return t("taskGroup.queued");
    case "in-review":
      return t("taskGroup.inReview");
    case "finished":
      return t("taskGroup.finished");
    default:
      return group satisfies never;
  }
};

/** What the agent is doing now, from the fold's derived state (the task page). */
export const activityText = (activity: TaskActivity): string => {
  switch (activity.kind) {
    case "idle":
      return "";
    case "setting-up":
      return t("doing.settingUp");
    case "setup-failed":
      return t("doing.setupFailed");
    case "thinking":
      return t("doing.thinking");
    case "writing":
      return t("doing.writing");
    case "tool":
      return t("doing.tool", { title: activity.title });
    case "waiting-approval":
      return t("doing.waitingApproval");
    case "waiting-answer":
      return t("doing.waitingAnswer");
    case "stopping":
      return t("doing.stopping");
    case "turn-ended":
      return activity.stopReason === "cancelled" ? t("doing.stopped") : t("doing.turnEnded");
    case "turn-failed":
      return t("doing.turnFailed");
    case "crashed":
      return t("doing.crashed");
    case "runner-lost":
      return t("doing.runnerLost");
    case "session-ended":
      return activity.outcome === "with-changes" ? t("doing.endedWithChanges") : t("doing.endedWithoutChanges");
    default:
      return activity satisfies never;
  }
};

/** What the agent is doing now, from the list's latest event (the task list). */
export const doingText = (doing: Doing | null): string => {
  if (doing === null) return "";
  switch (doing.kind) {
    case "tool.called":
      return t("doing.tool", { title: doing.detail ?? "" });
    case "agent.message":
      return t("doing.writing");
    case "agent.thought":
      return t("doing.thinking");
    case "environment.setup_started":
    case "environment.setup_output":
      return t("doing.settingUp");
    case "approval.requested":
      return t("doing.waitingApproval");
    case "question.asked":
      return t("doing.waitingAnswer");
    case "git.pushed":
      return t("doing.pushing");
    default:
      return doing.kind satisfies never;
  }
};
