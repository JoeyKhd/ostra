import type { Db, Tx } from "@ostra/db";
import { apiFormatFromDb, effortLevelToDb, mapModel, mapTask, Prisma } from "@ostra/db";
import {
  organizationIdSchema,
  PROTOCOL_MINOR,
  projectIdSchema,
  providerIdSchema,
  reasoningControlsSchema,
  runnerIdSchema,
  runnerLimits,
  sessionIdSchema,
} from "@ostra/protocol";
import type { EffortChangeId, EffortLevel, ModelId, ReasoningControls, TaskId } from "@ostra/protocol";

import { canSetTaskEffort, requireOrganizationAdmin, requireProjectAccess } from "../access.ts";
import { modelEffort } from "../effort/levels.ts";
import type { AgentEffortLevels } from "../effort/levels.ts";
import type { MemberScope } from "../access.ts";
import type { Ports } from "../ports.ts";
import type { UseCaseResult } from "./common.ts";
import { appendServerEvent } from "./server-events.ts";

// Reasoning effort's use cases (F-137, ADR 0066, milestone 4's ticket 56): an admin's controls for
// a model, and the driver's level for a running task. Each is one transaction with its audit entry
// (F-073) and its change notice; a rollback leaves neither. A task's level must be one its
// session's model offers (ticket 59); ticket 61 adds the routers.

export type EffortDeps = { readonly db: Db } & Pick<Ports, "outbox" | "notices" | "audit" | "clock"> & {
  /** Core's agent registry: the levels each agent can send for a model (ticket 57's `effortLevels`). */
  readonly effortLevels: AgentEffortLevels;
};

// ---------- a model's reasoning controls (Q286) ----------

export type SetModelReasoningInput = {
  readonly modelId: ModelId;
  /** The admin's controls, or `null` to go back to the catalog's. */
  readonly controls: ReasoningControls | null;
};

export type SetModelReasoningResult = UseCaseResult<{ readonly changed: boolean }, "not-found" | "forbidden">;

/** The controls' shape for the audit entry: what they allow, never more. */
const controlsSummary = (controls: ReasoningControls | null): string => {
  if (controls === null) {
    return "catalog";
  }
  if (!controls.supported) {
    return "none";
  }
  const parts = [
    ...(controls.toggle === true ? ["toggle"] : []),
    ...(controls.effort === undefined ? [] : [`effort:${controls.effort.join("/")}`]),
    ...(controls.budget === undefined ? [] : ["budget"]),
  ];
  return parts.length === 0 ? "no-control" : parts.join(",");
};

const sameControls = (a: ReasoningControls | null, b: ReasoningControls | null): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Sets an organization admin's reasoning controls on one provider's model, or clears them with
 * `null` so the catalog's apply again (ADR 0066, Q286). The catalog's value stays beside them, and
 * a catalog refresh writes only that one, so it never undoes the admin's.
 */
export const setModelReasoningInTx = async (
  deps: Pick<Ports, "notices" | "audit">,
  tx: Tx,
  scope: MemberScope,
  input: SetModelReasoningInput,
): Promise<SetModelReasoningResult> => {
  const row = await tx.model.findFirst({ where: { id: input.modelId, organizationId: scope.organizationId } });
  if (row === null) {
    return { ok: false, error: "not-found", message: "No such model" };
  }
  const model = mapModel(row);
  const admin = requireOrganizationAdmin(scope, model.organizationId);
  if (!admin.ok) {
    return admin.code === "not-found"
      ? { ok: false, error: "not-found", message: "No such model" }
      : { ok: false, error: "forbidden", message: "Only an organization admin can change a model's reasoning" };
  }
  if (sameControls(model.adminReasoning, input.controls)) {
    return { ok: true, changed: false };
  }
  // The controls are parsed again on the way in: the column holds only what the schema reads back.
  const adminReasoning = input.controls === null ? Prisma.DbNull : reasoningControlsSchema.parse(input.controls);
  await tx.model.update({ where: { id: model.id }, data: { adminReasoning } });
  await deps.audit.recordInTx(tx, {
    organizationId: model.organizationId,
    projectId: null,
    actor: { kind: "member", id: scope.memberId },
    action: "model.reasoning-changed",
    entity: "model",
    entityId: model.id,
    data: { from: controlsSummary(model.adminReasoning), to: controlsSummary(input.controls) },
  });
  await deps.notices.emitInTx(tx, {
    organizationId: model.organizationId,
    projectId: null,
    entity: "model-provider",
    entityId: providerIdSchema.parse(model.providerId),
  });
  return { ok: true, changed: true };
};

