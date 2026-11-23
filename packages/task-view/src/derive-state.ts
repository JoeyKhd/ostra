import type {
  ApprovalId,
  EffortLevel,
  MemberId,
  QuestionId,
  RepoId,
  SessionOutcome,
  StopReason,
  StoredEvent,
  ToolCallId,
  ToolKind,
} from "@ostra/protocol";

import type { PullRequestData, TokenCounts } from "./ui-types.ts";

// What the agent is doing now, derived from the same events every viewer folds, so every viewer
// and the task list agree (ADR 0036). Pure. Ported from spikes/live-stream-and-task-view
// (`deriveTaskState`), widened to milestone 1's events.

/** One line for the task list's "doing now" column. */
export type TaskActivity =
  | { readonly kind: "idle" }
  | { readonly kind: "setting-up" }
  | { readonly kind: "setup-failed"; readonly exitCode: number | null }
  | { readonly kind: "thinking" }
  | { readonly kind: "writing" }
  | { readonly kind: "tool"; readonly toolKind: ToolKind; readonly title: string }
  | { readonly kind: "waiting-approval" }
  | { readonly kind: "waiting-answer" }
  | { readonly kind: "stopping" }
  | { readonly kind: "turn-ended"; readonly stopReason: StopReason }
  | { readonly kind: "turn-failed"; readonly error: string }
  | { readonly kind: "crashed"; readonly error: string }
  | { readonly kind: "runner-lost" }
  | { readonly kind: "session-ended"; readonly outcome: SessionOutcome };

export type TaskViewState = {
  readonly headSeq: number;
  readonly turnRunning: boolean;
  readonly activity: TaskActivity;
  readonly driverMemberId: MemberId | null;
  readonly pendingApprovalIds: readonly ApprovalId[];
  readonly openQuestionIds: readonly QuestionId[];
  /** The key proxy's counts over the whole task (F-089). */
  readonly tokens: TokenCounts;
  /** The agent's latest context figure: the context meter only. */
  readonly context: { readonly used: number; readonly size: number } | null;
  readonly pullRequests: readonly PullRequestData[];
  /** The latest branch push per repo, not counting the hidden ref. */
  readonly branches: readonly {
    readonly repoId: RepoId;
    readonly branch: string;
    readonly headSha: string;
  }[];
  readonly lastOutcome: SessionOutcome | null;
  /** F-137: the task's level after its last `effort.changed`, or `null` when nobody changed it. */
  readonly effort: EffortLevel | null;
  /** F-137: the running turn's level (`default` when it sent none), or `null` while no turn runs. */
  readonly runningEffort: EffortLevel | null;
  /** F-137: the reasoning tokens over the whole task, inside `tokens.outputTokens`. */
  readonly reasoningTokens: number;
};

export type DeriveOptions = {
  /** The task's driver before the first `driver.changed` in `events`. */
  readonly initialDriver?: MemberId | null;
};

const zeroTokens: TokenCounts = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estimated: false,
};

