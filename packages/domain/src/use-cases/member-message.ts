import type { Tx } from "@ostra/db";
import { mapTask } from "@ostra/db";
import { memberIdSchema, organizationIdSchema, projectIdSchema, runnerIdSchema, runnerLimits, sessionIdSchema } from "@ostra/protocol";
import type { ClientMessageId, MessageFileId, MessageIntent, RunnerId, SessionId, TaskId, TaskSeq } from "@ostra/protocol";

import { transitionLeasePurpose } from "../lifecycles/m8-previews.ts";
import { taskFromColumns } from "../lifecycles/mapping.ts";
import { transitionTask } from "../lifecycles/task.ts";
import { resolveNeedsYouItemsInTx } from "./needs-you-items.ts";

import { requireProjectAccess } from "../access.ts";
import { appendMemberMessageInTx, defaultMessageFilesDeps, filesToBindInTx, runnerTakesFilesInTx, steerFileFields, uploadsOfInTx } from "../files/message-files.ts";
import type { MessageFilesDeps, MessageFilesToBind, TicketFilesToBind } from "../files/message-files.ts";
import type { MemberScope } from "../access.ts";
import type { Ports } from "../ports.ts";
import { checkBudget, holdTurnInTx, sessionModelIdInTx, turnOriginOfIntent } from "./budgets.ts";
import { creditSenderInTx, taskCoAuthorsInTx } from "./co-authors.ts";
import type { CoAuthorCredit } from "./co-authors.ts";
import type { UseCaseResult } from "./common.ts";
import { moveTaskInTx } from "./moves.ts";
import { answerNextTurnItemsInTx } from "./needs-you-items.ts";
import { reopenTask } from "./reopen.ts";
import type { ReopenTaskResult } from "./reopen.ts";
import { recordPersonActionInTx } from "../review-loop/rounds.ts";
import { sessionProviderGateInTx } from "../providers/session-model.ts";
import { restartOnProviderChangeInTx } from "../providers/turn-start.ts";
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
// member who wrote it is credited for what follows. So is every message's sender (F-078, ADR 0040):
// a `Co-authored-by` trailer on the task's next commits, unless the caller says `credit: false`. A
// steer carries the task's co-authors with the sender's credit (minor 8), so the box's commits from
// that message on credit them; a reopen's do through the new session's spec.

export type SendMemberMessageDeps = Pick<Ports, "jobs" | "outbox" | "notices" | "audit" | "clock"> & {
  readonly spendCap?: SpendCapSettings | undefined;
  readonly timers?: SessionTimers | undefined;
  /** Milestone 9 (F-148): the message files' limits and which agents take images; the defaults when left out. */
  readonly files?: MessageFilesDeps | undefined;
};

export type SendMemberMessageInput = {
  readonly taskId: TaskId;
  /** Fixed by what the message is for, so the same action sent twice is applied once. */
  readonly clientMessageId: ClientMessageId;
  /** Rendered by the domain's prompts: never logged. Milestone 9: may be empty when files come. */
  readonly text: string;
  readonly intent: MessageIntent;
  /** `driver`: the panel's actions; `anyone`: a PR comment, queued whoever drives. */
  readonly sender: "driver" | "anyone";
  /**
   * Milestone 6 (F-105): a reopen keeps the task's driver. A reviewer's "changes requested" is a
   * review, so it doesn't make the reviewer the task's driver. Missing: a reopen makes the sender the driver.
   */
  readonly keepDriver?: true;
  /**
   * F-078 (ADR 0040): missing, the sender is a co-author of what follows by their ostra email
   * (`creditCoAuthorInTx`). `{ email }`: by that address, an `@ostra` comment's commenter by the
   * link's no-reply one (ADR 0052). `false`: a reviewer's "changes requested", which credits no one
   * (ADR 0040, amended).
   */
  readonly credit?: Exclude<CoAuthorCredit, undefined>;
  /** Milestone 9 (F-148): the sender's uploads that go with the message, in their order. */
  readonly fileIds?: readonly MessageFileId[];
  /**
   * Milestone 9 (F-149, ticket 06): a ticket's files core fetched for the message (a Linear
   * follow-up's, a ticket update's), bound to it as the ticket's.
   */
  readonly ticketFiles?: TicketFilesToBind;
};

export type MemberMessageDelivery = "steer" | "reopen";

export type SendMemberMessageResult = UseCaseResult<
  {
    readonly delivery: MemberMessageDelivery;
    readonly sessionId: SessionId;
    readonly seq: TaskSeq | null;
    readonly duplicate: boolean;
    /** Milestone 4 (F-037): the budget gate held the turn; the message is saved and waits for the release. */
    readonly held?: true;
  },
  | "not-found"
  | "take-over-to-send"
  /** Milestone 9 (Q340): a message with files to a session whose runner speaks below protocol minor 8. */
  | "runner-needs-upgrade"
  | Exclude<ReopenTaskResult, { readonly ok: true }>["error"]
