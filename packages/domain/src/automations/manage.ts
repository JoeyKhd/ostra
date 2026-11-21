import { secretRefSchema } from "@ostra/adapter-sdk";
import type { SecretRef, SecretStoreAdapter } from "@ostra/adapter-sdk";
import { Prisma } from "@ostra/db";
import type { Tx } from "@ostra/db";
import { automationIdSchema, projectIdSchema } from "@ostra/protocol";
import type { AutomationId, OrganizationId, ProjectId } from "@ostra/protocol";

import { requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import type { AutomationSettings, DeleteAutomation, M6Deps, PauseAutomation, RotateWebhookSecret, SaveAutomation } from "../use-cases/m6-signatures.ts";
import { isTimeZone, minimumIntervalOk, nextOccurrence, parseCron } from "./cron.ts";
import { pauseAutomationInTx } from "./intake.ts";
import { newWebhookId, newWebhookSecret, WEBHOOK_SECRET_PURPOSE } from "./webhook.ts";
import { isPayloadPath, templateProblems, WEBHOOK_PROMPT_MAX } from "./webhook-template.ts";
import type { StartPorts } from "../starts/start-task-body.ts";

// Saving, pausing and deleting an automation (F-011, F-106, ADR 0056; milestone 6's tickets 10 and
// 11, called by ticket 24's router). A project admin writes them. Saving a schedule recomputes its
// next occurrence from now, so an edit takes effect at the next tick and never fires a past time;
// so does a resume. A delete is soft: the automation starts nothing more, at the next tick, and its
// runs stay for its tasks' history. A schedule's prompt is never logged nor put in an audit entry.
//
// A webhook (F-139, ADR 0056 amended 2026-11-21) gets its address's ID and its signing secret when
// it's created: the secret goes into the secret store before the transaction, is deleted again when
// the transaction refuses or fails, and comes back once, in the create's answer. "New secret" makes
// another the same way and deletes the old one once the new one is stored. Its templates and its
// filter are never logged nor put in an audit entry either.

/** `OSTRA_SCHEDULE_MIN_INTERVAL_MINUTES`'s default. */
export const SCHEDULE_MIN_INTERVAL_MINUTES_DEFAULT = 60;

const NAME_MAX = 200;
const PROMPT_MAX = 262_144;

export type ManageOptions = {
  /** `OSTRA_SCHEDULE_MIN_INTERVAL_MINUTES`. */
  readonly scheduleMinIntervalMinutes?: number;
  /** Where a webhook's signing secret is kept (F-139): needed to create a webhook, or to give it a new secret. */
  readonly secretStore?: Pick<SecretStoreAdapter, "put" | "delete">;
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
  if (!minimumIntervalOk(parsed.cron, minIntervalMinutes, timeZone)) {
    return { ok: false, error: "schedule-too-often", message: `A schedule runs at most once every ${String(minIntervalMinutes)} minutes` };
  }
  const next = nextOccurrence(parsed.cron, timeZone, now);
  return { ok: true, schedule: parsed.cron.source, timeZone, nextOccurrenceAt: next === null ? null : new Date(next) };
};

/** Why a webhook's templates or its idempotency field are refused, or `null`. Names the placeholder, never the text around it. */
const webhookRefusal = (settings: Extract<AutomationSettings, { readonly kind: "webhook" }>): string | null => {
  if (settings.title.trim() === "" || settings.prompt.trim() === "") {
    return "A webhook automation has a title and a prompt";
  }
  if (settings.prompt.length > WEBHOOK_PROMPT_MAX) {
    return "The prompt is too long";
  }
  for (const [where, template] of [["title", settings.title], ["prompt", settings.prompt]] as const) {
    const [problem] = templateProblems(template);
    if (problem !== undefined) {
      return `${problem.placeholder.slice(0, 80)} on line ${String(problem.line)} of the ${where} isn't a field of the request: write {{body.field}}, such as {{body.alert.title}}`;
    }
  }
  if (settings.idempotencyField !== null && !isPayloadPath(settings.idempotencyField)) {
    return "The idempotency key's field is a body field, such as body.alert.id";
  }
  return null;
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
    case "webhook": {
      const refusal = webhookRefusal(settings);
      if (refusal !== null) {
        return { ok: false as const, error: "invalid-input" as const, message: refusal };
      }
      return {
        ok: true as const,
        columns: {
          ...base,
          kind: settings.kind,
          filter: null,
          schedule: null,
          nextOccurrenceAt: null,
          skipWhileOpen: settings.skipWhileOpen,
          prompt: settings.prompt,
          title: settings.title.trim().slice(0, 512),
          webhookAuth: settings.auth,
          payloadFilter: settings.filter.map((condition) => ({ ...condition })),
          idempotencyField: settings.idempotencyField,
        },
      };
    }
    default:
      return settings satisfies never;
  }
};

