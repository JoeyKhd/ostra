import {
  CRON_MAX_CHARS,
  cronSentence,
  deleteAutomation,
  dryRunAutomation,
  intakeFilterSchema,
  isTimeZone,
  minimumIntervalOk,
  nextOccurrence,
  openCachedChildrenInTx,
  parseCron,
  parseIntakeFilter,
  pauseAutomation,
  requireProjectAccess,
  saveAutomation,
  startMany,
} from "@ostra/domain";
import type { AutomationSettings, DryRunRow, IntakeFilter } from "@ostra/domain";
import type { Db } from "@ostra/db";
import {
  agentProfileIdSchema,
  automationIdSchema,
  bulkStartIdSchema,
  projectIdSchema,
  runnerLabelSchema,
  taskIdSchema,
  ticketIdSchema,
} from "@ostra/protocol";
import type { AgentProfileId, AutomationId, OrganizationId, ProjectId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { ApiDeps } from "../trpc/context.ts";
import { denied, loadProjectAccess, memberProcedure, projectProcedure, router, unwrap } from "../trpc/init.ts";
import type { ProjectAccess } from "../trpc/init.ts";

// Automations (F-011, F-106, F-107; ADR 0056; milestone 6's ticket 24): a project's intake rules and
// schedules. A project admin creates, edits, pauses, resumes and deletes them, and presses a dry run's
// "Start all"; any member who can open the project reads the list, an automation, its dry run and
// its history. A delete is soft, so the history and the tasks it started stay. Saving starts nothing
// (ADR 0056): the dry run says what would start, and "Start all" is a bulk start by hand.
//
// A rule names a task kind, an agent profile and pool labels, never a repo: the input schemas are
// strict, so a `repoId` is refused before anything is read. The profile must be one every member who
// can open the project may use. The pool labels are checked against the project's pools: a label no
// runner of them carries is returned (`labelsNoRunnerHas`), since its tasks would wait, not refused.
// A schedule's prompt is the members' to read in the panel and never reaches a log or an audit entry.

const startKindSchema = z.enum(["code", "refine"]);
const nameSchema = z.string().trim().min(1).max(80);
const poolLabelsSchema = z.array(runnerLabelSchema).max(16);
const PROMPT_MAX = 262_144;

const baseShape = {
  name: nameSchema,
  taskKind: startKindSchema,
  agentProfileId: agentProfileIdSchema.nullable(),
  poolLabels: poolLabelsSchema,
  requireApproval: z.boolean(),
};

/** What a project admin saves: strict, so a rule that names a repo (or anything else) is refused. */
const settingsSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("intake_rule"), ...baseShape, filter: intakeFilterSchema }),
  z.strictObject({
    kind: z.literal("schedule"),
    ...baseShape,
    schedule: z.string().max(CRON_MAX_CHARS),
    timeZone: z.string().min(1).max(64),
    skipWhileOpen: z.boolean(),
    does: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("filter"), filter: intakeFilterSchema }),
      z.strictObject({ kind: z.literal("prompt"), title: z.string().trim().min(1).max(512), prompt: z.string().min(1).max(PROMPT_MAX) }),
    ]),
  }),
]);
type SettingsInput = z.infer<typeof settingsSchema>;

const settingsOf = (input: SettingsInput): AutomationSettings => input;

const pausedSchema = z.object({
  at: z.number().int(),
  reason: z.enum(["member", "hourly_limit"]),
  /** Who paused it, for a member's pause; `null` for the hourly limit or a former member. */
  byName: z.string().nullable(),
});

const runStateSchema = z.enum(["started", "skipped", "missed"]);
const skipReasonSchema = z.enum(["last_open", "has_task", "paused", "hourly_limit", "over_limit", "budget"]);

