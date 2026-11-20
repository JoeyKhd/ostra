import { Prisma } from "@ostra/db";
import type { Tx } from "@ostra/db";
import { automationIdSchema, projectIdSchema } from "@ostra/protocol";
import type { AutomationId, OrganizationId, ProjectId } from "@ostra/protocol";

import { requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import type { AutomationSettings, DeleteAutomation, M6Deps, PauseAutomation, SaveAutomation } from "../use-cases/m6-signatures.ts";
import { isTimeZone, minimumIntervalOk, nextOccurrence, parseCron } from "./cron.ts";
import { pauseAutomationInTx } from "./intake.ts";
import type { StartPorts } from "../starts/start-task-body.ts";

// Saving, pausing and deleting an automation (F-011, F-106, ADR 0056; milestone 6's tickets 10 and
// 11, called by ticket 24's router). A project admin writes them. Saving a schedule recomputes its
// next occurrence from now, so an edit takes effect at the next tick and never fires a past time;
// so does a resume. A delete is soft: the automation starts nothing more, at the next tick, and its
// runs stay for its tasks' history. A schedule's prompt is never logged nor put in an audit entry.

/** `OSTRA_SCHEDULE_MIN_INTERVAL_MINUTES`'s default. */
export const SCHEDULE_MIN_INTERVAL_MINUTES_DEFAULT = 60;

const NAME_MAX = 200;
const PROMPT_MAX = 262_144;

export type ManageOptions = {
  /** `OSTRA_SCHEDULE_MIN_INTERVAL_MINUTES`. */
  readonly scheduleMinIntervalMinutes?: number;
};

type AdminCheck = { readonly ok: true; readonly projectId: ProjectId } | { readonly ok: false; readonly error: "forbidden" | "not-found"; readonly message: string };

/** The project, for a project admin; another organization's or a hidden project is `not-found`. */
const projectAdminInTx = async (tx: Pick<Tx, "project">, scope: MemberScope, projectId: string): Promise<AdminCheck> => {
  const project = await tx.project.findFirst({ where: { id: projectId, organizationId: scope.organizationId }, select: { id: true, access: true } });
  if (project === null) {
    return { ok: false, error: "not-found", message: "No such project" };
  }
  const id = projectIdSchema.parse(project.id);
  const access = requireProjectAccess(scope, { id, organizationId: scope.organizationId, access: project.access }, "admin");
  if (!access.ok) {
    return access.code === "not-found" ? { ok: false, error: "not-found", message: "No such project" } : { ok: false, error: "forbidden", message: "Only a project admin changes its automations" };
  }
  return { ok: true, projectId: id };
};

/** The columns a schedule's settings write, or why they're refused. */
type ScheduleColumns =
  | { readonly ok: true; readonly schedule: string; readonly timeZone: string; readonly nextOccurrenceAt: Date | null }
  | { readonly ok: false; readonly error: "invalid-input" | "schedule-too-often"; readonly message: string };

/** A schedule's next occurrence after `now` in its zone: what a save and a resume set. */
export const scheduleColumnsAt = (schedule: string, timeZone: string, now: number, minIntervalMinutes: number): ScheduleColumns => {
  const parsed = parseCron(schedule);
  if (!parsed.ok) {
    return { ok: false, error: "invalid-input", message: `The schedule isn't valid: ${parsed.reason}` };
  }
  if (!isTimeZone(timeZone)) {
    return { ok: false, error: "invalid-input", message: "The time zone isn't one ostra knows" };
  }
  if (!minimumIntervalOk(parsed.cron, minIntervalMinutes)) {
    return { ok: false, error: "schedule-too-often", message: `A schedule runs at most once every ${String(minIntervalMinutes)} minutes` };
  }
  const next = nextOccurrence(parsed.cron, timeZone, now);
  return { ok: true, schedule: parsed.cron.source, timeZone, nextOccurrenceAt: next === null ? null : new Date(next) };
};

/** An automation's columns from its settings. Never logs the prompt. */
const columnsOf = (settings: AutomationSettings, now: number, minIntervalMinutes: number) => {
  const base = {
    name: settings.name.trim().slice(0, NAME_MAX),
    taskKind: settings.taskKind,
    agentProfileId: settings.agentProfileId,
    poolLabels: [...new Set(settings.poolLabels)].sort(),
    requireApproval: settings.requireApproval,
  };
  switch (settings.kind) {
    case "intake_rule":
      return { ok: true as const, columns: { ...base, kind: settings.kind, filter: settings.filter, schedule: null, nextOccurrenceAt: null, prompt: null, title: null } };
    case "schedule": {
      const schedule = scheduleColumnsAt(settings.schedule, settings.timeZone, now, minIntervalMinutes);
      if (!schedule.ok) {
        return schedule;
      }
      const does =
        settings.does.kind === "filter"
          ? { filter: settings.does.filter, prompt: null, title: null }
          : settings.does.prompt.trim() === "" || settings.does.prompt.length > PROMPT_MAX || settings.does.title.trim() === ""
            ? null
            : { filter: null, prompt: settings.does.prompt, title: settings.does.title.trim().slice(0, 512) };
      if (does === null) {
        return { ok: false as const, error: "invalid-input" as const, message: "A prompt schedule has a title and a prompt" };
      }
      return {
        ok: true as const,
        columns: {
          ...base,
          kind: settings.kind,
          schedule: schedule.schedule,
          timeZone: schedule.timeZone,
          nextOccurrenceAt: schedule.nextOccurrenceAt,
          skipWhileOpen: settings.skipWhileOpen,
          filter: does.filter ?? null,
          prompt: does.prompt,
          title: does.title,
        },
      };
    }
    default:
      return settings satisfies never;
  }
};

export const saveAutomation = async (deps: StartPorts & ManageOptions, scope: Parameters<SaveAutomation>[1], input: Parameters<SaveAutomation>[2]): ReturnType<SaveAutomation> => {
  if (input.settings.name.trim() === "") {
    return { ok: false, error: "invalid-input", message: "An automation has a name" };
  }
  const now = deps.clock.now();
  const made = columnsOf(input.settings, now, deps.scheduleMinIntervalMinutes ?? SCHEDULE_MIN_INTERVAL_MINUTES_DEFAULT);
  if (!made.ok) {
    return made;
  }
  const { columns } = made;
  return deps.db.$transaction(async (tx): ReturnType<SaveAutomation> => {
    const admin = await projectAdminInTx(tx, scope, input.projectId);
    if (!admin.ok) {
      return admin;
    }
    const organizationId = scope.organizationId;
    const taken = await tx.automation.findFirst({
      where: { organizationId, projectId: admin.projectId, deletedAt: null, name: { equals: columns.name, mode: "insensitive" }, ...(input.automationId === null ? {} : { id: { not: input.automationId } }) },
      select: { id: true },
    });
    if (taken !== null) {
      return { ok: false, error: "name-taken", message: "Another automation of this project has that name" };
    }
    const data = { ...columns, filter: columns.filter ?? Prisma.DbNull, updatedByMemberId: scope.memberId };
    let automationId: AutomationId;
    if (input.automationId === null) {
      const row = await tx.automation.create({ data: { ...data, organizationId, projectId: admin.projectId, createdByMemberId: scope.memberId }, select: { id: true } });
      automationId = automationIdSchema.parse(row.id);
    } else {
      const updated = await tx.automation.updateMany({
        where: { id: input.automationId, organizationId, projectId: admin.projectId, deletedAt: null, kind: columns.kind },
        data,
      });
      if (updated.count === 0) {
        return { ok: false, error: "not-found", message: "No such automation" };
      }
      automationId = input.automationId;
    }
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: admin.projectId,
      actor: { kind: "member", id: scope.memberId },
      action: input.automationId === null ? "automation.created" : "automation.updated",
      entity: "automation",
      entityId: automationId,
      // Settings only: never the prompt nor the filter's values.
      data: { kind: columns.kind, taskKind: columns.taskKind, requireApproval: columns.requireApproval, schedule: columns.schedule },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: admin.projectId, entity: "project", entityId: admin.projectId });
    return { ok: true, automationId, nextOccurrenceAt: columns.nextOccurrenceAt?.getTime() ?? null };
  });
};

