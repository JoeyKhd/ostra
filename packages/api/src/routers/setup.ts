import { recordSetupComplete, setupStepMarks, setupTimeline, skipSetupStep, skipSetupStepInputSchema } from "@ostra/domain";
import type { AuditAction } from "@ostra/domain";
import { organizationIdSchema } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { adminProcedure, instanceAdminProcedure, memberProcedure, router, unwrap } from "../trpc/init.ts";
import { setupTimelineInputSchema, setupTimelineOutputSchema } from "./setup-timeline-schema.ts";

// F-076 (ticket 30), ticket 27: the first-run checklist. The first admin isn't made here: the
// server seeds it at start (F-001, `auth/first-admin.ts`), so the checklist's first step is always
// done. The Linear step can be set aside (`skip`), and shows its connection's state. Milestone 7
// (ticket 24): each step links to its page in the docs, setup is `complete` without Linear, and
// `timeline` says when each step was done, for the 30-minute measure. 2026-11-21 (the maintainer's
// "all yes"): once every required step was done, setup stays `complete` for good, kept as
// `setupCompletedAt`, so the checklist never comes back when every runner goes offline later;
// `runnerOnline` lets Home say so instead.

/** The setup checklist's steps, in the order the panel shows them (spec section 3). */
export const setupStepIds = ["admin", "model-provider", "github", "linear", "project", "runner", "first-task"] as const;
export type SetupStepId = (typeof setupStepIds)[number];

/** Linear is optional (F-076): shown, skippable, ticked once connected, never counted against `complete`. */
const optionalSetupSteps: ReadonlySet<SetupStepId> = new Set<SetupStepId>(["linear"]);

/**
 * Each step's page in the docs site, relative to `OSTRA_DOCS_URL` (the site exports with a
 * trailing slash). A heading's anchor is the docs' slug of its text (`apps/docs/content`).
 */
export const setupStepDocs = {
  admin: "docs/install/first-sign-in/",
  "model-provider": "docs/agents-and-models/model-providers/",
  github: "docs/install/setup/#3-connect-github",
  linear: "docs/install/linear/",
  project: "docs/install/setup/#5-create-a-project",
  runner: "docs/install/setup/#6-connect-a-runner",
  "first-task": "docs/using-ostra/tasks/",
} as const satisfies Record<SetupStepId, string>;

/**
 * `done`, `skipped` (the admin set it aside) or `open`; the Linear step also says `pending` (the
 * app is made and waits for its values or the consent) or `failed` (the connection broke).
 */
export const setupStepStates = ["done", "skipped", "open", "pending", "failed"] as const;
export type SetupStepState = (typeof setupStepStates)[number];

const setupStatusSchema = z.object({
  steps: z.array(z.object({ id: z.enum(setupStepIds), state: z.enum(setupStepStates), docs: z.url() })),
  /** The first step that is `open`, or `null` when none is. */
  next: z.enum(setupStepIds).nullable(),
  /**
   * Every step but the optional Linear one is done, or was once (`completedAt`): Home drops the
   * checklist, and it never comes back.
   */
  complete: z.boolean(),
  /** When every required step was first done, as epoch milliseconds; `null` until then. */
  completedAt: z.number().int().nullable(),
  /** Whether any of the organization's runners is online: once setup is done, Home says when none is. */
  runnerOnline: z.boolean(),
});

/** Every audit action that marks a setup step, for the timeline's one query. */
const setupMarkActions: readonly AuditAction[] = Object.values(setupStepMarks).flat();

export const setupRouter = router({
  /** The checklist, derived from the tables: where each step stands (F-076). */
  status: memberProcedure.output(setupStatusSchema).query(async ({ ctx }) => {
    const { db, settings, ports } = ctx.deps;
    const organizationId = ctx.scope.organizationId;
    const [providers, github, linear, setting, projects, runners, tasks] = await Promise.all([
      db.modelProvider.count({ where: { organizationId } }),
      db.connection.count({ where: { organizationId, kind: "github" } }),
      db.connection.findFirst({ where: { organizationId, kind: "linear", state: { not: "revoked" } }, select: { state: true } }),
      db.organizationSetting.findUnique({ where: { organizationId }, select: { linearSkippedAt: true, setupCompletedAt: true } }),
      db.project.count({ where: { organizationId } }),
      db.runner.count({ where: { organizationId, state: "online" } }),
      db.task.count({ where: { organizationId } }),
    ]);
    const settled = (done: boolean): SetupStepState => (done ? "done" : "open");
    // A connected Linear is done whether or not it was once skipped; a connection in progress or
    // broken says so; none is open, or skipped when an admin set it aside.
    const linearState = (): SetupStepState => {
      if (linear === null) {
        return setting?.linearSkippedAt === undefined || setting.linearSkippedAt === null ? "open" : "skipped";
      }
      return linear.state === "active" ? "done" : linear.state === "pending" ? "pending" : "failed";
    };
    const states: Record<SetupStepId, SetupStepState> = {
      // Reaching a member procedure means an admin exists.
      admin: "done",
      "model-provider": settled(providers > 0),
      github: settled(github > 0),
      linear: linearState(),
      project: settled(projects > 0),
      runner: settled(runners > 0),
      "first-task": settled(tasks > 0),
    };
    const steps = setupStepIds.map((id) => ({ id, state: states[id], docs: `${settings.docsUrl}${setupStepDocs[id]}` }));
    const allDone = steps.every((step) => step.state === "done" || optionalSetupSteps.has(step.id));
    // Kept the first time every step is done; a step that reopens later (a runner offline) doesn't undo it.
    const completedAt = setting?.setupCompletedAt?.getTime() ?? (allDone ? await recordSetupComplete(db, organizationId, ports.clock.now()) : null);
    return {
      steps,
      next: steps.find((step) => step.state === "open")?.id ?? null,
      complete: completedAt !== null,
      completedAt,
      runnerOnline: runners > 0,
    };
  }),

  /** "Skip for now" on the checklist's Linear step. Admins only. */
  skip: adminProcedure
    .input(skipSetupStepInputSchema)
    .output(z.object({ skippedAt: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const result = await db.$transaction((tx) => skipSetupStep({ tx, scope: ctx.scope, ...ports }, input));
      const skipped = unwrap(result, { forbidden: "FORBIDDEN" });
      return { skippedAt: skipped.skippedAt };
    }),

  /**
   * When each setup step of the install's first organization was done, from its audit entries and
   * its first PR's `pr.opened` event, measured from `start` (ADR 0064's 30-minute measure). The
   * instance admin's: `pnpm measure:setup` reads it. IDs and times only.
   */
  timeline: instanceAdminProcedure
    .input(setupTimelineInputSchema)
    .output(setupTimelineOutputSchema)
    .query(async ({ ctx, input }) => {
      const { db } = ctx.deps;
      const first = await db.organization.findFirst({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } });
      if (first === null) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No organization yet" });
      }
      const organizationId = organizationIdSchema.parse(first.id);
      const [marks, pullRequest] = await Promise.all([
        db.auditEntry.groupBy({ by: ["action"], where: { organizationId, action: { in: [...setupMarkActions] } }, _min: { createdAt: true } }),
        db.event.aggregate({ where: { organizationId, kind: "pr.opened" }, _min: { occurredAt: true } }),
      ]);
      const entries = marks.flatMap((row) => (row._min.createdAt === null ? [] : [{ organizationId, action: row.action, createdAt: row._min.createdAt.getTime() }]));
      return setupTimeline(organizationId, { start: input.start, entries, firstPullRequestOpenedAt: pullRequest._min.occurredAt?.getTime() ?? null });
    }),
});