const automationSchema = z.object({
  id: automationIdSchema,
  projectId: projectIdSchema,
  kind: z.enum(["intake_rule", "schedule"]),
  name: z.string(),
  taskKind: z.enum(["refine", "code", "review"]),
  agentProfile: z.object({ id: agentProfileIdSchema, name: z.string() }).nullable(),
  poolLabels: z.array(z.string()),
  /** The pool labels no runner of the project's pools carries: its tasks would wait for one. */
  labelsNoRunnerHas: z.array(z.string()),
  requireApproval: z.boolean(),
  /** A rule's filter, or a filter schedule's; `null` for a prompt schedule. */
  filter: intakeFilterSchema.nullable(),
  schedule: z
    .object({
      cron: z.string(),
      timeZone: z.string(),
      /** The cron in words in its zone, as the editor, the list and the history say it. */
      sentence: z.string(),
      skipWhileOpen: z.boolean(),
      does: z.enum(["filter", "prompt"]),
      /** A prompt schedule's task title and prompt (never logged). */
      title: z.string().nullable(),
      prompt: z.string().nullable(),
    })
    .nullable(),
  paused: pausedSchema.nullable(),
  nextOccurrenceAt: z.number().int().nullable(),
  lastOccurrenceAt: z.number().int().nullable(),
  lastRun: z.object({ at: z.number().int(), state: runStateSchema, taskId: taskIdSchema.nullable(), ticketKey: z.string().nullable() }).nullable(),
  /** Its runs by outcome, and its starts in the last hour (the hourly limit's count). */
  counts: z.object({ started: z.number().int(), skipped: z.number().int(), missed: z.number().int(), lastHour: z.number().int() }),
  deleted: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
type AutomationView = z.infer<typeof automationSchema>;

type AutomationRow = Awaited<ReturnType<Db["automation"]["findFirstOrThrow"]>>;

const shortIdOf = (id: string): string => id.replaceAll("-", "").slice(-8);

/** The labels each of the project's pool runners carries (online or not, but not revoked). */
const poolRunnerLabels = async (db: Db, organizationId: OrganizationId, projectId: ProjectId): Promise<readonly (readonly string[])[]> => {
  const pools = await db.projectPool.findMany({ where: { organizationId, projectId }, select: { poolId: true } });
  if (pools.length === 0) {
    return [];
  }
  const runners = await db.runner.findMany({
    where: { organizationId, kind: "pool", poolId: { in: pools.map((pool) => pool.poolId) }, state: { not: "revoked" } },
    select: { labels: true },
  });
  return runners.map((runner) => runner.labels);
};

/** The labels of `wanted` that no runner carries together with the others: each one checked alone. */
const labelsNoRunnerHas = (wanted: readonly string[], runners: readonly (readonly string[])[]): string[] =>
  wanted.filter((label) => !runners.some((labels) => labels.includes(label)));

/**
 * The profile a rule names must be one every member who can open the project may use: built-in, or
 * open to everyone, or listed with each of them on its list (organization admins may use any).
 */
const checkRuleProfile = async (db: Db, organizationId: OrganizationId, projectId: ProjectId, profileId: AgentProfileId): Promise<void> => {
  const profile = await db.agentProfile.findFirst({
    where: { id: profileId, organizationId },
    select: { id: true, name: true, builtIn: true, access: true, archivedAt: true, members: { select: { memberId: true } } },
  });
  if (profile === null) {
    throw new TRPCError({ code: "NOT_FOUND", message: "No such agent profile" });
  }
  if (profile.archivedAt !== null) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `The agent profile "${profile.name}" is archived` });
  }
  if (profile.builtIn || profile.access === "everyone") {
    return;
  }
  const project = await db.project.findFirstOrThrow({ where: { id: projectId, organizationId }, select: { access: true } });
  const members = await db.member.findMany({
    where: { organizationId, state: "active", ...(project.access === "restricted" ? { projectMemberships: { some: { projectId } } } : {}) },
    select: { id: true, role: true },
  });
  const listed = new Set(profile.members.map((row) => row.memberId));
  const left = members.filter((member) => !member.role.split(",").some((part) => part.trim() === "admin") && !listed.has(member.id));
  if (left.length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Not every member of this project may use the agent profile "${profile.name}": a rule's profile must be one they all may use`,
    });
  }
};