const findAutomationInTx = async (tx: Tx, scope: MemberScope, automationId: AutomationId) => {
  const row = await tx.automation.findFirst({ where: { id: automationId, organizationId: scope.organizationId, deletedAt: null } });
  if (row === null) {
    return { ok: false as const, error: "not-found" as const, message: "No such automation" };
  }
  const admin = await projectAdminInTx(tx, scope, row.projectId);
  return admin.ok ? { ok: true as const, row, projectId: admin.projectId } : admin;
};

export const pauseAutomation = async (deps: StartPorts & ManageOptions, scope: Parameters<PauseAutomation>[1], input: Parameters<PauseAutomation>[2]): ReturnType<PauseAutomation> =>
  deps.db.$transaction(async (tx): ReturnType<PauseAutomation> => {
    const found = await findAutomationInTx(tx, scope, input.automationId);
    if (!found.ok) {
      return found;
    }
    const { row, projectId } = found;
    const organizationId: OrganizationId = scope.organizationId;
    if (input.paused) {
      const paused = await pauseAutomationInTx({ tx, ...deps }, { organizationId, projectId, automationId: input.automationId, reason: "member", memberId: scope.memberId });
      if (!paused.paused) {
        return { ok: false, error: "not-allowed-in-state", message: "The automation is paused already" };
      }
      return { ok: true, pausedAt: deps.clock.now() };
    }
    if (row.pausedAt === null) {
      return { ok: false, error: "not-allowed-in-state", message: "The automation isn't paused" };
    }
    // A resume acts from now on: a schedule's next occurrence is the next one after now, never a past one.
    const now = deps.clock.now();
    const schedule = row.schedule === null ? null : scheduleColumnsAt(row.schedule, row.timeZone, now, 1);
    await tx.automation.update({
      where: { id: row.id },
      data: { pausedAt: null, pausedReason: null, updatedByMemberId: scope.memberId, ...(schedule?.ok === true ? { nextOccurrenceAt: schedule.nextOccurrenceAt } : {}) },
    });
    await deps.audit.recordInTx(tx, { organizationId, projectId, actor: { kind: "member", id: scope.memberId }, action: "automation.resumed", entity: "automation", entityId: input.automationId });
    await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "project", entityId: projectId });
    return { ok: true, pausedAt: null };
  });

export const deleteAutomation = async (deps: StartPorts, scope: Parameters<DeleteAutomation>[1], input: Parameters<DeleteAutomation>[2]): ReturnType<DeleteAutomation> =>
  deps.db.$transaction(async (tx): ReturnType<DeleteAutomation> => {
    const found = await findAutomationInTx(tx, scope, input.automationId);
    if (!found.ok) {
      return found;
    }
    const deletedAt = deps.clock.now();
    await tx.automation.update({ where: { id: found.row.id }, data: { deletedAt: new Date(deletedAt), updatedByMemberId: scope.memberId } });
    await deps.audit.recordInTx(tx, {
      organizationId: scope.organizationId,
      projectId: found.projectId,
      actor: { kind: "member", id: scope.memberId },
      action: "automation.deleted",
      entity: "automation",
      entityId: input.automationId,
    });
    await deps.notices.emitInTx(tx, { organizationId: scope.organizationId, projectId: found.projectId, entity: "project", entityId: found.projectId });
    return { ok: true, deletedAt };
  });

/** The ports the management use cases take, for a caller that holds them. */
export type ManageDeps = M6Deps & ManageOptions;
