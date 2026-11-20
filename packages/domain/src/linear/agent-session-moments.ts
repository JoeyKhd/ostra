import type { DbEnum, Tx } from "@ostra/db";
import { agentActivityIdSchema, agentSessionIdSchema, connectionIdSchema } from "@ostra/protocol";
import type { AgentSessionId, OrganizationId, TaskId } from "@ostra/protocol";

import type { JobQueue } from "../ports.ts";
import { agentSessionCopy } from "./agent-session-copy.ts";
import type { AgentSessionMoment, NeedsYouWords } from "./agent-session-copy.ts";

// A task's moments in its Linear agent session (F-012, ADR 0057, milestone 6's ticket 13): a turn
// started, a PR opened, a needs-you item with its link, stopped, done, failed. Each is written to
// the session's outbox (`AgentActivity`) in the transaction of the move it tells, through the
// domain's copy, so the post commits with the move and a rolled-back move posts nothing. A moment
// that ends the session (stopped, merged, done, failed) is its final response: the session ends in
// the same transaction, the posts still pending before it are dropped, and nothing is posted after.
//
// The panel's address isn't known here: a task link is written as `TASK_URL_TOKEN`, which the
// sender (`linear.activity.send`, which has `OSTRA_PUBLIC_URL`) replaces with the task's page.

/** Stands for the task's page in a body written where the panel's address isn't at hand. */
export const TASK_URL_TOKEN = "{{ostra-task-url}}";

/** A body with its task link filled in. */
export const withTaskUrl = (body: string, taskUrl: string): string =>
  body.replaceAll(TASK_URL_TOKEN, taskUrl);

/** A moment told each time it happens: its key is the session's count of posts so far. */
export const NEXT_KEY = "next";

/** The key prefix of a heartbeat's activity: the sender gives a failed one up after 5 minutes. */
export const HEARTBEAT_KEY_PREFIX = "heartbeat:";

/** How long a heartbeat that fails is retried (ticket 13): a later one replaces it anyway. */
export const HEARTBEAT_RETRY_MS = 5 * 60_000;

/** A needs-you reason as the session's elicitation words it: ostra's words, never the item's text. */
export const needsYouWordsOf = (reason: DbEnum.NeedsYouReason): NeedsYouWords => {
  switch (reason) {
    case "question":
      return "question";
    case "approval":
      return "approval";
    case "plan":
      return "plan";
    case "no_changes":
    case "files_outside_repos":
      return "no-changes";
    case "stalled":
      return "stalled";
    case "spend_cap":
      return "spend-cap";
    case "crashed":
    case "unstorable_event":
    case "restore_conflict":
      return "crashed";
    case "setup_failed":
      return "setup-failed";
    case "round_cap":
      return "round-cap";
    case "waiting_for_reviewer":
      return "review";
    case "ticket_closed":
    case "draft_ready":
    case "environment_proposal":
    case "awaiting_approval":
    case "no_provider_for_model":
    case "runner_awaiting_approval":
      return "other";
    default:
      return reason satisfies never;
  }
};

/** A task's state after a move, as the moments read it. */
export type MovedTask = {
  readonly state: DbEnum.TaskState;
  readonly needsYouReason: DbEnum.NeedsYouReason | null;
  readonly stoppedReason: DbEnum.TaskStopReason | null;
};

/** What a move tells the session, if anything, and whether it's the session's final word. */
export type MomentOfMove = {
  readonly moment: AgentSessionMoment;
  readonly final: boolean;
  readonly key: string;
};

/**
 * The moment a move from `from` to `to` tells: a turn started (into `running`), a needs-you item
 * (into `needs_you`), the work handed in (into `in_review`), done (`merged`, `done`), stopped or
 * failed. A rejection (`stopped`, `rejected`) is told by the answer itself (ticket 14), and a stop
 * from Linear ends the session before the task moves, so neither is told here.
 */
export const momentOfMove = (
  from: DbEnum.TaskState,
  to: MovedTask,
  counts: { readonly turns: number; readonly pullRequests: number },
): MomentOfMove | null => {
  if (from === to.state) {
    return null;
  }
  switch (to.state) {
    case "running":
      return {
        moment: { kind: "working", turn: Math.max(1, counts.turns) },
        final: false,
        key: NEXT_KEY,
      };
    case "needs_you":
      return to.needsYouReason === null
        ? null
        : {
            moment: {
              kind: "needs-you",
              reason: needsYouWordsOf(to.needsYouReason),
              taskUrl: TASK_URL_TOKEN,
            },
            final: false,
            key: NEXT_KEY,
          };
    case "in_review":
      return {
        moment: { kind: "done", pullRequests: counts.pullRequests, taskUrl: TASK_URL_TOKEN },
        final: false,
        key: NEXT_KEY,
      };
    case "merged":
    case "done":
      return {
        moment: { kind: "done", pullRequests: counts.pullRequests, taskUrl: TASK_URL_TOKEN },
        final: true,
        key: NEXT_KEY,
      };
    case "stopped":
      switch (to.stoppedReason) {
        case "rejected":
          return null;
        case "requested":
        case "cancelled":
        case "prs_closed":
        case null:
          return {
            moment: { kind: "stopped-in-ostra", taskUrl: TASK_URL_TOKEN },
            final: true,
            key: NEXT_KEY,
          };
        case "runner_lost":
        case "spend_cap":
        case "runaway":
          return {
            moment: { kind: "failed", taskUrl: TASK_URL_TOKEN },
            final: true,
            key: NEXT_KEY,
          };
        default:
          return to.stoppedReason satisfies never;
      }
    case "awaiting_approval":
    case "queued":
    case "preparing":
      return null;
    default:
      return to.state satisfies never;
  }
};

