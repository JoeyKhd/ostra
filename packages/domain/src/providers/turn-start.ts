import type { mapTask, Tx } from "@ostra/db";
import { leaseEpochSchema, organizationIdSchema, projectIdSchema, sessionIdSchema } from "@ostra/protocol";
import type { ClientMessageId, MemberId, MessageIntent, SessionId, TaskSeq } from "@ostra/protocol";

import type { Ports } from "../ports.ts";
import { moveSessionInTx, moveTaskInTx } from "../use-cases/moves.ts";
import { answerNextTurnItemsInTx } from "../use-cases/needs-you-items.ts";
import { unansweredMessagesInTx } from "../use-cases/reopen.ts";
import { appendServerEvent } from "../use-cases/server-events.ts";
import { endSessionTimersInTx } from "../use-cases/sessions-m2.ts";
import type { SessionTimers } from "../use-cases/sessions-m2.ts";
import type { ProviderGate } from "./resolve.ts";

// A turn start on a going session whose provider changed (F-135, ADR 0065, ticket 48). The caller
// holds the task's lock and ran `sessionProviderGateInTx`. `moved`: the turn starts in a fresh
// session, on the provider the project serves the model from now, and the dispatch gives it a
// fresh box (the kept box holds the old key: F-033's path). `none`: the message is held in the new
// session's thread, and the dispatch leaves the task queued with `no-provider-for-model` and a
// needs-you item for the organization's admins. Never a steer into the old box.

const ACTIVE_SESSION_STATES = ["starting", "running", "waiting", "idle"] as const;

type TaskRow = Pick<
  ReturnType<typeof mapTask>,
  "id" | "organizationId" | "projectId" | "kind" | "state" | "subState" | "needsYouReason" | "stoppedReason" | "leaseEpoch" | "agentProfileId"
>;

export type ProviderRestartDeps = Pick<Ports, "jobs" | "notices" | "clock"> & { readonly timers?: SessionTimers | undefined };

/** The message the turn was for, written as the fresh session's prompt. Never logged. */
export type ProviderRestartMessage = {
  readonly memberId: MemberId;
  readonly clientMessageId: ClientMessageId;
  readonly text: string;
  readonly intent?: MessageIntent | undefined;
};

/** Ends the going session, and starts a fresh one on what the gate says; the message is its first prompt. */
export const restartOnProviderChangeInTx = async (
  deps: ProviderRestartDeps,
  tx: Tx,
  task: TaskRow,
  gate: Exclude<ProviderGate, { readonly kind: "open" }>,
  message: ProviderRestartMessage,
): Promise<{ readonly sessionId: SessionId; readonly seq: TaskSeq }> => {
  const organizationId = organizationIdSchema.parse(task.organizationId);
  const projectId = projectIdSchema.parse(task.projectId);
  const now = deps.clock.now();
  const moveDeps = { tx, notices: deps.notices, jobs: deps.jobs };
  const going = await tx.session.findMany({ where: { taskId: task.id, state: { in: [...ACTIVE_SESSION_STATES] } }, orderBy: [{ startedAt: "desc" }, { id: "desc" }] });
  for (const old of going) {
    await moveSessionInTx(moveDeps, old, { type: "stop" });
    await endSessionTimersInTx(deps, tx, { organizationId, taskId: task.id, sessionId: sessionIdSchema.parse(old.id) });
  }
  await tx.lease.updateMany({ where: { taskId: task.id, state: "active" }, data: { state: "ended", endedAt: new Date(now), endReason: "superseded" } });
  const owed = (await unansweredMessagesInTx(tx, task.id)).filter((owing) => !owing.replayed);
  const created = await tx.session.create({
    data: {
      organizationId,
      projectId,
      taskId: task.id,
      agentProfileId: going[0]?.agentProfileId ?? task.agentProfileId,
      origin: "new",
      state: "starting",
      // `none` records nothing: the dispatch resolves again, and says why the task waits.
      ...(gate.kind === "moved" ? { providerId: gate.providerId, modelId: gate.modelId } : {}),
    },
    select: { id: true },
  });
  const sessionId = sessionIdSchema.parse(created.id);
  for (const owing of owed) {
    await appendServerEvent(tx, {
      organizationId,
      projectId,
      taskId: task.id,
      sessionId,
      at: now,
      event: { kind: "user.message", memberId: owing.memberId, clientMessageId: owing.clientMessageId, text: owing.text, delivery: "queued", replayed: true },
    });
  }
  const seq = await appendServerEvent(tx, {
    organizationId,
    projectId,
    taskId: task.id,
    sessionId,
    at: now,
    event: {
      kind: "user.message",
      memberId: message.memberId,
      clientMessageId: message.clientMessageId,
      text: message.text,
      delivery: "queued",
      ...(message.intent === undefined ? {} : { intent: message.intent }),
    },
  });
  if (task.state === "needs_you") {
    // The message answers what the task waited on, as any send does: its next turn's items close.
    await answerNextTurnItemsInTx(deps, tx, task.id, { at: new Date(now), byMemberId: message.memberId });
  }
  await moveTaskInTx(moveDeps, task, { type: "provider_changed" });
  await deps.jobs.enqueueInTx(tx, "task.dispatch", { organizationId, taskId: task.id, sessionId, leaseEpoch: leaseEpochSchema.parse(task.leaseEpoch + 1) });
  await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: task.id });
  return { sessionId, seq };
};