const viewOf = async (
  db: Db,
  organizationId: OrganizationId,
  rows: readonly AutomationRow[],
  runners: readonly (readonly string[])[],
  now: number,
): Promise<AutomationView[]> => {
  const ids = rows.map((row) => row.id);
  const profileIds = rows.flatMap((row) => (row.agentProfileId === null ? [] : [row.agentProfileId]));
  const pauserIds = rows.flatMap((row) => (row.pausedReason === "member" && row.updatedByMemberId !== null ? [row.updatedByMemberId] : []));
  const [profiles, pausers, lastRuns, byState, lastHour] = await Promise.all([
    db.agentProfile.findMany({ where: { organizationId, id: { in: profileIds } }, select: { id: true, name: true } }),
    db.member.findMany({ where: { organizationId, id: { in: pauserIds } }, select: { id: true, user: { select: { name: true } } } }),
    ids.length === 0
      ? Promise.resolve([])
      : db.automationRun.findMany({
          where: { organizationId, automationId: { in: ids } },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          distinct: ["automationId"],
          select: { automationId: true, createdAt: true, state: true, taskId: true, ticket: { select: { key: true } } },
        }),
    // A "Start all" press is a run of its own, and so is each ticket it matched: only runs that hold a task count as starts.
    db.automationRun.groupBy({ by: ["automationId", "state"], where: { organizationId, automationId: { in: ids }, OR: [{ state: { not: "started" } }, { taskId: { not: null } }] }, _count: { _all: true } }),
    db.automationRun.groupBy({
      by: ["automationId"],
      where: { organizationId, automationId: { in: ids }, state: "started", taskId: { not: null }, createdAt: { gte: new Date(now - 3_600_000) } },
      _count: { _all: true },
    }),
  ]);
  const countOf = (automationId: string, state: z.infer<typeof runStateSchema>): number =>
    byState.find((row) => row.automationId === automationId && row.state === state)?._count._all ?? 0;
  const profileName = new Map(profiles.map((profile) => [profile.id, profile.name] as const));
  const pauserName = new Map(pausers.map((member) => [member.id, member.user.name] as const));
  const lastRun = new Map(lastRuns.map((run) => [run.automationId, run] as const));
  return rows.map((row): AutomationView => {
    const stored = row.filter === null ? null : parseIntakeFilter(row.filter);
    const filter: IntakeFilter | null = stored?.ok === true ? stored.filter : null;
    const run = lastRun.get(row.id);
    const sentence = row.schedule === null ? null : cronSentence(row.schedule, row.timeZone);
    return {
      id: automationIdSchema.parse(row.id),
      projectId: projectIdSchema.parse(row.projectId),
      kind: row.kind,
      name: row.name,
      taskKind: row.taskKind,
      agentProfile: row.agentProfileId === null ? null : { id: agentProfileIdSchema.parse(row.agentProfileId), name: profileName.get(row.agentProfileId) ?? "An archived profile" },
      poolLabels: row.poolLabels,
      labelsNoRunnerHas: labelsNoRunnerHas(row.poolLabels, runners),
      requireApproval: row.requireApproval,
      filter,
      schedule:
        row.schedule === null
          ? null
          : {
              cron: row.schedule,
              timeZone: row.timeZone,
              sentence: sentence?.text ?? row.schedule,
              skipWhileOpen: row.skipWhileOpen,
              does: row.prompt === null ? "filter" : "prompt",
              title: row.title,
              prompt: row.prompt,
            },
      paused:
        row.pausedAt === null || row.pausedReason === null
          ? null
          : { at: row.pausedAt.getTime(), reason: row.pausedReason, byName: row.pausedReason === "member" && row.updatedByMemberId !== null ? (pauserName.get(row.updatedByMemberId) ?? null) : null },
      nextOccurrenceAt: row.nextOccurrenceAt?.getTime() ?? null,
      lastOccurrenceAt: row.lastOccurrenceAt?.getTime() ?? null,
      lastRun:
        run === undefined
          ? null
          : { at: run.createdAt.getTime(), state: run.state, taskId: run.taskId === null ? null : taskIdSchema.parse(run.taskId), ticketKey: run.ticket?.key ?? null },
      counts: {
        started: countOf(row.id, "started"),
        skipped: countOf(row.id, "skipped"),
        missed: countOf(row.id, "missed"),
        lastHour: lastHour.find((one) => one.automationId === row.id)?._count._all ?? 0,
      },
      deleted: row.deletedAt !== null,
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
    };
  });
};

/** One automation's view, read again after a write. */
const oneView = async (deps: ApiDeps, organizationId: OrganizationId, automationId: AutomationId): Promise<AutomationView> => {
  const row = await deps.db.automation.findFirstOrThrow({ where: { id: automationId, organizationId } });
  const runners = await poolRunnerLabels(deps.db, organizationId, projectIdSchema.parse(row.projectId));
  const [view] = await viewOf(deps.db, organizationId, [row], runners, deps.ports.clock.now());
  if (view === undefined) {
    throw new TRPCError({ code: "NOT_FOUND", message: "No such automation" });
  }
  return view;
};

