import type { Tx } from "@ostra/db";
import { mapTask } from "@ostra/db";
import { organizationIdSchema, projectIdSchema, runnerIdSchema, runnerLimits, sessionIdSchema } from "@ostra/protocol";
import type { ClientMessageId, MessageIntent, SessionId, TaskId, TaskSeq } from "@ostra/protocol";

import { requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import type { Ports } from "../ports.ts";
import type { UseCaseResult } from "./common.ts";
import { moveTaskInTx } from "./moves.ts";
import { reopenTask } from "./reopen.ts";
import type { ReopenTaskResult } from "./reopen.ts";
import { appendServerEvent } from "./server-events.ts";
import type { SessionTimers } from "./sessions-m2.ts";
import type { SpendCapSettings } from "./spend.ts";

// A member message ostra renders for a panel action or a PR comment (milestone 3: diff comments,
// "Update branch", "Ask the agent to fix", "Keep working", `@ostra`), sent as the composer sends
// (ADR 0036): to a session that's going, a steer the runner delivers after the turn (or at once,
// where the agent steers mid-turn); with no session going, a reopen (milestone 2's `reopenTask`),
// which writes the message as the new session's first prompt. The text is never logged.
//
// Who may send to a session that's going: the driver, for the panel's actions (anyone else is told
// "Take over to send", ADR 0036). An `@ostra` comment is queued whoever drives (`anyone`), and the
// member who wrote it is credited for what follows.

export type SendMemberMessageDeps = Pick<Ports, "jobs" | "outbox" | "notices" | "audit" | "clock"> & {
  readonly spendCap?: SpendCapSettings | undefined;
  readonly timers?: SessionTimers | undefined;
};

export type SendMemberMessageInput = {
  readonly taskId: TaskId;
  /** Fixed by what the message is for, so the same action sent twice is applied once. */
  readonly clientMessageId: ClientMessageId;
  /** Rendered by the domain's prompts: never logged. */
  readonly text: string;
  readonly intent: MessageIntent;
  /** `driver`: the panel's actions; `anyone`: a PR comment, queued whoever drives. */
  readonly sender: "driver" | "anyone";
};

export type MemberMessageDelivery = "steer" | "reopen";

export type SendMemberMessageResult = UseCaseResult<
  { readonly delivery: MemberMessageDelivery; readonly sessionId: SessionId; readonly seq: TaskSeq | null; readonly duplicate: boolean },
  "not-found" | "take-over-to-send" | Exclude<ReopenTaskResult, { readonly ok: true }>["error"]
>;

/** The session states a message is steered into, rather than reopening the task. */
const GOING_SESSION_STATES = ["starting", "running", "waiting", "idle"] as const;

/** A message longer than a steer may carry is cut, so a send never fails on its length. */
const fitText = (text: string): string => (text.length <= runnerLimits.steerTextMaxChars ? text : text.slice(0, runnerLimits.steerTextMaxChars));

/**
 * Sends one member message in the caller's transaction. Takes the task's lock first, so the driver
 * read and the write commit together (ADR 0036's race): a take-over committed first makes the old
 * driver's send refused.
 */
export const sendMemberMessageInTx = async (
  deps: SendMemberMessageDeps,
  tx: Tx,
  scope: MemberScope,
  input: SendMemberMessageInput,
): Promise<SendMemberMessageResult> => {
  const organizationId = scope.organizationId;
  const locked = await tx.$queryRaw<readonly unknown[]>`
    SELECT 1 FROM "task" WHERE "id" = ${input.taskId} AND "organizationId" = ${organizationId} FOR UPDATE`;
  if (locked.length === 0) {
    return { ok: false, error: "not-found", message: "No such task" };
  }
  const task = mapTask(await tx.task.findUniqueOrThrow({ where: { id: input.taskId } }));
  const project = await tx.project.findFirst({ where: { id: task.projectId, organizationId }, select: { id: true, access: true } });
  if (project === null) {
    return { ok: false, error: "not-found", message: "No such task" };
  }
  const access = requireProjectAccess(scope, { id: projectIdSchema.parse(project.id), organizationId, access: project.access }, "read");
  if (!access.ok) {
    return { ok: false, error: "not-found", message: "No such task" };
  }
  // The same message again is the same send.
  const sent = await tx.event.findFirst({
    where: { taskId: task.id, kind: "user.message", payload: { path: ["clientMessageId"], equals: input.clientMessageId } },
    select: { seq: true, sessionId: true, payload: true },
  });
  if (sent !== null) {
    const reopen = typeof sent.payload === "object" && sent.payload !== null && "reopen" in sent.payload;
    return { ok: true, delivery: reopen ? "reopen" : "steer", sessionId: sessionIdSchema.parse(sent.sessionId), seq: null, duplicate: true };
  }
  const text = fitText(input.text);
  const [lease, session] = await Promise.all([
    tx.lease.findFirst({ where: { taskId: task.id, state: "active" }, select: { runnerId: true } }),
    tx.session.findFirst({ where: { taskId: task.id, state: { in: [...GOING_SESSION_STATES] } }, orderBy: { startedAt: "desc" }, select: { id: true } }),
  ]);
  const going = (task.state === "running" || task.state === "needs_you") && lease !== null && session !== null;
  if (!going) {
    const reopened = await reopenTask(
      { tx, scope, jobs: deps.jobs, notices: deps.notices, audit: deps.audit, clock: deps.clock, spendCap: deps.spendCap, timers: deps.timers },
      { taskId: task.id, clientMessageId: input.clientMessageId, text, intent: input.intent },
    );
    if (!reopened.ok) {
      return reopened;
    }
    return { ok: true, delivery: "reopen", sessionId: reopened.sessionId, seq: null, duplicate: false };
  }
  if (input.sender === "driver" && task.driverMemberId !== scope.memberId) {
    return { ok: false, error: "take-over-to-send", message: "Take over to send" };
  }
  const now = deps.clock.now();
  const projectId = projectIdSchema.parse(task.projectId);
  const sessionId = sessionIdSchema.parse(session.id);
  if (task.state === "needs_you") {
    // The message answers what the task waited on, as the composer's send does.
    await moveTaskInTx({ tx, notices: deps.notices }, task, { type: "member_acted", boxWarm: true });
  }
  const seq = await appendServerEvent(tx, {
    organizationId: organizationIdSchema.parse(organizationId),
    projectId,
    taskId: task.id,
    sessionId,
    at: now,
    event: { kind: "user.message", memberId: scope.memberId, clientMessageId: input.clientMessageId, text, delivery: "queued", intent: input.intent },
  });
  await deps.outbox.enqueueInTx(tx, organizationIdSchema.parse(organizationId), runnerIdSchema.parse(lease.runnerId), {
    kind: "steer",
    body: { sessionId, clientMessageId: input.clientMessageId, text, delivery: "queue", intent: input.intent },
    notAfter: now + runnerLimits.offerTimeoutMs,
    task: { taskId: task.id, projectId },
  });
  await deps.notices.emitInTx(tx, { organizationId: organizationIdSchema.parse(organizationId), projectId, entity: "task", entityId: task.id });
  return { ok: true, delivery: "steer", sessionId, seq, duplicate: false };
};