export type SetModelReasoning = (deps: EffortDeps, scope: MemberScope, input: SetModelReasoningInput) => Promise<SetModelReasoningResult>;

export const setModelReasoning: SetModelReasoning = (deps, scope, input) =>
  deps.db.$transaction((tx) => setModelReasoningInTx(deps, tx, scope, input));

// ---------- a task's level, from its driver (Q288) ----------

export type SetTaskEffortInput = {
  readonly taskId: TaskId;
  readonly level: EffortLevel;
  /** Fixed by the panel per change, so a retried change is applied once. */
  readonly changeId: EffortChangeId;
};

export type SetTaskEffortResult = UseCaseResult<
  {
    readonly from: EffortLevel;
    readonly to: EffortLevel;
    readonly changed: boolean;
    /** Whether a `set-effort` went to the runner holding the session; otherwise the next session starts at it. */
    readonly sentToRunner: boolean;
  },
  "not-found" | "take-over-to-change" | "level-not-offered"
>;

/** The session states a running agent holds, which a `set-effort` reaches. */
const GOING_SESSION_STATES = ["starting", "running", "waiting", "idle"] as const;

/** The first protocol minor with `set-effort`. */
const SET_EFFORT_MINOR = 3;

/**
 * Sets a task's reasoning level for its next turn (ADR 0066). Takes the task's counter lock first,
 * as a steer does (F-024, ADR 0036), so the driver read and the write commit together: a take-over
 * committed first makes the old driver's change refused. In the same transaction: the task's level,
 * `effort.changed` in the thread, the audit entry, and a `set-effort` for the runner holding a
 * going session at minor 3. With none going, the next dispatch carries the level.
 */
