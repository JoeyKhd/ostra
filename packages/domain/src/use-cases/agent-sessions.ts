import type { Tx } from "@ostra/db";
import { agentActivityIdSchema, agentSessionIdSchema, connectionIdSchema } from "@ostra/protocol";
import type { AgentActivityId, AgentSessionId, OrganizationId, TaskId } from "@ostra/protocol";

import { agentSessionCopy } from "../linear/agent-session-copy.ts";
import type { AgentActivityCopy, AgentSessionMoment } from "../linear/agent-session-copy.ts";
import { transitionAgentSession } from "../lifecycles/m6.ts";
import type { AgentSessionEnd, AgentSessionInput, AgentSessionLifecycle } from "../lifecycles/m6.ts";
import type { JobQueue } from "../ports.ts";
import type { PostAgentActivity } from "./m6-signatures.ts";

// A Linear agent session's outbox (F-012, ADR 0057, ADR 0013): every post is an `AgentActivity`
// row with its idempotency key, written in the transaction of the moment it tells, and sent by
// `linear.activity.send` with the app's own token. The body is ostra's own words from
// `agentSessionCopy`, never agent output. The heartbeat's clock moves when a post is sent (core's
// sender), so a session that hears from ostra gets no heartbeat on top.

/** The session's lifecycle, from its row. `ended` keeps no reason in the row: `task-ended` stands for any. */
export const agentSessionFromRow = (row: { readonly state: "active" | "awaiting_approval" | "ended"; readonly endedAt: Date | null }): AgentSessionLifecycle => {
  switch (row.state) {
    case "active":
      return { state: "active" };
    case "awaiting_approval":
      return { state: "awaiting_approval" };
    case "ended":
      return { state: "ended", at: row.endedAt?.getTime() ?? 0, why: "task-ended" };
    default:
      return row.state satisfies never;
  }
};

/**
 * Moves a session by its lifecycle, in the caller's transaction; `true` when it moved. The update
 * is conditional on the state it read, so two writers can't both move it.
 */
export const moveAgentSessionInTx = async (tx: Tx, agentSessionId: AgentSessionId, input: AgentSessionInput): Promise<boolean> => {
  const row = await tx.agentSession.findUnique({ where: { id: agentSessionId }, select: { state: true, endedAt: true } });
  if (row === null) {
    return false;
  }
  const moved = transitionAgentSession(agentSessionFromRow(row), input);
  if (!moved.ok) {
    return false;
  }
  const next = moved.state;
  const updated = await tx.agentSession.updateMany({
    where: { id: agentSessionId, state: row.state },
    data: next.state === "ended" ? { state: "ended", endedAt: new Date(next.at) } : { state: next.state },
  });
  return updated.count === 1;
};

/** Ends a session (a stop, a rejection, its task's end, no board): final, and no heartbeat after. */
export const endAgentSessionInTx = (tx: Tx, agentSessionId: AgentSessionId, why: AgentSessionEnd, at: number): Promise<boolean> =>
  moveAgentSessionInTx(tx, agentSessionId, { type: "end", at, why });

/** Writes one copy to the session's outbox under its key, and owes its send. A replayed key writes nothing. */
export const writeAgentActivityInTx = async (
  deps: { readonly jobs: JobQueue },
  tx: Tx,
  input: { readonly organizationId: OrganizationId; readonly agentSessionId: AgentSessionId; readonly copy: AgentActivityCopy; readonly idempotencyKey: string },
): Promise<{ readonly agentActivityId: AgentActivityId; readonly created: boolean }> => {
  const session = await tx.agentSession.findFirst({ where: { id: input.agentSessionId, organizationId: input.organizationId }, select: { connectionId: true } });
  if (session === null) {
    throw new Error("writeAgentActivityInTx: no such agent session in the organization");
  }
  const created = await tx.agentActivity.createManyAndReturn({
    data: [
      {
        organizationId: input.organizationId,
        agentSessionId: input.agentSessionId,
        kind: input.copy.kind,
        ephemeral: input.copy.ephemeral,
        body: input.copy.body,
        idempotencyKey: input.idempotencyKey,
      },
    ],
    skipDuplicates: true,
    select: { id: true },
  });
  const [row] = created;
  if (row === undefined) {
    const existing = await tx.agentActivity.findUniqueOrThrow({
      where: { organizationId_idempotencyKey: { organizationId: input.organizationId, idempotencyKey: input.idempotencyKey } },
      select: { id: true },
    });
    return { agentActivityId: agentActivityIdSchema.parse(existing.id), created: false };
  }
  const agentActivityId = agentActivityIdSchema.parse(row.id);
  // Throttled per connection: Linear's rate limit is the install's (ADR 0037).
  await deps.jobs.enqueueInTx(
    tx,
    "linear.activity.send",
    { organizationId: input.organizationId, agentActivityId },
    { group: { id: connectionIdSchema.parse(session.connectionId) } },
  );
  return { agentActivityId, created: true };
};

/** `postAgentActivity`: a moment's copy, in the outbox under its key. */
export const postAgentActivity: PostAgentActivity = (deps, input) =>
  writeAgentActivityInTx(deps, deps.tx, {
    organizationId: input.organizationId,
    agentSessionId: input.agentSessionId,
    copy: agentSessionCopy(input.moment),
    idempotencyKey: input.idempotencyKey,
  });

/** The task's open agent session, if it has one: the session its moments are posted to. */
export const openAgentSessionOfTaskInTx = async (
  tx: Tx,
  organizationId: OrganizationId,
  taskId: TaskId,
): Promise<{ readonly agentSessionId: AgentSessionId; readonly state: "active" | "awaiting_approval" } | null> => {
  const row = await tx.agentSession.findFirst({
    where: { organizationId, taskId, state: { not: "ended" } },
    orderBy: { createdAt: "desc" },
    select: { id: true, state: true },
  });
  if (row === null || row.state === "ended") {
    return null;
  }
  return { agentSessionId: agentSessionIdSchema.parse(row.id), state: row.state };
};

/** An activity's idempotency key for one moment of one task's session: replaying the moment posts nothing twice. */
export const momentActivityKey = (agentSessionId: AgentSessionId, moment: AgentSessionMoment["kind"], discriminator = ""): string =>
  `agent-activity:${agentSessionId}:${moment}${discriminator === "" ? "" : `:${discriminator}`}`;