/** Deletes a secret the store kept for a save that didn't happen, or one replaced. Best effort: a leftover opens nothing. */
const forgetSecret = async (deps: ManageOptions, organizationId: OrganizationId, ref: SecretRef | null): Promise<void> => {
  if (ref === null || deps.secretStore === undefined) {
    return;
  }
  await deps.secretStore.delete(organizationId, ref).catch(() => undefined);
};

/** A write's answer; the secret made for it is deleted again when the write refuses or fails. */
const settled = async <T extends { readonly ok: boolean }>(deps: ManageOptions, organizationId: OrganizationId, ref: SecretRef | null, work: Promise<T>): Promise<T> => {
  try {
    const result = await work;
    if (!result.ok) {
      await forgetSecret(deps, organizationId, ref);
    }
    return result;
  } catch (error) {
    await forgetSecret(deps, organizationId, ref);
    throw error;
  }
};

/** A webhook's new address and secret, its secret already in the store. */
type NewWebhook = { readonly webhookId: string; readonly secret: string; readonly ref: SecretRef };

const makeWebhookSecret = async (deps: ManageOptions, organizationId: OrganizationId): Promise<{ readonly secret: string; readonly ref: SecretRef }> => {
  if (deps.secretStore === undefined) {
    throw new Error("A webhook automation needs the secret store");
  }
  const secret = newWebhookSecret();
  const stored = await deps.secretStore.put({ organizationId, purpose: WEBHOOK_SECRET_PURPOSE }, secret);
  if (!stored.ok) {
    throw new Error(`The secret store refused the webhook's secret: ${stored.error.code}`);
  }
  return { secret, ref: stored.value };
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
  const webhook: NewWebhook | null =
    columns.kind === "webhook" && input.automationId === null ? { webhookId: newWebhookId(), ...(await makeWebhookSecret(deps, scope.organizationId)) } : null;
  return settled(deps, scope.organizationId, webhook?.ref ?? null, deps.db.$transaction(async (tx): ReturnType<SaveAutomation> => {
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
      const row = await tx.automation.create({
        data: {
          ...data,
          organizationId,
          projectId: admin.projectId,
          createdByMemberId: scope.memberId,
          ...(webhook === null ? {} : { webhookId: webhook.webhookId, webhookSecretRef: webhook.ref }),
        },
        select: { id: true },
      });
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
      // Settings only: never the prompt, the templates nor the filter's values.
      data: {
        kind: columns.kind,
        taskKind: columns.taskKind,
        requireApproval: columns.requireApproval,
        schedule: columns.schedule,
        ...(columns.kind === "webhook" ? { auth: columns.webhookAuth, conditions: columns.payloadFilter.length, secretMade: webhook !== null } : {}),
      },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: admin.projectId, entity: "project", entityId: admin.projectId });
    return { ok: true, automationId, nextOccurrenceAt: columns.nextOccurrenceAt?.getTime() ?? null, secret: webhook?.secret ?? null };
  }));
};

type RotateResult = Awaited<ReturnType<RotateWebhookSecret>>;

export const rotateWebhookSecret = async (deps: StartPorts & ManageOptions, scope: Parameters<RotateWebhookSecret>[1], input: Parameters<RotateWebhookSecret>[2]): Promise<RotateResult> => {
  const made = await makeWebhookSecret(deps, scope.organizationId);
  const rotated = await settled(deps, scope.organizationId, made.ref, deps.db.$transaction(async (tx): Promise<{ readonly ok: true; readonly old: SecretRef | null } | Exclude<RotateResult, { readonly ok: true }>> => {
      const found = await findAutomationInTx(tx, scope, input.automationId);
      if (!found.ok) {
        return found;
      }
      if (found.row.kind !== "webhook" || found.row.webhookId === null) {
        return { ok: false, error: "not-allowed-in-state", message: "Only a webhook automation has a secret" };
      }
      await tx.automation.update({ where: { id: found.row.id }, data: { webhookSecretRef: made.ref, updatedByMemberId: scope.memberId } });
      await deps.audit.recordInTx(tx, {
        organizationId: scope.organizationId,
        projectId: found.projectId,
        actor: { kind: "member", id: scope.memberId },
        action: "automation.secret-rotated",
        entity: "automation",
        entityId: input.automationId,
      });
      await deps.notices.emitInTx(tx, { organizationId: scope.organizationId, projectId: found.projectId, entity: "project", entityId: found.projectId });
      const old = secretRefSchema.safeParse(found.row.webhookSecretRef);
      return { ok: true, old: old.success ? old.data : null };
    }));
  if (!rotated.ok) {
    return rotated;
  }
  // The old secret stops working at once: the row names the new one. Deleting it is housekeeping.
  await forgetSecret(deps, scope.organizationId, rotated.old);
  return { ok: true, secret: made.secret };
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
