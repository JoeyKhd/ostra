import { mapTask } from "@ostra/db";
import type { Tx } from "@ostra/db";
import {
  clientMessageIdSchema,
  leaseEpochSchema,
  messageIntentSchema,
  needsYouItemIdSchema,
  organizationIdSchema,
  projectIdSchema,
  runnerLimits,
  sessionIdSchema,
  taskEventSchema,
  taskIdSchema,
} from "@ostra/protocol";
import type { BlobRef, BoxId, ClientMessageId, MemberId, NeedsYouItemId, PendingMessage, SessionId, TaskId } from "@ostra/protocol";
import { z } from "zod";

import { requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import { taskFromColumns } from "../lifecycles/mapping.ts";
import { transitionTask } from "../lifecycles/task.ts";
import type { Ports } from "../ports.ts";
import { reopenCarryOnText } from "../tickets/contracts.ts";
import type { UseCaseResult } from "./common.ts";
import { moveSessionInTx, moveTaskInTx } from "./moves.ts";
import { appendServerEvent } from "./server-events.ts";
import { endSessionTimersInTx } from "./sessions-m2.ts";
import { resolveReopenProfileInTx } from "./task-profile.ts";
import type { SessionTimers } from "./sessions-m2.ts";
import { modelTokenPrices, spendCapFor, spendCapReached, taskTokensInTx } from "./spend.ts";
import type { SpendCapSettings } from "./spend.ts";

// Reopening (F-032, F-033, F-047; ADR 0039's three steps; spec section 4, "Reopen", and the
// decisions of ticket 40). `reopenTask` is the member's action; `chooseReopenStep` is the
// dispatch's choice of the same box, a fresh box from the archive, or the rebuild template.

// ---------- the member messages no turn answered (F-047, spike 2's gotcha 10) ----------

/** The turn stop reasons that answered nothing: the message they were working on is still owed. */
const UNANSWERED_STOPS: ReadonlySet<string> = new Set(["failed", "cancelled"]);

/** At most this many messages are carried into a reopen (the spec's own cap). */
const PENDING_MAX = 100;

/**
 * The member's messages no finished turn answered, oldest first, each once by its
 * `clientMessageId`: a message is answered when a turn that started after it ended normally. A
 * lost box's last message, one the idle timer's cancel left, and a reopen's own message are all
 * here, and a reopen's spec carries them as `pendingMessages`. A message too long to replay as a
 * turn (the first rendered ticket, whose text the spec's prompt already holds) is left out.
 */
export const unansweredMessagesInTx = async (
  tx: Pick<Tx, "event" | "turn">,
  taskId: TaskId,
): Promise<readonly (PendingMessage & { readonly seq: number; readonly memberId: MemberId; readonly replayed: boolean })[]> => {
  const turns = await tx.turn.findMany({ where: { taskId, endedAt: { not: null } }, select: { startSeq: true, stopReason: true } });
  const answeredBefore = turns
    .filter((turn) => turn.stopReason === null || !UNANSWERED_STOPS.has(turn.stopReason))
    .reduce((latest, turn) => Math.max(latest, turn.startSeq), 0);
  const rows = await tx.event.findMany({
    where: { taskId, kind: "user.message", seq: { gt: answeredBefore } },
    orderBy: { seq: "asc" },
    select: { seq: true, payload: true },
  });
  const seen = new Set<string>();
  const pending: { readonly seq: number; readonly clientMessageId: ClientMessageId; readonly text: string; readonly memberId: MemberId; readonly replayed: boolean }[] = [];
  for (const row of rows) {
    const parsed = taskEventSchema.safeParse(row.payload);
    if (!parsed.success || parsed.data.kind !== "user.message") {
      continue;
    }
    const message = parsed.data;
    if (seen.has(message.clientMessageId) || message.text.trim() === "" || message.text.length > runnerLimits.steerTextMaxChars) {
      continue;
    }
    seen.add(message.clientMessageId);
    pending.push({ seq: row.seq, clientMessageId: message.clientMessageId, text: message.text, memberId: message.memberId, replayed: message.replayed === true });
  }
  return pending.slice(-PENDING_MAX);
};

// ---------- the member's reopen (ticket 18, router ticket 30) ----------

export const reopenTaskInputSchema = z.strictObject({
  taskId: taskIdSchema,
  clientMessageId: clientMessageIdSchema,
  /**
   * The member's message. Optional only for the one-click reopen from a limit or a crash: the
   * server then writes `reopenCarryOnText`, unless a lost box's unanswered message is replayed.
   * Never logged.
   */
  text: z.string().trim().min(1).max(runnerLimits.steerTextMaxChars).optional(),
  /**
   * Milestone 3: why the message was written, when ostra rendered it for a panel action or a PR
   * comment (diff comments, "Update branch", `@ostra`, ...). Missing means the member typed it.
   */
  intent: messageIntentSchema.optional(),
});
export type ReopenTaskInput = z.infer<typeof reopenTaskInputSchema>;

export type ReopenTaskResult = UseCaseResult<
  { readonly sessionId: SessionId },
  | "not-found"
  | "forbidden"
  /** In milestone 2 a merged task isn't reopened: its fresh branch is F-066, milestone 3. */
  | "merged_reopen_later"
  /** Another active task holds the ticket (spec section 11, item 12). */
  | "ticket-has-task"
  /** The task is running, queued or preparing: there's nothing to reopen. */
  | "not-reopenable"
  /** A reopen that isn't from a limit or a crash needs the member's message. */
  | "text-required"
  /** The task reached its spend cap; milestone 2 raises it only through the setting (F-068). */
  | "spend-cap-reached"
  /** Milestone 3 (F-021): the member may not use the task's agent profile. */
  | "profile-not-allowed"
>;

export type ReopenTaskDeps = Pick<Ports, "jobs" | "notices" | "audit" | "clock"> & {
  readonly tx: Tx;
  readonly scope: MemberScope;
  /** The server's caps (`OSTRA_TASK_SPEND_CAP_USD`, `OSTRA_TASK_TOKEN_CAP`): a reopen at the cap is refused. */
  readonly spendCap?: SpendCapSettings | undefined;
  /** The old session's timer goes with it. */
  readonly timers?: SessionTimers | undefined;
};

/**
 * Writes the member's message (`user.message` with `reopen: true`), makes the member the driver, a
 * new session, and enqueues `task.dispatch`, which picks the step and raises the lease epoch.
 */
export type ReopenTask = (deps: ReopenTaskDeps, input: ReopenTaskInput) => Promise<ReopenTaskResult>;

/** The states a one-click reopen (no text) may come from: a limit or a crash (ticket 40's decision). */
const oneClick = (task: { readonly state: string; readonly needsYouReason: string | null; readonly stoppedReason: string | null }): boolean =>
  (task.state === "needs_you" && (task.needsYouReason === "stalled" || task.needsYouReason === "spend_cap" || task.needsYouReason === "crashed")) ||
  (task.state === "stopped" && (task.stoppedReason === "runner_lost" || task.stoppedReason === "runaway" || task.stoppedReason === "spend_cap"));

const ACTIVE_SESSION_STATES: ReadonlySet<string> = new Set(["starting", "running", "waiting", "idle"]);

const refused = (error: Exclude<ReopenTaskResult, { readonly ok: true }>["error"], message: string): ReopenTaskResult => ({ ok: false, error, message });

export const reopenTask: ReopenTask = async (deps, input) => {
  const { tx, scope } = deps;
  const organizationId = scope.organizationId;
  const locked = await tx.$queryRaw<readonly unknown[]>`
    SELECT 1 FROM "task" WHERE "id" = ${input.taskId} AND "organizationId" = ${organizationId} FOR UPDATE`;
  if (locked.length === 0) {
    return refused("not-found", "No such task");
  }
  const task = mapTask(await tx.task.findUniqueOrThrow({ where: { id: input.taskId } }));
  const project = await tx.project.findFirst({ where: { id: task.projectId, organizationId }, select: { id: true, access: true } });
  if (project === null) {
    return refused("not-found", "No such task");
  }
  // Any member who can open the project reopens its tasks (F-032), and becomes the driver.
  const access = requireProjectAccess(scope, { id: projectIdSchema.parse(project.id), organizationId, access: project.access }, "read");
  if (!access.ok) {
    return access.code === "not-found" ? refused("not-found", "No such task") : refused("forbidden", "You may not reopen this task");
  }
  // A send of the same message again is the same reopen (the panel retries).
  const sent = await tx.event.findFirst({
    where: { taskId: task.id, kind: "user.message", payload: { path: ["clientMessageId"], equals: input.clientMessageId } },
    select: { sessionId: true },
  });
  if (sent !== null) {
    return { ok: true, sessionId: sessionIdSchema.parse(sent.sessionId) };
  }
  if (task.state === "merged") {
    return refused("merged_reopen_later", "A merged task can't be reopened yet: its fresh branch comes in a later release. Start a new task instead");
  }
  const current = taskFromColumns(task);
  if (!current.ok) {
    throw new Error(`a task row breaks its lifecycle: ${current.reason}`);
  }
  if (!transitionTask(current.value, { type: "reopen" }).ok) {
    return refused("not-reopenable", "The task is still working: there's nothing to reopen");
  }
  if (input.text === undefined && !oneClick(task)) {
    return refused("text-required", "Say what the agent should do next");
  }
  // One active code task per ticket per project (spec section 11, item 12).
  if (task.kind === "code" && task.ticketId !== null) {
    const holder = await tx.task.findFirst({
      where: { projectId: task.projectId, ticketId: task.ticketId, kind: "code", id: { not: task.id }, state: { notIn: ["stopped", "merged", "done"] } },
      select: { id: true },
    });
    if (holder !== null) {
      return refused("ticket-has-task", `Another active task holds this ticket: ${holder.id}`);
    }
  }

  const sessions = await tx.session.findMany({ where: { taskId: task.id }, orderBy: [{ startedAt: "desc" }, { id: "desc" }] });
  const [previous] = sessions;
  // F-021: a reopen keeps the profile the task started with, archived or not, if the member may use it.
  const reopenProfile = await resolveReopenProfileInTx(tx, scope, { task, previousSessionProfileId: previous?.agentProfileId ?? null });
  if (!reopenProfile.ok) {
    return refused(reopenProfile.error, reopenProfile.message);
  }
  // The spend cap holds across sessions: a reopen at the cap waits for the cap to be raised.
  if (deps.spendCap !== undefined) {
    const profileId = previous?.agentProfileId ?? null;
    const model =
      profileId === null
        ? null
        : ((await tx.agentProfile.findFirst({ where: { id: profileId, organizationId }, include: { model: true } }))?.model ?? null);
    const cap = spendCapFor(deps.spendCap, model === null ? null : modelTokenPrices(model), {
      microUsd: task.spentMicroUsd,
      tokens: await taskTokensInTx(tx, task.id),
    });
    if (spendCapReached(cap)) {
      return refused("spend-cap-reached", "The task reached its spend cap. It can be reopened once the cap is raised (OSTRA_TASK_SPEND_CAP_USD)");
    }
  }

  const now = deps.clock.now();
  const organization = organizationIdSchema.parse(organizationId);
  const projectId = projectIdSchema.parse(task.projectId);
  const moveDeps = { tx, notices: deps.notices };

  // The old session ends here: one active session per task. The dispatch decides whether the new
  // one carries on in the same box (ADR 0039).
  for (const old of sessions.filter((row) => ACTIVE_SESSION_STATES.has(row.state))) {
    await moveSessionInTx(moveDeps, old, { type: "stop" });
    await endSessionTimersInTx(deps, tx, { organizationId: organization, taskId: task.id, sessionId: sessionIdSchema.parse(old.id) });
  }
  // The old grant ends too, so the queue's sweep can retry this dispatch. A warm box keeps its state:
  // the dispatch grants it again when its runner still holds it (`resumed`).
  await tx.lease.updateMany({
    where: { taskId: task.id, state: "active" },
    data: { state: "ended", endedAt: new Date(now), endReason: "superseded" },
  });
  // What no turn answered, before this reopen writes anything: replayed in the new session.
  const owed = (await unansweredMessagesInTx(tx, task.id)).filter((message) => !message.replayed);

  const profileId = reopenProfile.profileId;
  const created = await tx.session.create({
    data: { organizationId, projectId, taskId: task.id, agentProfileId: profileId, origin: "new", state: "starting" },
    select: { id: true },
  });
  const sessionId = sessionIdSchema.parse(created.id);
  for (const message of owed) {
    await appendServerEvent(tx, {
      organizationId: organization,
      projectId,
      taskId: task.id,
      sessionId,
      at: now,
      event: { kind: "user.message", memberId: message.memberId, clientMessageId: message.clientMessageId, text: message.text, delivery: "queued", replayed: true },
    });
  }
  // The member's message, or the one-click reopen's words, unless a replayed message already says it.
  const text = input.text ?? (owed.length > 0 ? null : reopenCarryOnText);
  if (text !== null) {
    await appendServerEvent(tx, {
      organizationId: organization,
      projectId,
      taskId: task.id,
      sessionId,
      at: now,
      event: {
        kind: "user.message",
        memberId: scope.memberId,
        clientMessageId: input.clientMessageId,
        text,
        delivery: "queued",
        reopen: true,
        ...(input.intent === undefined ? {} : { intent: input.intent }),
      },
    });
  }

  await tx.task.update({ where: { id: task.id }, data: { driverMemberId: scope.memberId } });
  await moveTaskInTx(moveDeps, task, { type: "reopen" });
  // The reopen answers what the task needed: a limit, a crash, no changes.
  await tx.needsYouItem.updateMany({
    where: { taskId: task.id, state: "open", reason: { notIn: ["restore_conflict", "files_outside_repos"] } },
    data: { state: "answered", resolvedAt: new Date(now), resolvedByMemberId: scope.memberId },
  });
  await deps.jobs.enqueueInTx(tx, "task.dispatch", {
    organizationId: organization,
    taskId: task.id,
    sessionId,
    leaseEpoch: leaseEpochSchema.parse(task.leaseEpoch + 1),
  });
  await deps.audit.recordInTx(tx, {
    organizationId: organization,
    projectId,
    actor: { kind: "member", id: scope.memberId },
    action: "task.reopened",
    entity: "task",
    entityId: task.id,
    data: { sessionId, from: task.state, replayed: owed.length },
  });
  await deps.notices.emitInTx(tx, { organizationId: organization, projectId, entity: "task", entityId: task.id });
  return { ok: true, sessionId };
};

// ---------- "Carry on without it" (ticket 18, router ticket 30) ----------

export const dismissNeedsYouInputSchema = z.strictObject({ taskId: taskIdSchema, itemId: needsYouItemIdSchema });
export type DismissNeedsYouInput = z.infer<typeof dismissNeedsYouInputSchema>;

export type DismissNeedsYouResult = UseCaseResult<{ readonly itemId: NeedsYouItemId }, "not-found" | "forbidden" | "not-open">;

/** Dismisses a needs-you item that doesn't hold the task, such as a restore conflict, as its audience. */
export type DismissNeedsYou = (deps: ReopenTaskDeps, input: DismissNeedsYouInput) => Promise<DismissNeedsYouResult>;

/** The reasons that never hold the task, so the task's state needn't move when one is dismissed. */
const DISMISSABLE: ReadonlySet<string> = new Set(["restore_conflict", "unstorable_event", "files_outside_repos"]);

export const dismissNeedsYou: DismissNeedsYou = async (deps, input) => {
  const { tx, scope } = deps;
  const organizationId = scope.organizationId;
  const item = await tx.needsYouItem.findFirst({ where: { id: input.itemId, taskId: input.taskId, organizationId } });
  if (item === null) {
    return { ok: false, error: "not-found", message: "No such item" };
  }
  const project = await tx.project.findFirst({ where: { id: item.projectId, organizationId }, select: { id: true, access: true } });
  if (project === null) {
    return { ok: false, error: "not-found", message: "No such item" };
  }
  const access = requireProjectAccess(scope, { id: projectIdSchema.parse(project.id), organizationId, access: project.access }, "read");
  if (!access.ok) {
    return access.code === "not-found" ? { ok: false, error: "not-found", message: "No such item" } : { ok: false, error: "forbidden", message: "You may not dismiss it" };
  }
  if (item.audience === "driver") {
    const task = await tx.task.findUniqueOrThrow({ where: { id: item.taskId }, select: { driverMemberId: true } });
    if (task.driverMemberId !== null && task.driverMemberId !== scope.memberId) {
      return { ok: false, error: "forbidden", message: "Only the task's driver can dismiss this" };
    }
  }
  if (item.state !== "open" || !DISMISSABLE.has(item.reason)) {
    return { ok: false, error: "not-open", message: "The item isn't open, or it holds the task" };
  }
  await tx.needsYouItem.update({
    where: { id: item.id },
    data: { state: "dismissed", resolvedAt: new Date(deps.clock.now()), resolvedByMemberId: scope.memberId },
  });
  await deps.notices.emitInTx(tx, {
    organizationId: organizationIdSchema.parse(organizationId),
    projectId: projectIdSchema.parse(item.projectId),
    entity: "task",
    entityId: taskIdSchema.parse(item.taskId),
  });
  return { ok: true, itemId: input.itemId };
};

// ---------- the dispatch's choice (ADR 0039) ----------

export type ReopenStepInput = {
  /** The task's last box, while it's kept: its runner, if online and at protocol minor 1 or above, still holds it. */
  readonly keptBox: { readonly boxId: BoxId; readonly runnerOnline: boolean; readonly runnerMinor: number } | null;
  /** The last session's archive, while the blob store still holds it. */
  readonly archive: BlobRef | null;
  /** The profile's agent adapter can import an archive (its `sessionArchive` capability). */
  readonly agentImportsArchives: boolean;
  /** The archive was made by the agent the task runs now: another agent can't load it (F-018). */
  readonly sameAgent: boolean;
};

export type ReopenStep =
  | { readonly step: "resumed"; readonly boxId: BoxId }
  | { readonly step: "restored"; readonly archive: BlobRef }
  | { readonly step: "rebuilt"; readonly reason: "no-archive" | "other-agent" | "archive-unsupported" };

/**
 * ADR 0039's three steps, in order: the same box while it's kept, a fresh box from the archive and
 * the hidden ref (the normal path), the rebuild template. Pure.
 */
export const chooseReopenStep = (input: ReopenStepInput): ReopenStep => {
  if (input.keptBox !== null && input.keptBox.runnerOnline && input.keptBox.runnerMinor >= 1) {
    return { step: "resumed", boxId: input.keptBox.boxId };
  }
  if (input.archive === null) {
    return { step: "rebuilt", reason: "no-archive" };
  }
  if (!input.sameAgent) {
    return { step: "rebuilt", reason: "other-agent" };
  }
  if (!input.agentImportsArchives) {
    return { step: "rebuilt", reason: "archive-unsupported" };
  }
  return { step: "restored", archive: input.archive };
};

/** What a reopened task's thread says it came back from: the event's `origin`. */
export type ReopenedTask = { readonly taskId: TaskId; readonly step: ReopenStep };
