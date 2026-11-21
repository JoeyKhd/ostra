import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// A row of a project's task list (project.md): its mark and its "doing now" column, in words.

export type TaskRow = RouterOutputs["tasks"]["list"][number]["tasks"][number];
type NeedsYouReason = NonNullable<TaskRow["needsYouReason"]>;
type StopReason = NonNullable<TaskRow["stoppedReason"]>;
type PrState = TaskRow["prs"][number]["state"];

/** A run of "doing now" text: plain (`--muted`), `code` (a command or path, mono `--text`) or `strong` (`--text`). */
export type Segment = { readonly text: string; readonly style: "plain" | "code" | "strong" };

const plain = (text: string): Segment => ({ text, style: "plain" });

/** The mark at the start of a row: the band already names the state, so only its dot or icon. */
export type TaskMark = "amber" | "green" | "preparing" | "queued" | "review" | "stopped" | "merged" | "done";

export const taskMark = (state: TaskRow["state"]): TaskMark => {
  switch (state) {
    case "awaiting_approval":
    case "needs_you":
      return "amber";
    case "running":
      return "green";
    case "preparing":
      return "preparing";
    case "queued":
      return "queued";
    case "in_review":
      return "review";
    case "stopped":
      return "stopped";
    case "merged":
      return "merged";
    case "done":
      return "done";
    default:
      return state satisfies never;
  }
};

export const needsYouReasonText = (reason: NeedsYouReason): string => {
  switch (reason) {
    case "question":
      return t("tasks.needsYouReason.question");
    case "approval":
      return t("tasks.needsYouReason.approval");
    case "plan":
      return t("tasks.needsYouReason.plan");
    case "no_changes":
      return t("tasks.needsYouReason.noChanges");
    case "stalled":
      return t("tasks.needsYouReason.stalled");
    case "spend_cap":
      return t("tasks.needsYouReason.spendCap");
    case "crashed":
      return t("tasks.needsYouReason.crashed");
    case "setup_failed":
      return t("tasks.needsYouReason.setupFailed");
    case "ticket_closed":
      return t("tasks.needsYouReason.ticketClosed");
    case "draft_ready":
      return t("tasks.needsYouReason.draftReady");
    case "round_cap":
      return t("tasks.needsYouReason.roundCap");
    case "waiting_for_reviewer":
      return t("tasks.needsYouReason.waitingForReviewer");
    case "environment_proposal":
      return t("tasks.needsYouReason.environmentProposal");
    case "restore_conflict":
      return t("tasks.needsYouReason.restoreConflict");
    case "unstorable_event":
      return t("tasks.needsYouReason.unstorableEvent");
    case "files_outside_repos":
      return t("tasks.needsYouReason.filesOutsideRepos");
    case "no_provider_for_model":
      return t("tasks.needsYouReason.noProviderForModel");
    case "runner_awaiting_approval":
      return t("tasks.needsYouReason.runnerAwaitingApproval");
    case "awaiting_approval":
      return t("tasks.needsYouReason.awaitingApproval");
    default:
      return reason satisfies never;
  }
};

export const stopReasonText = (reason: StopReason): string => {
  switch (reason) {
    case "requested":
      return t("tasks.stopReason.requested");
    case "rejected":
      return t("tasks.stopReason.rejected");
    case "prs_closed":
      return t("tasks.stopReason.prsClosed");
    case "runner_lost":
      return t("tasks.stopReason.runnerLost");
    case "spend_cap":
      return t("tasks.stopReason.spendCap");
    case "runaway":
      return t("tasks.stopReason.runaway");
    case "cancelled":
      return t("tasks.stopReason.cancelled");
    default:
      return reason satisfies never;
  }
};

const prStateText = (state: PrState): string => {
  switch (state) {
    case "no_branch":
      return t("tasks.prState.noBranch");
    case "branch_pushed":
      return t("tasks.prState.branchPushed");
    case "pr_open":
      return t("tasks.prState.open");
    case "merged":
      return t("tasks.prState.merged");
    case "closed_unmerged":
      return t("tasks.prState.closed");
    default:
      return state satisfies never;
  }
};