/** What a procedure on one automation gets: the automation, inside a project the member may use. */
type AutomationAccess = { readonly automationId: AutomationId; readonly projectId: ProjectId; readonly deleted: boolean };

/**
 * A procedure on one automation: its input holds `automationId`. The automation is read inside the
 * member's organization only, then its project is checked as `projectProcedure` does: another
 * organization's automation, and a restricted project's the member isn't on, are `NOT_FOUND`. A
 * deleted automation is `NOT_FOUND` too, except where `deleted: "allowed"` (its history).
 */
const automationProcedure = <S extends z.ZodType<{ readonly automationId: AutomationId }>>(need: "read" | "admin", schema: S, deleted: "allowed" | "refused" = "refused") =>
  memberProcedure.input(schema).use(async ({ ctx, input, next }) => {
    const row = await ctx.deps.db.automation.findFirst({
      where: { id: input.automationId, organizationId: ctx.scope.organizationId, ...(deleted === "refused" ? { deletedAt: null } : {}) },
      select: { id: true, projectId: true, deletedAt: true },
    });
    if (row === null) {
      throw denied("not-found", "automation");
    }
    let project: ProjectAccess;
    try {
      project = await loadProjectAccess(ctx.deps.db, ctx.scope, projectIdSchema.parse(row.projectId), need);
    } catch (error) {
      if (error instanceof TRPCError && error.code === "NOT_FOUND") {
        throw denied("not-found", "automation");
      }
      throw error;
    }
    const automation: AutomationAccess = { automationId: automationIdSchema.parse(row.id), projectId: project.projectId, deleted: row.deletedAt !== null };
    return next({ ctx: { ...ctx, project, automation } });
  });

const saveCodes = {
  forbidden: "FORBIDDEN",
  "not-found": "NOT_FOUND",
  "invalid-input": "BAD_REQUEST",
  "schedule-too-often": "BAD_REQUEST",
  "name-taken": "CONFLICT",
} as const;

/** Checks a rule's profile, then saves it through the domain (its audit entry and change notice). */
const save = async (deps: ApiDeps, scope: Parameters<typeof saveAutomation>[1], projectId: ProjectId, automationId: AutomationId | null, settings: SettingsInput) => {
  if (settings.agentProfileId !== null) {
    await checkRuleProfile(deps.db, scope.organizationId, projectId, settings.agentProfileId);
  }
  const saved = unwrap(
    await saveAutomation({ db: deps.db, ...deps.ports, scheduleMinIntervalMinutes: deps.settings.team.scheduleMinIntervalMinutes }, scope, { projectId, automationId, settings: settingsOf(settings) }),
    saveCodes,
  );
  return oneView(deps, scope.organizationId, saved.automationId);
};

const dryRunOutcomeSchema = z.union([
  z.object({ kind: z.literal("would-start") }),
  z.object({ kind: z.literal("would-skip"), reason: z.literal("has-task"), taskId: taskIdSchema.nullable(), shortId: z.string().nullable() }),
  z.object({ kind: z.literal("would-skip"), reason: z.literal("has-sub-issues"), subIssues: z.number().int() }),
  z.object({ kind: z.literal("would-skip"), reason: z.union([z.literal("matched-before"), skipReasonSchema]) }),
]);

const dryRunSchema = z.object({
  rows: z.array(z.object({ ticketId: ticketIdSchema, key: z.string(), title: z.string(), outcome: dryRunOutcomeSchema })),
  /** Every ticket that matches, beyond the rows listed. */
  total: z.number().int(),
  /** The tickets a "Start all" would start now. */
  wouldStart: z.number().int(),
});
type DryRunView = z.infer<typeof dryRunSchema>;

/**
 * The domain's dry run with what the panel shows beside each row: the ticket's title, the task a
 * `has-task` skip names, and a code start on a parent, which starts nothing for it (F-077: its
 * sub-issues start from its page), so "Start all" starts exactly the `would-start` rows.
 */