export const deriveTaskState = (
  events: readonly StoredEvent[],
  options: DeriveOptions = {},
): TaskViewState => {
  let driver = options.initialDriver ?? null;
  let running = false;
  let head = 0;
  let activity: TaskActivity = { kind: "idle" };
  let tokens = zeroTokens;
  let context: TaskViewState["context"] = null;
  let lastOutcome: SessionOutcome | null = null;
  let effort: EffortLevel | null = null;
  let runningEffort: EffortLevel | null = null;
  let reasoningTokens = 0;
  const approvals = new Set<ApprovalId>();
  const questions = new Set<QuestionId>();
  const openTools = new Map<ToolCallId, { toolKind: ToolKind; title: string }>();
  const prs = new Map<string, PullRequestData>();
  const prTitles = new Map<RepoId, string>();
  const branches = new Map<RepoId, { repoId: RepoId; branch: string; headSha: string }>();

  // While a tool runs, approvals or questions are open, those win over the last text.
  const current = (fallback: TaskActivity): TaskActivity => {
    if (approvals.size > 0) return { kind: "waiting-approval" };
    if (questions.size > 0) return { kind: "waiting-answer" };
    const tool = [...openTools.values()].at(-1);
    if (tool !== undefined) return { kind: "tool", toolKind: tool.toolKind, title: tool.title };
    return fallback;
  };

  for (const { seq, event } of events) {
    head = Math.max(head, seq);
    switch (event.kind) {
      case "driver.changed":
        driver = event.memberId;
        break;
      case "environment.setup_started":
      case "environment.setup_output":
        activity = { kind: "setting-up" };
        break;
      case "environment.setup_finished":
        activity =
          event.exitCode === 0
            ? { kind: "idle" }
            : { kind: "setup-failed", exitCode: event.exitCode };
        break;
      case "turn.started":
        running = true;
        runningEffort = event.effort ?? "default";
        openTools.clear();
        activity = { kind: "thinking" };
        break;
      case "turn.ended":
        running = false;
        openTools.clear();
        activity = { kind: "turn-ended", stopReason: event.stopReason };
        break;
      case "turn.failed":
        running = false;
        openTools.clear();
        activity = { kind: "turn-failed", error: event.error };
        break;
      case "turn.cancel_requested":
        if (running) activity = { kind: "stopping" };
        break;
      case "agent.thought":
        if (running) activity = current({ kind: "thinking" });
        break;
      case "agent.message":
      case "agent.content":
        if (running) activity = current({ kind: "writing" });
        break;
      case "tool.called":
        openTools.set(event.toolCallId, { toolKind: event.toolKind, title: event.title });
        if (running) activity = current({ kind: "thinking" });
        break;
      case "tool.completed":
      case "tool.failed":
        openTools.delete(event.toolCallId);
        if (running) activity = current({ kind: "thinking" });
        break;
      case "approval.requested":
        approvals.add(event.approvalId);
        activity = current(activity);
        break;
      case "approval.answered":
      case "approval.auto_answered":
      case "approval.closed":
        approvals.delete(event.approvalId);
        if (running) activity = current({ kind: "thinking" });
        break;
      case "question.asked":
        questions.add(event.questionId);
        activity = current(activity);
        break;
      case "question.answered":
      case "question.closed":
        questions.delete(event.questionId);
        if (running) activity = current({ kind: "thinking" });
        break;
      case "usage.recorded":
        reasoningTokens += event.reasoningTokens ?? 0;
        tokens = {
          inputTokens: tokens.inputTokens + event.inputTokens,
          outputTokens: tokens.outputTokens + event.outputTokens,
          cacheReadTokens: tokens.cacheReadTokens + event.cacheReadTokens,
          cacheWriteTokens: tokens.cacheWriteTokens + event.cacheWriteTokens,
          estimated: tokens.estimated || event.estimated,
        };
        break;
      case "session.usage":
        context = { used: event.contextUsed, size: event.contextSize };
        break;
      case "git.pushed":
        if (!event.ref.startsWith("refs/ostra/")) {
          branches.set(event.repoId, {
            repoId: event.repoId,
            branch: event.branch,
            headSha: event.headSha,
          });
        }
        break;
      case "pr.text_set":
        prTitles.set(event.repoId, event.title);
        break;
      case "pr.opened": {
        const title = prTitles.get(event.repoId);
        prs.set(`${event.repoId}:${String(event.number)}`, {
          repoId: event.repoId,
          url: event.url,
          number: event.number,
          ...(title === undefined ? {} : { title }),
        });
        break;
      }
      case "session.ended":
        running = false;
        lastOutcome = event.outcome;
        activity = { kind: "session-ended", outcome: event.outcome };
        break;
      case "session.crashed":
        running = false;
        activity = { kind: "crashed", error: event.error };
        break;
      case "runner.lost":
        activity = { kind: "runner-lost" };
        break;
      case "runner.connected":
      case "session.restored":
        if (activity.kind === "runner-lost")
          activity = running ? current({ kind: "thinking" }) : { kind: "idle" };
        break;
      case "effort.changed":
        effort = event.to;
        break;
      case "session.saved":
      case "session.limit_reached":
      case "ticket.files_ready":
      case "workspace.files_outside_repos":
      case "plan.proposed":
      case "plan.answered":
      case "check.started":
      case "check.finished":
      case "snapshot.built":
      case "snapshot.failed":
      case "service.healthy":
      case "service.failed":
      case "diff.comments_sent":
      case "ticket.closed":
      case "pr.comment_received":
      case "memory.used":
      case "memory.proposed":
      case "turn.held":
      case "turn.released":
      case "review.check_updated":
      case "pr.related_updated":
      case "box.waiting":
      case "box.scheduled":
      case "task.cancelled":
      case "runner.drained":
      case "runner.resumed":
      case "question.auto_answered":
      case "commit.filtered":
      case "automation.started":
      case "task.approval_requested":
      case "task.approved":
      case "task.rejected":
      case "tracker.session_event":
      case "draft.submitted":
      case "draft.applied":
      case "ci.updated":
      case "round.started":
      case "round.capped":
      case "review.submitted":
      case "review.posted":
      case "reviewers.updated":
      case "environment.proposed":
      case "subagent.started":
      case "subagent.status":
      case "app.process":
      case "app.browser":
      case "attachment.added":
      case "attachment.skipped":
      case "preview.list":
      case "preview.dropped":
      case "preview.opened":
      case "preview.closed":
      case "preview.level_changed":
      case "preview.link_created":
      case "preview.link_revoked":
      case "app.started_by":
      case "files.written":
      case "box.lost":
      case "ticket.context_read":
      case "user.message":
      case "tool.progress":
      case "plan.updated":
      case "compaction.updated":
      case "session.config_changed":
      case "provider.rate_limited":
      case "agent.unknown":
      case "unsupported":
        break;
      case "egress.blocked":
        // Post-v1 (F-052): a refused destination is bookkeeping; it changes no state.
        break;
      default:
        event satisfies never;
    }
  }

  return {
    headSeq: head,
    turnRunning: running,
    activity,
    driverMemberId: driver,
    pendingApprovalIds: [...approvals],
    openQuestionIds: [...questions],
    tokens,
    context,
    pullRequests: [...prs.values()],
    branches: [...branches.values()],
    lastOutcome,
    effort,
    runningEffort: running ? runningEffort : null,
    reasoningTokens,
  };
};