/** The verb for a tool call whose detail is its command or path. */
const verbOf = (toolKind: NonNullable<TaskRow["doing"]>["toolKind"]): string | null => {
  if (toolKind === "execute") return t("tasks.row.running");
  if (toolKind === "edit") return t("tasks.row.editing");
  if (toolKind === "read") return t("tasks.row.reading");
  return null;
};

/** A tool call as a verb and its command or path, or its title alone. */
const toolSegments = (doing: NonNullable<TaskRow["doing"]>): readonly Segment[] => {
  if (doing.detail === null) return [];
  const verb = verbOf(doing.toolKind);
  return verb === null ? [plain(doing.detail)] : [plain(`${verb} `), { text: doing.detail, style: "code" }];
};

/** What waits on the member: the approval's command or the question, else the reason. */
const needsYouSegments = (task: TaskRow): readonly Segment[] => {
  const { doing } = task;
  if (doing?.kind === "approval.requested" && doing.detail !== null) {
    return [plain(`${t("tasks.row.approval")} `), { text: doing.detail, style: "code" }];
  }
  if (doing?.kind === "question.asked" && doing.detail !== null) {
    return [plain(`${t("tasks.row.question")} ${doing.detail}`)];
  }
  if (task.needsYouReason !== null) return [plain(needsYouReasonText(task.needsYouReason))];
  return [plain(doing?.kind === "question.asked" ? t("doing.waitingAnswer") : t("doing.waitingApproval"))];
};

/** What the agent is doing now, from its latest event (the shell's live rows use it too). */
export const runningSegments = (doing: TaskRow["doing"]): readonly Segment[] => {
  if (doing === null) return [];
  switch (doing.kind) {
    case "tool.called":
      return toolSegments(doing);
    case "agent.message":
      return [plain(t("doing.writing"))];
    case "agent.thought":
      return [plain(t("doing.thinking"))];
    case "environment.setup_started":
    case "environment.setup_output":
      return [plain(t("doing.settingUp"))];
    case "approval.requested":
      return [plain(t("doing.waitingApproval"))];
    case "question.asked":
      return [plain(t("doing.waitingAnswer"))];
    case "git.pushed":
      return [plain(t("doing.pushing"))];
    default:
      return doing.kind satisfies never;
  }
};

/** The row's "doing now" column (project.md, "States and copy"). */
export const doingNow = (task: TaskRow): readonly Segment[] => {
  switch (task.state) {
    case "awaiting_approval":
      return [plain(t("tasks.row.awaitingStart"))];
    case "needs_you":
      return needsYouSegments(task);
    case "running":
      return runningSegments(task.doing);
    case "preparing":
      return [plain(t("tasks.row.preparing"))];
    case "queued":
      return [plain(t("tasks.row.queued"))];
    case "in_review":
      return task.prs.flatMap((pr, i) => [
        ...(i > 0 ? [plain(", ")] : []),
        plain(`${t("tasks.row.pr")} `),
        { text: `#${String(pr.number)}`, style: "strong" as const },
        plain(` · ${prStateText(pr.state)}`),
      ]);
    case "stopped":
      return task.stoppedReason === null ? [plain(t("taskState.stopped"))] : [plain(t("tasks.row.stopped", { reason: stopReasonText(task.stoppedReason) }))];
    case "merged":
      return [plain(t("tasks.row.merged"))];
    case "done":
      return [plain(t("tasks.row.done"))];
    default:
      return task.state satisfies never;
  }
};

/** The lede's counts: what waits on the member and what runs, each left out at 0. */
export const ledeCounts = (needsYou: number, running: number): readonly string[] => [
  ...(needsYou > 0 ? [t("tasks.waitingOnYou", { n: needsYou })] : []),
  ...(running > 0 ? [t("tasks.runningCount", { n: running })] : []),
];
