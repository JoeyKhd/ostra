import type { Logger } from "@ostra/adapter-sdk";
import { effortLevelToDb, LIVE_TEXT_TABLE, mapTask, notifyChannels, Prisma } from "@ostra/db";
import type { Session, Tx } from "@ostra/db";
import { boxIdSchema, modelIdSchema, organizationIdSchema, projectIdSchema, runnerEventSchema, sessionIdSchema, runnerIdSchema, taskIdSchema, taskSeqSchema } from "@ostra/protocol";
import type { LeaseEpoch, RunnerEvent, RunnerId, SessionId, SessionSeq, TaskId, TaskSeq } from "@ostra/protocol";
import { z } from "zod";

import { taskRepoFromColumns, taskRepoToColumns } from "../lifecycles/mapping.ts";
import { transitionTaskRepo } from "../lifecycles/task-repo.ts";
import type { Ports } from "../ports.ts";
import { recordApprovalAutoAnsweredInTx, recordApprovalClosedInTx, recordApprovalRequestedInTx } from "./approvals.ts";
import { holdProviderInTx } from "./hold-provider.ts";
import { recordPlanProposedInTx, recordQuestionAskedInTx } from "./plans-questions.ts";
import { moveSessionInTx, moveTaskInTx } from "./moves.ts";
import { createNeedsYouItemInTx, resolveNeedsYouItemsInTx, setNeedsYouSummaryInTx } from "./needs-you-items.ts";
import { releaseLeaseInTx } from "./record-session-end.ts";
import { unansweredMessagesInTx } from "./reopen.ts";
import { writeEventSearchEntries } from "../search/entries.ts";
import { storableEvent } from "./storable-event.ts";
import type { TaskMoveDeps } from "./moves.ts";
import { recordCheckFinishedInTx, recordCheckStartedInTx } from "./checks.ts";
import { recordMemoryUse } from "../memory/store.ts";
import { sendClosingTurnInTx } from "../memory/closing-turn.ts";
import type { ReviewLoopCapabilities } from "../review-loop/loop.ts";
import { cancelBoxIdleTimerInTx, endSessionTimersInTx, markBoxBusyInTx, recordLimitReached, recordWorkSaved, startSessionTimersInTx } from "./sessions-m2.ts";
import { recordSpendInTx } from "./budgets.ts";
import { modelTokenPrices, priceTokens } from "./spend.ts";
import type { SessionTimers } from "./sessions-m2.ts";

// ADR 0034, ADR 0035, F-045: one `events` frame, saved in one transaction. Idempotent on
// `(sessionId, sessionSeq)`; numbered per task under the task row's lock (so a grace sweep can't
// interleave); the lease epoch checked; reactions enqueued (`task.session-ended` for a
// `session.ended`); acked per session only after the commit. A batch that doesn't start at the
// session's cursor plus one gets `resendFrom`. A stale epoch is refused, never quarantined (Q111).
// Written by ticket 25; ported from spikes/live-stream-and-task-view/src/server/appender.ts and
// spikes/runner-transport/src/server/replica.ts (`ingest`).
//
// The lock: ADR 0034 as amended asks for a share lock on the task row for the epoch check. Ingest
// also takes the task's event counter, which is on that row, and upgrading a share lock to an update
// lock deadlocks two writers to one task. So the row is taken `FOR NO KEY UPDATE` from the start:
// the grace sweep's `FOR UPDATE` and the panel's own appends wait for it the same way, and foreign
// keys pointing at the task (`FOR KEY SHARE`) don't.

export const ingestEventsInputSchema = z.strictObject({
  runnerId: runnerIdSchema,
  events: z.array(runnerEventSchema).min(1),
});
export type IngestEventsInput = z.infer<typeof ingestEventsInputSchema>;

/** One session's outcome, which becomes its `ack` or `error` frame. */
export type SessionIngestOutcome =
  | {
      readonly kind: "saved";
      readonly sessionId: SessionId;
      readonly taskId: TaskId;
      /** The highest session number now saved. */
      readonly upTo: SessionSeq;
      /** The newest task number given, for the wake-up NOTIFY. */
      readonly headSeq: TaskSeq;
      readonly duplicates: number;
    }
  | { readonly kind: "gap"; readonly sessionId: SessionId; readonly upTo: number; readonly resendFrom: SessionSeq }
  | { readonly kind: "stale-lease"; readonly sessionId: SessionId; readonly currentEpoch: LeaseEpoch }
  | { readonly kind: "unknown-session"; readonly sessionId: SessionId };