export const setTaskEffortInTx = async (
  deps: Pick<EffortDeps, "outbox" | "notices" | "audit" | "clock" | "effortLevels">,
  tx: Tx,
  scope: MemberScope,
  input: SetTaskEffortInput,
): Promise<SetTaskEffortResult> => {
  const organizationId = scope.organizationId;
  const locked = await tx.$queryRaw<readonly unknown[]>`
    SELECT 1 FROM "task" WHERE "id" = ${input.taskId} AND "organizationId" = ${organizationId} FOR UPDATE`;
  if (locked.length === 0) {
    return { ok: false, error: "not-found", message: "No such task" };
  }
  const task = mapTask(await tx.task.findUniqueOrThrow({ where: { id: input.taskId } }));
  const project = await tx.project.findFirst({ where: { id: task.projectId, organizationId }, select: { id: true, access: true } });
  if (project === null || !requireProjectAccess(scope, { id: projectIdSchema.parse(project.id), organizationId, access: project.access }, "read").ok) {
    return { ok: false, error: "not-found", message: "No such task" };
  }
  if (!canSetTaskEffort(scope, task)) {
    return { ok: false, error: "take-over-to-change", message: "Take over to change the reasoning level" };
  }
  // The level must be one the session's model offers, as its agent can send it (ADR 0066): the
  // panel offers only those, so another is refused, naming them.
  // The session's model row (F-135), else its profile's; the profile is the session's, else the
  // task's, else the project's default code profile before the task has a session.
  const latest = await tx.session.findFirst({ where: { taskId: task.id }, orderBy: { startedAt: "desc" }, select: { agentProfileId: true, modelId: true } });
  const profileId =
    latest?.agentProfileId ??
    task.agentProfileId ??
    (await tx.project.findFirst({ where: { id: task.projectId, organizationId }, select: { defaultCodeProfileId: true } }))?.defaultCodeProfileId ??
    null;
  const profile = profileId === null ? null : await tx.agentProfile.findFirst({ where: { id: profileId, organizationId }, select: { adapter: true, modelId: true } });
  const modelId = latest?.modelId ?? profile?.modelId ?? null;
  const model = modelId === null ? null : await tx.model.findFirst({ where: { id: modelId, organizationId }, include: { provider: true } });
  const levels =
    profile === null || model === null
      ? (["default"] as const)
      : modelEffort(deps.effortLevels, {
          adapter: profile.adapter,
          apiFormat: apiFormatFromDb[model.provider.apiFormat],
          model: mapModel(model),
          level: input.level,
        }).levels;
  if (!levels.includes(input.level)) {
    return { ok: false, error: "level-not-offered", message: `This model offers these levels: ${levels.join(", ")}` };
  }
  const from = task.effort;
  if (from === input.level) {
    return { ok: true, from, to: input.level, changed: false, sentToRunner: false };
  }
  const now = deps.clock.now();
  const projectId = task.projectId;
  await tx.task.update({ where: { id: task.id }, data: { effort: effortLevelToDb[input.level] } });
  const session = await tx.session.findFirst({ where: { taskId: task.id }, orderBy: { startedAt: "desc" }, select: { id: true } });
  if (session !== null) {
    await appendServerEvent(tx, {
      organizationId: organizationIdSchema.parse(organizationId),
      projectId,
      taskId: task.id,
      sessionId: sessionIdSchema.parse(session.id),
      at: now,
      event: { kind: "effort.changed", from, to: input.level, memberId: scope.memberId },
    });
  }
  let sentToRunner = false;
  const going = await tx.session.findFirst({
    where: { taskId: task.id, state: { in: [...GOING_SESSION_STATES] } },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });
  const lease = going === null ? null : await tx.lease.findFirst({ where: { taskId: task.id, state: "active" }, select: { runnerId: true } });
  if (going !== null && lease !== null) {
    const runnerId = runnerIdSchema.parse(lease.runnerId);
    const minor = (await tx.runnerPresence.findUnique({ where: { runnerId }, select: { minor: true } }))?.minor ?? PROTOCOL_MINOR;
    if (minor >= SET_EFFORT_MINOR) {
      await deps.outbox.enqueueInTx(tx, organizationIdSchema.parse(organizationId), runnerId, {
        kind: "set-effort",
        body: { sessionId: sessionIdSchema.parse(going.id), level: input.level, changeId: input.changeId },
        notAfter: now + runnerLimits.offerTimeoutMs,
        task: { taskId: task.id, projectId },
      });
      sentToRunner = true;
    }
  }
  await deps.audit.recordInTx(tx, {
    organizationId: organizationIdSchema.parse(organizationId),
    projectId,
    actor: { kind: "member", id: scope.memberId },
    action: "task.effort-changed",
    entity: "task",
    entityId: task.id,
    data: { from, to: input.level },
  });
  await deps.notices.emitInTx(tx, { organizationId: organizationIdSchema.parse(organizationId), projectId, entity: "task", entityId: task.id });
  return { ok: true, from, to: input.level, changed: true, sentToRunner };
};

export type SetTaskEffort = (deps: EffortDeps, scope: MemberScope, input: SetTaskEffortInput) => Promise<SetTaskEffortResult>;

export const setTaskEffort: SetTaskEffort = (deps, scope, input) => deps.db.$transaction((tx) => setTaskEffortInTx(deps, tx, scope, input));
