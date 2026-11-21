import type { Db } from "@ostra/db";
import {
  appProcessesInTx,
  appProcessListWords,
  decideEnvironmentProposal,
  appProcessSchema,
  detectRepoEnvironment,
  environmentAppProcessList,
  installationStateSelect,
  installationUsable,
  keptProcessWithoutCommand,
  saveAppProcesses,
  screenshotSettingsSchema,
} from "@ostra/domain";
import type { AppProcess, AppProcessListIssue, DetectedAppProcess, ScreenshotSettings } from "@ostra/domain";
import {
  appLabelSchema,
  appProcessStateSchema,
  appProcessReasonSchema,
  appReadyCheckSchema,
  blobIdSchema,
  connectionIdSchema,
  environmentIdSchema,
  environmentProposalIdSchema,
  environmentProposalSchema,
  memberIdSchema,
  noBrowserReasonSchema,
  projectIdSchema,
  repoFullNameSchema,
  repoIdSchema,
  runnerLimits,
  screenshotWidthSchema,
  serviceIdSchema,
  taskIdSchema,
} from "@ostra/protocol";
import type { EnvironmentId, OrganizationId, ProjectId, RepoId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { loadGitHubConnection } from "../services/github-connection.ts";
import type { ApiDeps } from "../trpc/context.ts";
import { projectProcedure, router, unwrap } from "../trpc/init.ts";

// Milestone 8, ticket 16 (F-140, F-121, ADR 0068): the environment's App tab.
//
// - `environments.appProcesses.list`: the saved processes in their start order, each with how it
//   did on the last box (`app.process`), the box's browser (`app.browser`), and the processes kept
//   from a task that wait on a project admin ("Keep it", source `kept`). For anyone who can open the
//   project; commands are the repo's own, shown to its members and never logged.
// - `environments.appProcesses.detected`: what detection reads in the repos now and the list doesn't
//   have, marked `detected` (`environmentAppProcessList`), for an admin to add.
// - `environments.appProcesses.save`: a project admin's whole list, in order, refused with each
//   rule's words (one primary, names and ports once, port 7101 kept by the box, the project's repos).
//   The box's other ports are picked when it starts, so the box refuses them then (`mayReach`).
// - `environments.screenshots`: "Screenshots after each turn", its routes and widths.
// - `environments.services.setPreview`: a service's preview label (`servicePreviewProcedure`).
//
// Each save is the domain's `saveAppProcesses`, one transaction with its audit entry
// (`environment.app-processes-saved`), which names processes and fields, never a command.

const projectInput = z.strictObject({ projectId: projectIdSchema });

const notFound = (what: string): TRPCError => new TRPCError({ code: "NOT_FOUND", message: `No such ${what}` });

const previewDeps = (deps: ApiDeps) => ({ db: deps.db, ...deps.ports, settings: deps.settings.previews });

const environmentOf = async (db: Db, organizationId: OrganizationId, projectId: ProjectId): Promise<{ readonly id: EnvironmentId; readonly screenshots: ScreenshotSettings }> => {
  const row = await db.environment.findFirst({ where: { projectId, organizationId }, select: { id: true, screenshotsAfterTurn: true, screenshotRoutes: true, screenshotWidths: true } });
  if (row === null) {
    throw notFound("environment");
  }
  const screenshots = screenshotSettingsSchema.safeParse({ afterTurn: row.screenshotsAfterTurn, routes: row.screenshotRoutes, widths: row.screenshotWidths });
  return { id: environmentIdSchema.parse(row.id), screenshots: screenshots.success ? screenshots.data : screenshotSettingsSchema.parse({ afterTurn: row.screenshotsAfterTurn }) };
};

// ---------- the views ----------

/** An app process as the environment holds it. Its command is the repo's own: never logged. */
const appProcessFieldsSchema = z.object({
  name: z.string(),
  repoId: repoIdSchema,
  folder: z.string(),
  command: z.string(),
  port: z.number().int(),
  ready: appReadyCheckSchema,
  label: z.string(),
  primary: z.boolean(),
  hostRewrite: z.boolean(),
});
type AppProcessFields = z.infer<typeof appProcessFieldsSchema>;
const fieldsOf = (process: AppProcess): AppProcessFields => process;

/** How a process did on the last box that ran it, from its newest `app.process` event: never a live probe. */
const lastBoxSchema = z.object({
  state: appProcessStateSchema,
  /** Epoch ms. */
  at: z.number().int(),
  runnerName: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  reason: appProcessReasonSchema.nullable(),
  /** How long it took from `starting` to `ready` in that box; `null` for any other state. */
  readyAfterMs: z.number().int().nullable(),
  /** The task whose box it was. */
  taskId: taskIdSchema,
  /** Ticket 17: a process that exited or failed names its log's tail, a blob of that task ("Show the log"). */
  logBlobId: blobIdSchema.nullable(),
});

const appProcessEventSchema = z.looseObject({
  kind: z.literal("app.process"),
  name: z.string(),
  state: appProcessStateSchema,
  exitCode: z.number().int().nullable().catch(null),
  reason: appProcessReasonSchema.nullable().catch(null),
  logBlobId: blobIdSchema.nullable().catch(null),
});

const lastBoxOf = async (db: Db, organizationId: OrganizationId, projectId: ProjectId, name: string): Promise<z.infer<typeof lastBoxSchema> | null> => {
  // Ticket 17: a process stopped with its box says nothing of how it did, so the newest other state counts.
  const event = await db.event.findFirst({
    where: { organizationId, projectId, kind: "app.process", AND: [{ payload: { path: ["name"], equals: name } }, { NOT: { payload: { path: ["state"], equals: "stopped" } } }] },
    orderBy: [{ occurredAt: "desc" }, { seq: "desc" }],
    select: { taskId: true, sessionId: true, seq: true, payload: true, occurredAt: true, session: { select: { box: { select: { runner: { select: { name: true } } } } } } },
  });
  const parsed = appProcessEventSchema.safeParse(event?.payload);
  if (event === null || !parsed.success) {
    return null;
  }
  let readyAfterMs: number | null = null;
  if (parsed.data.state === "ready") {
    const started = await db.event.findFirst({
      where: { organizationId, taskId: event.taskId, sessionId: event.sessionId, kind: "app.process", seq: { lt: event.seq }, AND: [{ payload: { path: ["name"], equals: name } }, { payload: { path: ["state"], equals: "starting" } }] },
      orderBy: { seq: "desc" },
      select: { occurredAt: true },
    });
    readyAfterMs = started === null ? null : Math.max(0, event.occurredAt.getTime() - started.occurredAt.getTime());
  }
  return {
    state: parsed.data.state,
    at: event.occurredAt.getTime(),
    runnerName: event.session.box?.runner?.name ?? null,
    exitCode: parsed.data.exitCode,
    reason: parsed.data.reason,
    readyAfterMs,
    taskId: taskIdSchema.parse(event.taskId),
    logBlobId: parsed.data.logBlobId,
  };
};

/**
 * Ticket 17: the runner of the project's newest box, when it speaks a protocol below minor 7: it
 * starts no app process, takes no picture and opens no preview (ADR 0068), so the App tab says so.
 */
const olderRunnerOf = async (db: Db, organizationId: OrganizationId, projectId: ProjectId): Promise<{ readonly name: string } | null> => {
  const lease = await db.lease.findFirst({
    where: { organizationId, projectId },
    orderBy: { grantedAt: "desc" },
    select: { runner: { select: { name: true, presence: { select: { minor: true } } } } },
  });
  const minor = lease?.runner.presence?.minor ?? null;
  return lease === null || minor === null || minor >= 7 ? null : { name: lease.runner.name };
};

/** The box's browser, from the project's newest `app.browser`: its name and version, or why there was none. */
const boxBrowserViewSchema = z.object({
  browser: z.discriminatedUnion("available", [
    z.object({ available: z.literal(true), name: z.string(), version: z.string() }),
    z.object({ available: z.literal(false), reason: noBrowserReasonSchema }),
  ]),
  /** Epoch ms. */
  at: z.number().int(),
  runnerName: z.string().nullable(),
});

const browserEventSchema = z.looseObject({
  kind: z.literal("app.browser"),
  browser: z.discriminatedUnion("available", [
    z.looseObject({ available: z.literal(true), name: z.string(), version: z.string() }),
    z.looseObject({ available: z.literal(false), reason: noBrowserReasonSchema }),
  ]),
});

const boxBrowserOf = async (db: Db, organizationId: OrganizationId, projectId: ProjectId): Promise<z.infer<typeof boxBrowserViewSchema> | null> => {
  const event = await db.event.findFirst({
    where: { organizationId, projectId, kind: "app.browser" },
    orderBy: [{ occurredAt: "desc" }, { seq: "desc" }],
    select: { payload: true, occurredAt: true, session: { select: { box: { select: { runner: { select: { name: true } } } } } } },
  });
  const parsed = browserEventSchema.safeParse(event?.payload);
  if (event === null || !parsed.success) {
    return null;
  }
  const seen = parsed.data.browser;
  return {
    browser: seen.available ? { available: true, name: seen.name, version: seen.version } : { available: false, reason: seen.reason },
    at: event.occurredAt.getTime(),
    runnerName: event.session.box?.runner?.name ?? null,
  };
};

/** A process kept from a task ("Keep it"), waiting on a project admin. */
const keptViewSchema = z.object({
  proposalId: environmentProposalIdSchema,
  /** Epoch ms. */
  createdAt: z.number().int(),
  task: z.object({ taskId: taskIdSchema, title: z.string(), key: z.string() }),
  /** Who kept it, from its audit entry. */
  keptBy: z.object({ memberId: memberIdSchema, name: z.string() }).nullable(),
  process: appProcessFieldsSchema,
  /** "Accept" waits until "Edit and accept" names the command that starts it. */
  waitsForCommand: z.boolean(),
});

/** Who kept a proposal's process, from its audit entry; `null` for an onboarding one. */
export const keptByOf = async (db: Db, organizationId: OrganizationId, proposalId: string): Promise<{ readonly memberId: z.infer<typeof memberIdSchema>; readonly name: string } | null> => {
  const entry = await db.auditEntry.findFirst({
    where: { organizationId, action: "environment.app-process-kept", data: { path: ["proposalId"], equals: proposalId } },
    orderBy: { createdAt: "desc" },
    select: { actorId: true, actorName: true },
  });
  const actorId = entry?.actorId ?? null;
  return actorId === null ? null : { memberId: memberIdSchema.parse(actorId), name: entry?.actorName ?? "A former member" };
};

/** A task's short key, as the panel names it: its ticket's, or the end of its ID. */
const taskKeyOf = (task: { readonly id: string; readonly ticketKey: string | null }): string => task.ticketKey ?? task.id.replaceAll("-", "").slice(-8);

const keptOf = async (db: Db, organizationId: OrganizationId, projectId: ProjectId): Promise<z.infer<typeof keptViewSchema>[]> => {
  const rows = await db.environmentProposal.findMany({
    where: { organizationId, projectId, state: "proposed", source: "kept" },
    orderBy: { createdAt: "asc" },
    take: 50,
    select: { id: true, body: true, createdAt: true, task: { select: { id: true, title: true, ticketKey: true } } },
  });
  const out: z.infer<typeof keptViewSchema>[] = [];
  for (const row of rows) {
    const body = environmentProposalSchema.safeParse(row.body);
    const processes: readonly AppProcess[] = body.success ? (body.data.appProcesses ?? []) : [];
    const [process] = processes;
    if (process === undefined) {
      continue;
    }
    out.push({
      proposalId: environmentProposalIdSchema.parse(row.id),
      createdAt: row.createdAt.getTime(),
      task: { taskId: taskIdSchema.parse(row.task.id), title: row.task.title, key: taskKeyOf(row.task) },
      keptBy: await keptByOf(db, organizationId, row.id),
      process: fieldsOf(process),
      waitsForCommand: keptProcessWithoutCommand(processes) !== null,
    });
  }
  return out;
};

/** What detection found and the list lacks: its command may be unknown. Never run: read as text. */
export const detectedAppProcessViewSchema = z.object({
  name: z.string(),
  label: z.string(),
  port: z.number().int(),
  /** The command that starts it, or `null` when no file says. */
  command: z.string().nullable(),
  folder: z.string(),
  ready: z.discriminatedUnion("kind", [z.object({ kind: z.literal("http"), path: z.string() }), z.object({ kind: z.literal("port") })]),
  primary: z.boolean(),
  /** The file it was found in. */
  source: z.string(),
});
const detectedView = (process: DetectedAppProcess): z.infer<typeof detectedAppProcessViewSchema> => process;

/** A rule the list breaks, with its words, for the field it's about. */
const issueSchema = z.discriminatedUnion("rule", [
  z.object({ rule: z.literal("one-primary"), message: z.string() }),
  z.object({ rule: z.literal("unique-name"), name: z.string(), message: z.string() }),
  z.object({ rule: z.literal("unique-port"), port: z.number().int(), message: z.string() }),
  z.object({ rule: z.literal("reserved-port"), port: z.number().int(), name: z.string(), message: z.string() }),
  z.object({ rule: z.literal("unknown-repo"), name: z.string(), message: z.string() }),
]);
const issueView = (issue: AppProcessListIssue): z.infer<typeof issueSchema> => ({ ...issue, message: appProcessListWords(issue) });

// ---------- app processes ----------

/**
 * Ticket 17: "Accept" on a process kept from a task, after a project admin reviewed it in the App
 * tab's sheet: the kept proposal is accepted with its one process as the admin left it (the command
 * that starts it named, which "Keep it" couldn't know), through the domain's `decideEnvironmentProposal`
 * as "Edit and accept" is, so its rules, its scan and its audit entry hold.
 */
const acceptKeptProcedure = projectProcedure("admin", z.strictObject({ projectId: projectIdSchema, proposalId: environmentProposalIdSchema, process: appProcessSchema }))
  .output(z.object({ resultVersion: z.number().int().nullable() }))
  .mutation(async ({ ctx, input }) => {
    const { db, ports } = ctx.deps;
    const row = await db.environmentProposal.findFirst({
      where: { id: input.proposalId, organizationId: ctx.scope.organizationId, projectId: input.projectId, source: "kept", state: "proposed" },
      select: { body: true },
    });
    const body = environmentProposalSchema.safeParse(row?.body);
    if (row === null || !body.success) {
      throw notFound("kept process");
    }
    const decided = await decideEnvironmentProposal({ db, ...ports }, ctx.scope, { proposalId: input.proposalId, decision: { kind: "accept", edited: { ...body.data, appProcesses: [input.process] } } });
    if (!decided.ok && decided.error === "secret-found") {
      throw new TRPCError({ code: "BAD_REQUEST", message: decided.message });
    }
    const result = unwrap(decided, { forbidden: "FORBIDDEN", "not-found": "NOT_FOUND", "already-decided": "CONFLICT", "invalid-input": "BAD_REQUEST" });
    return { resultVersion: result.resultVersion };
  });


export const appProcessesRouter = router({
  acceptKept: acceptKeptProcedure,
  /** The saved processes in their start order, each with its last box; the box's browser; what was kept from a task. */
  list: projectProcedure("read", projectInput)
    .output(
      z.object({
        environmentId: environmentIdSchema,
        processes: z.array(appProcessFieldsSchema.extend({ lastBox: lastBoxSchema.nullable() })),
        browser: boxBrowserViewSchema.nullable(),
        kept: z.array(keptViewSchema),
        /** Ticket 17: the runner of the newest box, when it's below protocol minor 7 and runs no app process. */
        olderRunner: z.object({ name: z.string() }).nullable(),
        /** A project admin edits the list; a member reads it. */
        canEdit: z.boolean(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { db } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const environment = await environmentOf(db, organizationId, input.projectId);
      const processes = [];
      for (const process of await appProcessesInTx(db, environment.id)) {
        processes.push({ ...fieldsOf(process), lastBox: await lastBoxOf(db, organizationId, input.projectId, process.name) });
      }
      return {
        environmentId: environment.id,
        processes,
        browser: await boxBrowserOf(db, organizationId, input.projectId),
        kept: await keptOf(db, organizationId, input.projectId),
        olderRunner: await olderRunnerOf(db, organizationId, input.projectId),
        canEdit: ctx.project.role === "admin",
      };
    }),

  /**
   * What detection (F-112) reads in each repo's files now and the list doesn't have, by name or
   * port, marked `detected` for a project admin to add. Read as text, never run. A repo whose files
   * can't be read adds nothing, with the reason.
   */
  detected: projectProcedure("read", projectInput)
    .output(
      z.object({
        processes: z.array(z.object({ origin: z.literal("detected"), repoId: repoIdSchema, repo: z.string(), process: detectedAppProcessViewSchema })),
        /** Why a repo added nothing: its installation isn't linked, or its files couldn't be read. */
        unread: z.array(z.object({ repoId: repoIdSchema, repo: z.string(), reason: z.string() })),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { db } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const environment = await environmentOf(db, organizationId, input.projectId);
      const repos = await db.repo.findMany({
        where: { projectId: input.projectId, organizationId },
        include: { ...installationStateSelect },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      });
      const detected: { readonly repoId: RepoId; readonly processes: readonly DetectedAppProcess[] }[] = [];
      const unread: { readonly repoId: RepoId; readonly repo: string; readonly reason: string }[] = [];
      for (const repo of repos) {
        const repoId = repoIdSchema.parse(repo.id);
        if (!installationUsable(repo.installation)) {
          unread.push({ repoId, repo: repo.fullName, reason: "its GitHub installation isn't linked to ostra" });
          continue;
        }
        try {
          const github = await loadGitHubConnection(ctx.deps, ctx.scope, connectionIdSchema.parse(repo.connectionId));
          const found = await detectRepoEnvironment(
            ctx.deps.ports.adapters.codeHost,
            { app: github.credentials, installationId: repo.installationId, repo: repoFullNameSchema.parse(repo.fullName) },
            repo.defaultBranch,
          );
          detected.push({ repoId, processes: found.appProcesses });
          // `detectRepoEnvironment` says so when the repo's files couldn't be read at all.
          const unreadable = found.reasons.find((reason) => reason.file === "(the repo)");
          if (unreadable !== undefined) {
            unread.push({ repoId, repo: repo.fullName, reason: unreadable.finding });
          }
        } catch (error) {
          // Detection is a hint: a repo the App can't read now adds nothing, and the list still shows.
          unread.push({ repoId, repo: repo.fullName, reason: error instanceof TRPCError ? error.message : "its files couldn't be read" });
        }
      }
      const saved = await appProcessesInTx(db, environment.id);
      return {
        processes: environmentAppProcessList(saved, detected).flatMap((entry) =>
          entry.origin === "detected" ? [{ origin: "detected" as const, repoId: entry.repoId, repo: repos.find((repo) => repo.id === entry.repoId)?.fullName ?? "", process: detectedView(entry.process) }] : [],
        ),
        unread,
      };
    }),

  /**
   * A project admin saves the whole list in its start order. A field that doesn't read is refused at
   * the door (`appProcessSchema`); a rule the list breaks comes back with each rule's words, for the
   * field it's about, and nothing is saved.
   */
  save: projectProcedure("admin", z.strictObject({ projectId: projectIdSchema, processes: z.array(appProcessSchema).max(runnerLimits.appProcessesMax) }))
    .output(
      z.discriminatedUnion("ok", [
        z.object({ ok: z.literal(true), saved: z.number().int() }),
        z.object({ ok: z.literal(false), reason: z.literal("rule-broken"), message: z.string(), issues: z.array(issueSchema) }),
      ]),
    )
    .mutation(async ({ ctx, input }) => {
      const saved = await saveAppProcesses(previewDeps(ctx.deps), ctx.scope, { projectId: input.projectId, processes: input.processes });
      if (saved.ok) {
        return { ok: true as const, saved: saved.saved };
      }
      switch (saved.error) {
        case "rule-broken":
          return { ok: false as const, reason: "rule-broken" as const, message: saved.message, issues: saved.issues.map(issueView) };
        case "not-found":
          throw new TRPCError({ code: "NOT_FOUND", message: saved.message });
        case "forbidden":
          throw new TRPCError({ code: "FORBIDDEN", message: saved.message });
        case "invalid-input":
          throw new TRPCError({ code: "BAD_REQUEST", message: saved.message });
        default:
          return saved satisfies never;
      }
    }),
});

// ---------- screenshots after each turn (F-121) ----------

const screenshotsViewSchema = z.object({
  afterTurn: z.boolean(),
  routes: z.array(z.string()),
  widths: z.array(screenshotWidthSchema),
  /** The primary process they open, or `null`: with none, none are taken. */
  primary: z.string().nullable(),
  /** Whether they're taken now: on, and a primary declared. */
  takes: z.boolean(),
});

const screenshotsView = async (db: Db, environmentId: EnvironmentId, settings: ScreenshotSettings): Promise<z.infer<typeof screenshotsViewSchema>> => {
  const primary = (await appProcessesInTx(db, environmentId)).find((process) => process.primary)?.name ?? null;
  return { afterTurn: settings.afterTurn, routes: [...settings.routes], widths: [...settings.widths], primary, takes: settings.afterTurn && primary !== null };
};

/** A save's refusal as the tRPC error a caller sees: only the processes' save has rules to word. */
const refusedSave = (refusal: { readonly error: "not-found" | "forbidden" | "invalid-input" | "rule-broken"; readonly message: string }): TRPCError => {
  switch (refusal.error) {
    case "not-found":
      return new TRPCError({ code: "NOT_FOUND", message: refusal.message });
    case "forbidden":
      return new TRPCError({ code: "FORBIDDEN", message: refusal.message });
    case "invalid-input":
    case "rule-broken":
      return new TRPCError({ code: "BAD_REQUEST", message: refusal.message });
    default:
      return refusal.error satisfies never;
  }
};

export const screenshotsRouter = router({
  /** "Screenshots after each turn": on or off, its routes and its widths, and whether they're taken now. */
  get: projectProcedure("read", projectInput)
    .output(screenshotsViewSchema)
    .query(async ({ ctx, input }) => {
      const environment = await environmentOf(ctx.deps.db, ctx.scope.organizationId, input.projectId);
      return screenshotsView(ctx.deps.db, environment.id, environment.screenshots);
    }),

  /** A project admin's save: up to 5 routes from `/`, each once, and the widths. Audited with the processes' entry. */
  save: projectProcedure(
    "admin",
    z.strictObject({
      projectId: projectIdSchema,
      afterTurn: z.boolean(),
      routes: screenshotSettingsSchema.shape.routes.unwrap(),
      widths: screenshotSettingsSchema.shape.widths.unwrap(),
    }),
  )
    .output(screenshotsViewSchema)
    .mutation(async ({ ctx, input }) => {
      const screenshots: ScreenshotSettings = { afterTurn: input.afterTurn, routes: input.routes, widths: input.widths };
      const saved = await saveAppProcesses(previewDeps(ctx.deps), ctx.scope, { projectId: input.projectId, screenshots });
      if (!saved.ok) {
        throw refusedSave(saved);
      }
      const environment = await environmentOf(ctx.deps.db, ctx.scope.organizationId, input.projectId);
      return screenshotsView(ctx.deps.db, environment.id, environment.screenshots);
    }),
});

// ---------- a service with a web UI (F-140) ----------

/**
 * A service's preview label (F-140): a service with a web UI, such as Mailpit's, opens as a preview
 * under it; `null` makes it no preview. A project admin's; a service without a port can't be one.
 */
export const servicePreviewProcedure = projectProcedure("admin", z.strictObject({ projectId: projectIdSchema, serviceId: serviceIdSchema, label: appLabelSchema.nullable() }))
  .output(z.object({ serviceId: serviceIdSchema, previewLabel: z.string().nullable() }))
  .mutation(async ({ ctx, input }) => {
    const service = await ctx.deps.db.service.findFirst({ where: { id: input.serviceId, projectId: input.projectId, organizationId: ctx.scope.organizationId }, select: { name: true } });
    if (service === null) {
      throw notFound("service");
    }
    const saved = await saveAppProcesses(previewDeps(ctx.deps), ctx.scope, { projectId: input.projectId, servicePreviews: { [service.name]: input.label } });
    if (!saved.ok) {
      throw refusedSave(saved);
    }
    return { serviceId: input.serviceId, previewLabel: input.label };
  });