/** The task's open agent session, locked for this transaction: the one its moments go to. */
const openSessionOfTaskInTx = async (
  tx: Tx,
  organizationId: OrganizationId,
  taskId: TaskId,
): Promise<{ readonly id: AgentSessionId; readonly connectionId: string } | null> => {
  const rows = await tx.$queryRaw<
    readonly { readonly id: string; readonly connectionId: string }[]
  >`
    SELECT "id", "connectionId" FROM "agent_session"
    WHERE "organizationId" = ${organizationId} AND "taskId" = ${taskId} AND "state" <> 'ended'
    ORDER BY "createdAt" DESC LIMIT 1 FOR UPDATE`;
  const [row] = rows;
  return row === undefined
    ? null
    : { id: agentSessionIdSchema.parse(row.id), connectionId: row.connectionId };
};

/**
 * Writes one moment to the task's open session, in the caller's transaction, under its key: a
 * replayed moment posts nothing twice. `final` ends the session with it: the posts still pending
 * are dropped, so this is the last word the session hears. `false` when the task has no open session.
 */
export const recordAgentSessionMomentInTx = async (
  deps: { readonly jobs: JobQueue },
  tx: Tx,
  input: {
    readonly organizationId: OrganizationId;
    readonly taskId: TaskId;
    readonly moment: AgentSessionMoment;
    /**
     * What makes this moment's post unique in the session (a PR's number), so a replay posts it
     * once; `next` for a moment told each time it happens (a move: its replay is refused anyway).
     */
    readonly key: string;
    readonly final: boolean;
    readonly at: number;
  },
): Promise<boolean> => {
  const session = await openSessionOfTaskInTx(tx, input.organizationId, input.taskId);
  if (session === null) {
    return false;
  }
  return writeMomentToSessionInTx(deps, tx, {
    organizationId: input.organizationId,
    agentSessionId: session.id,
    connectionId: session.connectionId,
    moment: input.moment,
    key: input.key,
    final: input.final,
    at: input.at,
  });
};

/** Writes one moment to a session the caller already holds (it locked or created the row). */
export const writeMomentToSessionInTx = async (
  deps: { readonly jobs: JobQueue },
  tx: Tx,
  input: {
    readonly organizationId: OrganizationId;
    readonly agentSessionId: AgentSessionId;
    readonly connectionId: string;
    readonly moment: AgentSessionMoment;
    /** As `recordAgentSessionMomentInTx`'s. */
    readonly key: string;
    readonly final: boolean;
    readonly at: number;
  },
): Promise<boolean> => {
  const key =
    input.key === NEXT_KEY
      ? `n${String(await tx.agentActivity.count({ where: { agentSessionId: input.agentSessionId } }))}`
      : input.key;
  const copy = agentSessionCopy(input.moment);
  const idempotencyKey = `agent-activity:${input.agentSessionId}:${input.moment.kind}:${key}`;
  if (input.final) {
    // The final word: what was still waiting to go out would land after it, so it's dropped.
    await tx.agentActivity.updateMany({
      where: { agentSessionId: input.agentSessionId, state: "pending" },
      data: { state: "failed" },
    });
  }
  const created = await tx.agentActivity.createManyAndReturn({
    data: [
      {
        organizationId: input.organizationId,
        agentSessionId: input.agentSessionId,
        kind: copy.kind,
        ephemeral: copy.ephemeral,
        body: copy.body,
        idempotencyKey,
      },
    ],
    skipDuplicates: true,
    select: { id: true },
  });
  for (const row of created) {
    await deps.jobs.enqueueInTx(
      tx,
      "linear.activity.send",
      {
        organizationId: input.organizationId,
        agentActivityId: agentActivityIdSchema.parse(row.id),
      },
      // Throttled per connection: Linear's rate limit is the install's (ADR 0037).
      { group: { id: connectionIdSchema.parse(input.connectionId) } },
    );
  }
  if (input.final) {
    await tx.agentSession.updateMany({
      where: { id: input.agentSessionId, state: { not: "ended" } },
      data: { state: "ended", endedAt: new Date(input.at) },
    });
  }
  return created.length > 0;
};