export type IngestEventsResult = { readonly outcomes: readonly SessionIngestOutcome[] };

export type IngestEventsDeps = Pick<Ports, "jobs" | "notices" | "clock"> & Partial<Pick<Ports, "outbox">> & {
  readonly tx: Tx;
  /** Where refused transitions are logged, with IDs only. */
  readonly logger?: Logger;
  /** Milestone 2: the session's and the box's timers (tickets 17, 19, 20). */
  readonly timers?: SessionTimers;
  /** Milestone 4: `OSTRA_BUDGET_WARN_PERCENT`, the share of a budget that warns its admins (F-037). */
  readonly budgetWarnPercent?: number | undefined;
  /** Milestone 6 (F-035, F-100): the code host's review-loop capabilities; without them, milestone 5's path. */
  readonly reviewLoop?: ReviewLoopCapabilities | undefined;
};

export type IngestEvents = (deps: IngestEventsDeps, input: IngestEventsInput) => Promise<IngestEventsResult>;

type LockedTask = ReturnType<typeof mapTask>;

/** Locks the task row for the batch (see the note on the lock above) and reads it. */
const lockTaskRow = async (tx: Tx, taskId: TaskId): Promise<LockedTask | null> => {
  const locked = await tx.$queryRaw<readonly unknown[]>`SELECT 1 FROM "task" WHERE "id" = ${taskId} FOR NO KEY UPDATE`;
  const row = locked.length === 0 ? null : await tx.task.findUnique({ where: { id: taskId } });
  return row === null ? null : mapTask(row);
};

/** Groups a frame's events by session, keeping each session's order. */
const bySession = (events: readonly RunnerEvent[]): Map<SessionId, RunnerEvent[]> => {
  const groups = new Map<SessionId, RunnerEvent[]>();
  for (const item of events) {
    const group = groups.get(item.sessionId);
    if (group === undefined) {
      groups.set(item.sessionId, [item]);
    } else {
      group.push(item);
    }
  }
  return groups;
};

type Stored = { readonly item: RunnerEvent; readonly seq: TaskSeq };

/** The names an item lists, for the panel's words: as many as fit, then how many more. */
const filesSummary = (paths: readonly string[], more: number): string => `${paths.join(", ")}${more > 0 ? ` (+${String(more)})` : ""}`;

/**
 * Files left outside every repo (Q133): a needs-you item for the driver, or for the project's
 * members when the task has none. An open one is updated, never doubled, and an empty set closes it.
 * ostra never moves, commits or deletes the files: a reply lets the agent move them.
 */
export const applyFilesOutsideReposInTx = async (
  deps: Pick<IngestEventsDeps, "tx" | "notices" | "clock" | "jobs">,
  task: LockedTask,
  paths: readonly string[],
  more: number,
): Promise<void> => {
  const { tx } = deps;
  const open = await tx.needsYouItem.findFirst({ where: { taskId: task.id, reason: "files_outside_repos", state: "open" }, select: { id: true } });
  if (paths.length === 0) {
    if (open === null) {
      return;
    }
    await resolveNeedsYouItemsInTx(deps, tx, { id: open.id }, { state: "answered", at: new Date(deps.clock.now()), byMemberId: null });
  } else if (open === null) {
    await createNeedsYouItemInTx(deps, tx, {
      organizationId: task.organizationId,
      projectId: task.projectId,
      taskId: task.id,
      reason: "files_outside_repos",
      audience: task.driverMemberId === null ? "project_members" : "driver",
      summary: filesSummary(paths, more),
    });
  } else {
    await setNeedsYouSummaryInTx(tx, open.id, filesSummary(paths, more));
  }
  await deps.notices.emitInTx(tx, { organizationId: task.organizationId, projectId: task.projectId, entity: "task", entityId: task.id });
};

/**
 * A `session.restored` with what became of the box before it (ticket 18), when the runner didn't
 * say: `kept` for the same box, `released` when the old one was released, else `lost`.
 */