const dryRunView = async (
  deps: ApiDeps,
  scope: Parameters<typeof dryRunAutomation>[1],
  input: { readonly projectId: ProjectId; readonly filter: IntakeFilter; readonly automationId: AutomationId | null; readonly taskKind: "code" | "refine" },
): Promise<DryRunView> => {
  const result = unwrap(await dryRunAutomation({ db: deps.db }, scope, input), { forbidden: "FORBIDDEN", "not-found": "NOT_FOUND" });
  const ids = result.rows.map((row) => row.ticketId);
  const [tickets, tasks] = await Promise.all([
    deps.db.ticket.findMany({ where: { organizationId: scope.organizationId, id: { in: ids } }, select: { id: true, title: true, connectionId: true, externalId: true } }),
    deps.db.task.findMany({
      where: { organizationId: scope.organizationId, ticketId: { in: ids }, kind: "code", state: { notIn: ["stopped", "merged", "done"] } },
      select: { id: true, ticketId: true },
    }),
  ]);
  const ticketOf = new Map(tickets.map((ticket) => [ticket.id, ticket] as const));
  const taskOf = new Map(tasks.flatMap((task) => (task.ticketId === null ? [] : [[task.ticketId, task.id] as const])));
  const rows: DryRunView["rows"] = [];
  for (const row of result.rows) {
    const ticket = ticketOf.get(row.ticketId);
    rows.push({ ticketId: row.ticketId, key: row.key, title: ticket?.title ?? row.key, outcome: await outcomeOf(deps, row, ticket, taskOf, input.taskKind) });
  }
  return { rows, total: result.total, wouldStart: rows.filter((row) => row.outcome.kind === "would-start").length };
};

const outcomeOf = async (
  deps: ApiDeps,
  row: DryRunRow,
  ticket: { readonly connectionId: string; readonly externalId: string } | undefined,
  taskOf: ReadonlyMap<string, string>,
  taskKind: "code" | "refine",
): Promise<z.infer<typeof dryRunOutcomeSchema>> => {
  const outcome = row.outcome;
  if (outcome.kind === "would-skip") {
    if (outcome.reason === "has-task") {
      const taskId = taskOf.get(row.ticketId) ?? null;
      return { kind: "would-skip", reason: "has-task", taskId: taskId === null ? null : taskIdSchema.parse(taskId), shortId: taskId === null ? null : shortIdOf(taskId) };
    }
    return { kind: "would-skip", reason: outcome.reason };
  }
  if (taskKind === "code" && ticket !== undefined) {
    const children = await openCachedChildrenInTx(deps.db, ticket);
    if (children > 0) {
      return { kind: "would-skip", reason: "has-sub-issues", subIssues: children };
    }
  }
  return { kind: "would-start" };
};

/** The filter an automation checks: a rule's, or a filter schedule's. A prompt schedule has none. */
const filterOfRow = (row: { readonly filter: unknown; readonly prompt: string | null }): IntakeFilter => {
  const parsed = row.prompt === null && row.filter !== null ? parseIntakeFilter(row.filter) : { ok: false as const };
  if (!parsed.ok) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "A prompt schedule starts one task: it has no filter to dry-run" });
  }
  return parsed.filter;
};

const dryRunInput = z.union([
  z.strictObject({ projectId: projectIdSchema, filter: intakeFilterSchema, taskKind: startKindSchema.default("code") }),
  z.strictObject({ projectId: projectIdSchema, automationId: automationIdSchema }),
]);

const historyCursorSchema = z.string().regex(/^\d{1,16}\.[0-9a-f-]{36}$/);
const encodeCursor = (at: Date, id: string): string => Buffer.from(`${String(at.getTime())}.${id}`).toString("base64url");
const decodeCursor = (cursor: string): { readonly at: Date; readonly id: string } | null => {
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  if (!historyCursorSchema.safeParse(text).success) return null;
  const [ms = "", id = ""] = text.split(".");
  return { at: new Date(Number(ms)), id };
};

const HISTORY_PAGE = 100;
const NEXT_OCCURRENCES = 3;

