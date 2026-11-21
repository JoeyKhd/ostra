import type { Logger } from "@ostra/adapter-sdk";
import { mapTask } from "@ostra/db";
import type { Db } from "@ostra/db";
import { commandKindSupportedAt, leaseEpochSchema, previewRefusalWords, projectIdSchema, runnerLimits, sessionIdSchema } from "@ostra/protocol";

import { requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import type { Ports } from "../ports.ts";
import { dispatchTask } from "../use-cases/dispatch-task.ts";
import type { DispatchTaskDeps } from "../use-cases/dispatch-task.ts";
import type { StartApp } from "../use-cases/m8-preview-signatures.ts";
import { moveSessionInTx } from "../use-cases/moves.ts";
import { appendServerEvent } from "../use-cases/server-events.ts";
import { endSessionTimersInTx } from "../use-cases/sessions-m2.ts";
import type { SessionTimers } from "../use-cases/sessions-m2.ts";
import { resolveReopenProfileInTx } from "../use-cases/task-profile.ts";
import { boxPreviewability, previewBoxInTx } from "./views.ts";

// "Start the app" (milestone 8, ticket 19, F-141, Q300, ADR 0068): a stopped task's app starts
// again with no agent turn. Any member who can open the task may press it.
//
// - A task whose box still runs gets `app.start` for every process: the box keeps its lease.
// - Otherwise a lease with the purpose `app` is admitted at once, as any of the task's boxes is
//   (ADR 0059's choice and the project's caps; it takes a slot), with no budget gate, since it
//   makes no model call: a session for the app, `dispatch` with the purpose `app`, the audit entry
//   `app.started` and the event `app.started_by`, in the task's lock. The task's own state doesn't
//   move: the box runs beside it. With no runner to take it now, nothing is written and the answer
//   says so (`no-runner`, or `runner-needs-upgrade` when only runners below minor 7 could).
// - A member's message while that lease holds starts a turn in its box, through the budget gate
//   (`sendMemberMessageInTx`).

export type StartAppDeps = Pick<Ports, "jobs" | "outbox" | "notices" | "audit" | "clock"> & {
  readonly db: Db;
  readonly logger?: Logger;
  readonly timers?: SessionTimers;
  /** What the dispatch reads beyond the rows, as core's dispatcher passes it. */
  readonly dispatch?: Pick<DispatchTaskDeps, "reopen" | "effortLevels" | "personalSlots">;
};

type StartAppResult = Awaited<ReturnType<StartApp>>;

/** The errors thrown inside the transaction to roll back a start no runner took, with the dispatch's wait code: nothing of it is kept. */
const noRunnerCodes = new WeakMap<Error, string>();

const noRunnerError = (code: string): Error => {
  const error = new Error("no runner took the app's start");
  noRunnerCodes.set(error, code);
  return error;
};

const refused = (error: Extract<StartAppResult, { readonly ok: false }>["error"], message: string): StartAppResult => ({ ok: false, error, message });

export const startApp = async (deps: StartAppDeps, scope: MemberScope, input: Parameters<StartApp>[2]): Promise<StartAppResult> => {
  const organizationId = scope.organizationId;
  try {
    return await deps.db.$transaction(
      async (tx): Promise<StartAppResult> => {
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
        const access = requireProjectAccess(scope, { id: projectIdSchema.parse(project.id), organizationId, access: project.access }, "read");
        if (!access.ok) {
          return access.code === "not-found" ? refused("not-found", "No such task") : refused("forbidden", "You may not start this task's app");
        }
        if ((await tx.appProcess.count({ where: { organizationId, projectId: task.projectId } })) === 0) {
          return refused("no-app-processes", "This project's environment declares no app processes to start");
        }
        const now = deps.clock.now();
        const projectId = projectIdSchema.parse(task.projectId);

        // The box still runs: start what isn't running in it.
        const box = await previewBoxInTx(tx, organizationId, task.id);
        if (box !== null) {
          const can = boxPreviewability(box);
          if (!can.previewable && can.reason === "runner-needs-upgrade") {
            return refused(can.reason, previewRefusalWords(can.reason));
          }
          // An `app` box serves once its runner took it; a turn's box once it's made.
          const serving = box.purpose === "app" ? box.leaseAccepted : box.boxState === "ready" || box.boxState === "idle";
          if (serving && box.sessionId !== null && commandKindSupportedAt("app.start", box.minor)) {
            await deps.outbox.enqueueInTx(tx, organizationId, box.runnerId, {
              kind: "app.start",
              body: { sessionId: box.sessionId, names: null },
              notAfter: now + runnerLimits.offerTimeoutMs,
              task: { taskId: task.id, projectId },
            });
            return { ok: true, state: "running" };
          }
          return { ok: true, state: "starting" };
        }

        // No box: a lease for the app. A session that never got its box ends first: one per task.
        const sessions = await tx.session.findMany({ where: { taskId: task.id }, orderBy: [{ startedAt: "desc" }, { id: "desc" }] });
        for (const old of sessions.filter((row) => row.state === "starting" || row.state === "running" || row.state === "waiting" || row.state === "idle")) {
          await moveSessionInTx({ tx, notices: deps.notices }, old, { type: "stop" });
          await endSessionTimersInTx(deps, tx, { organizationId, taskId: task.id, sessionId: sessionIdSchema.parse(old.id) });
        }
        const profile = await resolveReopenProfileInTx(tx, scope, { task, previousSessionProfileId: sessions[0]?.agentProfileId ?? null });
        if (!profile.ok) {
          return refused("forbidden", profile.message);
        }
        const created = await tx.session.create({
          data: { organizationId, projectId, taskId: task.id, agentProfileId: profile.profileId, origin: "new", state: "starting" },
          select: { id: true },
        });
        const sessionId = sessionIdSchema.parse(created.id);
        await appendServerEvent(tx, { organizationId, projectId, taskId: task.id, sessionId, at: now, event: { kind: "app.started_by", memberId: scope.memberId } });
        const leaseEpoch = leaseEpochSchema.parse(task.leaseEpoch + 1);
        const dispatched = await dispatchTask(
          {
            tx,
            jobs: deps.jobs,
            outbox: deps.outbox,
            notices: deps.notices,
            clock: deps.clock,
            ...(deps.logger === undefined ? {} : { logger: deps.logger }),
            ...deps.dispatch,
            app: { startedByMemberId: scope.memberId },
          },
          { organizationId, taskId: task.id, sessionId, leaseEpoch },
        );
        if (!dispatched.ok) {
          throw noRunnerError(dispatched.message);
        }
        await deps.audit.recordInTx(tx, {
          organizationId,
          projectId,
          actor: { kind: "member", id: scope.memberId },
          action: "app.started",
          entity: "task",
          entityId: task.id,
          data: { sessionId, leaseEpoch, runnerId: dispatched.runnerId, boxId: dispatched.boxId },
        });
        deps.logger?.info("app.started", { taskId: task.id, sessionId, leaseEpoch, runnerId: dispatched.runnerId });
        return { ok: true, state: "starting" };
      },
      { timeout: 30_000 },
    );
  } catch (error) {
    const code = error instanceof Error ? noRunnerCodes.get(error) : undefined;
    if (code !== undefined) {
      // `needs-protocol`: only runners below minor 7 could have taken it.
      return code === "needs-protocol"
        ? refused("runner-needs-upgrade", previewRefusalWords("runner-needs-upgrade"))
        : refused("no-runner", "No runner can start this task's app now. Try again once one is free.");
    }
    throw error;
  }
};
startApp satisfies StartApp;