>;

/** The session states a message is steered into, rather than reopening the task. */
const GOING_SESSION_STATES = ["starting", "running", "waiting", "idle"] as const;

/**
 * Milestone 9 (Q340): the box's words when a message with files would be steered to a runner below
 * protocol minor 8, which never writes them into the box: the send is refused, nothing written.
 */
export const RUNNER_NEEDS_UPGRADE_FOR_FILES = "This task's runner needs upgrading to take files: update it, or reopen the task on another runner";

/** A message longer than a steer may carry is cut, so a send never fails on its length. */
const fitText = (text: string): string => (text.length <= runnerLimits.steerTextMaxChars ? text : text.slice(0, runnerLimits.steerTextMaxChars));

/**
 * A message while an `app` lease holds (milestone 8, Q300, ADR 0068): the turn starts in that box,
 * on that lease and its session, as a reopen would carry on (the driver, the needs-you items, the
 * task's move to `queued`, then `preparing` once the runner took the lease) but with no new box.
 * The lease's purpose becomes `turn`, and the runner launches the agent at the `steer`. It passes
 * the budget gate as any turn: a held one keeps the message for the release. `null`: the task
 * can't carry on this way (a merged one), so the message reopens it as before.
 */
const turnOnAppLeaseInTx = async (
  deps: SendMemberMessageDeps,
  tx: Tx,
  scope: MemberScope,
  task: ReturnType<typeof mapTask>,
  lease: { readonly id: string; readonly runnerId: RunnerId; readonly acceptedAt: Date | null; readonly appStartedByMemberId: string | null },
  session: { readonly id: string; readonly agentProfileId: string | null; readonly modelId: string | null },
  input: SendMemberMessageInput,
  text: string,
  files: MessageFilesToBind | null,
): Promise<SendMemberMessageResult | null> => {
  const current = taskFromColumns(task);
  if (!current.ok || !transitionTask(current.value, { type: "reopen" }).ok) {
    return null;
  }
  const now = deps.clock.now();
  const organizationId = organizationIdSchema.parse(scope.organizationId);
  const projectId = projectIdSchema.parse(task.projectId);
  const sessionId = sessionIdSchema.parse(session.id);
  const message = { kind: "user.message", memberId: scope.memberId, clientMessageId: input.clientMessageId, text, delivery: "queued", intent: input.intent } as const;
  // F-078 (ADR 0040): the message starts a turn now or at the budget's release: its sender is a co-author.
  await creditSenderInTx(deps.jobs, tx, input.credit, { organizationId, projectId, taskId: task.id, memberId: scope.memberId });
  const gate = await checkBudget(tx, {
    organizationId,
    projectId,
    modelId: await sessionModelIdInTx(tx, organizationId, { agentProfileId: session.agentProfileId, modelId: session.modelId }),
    origin: turnOriginOfIntent(input.intent),
    now,
  });
  if (gate.kind === "held") {
    const { seq: heldSeq } = await appendMemberMessageInTx(tx, { organizationId, projectId, taskId: task.id, sessionId, at: now }, message, files);
    await holdTurnInTx(deps, tx, { organizationId, projectId, taskId: task.id, sessionId, held: gate, pendingMessageSeq: heldSeq, now, queued: false });
    return { ok: true, delivery: "steer", sessionId, seq: heldSeq, duplicate: false, held: true };
  }
  // The lease's purpose: `app` becomes `turn` at the message, in the same box (`transitionLeasePurpose`).
  const purpose = transitionLeasePurpose(
    { purpose: "app", startedByMemberId: memberIdSchema.parse(lease.appStartedByMemberId ?? scope.memberId), at: now },
    { type: "message", at: now },
  );
  if (purpose.ok) {
    await tx.lease.update({ where: { id: lease.id }, data: { purpose: purpose.state.purpose, appStartedByMemberId: null } });
  }
  const moveDeps = { tx, notices: deps.notices, jobs: deps.jobs };
  if (input.keepDriver !== true) {
    await tx.task.update({ where: { id: task.id }, data: { driverMemberId: scope.memberId } });
  }
  await moveTaskInTx(moveDeps, task, { type: "reopen" });
  if (lease.acceptedAt !== null) {
    // The runner already took the box: the task is preparing it, and the turn's start makes it running.
    await moveTaskInTx(moveDeps, mapTask(await tx.task.findUniqueOrThrow({ where: { id: task.id } })), { type: "runner_accepted" });
  }
  await resolveNeedsYouItemsInTx(
    deps,
    tx,
    { taskId: task.id, reasonNotIn: ["restore_conflict", "files_outside_repos"] },
    { state: "answered", at: new Date(now), byMemberId: scope.memberId },
  );
  const { seq, bound } = await appendMemberMessageInTx(tx, { organizationId, projectId, taskId: task.id, sessionId, at: now }, message, files);
  await deps.outbox.enqueueInTx(tx, organizationId, lease.runnerId, {
    kind: "steer",
    // F-078 (minor 8): the task's co-authors, the sender among them, for the box's commits from this message on.
    body: { sessionId, clientMessageId: input.clientMessageId, text, delivery: "queue", intent: input.intent, ...steerFileFields(bound), coAuthors: await taskCoAuthorsInTx(tx, { organizationId, taskId: task.id }) },
    notAfter: now + runnerLimits.offerTimeoutMs,
    task: { taskId: task.id, projectId },
  });
  await deps.audit.recordInTx(tx, {
    organizationId,
    projectId,
    actor: { kind: "member", id: scope.memberId },
    action: "task.reopened",
    entity: "task",
    entityId: task.id,
    data: { sessionId, from: task.state, via: "app" },
  });
  await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: task.id });
  return { ok: true, delivery: "steer", sessionId, seq, duplicate: false };
};

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
  // Milestone 9 (F-148): the files are the sender's own unsent uploads of the project, checked
  // before anything is written; files alone make a message.
  const fileIds = input.fileIds ?? [];
  if ((await uploadsOfInTx(tx, scope, projectIdSchema.parse(task.projectId), fileIds)) === null) {
    return { ok: false, error: "file-not-found", message: "One of the files isn't one of your unsent uploads in this project" };
  }
  const [lease, session] = await Promise.all([
    tx.lease.findFirst({ where: { taskId: task.id, state: "active" }, select: { id: true, runnerId: true, purpose: true, acceptedAt: true, appStartedByMemberId: true, boxId: true } }),
    tx.session.findFirst({
      where: { taskId: task.id, state: { in: [...GOING_SESSION_STATES] } },
      orderBy: { startedAt: "desc" },
      select: { id: true, state: true, agentProfileId: true, providerId: true, modelId: true, boxId: true },
    }),
  ]);
  // Milestone 9 (Q340): a message with files steered into a box needs its runner at minor 8,
  // refused before anything is written (the box says the runner needs upgrading).
  const going = (task.state === "running" || task.state === "needs_you") && lease !== null && session !== null;
  const steered = going || (lease?.purpose === "app" && session?.boxId === lease.boxId) ? lease : null;
  const hasFiles = fileIds.length > 0 || (input.ticketFiles?.stored.length ?? 0) > 0;
  if (hasFiles && steered !== null && !(await runnerTakesFilesInTx(tx, steered.runnerId))) {
    return { ok: false, error: "runner-needs-upgrade", message: RUNNER_NEEDS_UPGRADE_FOR_FILES };
  }
  // Milestone 6 (ADR 0041, F-101): a person acted, so the automatic turns count from nothing again.
  await recordPersonActionInTx(tx, task.id, new Date(deps.clock.now()));
  const files =
    session === null ? null : await filesToBindInTx(tx, organizationIdSchema.parse(organizationId), deps.files ?? defaultMessageFilesDeps, { fileIds, modelId: session.modelId, agentProfileId: session.agentProfileId, ticket: input.ticketFiles });
  // Milestone 8 (Q300, ticket 19): a message while "Start the app"'s lease holds starts a turn in its box.
  if (lease?.purpose === "app" && session?.boxId === lease.boxId) {
    const turned = await turnOnAppLeaseInTx(deps, tx, scope, task, { ...lease, runnerId: runnerIdSchema.parse(lease.runnerId) }, session, input, text, files);
    if (turned !== null) {
      return turned;
    }
  }
  const origin = turnOriginOfIntent(input.intent);
  if (!going) {
    const reopened = await reopenTask(
      {
        tx,
        scope,
        jobs: deps.jobs,
        notices: deps.notices,
        audit: deps.audit,
        clock: deps.clock,
        spendCap: deps.spendCap,
        timers: deps.timers,
        origin: origin === "message" ? "reopen" : origin,
        ...(input.keepDriver === true ? { keepDriver: true as const } : {}),
        ...(input.credit === undefined ? {} : { credit: input.credit }),
        ...(deps.files === undefined ? {} : { files: deps.files }),
        // Milestone 9 (ticket 12): a follow-up's files go with the message that reopens the task.
        ...(input.ticketFiles === undefined ? {} : { ticketFiles: input.ticketFiles }),
      },
      { taskId: task.id, clientMessageId: input.clientMessageId, text, intent: input.intent, ...(fileIds.length === 0 ? {} : { fileIds: [...fileIds] }) },
    );
    if (!reopened.ok) {
      return reopened;
    }
    return { ok: true, delivery: "reopen", sessionId: reopened.sessionId, seq: null, duplicate: false, ...(reopened.held === true ? { held: true as const } : {}) };
  }
  if (input.sender === "driver" && task.driverMemberId !== scope.memberId) {
    return { ok: false, error: "take-over-to-send", message: "Take over to send" };
  }
  const now = deps.clock.now();
  const projectId = projectIdSchema.parse(task.projectId);
  const sessionId = sessionIdSchema.parse(session.id);
  // F-078 (ADR 0040): the message is sent, steered, held or restarted below: its sender is a co-author.
  await creditSenderInTx(deps.jobs, tx, input.credit, { organizationId: organizationIdSchema.parse(organizationId), projectId, taskId: task.id, memberId: scope.memberId });
  // Milestone 4 (F-037, ADR 0055): a message to an idle session starts a turn, so it passes the
  // budget gate first. A session with a turn going takes it into that turn, gate or not.
  if (session.state === "idle") {
    // Milestone 4 (F-135, ADR 0065): a turn start checks the session's provider against the
    // project's list now. Moved or gone, the turn starts in a fresh session instead of the box that
    // holds the old key; a turn going finishes on its own.
    const providers = await sessionProviderGateInTx(tx, { organizationId: organizationIdSchema.parse(organizationId), projectId, providerId: session.providerId, modelId: session.modelId, agentProfileId: session.agentProfileId });
    if (providers !== null && providers.kind !== "open") {
      const restarted = await restartOnProviderChangeInTx(deps, tx, task, providers, { memberId: scope.memberId, clientMessageId: input.clientMessageId, text, intent: input.intent, files });
      return { ok: true, delivery: "reopen", sessionId: restarted.sessionId, seq: restarted.seq, duplicate: false };
    }
    const gate = await checkBudget(tx, {
      organizationId: organizationIdSchema.parse(organizationId),
      projectId,
      modelId: await sessionModelIdInTx(tx, organizationId, { agentProfileId: session.agentProfileId, modelId: session.modelId }),
      origin,
      now,
    });
    if (gate.kind === "held") {
      const { seq: heldSeq } = await appendMemberMessageInTx(
        tx,
        { organizationId: organizationIdSchema.parse(organizationId), projectId, taskId: task.id, sessionId, at: now },
        { kind: "user.message", memberId: scope.memberId, clientMessageId: input.clientMessageId, text, delivery: "queued", intent: input.intent },
        files,
      );
      await holdTurnInTx(deps, tx, { organizationId: organizationIdSchema.parse(organizationId), projectId, taskId: task.id, sessionId, held: gate, pendingMessageSeq: heldSeq, now, queued: false });
      return { ok: true, delivery: "steer", sessionId, seq: heldSeq, duplicate: false, held: true };
    }
  }
  if (task.state === "needs_you") {
    // The message answers what the task waited on, as the composer's send does, and its items close.
    await moveTaskInTx({ tx, notices: deps.notices, jobs: deps.jobs }, task, { type: "member_acted", boxWarm: true });
    await answerNextTurnItemsInTx(deps, tx, task.id, { at: new Date(now), byMemberId: scope.memberId });
  }
  const { seq, bound } = await appendMemberMessageInTx(
    tx,
    { organizationId: organizationIdSchema.parse(organizationId), projectId, taskId: task.id, sessionId, at: now },
    { kind: "user.message", memberId: scope.memberId, clientMessageId: input.clientMessageId, text, delivery: "queued", intent: input.intent },
    files,
  );
  await deps.outbox.enqueueInTx(tx, organizationIdSchema.parse(organizationId), runnerIdSchema.parse(lease.runnerId), {
    kind: "steer",
    // F-078 (minor 8): the task's co-authors, the sender among them, for the box's commits from this message on.
    body: {
      sessionId,
      clientMessageId: input.clientMessageId,
      text,
      delivery: "queue",
      intent: input.intent,
      ...steerFileFields(bound),
      coAuthors: await taskCoAuthorsInTx(tx, { organizationId: organizationIdSchema.parse(organizationId), taskId: task.id }),
    },
    notAfter: now + runnerLimits.offerTimeoutMs,
    task: { taskId: task.id, projectId },
  });
  await deps.notices.emitInTx(tx, { organizationId: organizationIdSchema.parse(organizationId), projectId, entity: "task", entityId: task.id });
  return { ok: true, delivery: "steer", sessionId, seq, duplicate: false };
};