export const automationsRouter = router({
  /** The project's automations, newest first. Any member who can open the project; `canEdit` for its admins. */
  list: projectProcedure("read", z.strictObject({ projectId: projectIdSchema }))
    .output(
      z.object({
        canEdit: z.boolean(),
        automations: z.array(automationSchema),
        /** The install's limits the screens name (`OSTRA_INTAKE_STARTS_PER_HOUR`, and the others). */
        limits: z.object({ startsPerHour: z.number().int(), bulkStartMax: z.number().int(), missedHours: z.number().int(), minIntervalMinutes: z.number().int() }),
      }),
    )
    .query(async ({ ctx, input }) => {
      const organizationId = ctx.scope.organizationId;
      const rows = await ctx.deps.db.automation.findMany({ where: { organizationId, projectId: input.projectId, deletedAt: null }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
      const runners = await poolRunnerLabels(ctx.deps.db, organizationId, input.projectId);
      const { team } = ctx.deps.settings;
      return {
        canEdit: ctx.project.role === "admin",
        automations: await viewOf(ctx.deps.db, organizationId, rows, runners, ctx.deps.ports.clock.now()),
        limits: { startsPerHour: team.intakeStartsPerHour, bulkStartMax: team.bulkStartMax, missedHours: team.scheduleMissedHours, minIntervalMinutes: team.scheduleMinIntervalMinutes },
      };
    }),

  /**
   * Home's needs-you rows for a rule its hourly limit paused (automations.md, "Paused by the limit"):
   * every such automation in a project the member is an admin of. Resuming it clears the row.
   */
  pausedByLimit: memberProcedure
    .output(z.array(z.object({ id: automationIdSchema, name: z.string(), projectId: projectIdSchema, projectName: z.string(), pausedAt: z.number().int(), startsPerHour: z.number().int() })))
    .query(async ({ ctx }) => {
      const rows = await ctx.deps.db.automation.findMany({
        where: { organizationId: ctx.scope.organizationId, pausedReason: "hourly_limit", pausedAt: { not: null }, deletedAt: null },
        orderBy: [{ pausedAt: "desc" }, { id: "desc" }],
        take: 50,
        select: { id: true, name: true, pausedAt: true, project: { select: { id: true, name: true, access: true } } },
      });
      return rows.flatMap((row) => {
        const projectId = projectIdSchema.parse(row.project.id);
        const admin = requireProjectAccess(ctx.scope, { id: projectId, organizationId: ctx.scope.organizationId, access: row.project.access }, "admin").ok;
        return admin && row.pausedAt !== null
          ? [{ id: automationIdSchema.parse(row.id), name: row.name, projectId, projectName: row.project.name, pausedAt: row.pausedAt.getTime(), startsPerHour: ctx.deps.settings.team.intakeStartsPerHour }]
          : [];
      });
    }),

  /** One automation, for the editor: read-only to a member, editable by a project admin. */
  get: automationProcedure("read", z.strictObject({ automationId: automationIdSchema }))
    .output(automationSchema.extend({ canEdit: z.boolean() }))
    .query(async ({ ctx }) => ({ ...(await oneView(ctx.deps, ctx.scope.organizationId, ctx.automation.automationId)), canEdit: ctx.project.role === "admin" })),

  /** A new rule or schedule. Saving starts nothing; a schedule's first occurrence is the next one after now. */
  create: projectProcedure("admin", z.strictObject({ projectId: projectIdSchema, settings: settingsSchema }))
    .output(automationSchema)
    .mutation(({ ctx, input }) => save(ctx.deps, ctx.scope, input.projectId, null, input.settings)),

  /** An edit, kind for kind. A schedule's next occurrence is computed again from now, so it never fires a past time. */
  update: automationProcedure("admin", z.strictObject({ automationId: automationIdSchema, settings: settingsSchema }))
    .output(automationSchema)
    .mutation(({ ctx, input }) => save(ctx.deps, ctx.scope, ctx.automation.projectId, ctx.automation.automationId, input.settings)),

  /** Paused at once: its next occurrence and its matches start nothing until it's resumed. */
  pause: automationProcedure("admin", z.strictObject({ automationId: automationIdSchema }))
    .output(automationSchema)
    .mutation(async ({ ctx }) => {
      unwrap(await pauseAutomation({ db: ctx.deps.db, ...ctx.deps.ports }, ctx.scope, { automationId: ctx.automation.automationId, paused: true }), {
        forbidden: "FORBIDDEN",
        "not-found": "NOT_FOUND",
        "not-allowed-in-state": "CONFLICT",
      });
      return oneView(ctx.deps, ctx.scope.organizationId, ctx.automation.automationId);
    }),

  /** Resumed from now on: a schedule's next occurrence is the next one after now, never a missed one. */
  resume: automationProcedure("admin", z.strictObject({ automationId: automationIdSchema }))
    .output(automationSchema)
    .mutation(async ({ ctx }) => {
      unwrap(await pauseAutomation({ db: ctx.deps.db, ...ctx.deps.ports }, ctx.scope, { automationId: ctx.automation.automationId, paused: false }), {
        forbidden: "FORBIDDEN",
        "not-found": "NOT_FOUND",
        "not-allowed-in-state": "CONFLICT",
      });
      return oneView(ctx.deps, ctx.scope.organizationId, ctx.automation.automationId);
    }),

  /** A soft delete: it starts nothing more, and its history and tasks stay. */
  delete: automationProcedure("admin", z.strictObject({ automationId: automationIdSchema }))
    .output(z.object({ deletedAt: z.number().int() }))
    .mutation(async ({ ctx }) => {
      const deleted = unwrap(await deleteAutomation({ db: ctx.deps.db, ...ctx.deps.ports }, ctx.scope, { automationId: ctx.automation.automationId }), {
        forbidden: "FORBIDDEN",
        "not-found": "NOT_FOUND",
      });
      return { deletedAt: deleted.deletedAt };
    }),

  /**
   * What a filter (the editor's, before it's saved) or a saved automation would start over the
   * project's cached open tickets right now. Reads only: nothing starts.
   */
  dryRun: projectProcedure("read", dryRunInput)
    .output(dryRunSchema)
    .query(async ({ ctx, input }) => {
      if ("filter" in input) {
        return dryRunView(ctx.deps, ctx.scope, { projectId: input.projectId, filter: input.filter, automationId: null, taskKind: input.taskKind });
      }
      const row = await ctx.deps.db.automation.findFirst({ where: { id: input.automationId, organizationId: ctx.scope.organizationId, projectId: input.projectId, deletedAt: null } });
      if (row === null) {
        throw denied("not-found", "automation");
      }
      return dryRunView(ctx.deps, ctx.scope, { projectId: input.projectId, filter: filterOfRow(row), automationId: input.automationId, taskKind: row.taskKind === "refine" ? "refine" : "code" });
    }),

  /**
   * "Start all": the saved automation's dry run, started by hand as one bulk start (ticket 11) with
   * the rule as each task's origin. Idempotent by the request's key: a double click starts nothing twice.
   */
  startAll: automationProcedure("admin", z.strictObject({ automationId: automationIdSchema, requestKey: z.string().trim().min(1).max(200) }))
    .output(z.object({ bulkStartId: bulkStartIdSchema, tickets: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports, settings } = ctx.deps;
      const row = await db.automation.findFirstOrThrow({ where: { id: ctx.automation.automationId, organizationId: ctx.scope.organizationId } });
      const existing = await db.bulkStart.findUnique({ where: { memberId_requestKey: { memberId: ctx.scope.memberId, requestKey: input.requestKey } }, select: { id: true, requested: true } });
      if (existing !== null) {
        // The same press again (a retry, a double click): the first one's bulk start.
        return { bulkStartId: bulkStartIdSchema.parse(existing.id), tickets: existing.requested };
      }
      const taskKind = row.taskKind === "refine" ? "refine" : "code";
      const dry = await dryRunView(ctx.deps, ctx.scope, { projectId: ctx.automation.projectId, filter: filterOfRow(row), automationId: ctx.automation.automationId, taskKind });
      const ticketIds = dry.rows.flatMap((ticket) => (ticket.outcome.kind === "would-start" ? [ticket.ticketId] : []));
      if (ticketIds.length === 0) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No ticket the rule matches would start now" });
      }
      const started = unwrap(
        await startMany({ db, ...ports, bulkStartMax: settings.team.bulkStartMax, publicUrl: settings.publicUrl }, ctx.scope, {
          projectId: ctx.automation.projectId,
          ticketIds,
          taskKind,
          agentProfileId: null,
          requestKey: input.requestKey,
          source: "dry_run",
          automationId: ctx.automation.automationId,
        }),
        { forbidden: "FORBIDDEN", "not-found": "NOT_FOUND", "invalid-input": "BAD_REQUEST", "too-many": "BAD_REQUEST" },
      );
      return { bulkStartId: started.bulkStartId, tickets: ticketIds.length };
    }),

  /**
   * A schedule as the editor types it: its sentence, its next three occurrences in its zone, or why
   * it's refused (not a cron, an unknown zone, or under `OSTRA_SCHEDULE_MIN_INTERVAL_MINUTES` apart).
   */
  previewSchedule: memberProcedure
    .input(z.strictObject({ cron: z.string().max(CRON_MAX_CHARS + 1), timeZone: z.string().min(1).max(64) }))
    .output(
      z.object({
        sentence: z.string().nullable(),
        /** `false` when the grammar has no words for it and the sentence is the cron itself. */
        described: z.boolean(),
        next: z.array(z.number().int()),
        minIntervalMinutes: z.number().int(),
        refusal: z.object({ code: z.enum(["invalid-cron", "invalid-time-zone", "too-often"]), message: z.string() }).nullable(),
      }),
    )
    .query(({ ctx, input }) => {
      const minIntervalMinutes = ctx.deps.settings.team.scheduleMinIntervalMinutes;
      const empty = { sentence: null, described: false, next: [], minIntervalMinutes };
      const parsed = parseCron(input.cron);
      if (!parsed.ok) {
        return { ...empty, refusal: { code: "invalid-cron" as const, message: `Not a cron expression: ${parsed.reason}.` } };
      }
      if (!isTimeZone(input.timeZone)) {
        return { ...empty, refusal: { code: "invalid-time-zone" as const, message: "That time zone isn't one ostra knows." } };
      }
      if (!minimumIntervalOk(parsed.cron, minIntervalMinutes, input.timeZone)) {
        return { ...empty, refusal: { code: "too-often" as const, message: `Occurrences must be at least ${String(minIntervalMinutes)} minutes apart.` } };
      }
      const next: number[] = [];
      let after = ctx.deps.ports.clock.now();
      while (next.length < NEXT_OCCURRENCES) {
        const at = nextOccurrence(parsed.cron, input.timeZone, after);
        if (at === null) break;
        next.push(at);
        after = at;
      }
      const sentence = cronSentence(parsed.cron.source, input.timeZone);
      return { sentence: sentence?.text ?? null, described: sentence?.described ?? false, next, minIntervalMinutes, refusal: null };
    }),

  /**
   * The automation's runs, newest first, with their state, reason, ticket and task: its occurrences,
   * its matches and its "Start all" presses. A deleted automation's history stays readable.
   */
  history: automationProcedure("read", z.strictObject({ automationId: automationIdSchema, cursor: z.string().max(200).optional() }), "allowed")
    .output(
      z.object({
        runs: z.array(
          z.object({
            id: z.string(),
            kind: z.enum(["occurrence", "ticket_match", "start_all"]),
            state: runStateSchema,
            skipReason: skipReasonSchema.nullable(),
            occurrenceAt: z.number().int().nullable(),
            at: z.number().int(),
            ticket: z.object({ id: ticketIdSchema, key: z.string(), title: z.string() }).nullable(),
            task: z.object({ id: taskIdSchema, shortId: z.string(), title: z.string(), state: z.string() }).nullable(),
            bulkStartId: bulkStartIdSchema.nullable(),
          }),
        ),
        nextCursor: z.string().nullable(),
        deleted: z.boolean(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { db } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
      if (input.cursor !== undefined && cursor === null) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "That page cursor isn't one this history gave" });
      }
      const where = { organizationId, automationId: ctx.automation.automationId };
      const runs = await db.automationRun.findMany({
        where: cursor === null ? where : { ...where, OR: [{ createdAt: { lt: cursor.at } }, { createdAt: cursor.at, id: { lt: cursor.id } }] },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: HISTORY_PAGE + 1,
        include: { ticket: { select: { id: true, key: true, title: true } }, task: { select: { id: true, title: true, state: true } } },
      });
      const page = runs.slice(0, HISTORY_PAGE);
      const last = page.at(-1);
      return {
        runs: page.map((run) => ({
          id: run.id,
          kind: run.kind,
          state: run.state,
          skipReason: run.skipReason,
          occurrenceAt: run.occurrenceAt?.getTime() ?? null,
          at: run.createdAt.getTime(),
          ticket: run.ticket === null ? null : { id: ticketIdSchema.parse(run.ticket.id), key: run.ticket.key, title: run.ticket.title },
          task: run.task === null ? null : { id: taskIdSchema.parse(run.task.id), shortId: shortIdOf(run.task.id), title: run.task.title, state: run.task.state },
          bulkStartId: run.bulkStartId === null ? null : bulkStartIdSchema.parse(run.bulkStartId),
        })),
        nextCursor: runs.length > HISTORY_PAGE && last !== undefined ? encodeCursor(last.createdAt, last.id) : null,
        deleted: ctx.automation.deleted,
      };
    }),
});
