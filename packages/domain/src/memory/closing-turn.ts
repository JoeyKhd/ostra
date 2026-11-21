import type { Tx } from "@ostra/db";
import { clientMessageIdSchema, memberIdSchema, organizationIdSchema, projectIdSchema, runnerIdSchema, runnerLimits, savedRepoSchema } from "@ostra/protocol";
import type { ClientMessageId, OrganizationId, SessionId, TaskEventOf, TaskId, TaskSeq } from "@ostra/protocol";
import { z } from "zod";

import type { Ports } from "../ports.ts";
import { CLOSING_TURN_PROMPT } from "../prompts/index.ts";
import { checkBudget, holdTurnInTx, sessionModelIdInTx } from "../use-cases/budgets.ts";
import { appendServerEvent } from "../use-cases/server-events.ts";

// The closing turn (F-111, ADR 0044 amended; milestone 4's ticket 16): a profile switch, off by
// default. When it's on, after a turn that changed a repo, core sends the session one more turn
// with a fixed prompt that asks for proposals and nothing else. It goes through the budget gate as
// any turn does (origin `closing-turn`), and is sent once per save: the closing turn changes no
// repo, and a save after a closing turn never sends another. Its prompt, `CLOSING_TURN_PROMPT`,
// lives with core's other prompts (`prompts/index.ts`), where the panel's reading finds it too.

const CLOSING_PREFIX = "closing-turn-";

/** The closing turn's message ID, fixed by the save it follows: a replayed save sends it once. */
export const closingTurnMessageId = (sessionId: SessionId, savedSeq: TaskSeq): ClientMessageId =>
  clientMessageIdSchema.parse(`${CLOSING_PREFIX}${sessionId}-${String(savedSeq)}`);

/** Whether a message is a closing turn's: what a proposal made in that turn is sourced as. */
export const isClosingTurnMessageId = (clientMessageId: string): boolean => clientMessageId.startsWith(CLOSING_PREFIX);

/** The session's last member message: the turn a proposal or a save belongs to. */
export const lastMessageIdInTx = async (tx: Pick<Tx, "event">, taskId: TaskId, sessionId: SessionId, beforeSeq?: TaskSeq): Promise<string | null> => {
  const row = await tx.event.findFirst({
    where: { taskId, sessionId, kind: "user.message", ...(beforeSeq === undefined ? {} : { seq: { lt: beforeSeq } }) },
    orderBy: { seq: "desc" },
    select: { payload: true },
  });
  return z.object({ clientMessageId: z.string() }).safeParse(row?.payload).data?.clientMessageId ?? null;
};

const savedReposOf = z.object({ repos: z.array(savedRepoSchema) });

export type ClosingTurnOutcome = "sent" | "held" | "off" | "no-changes" | "after-closing-turn" | "already-sent" | "no-lease" | "no-member";

export type ClosingTurnDeps = Pick<Ports, "outbox" | "notices" | "clock">;

/**
 * After a save (`session.saved`), in the ingest's transaction and the task's lock: the closing turn,
 * when the session's profile has the switch on and this turn moved a repo's head.
 */
export const sendClosingTurnInTx = async (
  deps: ClosingTurnDeps,
  tx: Tx,
  input: {
    readonly organizationId: OrganizationId;
    readonly taskId: TaskId;
    readonly sessionId: SessionId;
    readonly savedSeq: TaskSeq;
    readonly event: TaskEventOf<"session.saved">;
  },
): Promise<ClosingTurnOutcome> => {
  const session = await tx.session.findFirst({
    where: { id: input.sessionId, taskId: input.taskId, organizationId: input.organizationId },
    select: { agentProfileId: true, modelId: true },
  });
  const profileId = session?.agentProfileId ?? null;
  const profile =
    profileId === null ? null : await tx.agentProfile.findFirst({ where: { id: profileId, organizationId: input.organizationId }, select: { closingTurn: true } });
  if (session === null || profile?.closingTurn !== true) {
    return "off";
  }
  // A turn with changes: a repo whose head this save moved, against the task's save before it.
  const previous = await tx.event.findFirst({
    where: { taskId: input.taskId, kind: "session.saved", seq: { lt: input.savedSeq } },
    orderBy: { seq: "desc" },
    select: { payload: true },
  });
  const before = new Map((savedReposOf.safeParse(previous?.payload).data?.repos ?? []).map((repo) => [repo.repoId, repo.headSha]));
  const changed = input.event.repos.some((repo) => repo.ahead && repo.headSha !== null && before.get(repo.repoId) !== repo.headSha);
  if (!changed) {
    return "no-changes";
  }
  // The turn that just ended was itself a closing turn: never one after another.
  const lastId = await lastMessageIdInTx(tx, input.taskId, input.sessionId, input.savedSeq);
  if (lastId !== null && isClosingTurnMessageId(lastId)) {
    return "after-closing-turn";
  }
  const clientMessageId = closingTurnMessageId(input.sessionId, input.savedSeq);
  const sent = await tx.event.count({ where: { taskId: input.taskId, kind: "user.message", payload: { path: ["clientMessageId"], equals: clientMessageId } } });
  if (sent > 0) {
    return "already-sent";
  }
  const task = await tx.task.findFirstOrThrow({ where: { id: input.taskId }, select: { projectId: true, driverMemberId: true, creatorMemberId: true } });
  const lease = await tx.lease.findFirst({ where: { taskId: input.taskId, state: "active" }, select: { runnerId: true } });
  if (lease === null) {
    return "no-lease";
  }
  // The thread shows the closing turn as the task's driver's (or its creator's) message.
  const member = task.driverMemberId ?? task.creatorMemberId;
  if (member === null) {
    return "no-member";
  }
  const organizationId = organizationIdSchema.parse(input.organizationId);
  const projectId = projectIdSchema.parse(task.projectId);
  const now = deps.clock.now();
  const text = CLOSING_TURN_PROMPT.slice(0, runnerLimits.steerTextMaxChars);
  const seq = await appendServerEvent(tx, {
    organizationId,
    projectId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    at: now,
    event: { kind: "user.message", memberId: memberIdSchema.parse(member), clientMessageId, text, delivery: "queued", intent: "message" },
  });
  const gate = await checkBudget(tx, {
    organizationId,
    projectId,
    modelId: await sessionModelIdInTx(tx, organizationId, { agentProfileId: session.agentProfileId, modelId: session.modelId }),
    origin: "closing-turn",
    now,
  });
  if (gate.kind === "held") {
    await holdTurnInTx(deps, tx, { organizationId, projectId, taskId: input.taskId, sessionId: input.sessionId, held: gate, pendingMessageSeq: seq, now, queued: false });
    return "held";
  }
  await deps.outbox.enqueueInTx(tx, organizationId, runnerIdSchema.parse(lease.runnerId), {
    kind: "steer",
    body: { sessionId: input.sessionId, clientMessageId, text, delivery: "queue", intent: "message" },
    notAfter: now + runnerLimits.offerTimeoutMs,
    task: { taskId: input.taskId, projectId },
  });
  await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: input.taskId });
  return "sent";
};