const withPreviousBox = async (tx: Tx, taskId: TaskId, session: Session, item: RunnerEvent): Promise<RunnerEvent> => {
  if (item.event.kind !== "session.restored") {
    return item;
  }
  const previous = await tx.session.findFirst({
    where: { taskId, id: { not: session.id }, startedAt: { lte: session.startedAt } },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    select: { boxId: true },
  });
  const previousBoxId = previous?.boxId ?? null;
  if (previousBoxId === null) {
    return item;
  }
  const box = await tx.box.findUnique({ where: { id: previousBoxId }, select: { state: true } });
  const previousBox = previousBoxId === session.boxId ? "kept" : box?.state === "released" ? "released" : "lost";
  return { ...item, event: { ...item.event, previousBox } };
};

/** A turn's agent time in ms, clamped to the column. */
const agentTimeMs = (startedAt: number, endedAt: number): number => Math.min(Math.max(0, endedAt - startedAt), 2_147_483_647);

/** The session's ID, branded: the row was found by it. */
const item0SessionId = (session: Session): SessionId => sessionIdSchema.parse(session.id);

/** What the stored events imply, in the same transaction (ticket 25). */
const applyEffects = async (
  deps: IngestEventsDeps,
  runnerId: RunnerId,
  task: LockedTask,
  session: Session,
  stored: readonly Stored[],
): Promise<void> => {
  const moveDeps: TaskMoveDeps = { tx: deps.tx, notices: deps.notices, jobs: deps.jobs, ...(deps.logger === undefined ? {} : { logger: deps.logger }) };
  const { tx } = deps;
  // The rows move as the events go: re-read the session after each move so the next one sees it.
  let current = session;
  let taskRow: LockedTask = task;
  const reloadSession = async (): Promise<void> => {
    current = await tx.session.findUniqueOrThrow({ where: { id: session.id } });
  };
  const reloadTask = async (): Promise<void> => {
    taskRow = (await lockTaskRow(tx, task.id)) ?? taskRow;
  };
  const organizationId = organizationIdSchema.parse(task.organizationId);
  const sessionRef = { organizationId, taskId: task.id, sessionId: item0SessionId(session) };
  for (const { item, seq } of stored) {
    const event = item.event;
    switch (event.kind) {
      case "turn.started": {
        const ordinal = (await tx.turn.count({ where: { sessionId: session.id } })) + 1;
        await tx.turn.create({
          data: {
            organizationId: task.organizationId,
            projectId: task.projectId,
            taskId: task.id,
            sessionId: session.id,
            ordinal,
            startSeq: seq,
            startedAt: new Date(item.at),
            // F-137 (ADR 0066): the level the turn ran at, and the one asked for when it was clamped.
            ...(event.effort === undefined ? {} : { effort: effortLevelToDb[event.effort] }),
            ...(event.adjustedFrom === undefined ? {} : { effortAdjustedFrom: effortLevelToDb[event.adjustedFrom] }),
          },
        });
        if (current.state === "starting" || current.state === "idle") {
          const starting = current.state === "starting";
          const moved = await moveSessionInTx(moveDeps, current, { type: starting ? "agent_ready" : "turn_started" });
          await reloadSession();
          if (moved) {
            // The session's maximum duration counts from its first turn (F-068); a turn after an
            // earlier window ran out while it idled gets a fresh one (one job per session key).
            await startSessionTimersInTx(deps, tx, sessionRef);
          }
        }
        if (current.boxId !== null) {
          // The box is in use: ready, or warm again after idling (F-096); its idle timer goes.
          await markBoxBusyInTx(tx, current.boxId, new Date(item.at));
          await cancelBoxIdleTimerInTx(deps, tx, { organizationId, taskId: task.id, boxId: boxIdSchema.parse(current.boxId) });
        }
        if (taskRow.state !== "running") {
          await moveTaskInTx(moveDeps, taskRow, { type: "box_ready" });
          await reloadTask();
        }
        break;
      }
      case "turn.ended":
      case "turn.failed": {
        const open = await tx.turn.findFirst({
          where: { sessionId: session.id, endedAt: null },
          orderBy: { ordinal: "desc" },
          select: { id: true, startedAt: true },
        });
        if (open !== null) {
          await tx.turn.update({
            where: { id: open.id },
            data: {
              endedAt: new Date(item.at),
              stopReason: event.kind === "turn.ended" ? event.stopReason : "failed",
              // F-084: the agent's time in the turn, from its start to its end. The wait between turns is in neither.
              agentMs: agentTimeMs(open.startedAt.getTime(), item.at),
            },
          });
        }
        await moveSessionInTx(moveDeps, current, { type: "turn_ended" });
        await reloadSession();
        break;
      }
      case "agent.message":
      case "agent.thought":
        // The completed text is the event: its partial text is gone (ADR 0035).
        await tx.$executeRaw`DELETE FROM ${Prisma.raw(LIVE_TEXT_TABLE)} WHERE "taskId" = ${task.id} AND "segmentId" = ${event.segmentId}`;
        break;
      case "usage.recorded": {
        // F-068, Q163: priced on its four kinds with the model's prices; a model with no price is
        // counted in tokens only. Clamped to the column, so a runaway count can't refuse the event.
        // Milestone 4 (F-135, ADR 0065): priced from the session's own model row and counted against
        // its own provider. An event naming another provider or row is logged and counted as the
        // session's: a runner can't move spend onto another key.
        const ownModelId = current.modelId ?? event.modelId;
        if ((current.providerId !== null && event.providerId !== current.providerId) || ownModelId !== event.modelId) {
          deps.logger?.warn("usage.provider-mismatch", { taskId: task.id, sessionId: session.id, providerId: event.providerId, modelId: event.modelId });
        }
        const model = await tx.model.findFirst({
          where: { id: ownModelId, organizationId },
          select: { inputPricePerMTok: true, outputPricePerMTok: true, cacheReadPricePerMTok: true, cacheWritePricePerMTok: true },
        });
        const prices = model === null ? null : modelTokenPrices(model);
        const cost = prices === null ? 0 : priceTokens(prices, event);
        await tx.session.update({
          where: { id: session.id },
          data: {
            inputTokens: { increment: event.inputTokens },
            outputTokens: { increment: event.outputTokens },
            cacheReadTokens: { increment: event.cacheReadTokens },
            cacheWriteTokens: { increment: event.cacheWriteTokens },
            // F-137: the reasoning subset, already inside `outputTokens` and priced with it.
            reasoningTokens: { increment: event.reasoningTokens ?? 0 },
          },
        });
        if (cost > 0) {
          await tx.$executeRaw`UPDATE "session" SET "spentMicroUsd" = LEAST("spentMicroUsd"::bigint + ${cost}, 2147483647) WHERE "id" = ${session.id}`;
          await tx.$executeRaw`UPDATE "task" SET "spentMicroUsd" = LEAST("spentMicroUsd"::bigint + ${cost}, 2147483647) WHERE "id" = ${task.id}`;
        }
        // Milestone 4 (F-037, ticket 12): the project's, day's and model's rollup, and a `budget.check`
        // when this call takes a budget's month past its warn share or 100%. A model of another
        // organization has no row here, so it's never counted.
        if (model !== null) {
          await recordSpendInTx({ jobs: deps.jobs, budgetWarnPercent: deps.budgetWarnPercent }, tx, {
            organizationId,
            projectId: projectIdSchema.parse(task.projectId),
            modelId: modelIdSchema.parse(ownModelId),
            at: item.at,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            cacheReadTokens: event.cacheReadTokens,
            cacheWriteTokens: event.cacheWriteTokens,
            spentMicroUsd: prices === null ? null : cost,
          });
        }
        // F-084: the turn it belongs to (the session's latest, open while the agent works) keeps its own figures.
        const turn = await tx.turn.findFirst({ where: { sessionId: session.id }, orderBy: { ordinal: "desc" }, select: { id: true } });
        if (turn !== null) {
          await tx.turn.update({
            where: { id: turn.id },
            data: {
              inputTokens: { increment: event.inputTokens },
              outputTokens: { increment: event.outputTokens },
              cacheReadTokens: { increment: event.cacheReadTokens },
              cacheWriteTokens: { increment: event.cacheWriteTokens },
              reasoningTokens: { increment: event.reasoningTokens ?? 0 },
              ...(event.estimated ? { estimated: true } : {}),
            },
          });
          if (cost > 0) {
            await tx.$executeRaw`UPDATE "turn" SET "spentMicroUsd" = LEAST("spentMicroUsd"::bigint + ${cost}, 2147483647) WHERE "id" = ${turn.id}`;
          }
        }
        break;
      }
      case "memory.used":
        // F-110 (ticket 15): every row is kept; only a read or a search moves a note's last use (Q91).
        await recordMemoryUse(tx, { organizationId, taskId: task.id, sessionId: sessionRef.sessionId, noteIds: event.noteIds, via: event.via, at: item.at });
        break;
      case "provider.rate_limited": {
        // F-088, F-089: the key proxy saw a rate limit, so new dispatches wait on that provider. A
        // runner can only hold the provider its own session's model runs on, never another one.
        // Milestone 4 (F-135): the provider the session recorded at its start.
        if (current.providerId === event.providerId) {
          await holdProviderInTx(tx, task.organizationId, event.providerId, new Date(deps.clock.now() + event.retryAfterSeconds * 1000));
        } else {
          deps.logger?.warn("ingest.rate-limit-for-another-provider", { taskId: task.id, sessionId: session.id, providerId: event.providerId });
        }
        break;
      }
      case "git.pushed":
        if (event.ref === `refs/heads/${event.branch}`) {
          // The branch exists from its first push, however the session ends: a stop or a crash sends
          // no `session.ended`, and its branch must still read as pushed, ready to reopen (F-025).
          const rows = await tx.taskRepo.findMany({ where: { taskId: task.id, repoId: event.repoId, branchName: event.branch } });
          for (const row of rows) {
            const state = taskRepoFromColumns(row);
            const pushed = state.ok ? transitionTaskRepo(state.value, { type: "pushed" }) : null;
            await tx.taskRepo.update({
              where: { id: row.id },
              data: { headSha: event.headSha, ...(pushed?.ok === true ? { state: taskRepoToColumns(pushed.state).state, ahead: true } : {}) },
            });
          }
        }
        break;
      case "pr.text_set":
        await tx.taskRepo.updateMany({
          where: { taskId: task.id, repoId: event.repoId },
          data: { prTitle: event.title, prBody: event.body },
        });
        break;
      case "session.ended":
        // The reaction runs as a job (ticket 27): PRs, or needs you when nothing changed.
        await deps.jobs.enqueueInTx(tx, "task.session-ended", {
          organizationId: task.organizationId,
          taskId: task.id,
          sessionId: item.sessionId,
          eventSeq: seq,
        });
        break;
      case "session.crashed": {
        // Needs you for the driver; the box failed; the branch, the hidden ref and the last archive
        // stay, and a reopen carries on from them (ticket 27, F-047). The lease ends with the session,
        // so the runner's slot is free for its next task: the runner already freed its own, and a
        // lease left active keeps the server counting it.
        await moveSessionInTx(moveDeps, current, { type: "crash" });
        await reloadSession();
        await endSessionTimersInTx(deps, tx, sessionRef);
        // A reopen's turn that crashed after its save moved the task back to review still owes its
        // message: the task needs you, and the one-click reopen replays it (F-047).
        const unanswered = taskRow.state === "in_review" && (await unansweredMessagesInTx(tx, taskIdSchema.parse(task.id))).length > 0;
        const moved = await moveTaskInTx(moveDeps, taskRow, { type: "crashed", unanswered });
        await reloadTask();
        if (moved) {
          await createNeedsYouItemInTx(deps, tx, {
            organizationId: task.organizationId,
            projectId: task.projectId,
            taskId: task.id,
            reason: "crashed",
            audience: "driver",
          });
        }
        if (current.boxId !== null) {
          await tx.box.updateMany({
            where: { id: current.boxId, state: { in: ["creating", "preparing", "ready", "idle"] } },
            data: { state: "failed", failedReason: "the session crashed" },
          });
        }
        // After the box failed, so the release keeps its reason. The fence already checked that
        // this event carries the task's current epoch, so the active lease is this session's.
        await releaseLeaseInTx(tx, task.id, new Date(deps.clock.now()), "released", deps);
        break;
      }
      case "service.failed": {
        // Milestone 3 (F-094, ticket 27): a service that didn't start fails the setup, as a failed
        // setup script does: needs you, naming the service and the runner's words for why. A
        // service failing later, after the box was ready, is stored for the environment page only.
        if (taskRow.state !== "preparing") {
          break;
        }
        await moveSessionInTx(moveDeps, current, { type: "crash" });
        await reloadSession();
        await endSessionTimersInTx(deps, tx, sessionRef);
        const moved = await moveTaskInTx(moveDeps, taskRow, { type: "setup_failed" });
        await reloadTask();
        if (moved) {
          await createNeedsYouItemInTx(deps, tx, {
            organizationId: task.organizationId,
            projectId: task.projectId,
            taskId: task.id,
            reason: "setup_failed",
            audience: "driver",
            summary: `The ${event.name} service didn't start: ${event.reason}`.slice(0, 2_000),
          });
        }
        if (current.boxId !== null) {
          await tx.box.updateMany({
            where: { id: current.boxId, state: { in: ["creating", "preparing", "ready", "idle"] } },
            data: { state: "failed", failedReason: `the ${event.name} service failed` },
          });
        }
        await releaseLeaseInTx(tx, task.id, new Date(deps.clock.now()), "released", deps);
        break;
      }
      case "approval.requested":
        // Milestone 3 (ticket 17, F-026): the approval, its item, needs you, the fan-out.
        await recordApprovalRequestedInTx(deps, { task: taskRow, session: current, runnerId, event });
        await reloadSession();
        await reloadTask();
        break;
      case "approval.auto_answered":
        await recordApprovalAutoAnsweredInTx(deps, { task: taskRow, session: current, event });
        await reloadSession();
        await reloadTask();
        break;
      case "approval.closed":
        await recordApprovalClosedInTx(deps, { task: taskRow, session: current, event });
        await reloadSession();
        await reloadTask();
        break;
      case "question.asked":
        // Milestone 3 (ticket 18, F-024): the driver's item, needs you, the fan-out.
        await recordQuestionAskedInTx(deps, { task: taskRow, session: current, event });
        await reloadSession();
        await reloadTask();
        break;
      case "plan.proposed":
        // Milestone 3 (ticket 18, F-063): planState proposed, the plan item, needs you, the fan-out.
        await recordPlanProposedInTx(deps, { task: taskRow, event });
        await reloadTask();
        break;
      case "workspace.files_outside_repos":
        // Q133, ticket 44: one open item per task, updated as the set changes, closed when it's empty.
        await applyFilesOutsideReposInTx(deps, taskRow, event.paths, event.more);
        break;

      case "session.saved": {
        // After every turn (ticket 17): heads, hidden refs, the archive, then PRs or needs you.
        const saved = await recordWorkSaved(
          { tx, jobs: deps.jobs, notices: deps.notices, clock: deps.clock, timers: deps.timers, logger: deps.logger, reviewLoop: deps.reviewLoop },
          { organizationId, taskId: task.id, sessionId: sessionRef.sessionId, event, eventSeq: seq },
        );
        if (!saved.ok) {
          deps.logger?.warn("ingest.work-saved-refused", { taskId: task.id, sessionId: session.id, error: saved.error });
        }
        // Milestone 4 (F-111, ticket 16): the profile's closing turn, after a turn with changes.
        if (saved.ok && deps.outbox !== undefined) {
          const closing = await sendClosingTurnInTx(
            { outbox: deps.outbox, notices: deps.notices, clock: deps.clock },
            tx,
            { organizationId, taskId: task.id, sessionId: sessionRef.sessionId, savedSeq: seq, event },
          );
          if (closing === "sent" || closing === "held") {
            deps.logger?.info("ingest.closing-turn", { taskId: task.id, sessionId: session.id, outcome: closing });
          }
        }
        await reloadSession();
        await reloadTask();
        break;
      }
      case "check.started":
        // F-054, ticket 23: the check's run of this turn, until its `check.finished`.
        await recordCheckStartedInTx(tx, task, { sessionId: sessionRef.sessionId, checkId: event.checkId, repoId: event.repoId, name: event.name, at: item.at });
        break;
      case "check.finished":
        // Its result and the full output's blob; the PR opener reads it after `session.saved`.
        await recordCheckFinishedInTx(tx, {
          taskId: task.id,
          sessionId: sessionRef.sessionId,
          checkId: event.checkId,
          status: event.status,
          exitCode: event.exitCode,
          durationMs: event.durationMs,
          outputBlobId: event.outputBlobId,
          at: item.at,
        });
        break;
      case "session.limit_reached": {
        // The runner's key proxy stopped the session at the spend cap (ticket 19, F-068).
        if (deps.outbox === undefined) {
          deps.logger?.warn("ingest.limit-without-outbox", { taskId: task.id, sessionId: session.id });
          break;
        }
        const reached = await recordLimitReached(
          { tx, outbox: deps.outbox, jobs: deps.jobs, notices: deps.notices, clock: deps.clock, timers: deps.timers, logger: deps.logger },
          { organizationId, taskId: task.id, sessionId: sessionRef.sessionId, limit: event.limit, observed: event.observed, by: "runner" },
        );
        if (!reached.ok) {
          deps.logger?.info("ingest.limit-refused", { taskId: task.id, sessionId: session.id, error: reached.error });
        }
        await reloadSession();
        await reloadTask();
        break;
      }
      case "session.restored": {
        // Ticket 18: how the session came back. A conflict between the saved work and the
        // branch's new commits restores nothing and the task carries on from the branch's head;
        // the driver hears it (ADR 0039, Q150), and the task doesn't move.
        if (event.origin !== undefined) {
          await tx.session.update({ where: { id: session.id }, data: { origin: event.origin } });
        }
        if (event.hiddenRef === "conflict") {
          const open = await tx.needsYouItem.findFirst({ where: { taskId: task.id, reason: "restore_conflict", state: "open" }, select: { id: true } });
          if (open === null) {
            await createNeedsYouItemInTx(deps, tx, {
              organizationId: task.organizationId,
              projectId: task.projectId,
              taskId: task.id,
              reason: "restore_conflict",
              audience: task.driverMemberId === null ? "project_members" : "driver",
              summary: "The last turn's unfinished work conflicted with commits pushed to the branch since, so it wasn't restored. The agent carries on from the branch's head.",
            });
            await deps.notices.emitInTx(tx, { organizationId: task.organizationId, projectId: task.projectId, entity: "task", entityId: task.id });
          }
        }
        break;
      }
      case "user.message":
      case "turn.cancel_requested":
      case "agent.content":
      case "tool.called":
      case "tool.progress":
      case "tool.completed":
      case "tool.failed":
      case "approval.answered":
      case "question.answered":
      // A question the turn's end closed keeps its item open: its answer reopens the task (ticket 18).
      case "question.closed":
      case "plan.updated":
      case "compaction.updated":
      case "session.config_changed":
      case "driver.changed":
      case "runner.connected":
      case "runner.lost":
      case "pr.opened":
      case "agent.unknown":
      case "environment.setup_started":
      case "environment.setup_output":
      case "environment.setup_finished":
      case "session.usage":
      // Protocol minor 1: stored for now. Ticket 26 (ticket files) gives it its reaction.
      case "ticket.files_ready":
      // Protocol minor 2 (milestone 3): stored for now. Tickets 18 (plans), 23 (checks), 26
      // (snapshots) and 27 (services) give them their reactions; the server-only ones never come
      // from a runner, since the gateway refuses them.
      case "plan.answered":
      case "snapshot.built":
      case "snapshot.failed":
      // `service.healthy` is stored on the box's session: the environment page reads a service's
      // health on its last box from it (F-094, ticket 40).
      case "service.healthy":
      case "diff.comments_sent":
      case "ticket.closed":
      case "pr.comment_received":
      case "memory.proposed":
      case "turn.held":
      case "turn.released":
      case "review.check_updated":
      case "pr.related_updated":
      case "effort.changed":
      // Protocol minor 4 (milestone 5): stored for the task page. A runner sends `box.waiting` and
      // `box.scheduled` as runner events, which core records on the box's row (`box-wait.ts`); in
      // a session they move nothing. The server-only ones never come from a runner.
      case "box.waiting":
      case "box.scheduled":
      case "task.cancelled":
      case "runner.drained":
      case "runner.resumed":
      // Protocol minor 5 (milestone 6): stored for the task page. `question.auto_answered` and
      // `commit.filtered` come from a runner's automatic or onboarding turn and move nothing here
      // (tickets 18 and 21 read them); the server-only ones never come from a runner.
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
      // Protocol minor 6 (milestone 7, F-138): a subagent's start and its states, stored for the
      // task page's tree; the turn's wait for them is the runner's (ADR 0067), so nothing moves here.
      case "subagent.started":
      case "subagent.status":
        // Stored for the task page; nothing else moves.
        break;
      default:
        event satisfies never;
    }
  }
};

const ingestSession = async (
  deps: IngestEventsDeps,
  runnerId: RunnerId,
  sessionId: SessionId,
  items: readonly RunnerEvent[],
): Promise<SessionIngestOutcome> => {
  const { tx } = deps;
  const found = await tx.session.findUnique({ where: { id: sessionId }, select: { taskId: true } });
  if (found === null) {
    return { kind: "unknown-session", sessionId };
  }
  const task = await lockTaskRow(tx, taskIdSchema.parse(found.taskId));
  if (task === null) {
    return { kind: "unknown-session", sessionId };
  }
  // The session's cursor is read again under the task's lock: a batch that waited on the lock
  // behind another of this session's must see the cursor that one left, not the one before it.
  const session = await tx.session.findUnique({ where: { id: sessionId } });
  if (session === null) {
    return { kind: "unknown-session", sessionId };
  }
  // The session is this runner's only if it holds, or held, a lease of the task. Another runner's
  // session, or another organization's, is unknown to it: nothing about it leaks.
  const epochs = new Set(items.map((item) => item.leaseEpoch));
  const leases = await tx.lease.findMany({
    where: { taskId: task.id, organizationId: task.organizationId, runnerId, epoch: { in: [...epochs] } },
    select: { epoch: true },
  });
  if (leases.length === 0) {
    return { kind: "unknown-session", sessionId };
  }
  // The fence (F-045): every event must carry the task's current epoch. The grace, or a newer
  // dispatch, raised it: the write is refused, never kept (Q111).
  if (items.some((item) => item.leaseEpoch !== task.leaseEpoch)) {
    return { kind: "stale-lease", sessionId, currentEpoch: task.leaseEpoch };
  }
  let cursor = session.ingestedSeq;
  const fresh: RunnerEvent[] = [];
  let duplicates = 0;
  let gap = false;
  for (const item of [...items].sort((a, b) => a.sessionSeq - b.sessionSeq)) {
    if (item.sessionSeq <= cursor) {
      duplicates += 1;
      continue;
    }
    if (item.sessionSeq !== cursor + 1) {
      // A gap can never be committed: what came before it is saved, the rest is asked for again.
      gap = true;
      break;
    }
    fresh.push(item.event.kind === "session.restored" && item.event.previousBox === undefined ? await withPreviousBox(tx, task.id, session, item) : item);
    cursor = item.sessionSeq;
  }
  let headSeq = 0;
  const stored: Stored[] = [];
  if (fresh.length > 0) {
    const counter = await tx.task.update({
      where: { id: task.id },
      data: { eventSeq: { increment: fresh.length } },
      select: { eventSeq: true },
    });
    headSeq = counter.eventSeq;
    const firstSeq = headSeq - fresh.length + 1;
    fresh.forEach((item, index) => {
      stored.push({ item, seq: taskSeqSchema.parse(firstSeq + index) });
    });
    await tx.event.createMany({
      data: stored.map(({ item, seq }) => ({
        organizationId: task.organizationId,
        projectId: task.projectId,
        taskId: task.id,
        seq,
        sessionId,
        sessionSeq: item.sessionSeq,
        leaseEpoch: item.leaseEpoch,
        kind: item.event.kind,
        payload: storableEvent(item.event),
        occurredAt: new Date(item.at),
      })),
    });
    // Search (ticket 11): each message and tool call is found by its words, in this same transaction.
    await writeEventSearchEntries(
      tx,
      { organizationId: organizationIdSchema.parse(task.organizationId), projectId: projectIdSchema.parse(task.projectId), taskId: taskIdSchema.parse(task.id) },
      stored.map(({ item, seq }) => ({ seq, event: item.event })),
    );
    await tx.session.update({ where: { id: sessionId }, data: { ingestedSeq: cursor } });
    await applyEffects(deps, runnerId, task, session, stored);
    // One wake-up per task per batch, which commits with it: IDs and the newest seq, never content.
    await tx.$executeRaw`SELECT pg_notify(${notifyChannels.taskEvents}, ${JSON.stringify({ taskId: task.id, seq: headSeq })})`;
  } else {
    headSeq = task.eventSeq;
  }
  if (gap) {
    return { kind: "gap", sessionId, upTo: cursor, resendFrom: cursor + 1 };
  }
  return {
    kind: "saved",
    sessionId,
    taskId: task.id,
    upTo: cursor,
    headSeq: taskSeqSchema.parse(Math.max(1, headSeq)),
    duplicates,
  };
};

export const ingestEvents: IngestEvents = async (deps, input) => {
  const outcomes: SessionIngestOutcome[] = [];
  for (const [sessionId, items] of bySession(input.events)) {
    outcomes.push(await ingestSession(deps, input.runnerId, sessionId, items));
  }
  return { outcomes };
};
