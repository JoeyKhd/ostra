import { skipSetupStep, skipSetupStepInputSchema } from "@ostra/domain";
import { z } from "zod";

import { adminProcedure, memberProcedure, router, unwrap } from "../trpc/init.ts";

// F-076 (ticket 30), ticket 27: the first-run checklist. The first admin isn't made here: the
// server seeds it at start (F-001, `auth/first-admin.ts`), so the checklist's first step is always
// done. The Linear step can be set aside (`skip`), and shows its connection's state.

/** The setup checklist's steps, in the order the panel shows them (spec section 3). */
export const setupStepIds = ["admin", "model-provider", "github", "linear", "project", "runner", "first-task"] as const;
export type SetupStepId = (typeof setupStepIds)[number];

/**
 * `done`, `skipped` (the admin set it aside) or `open`; the Linear step also says `pending` (the
 * app is made and waits for its values or the consent) or `failed` (the connection broke).
 */
export const setupStepStates = ["done", "skipped", "open", "pending", "failed"] as const;
export type SetupStepState = (typeof setupStepStates)[number];

const setupStatusSchema = z.object({
  steps: z.array(z.object({ id: z.enum(setupStepIds), state: z.enum(setupStepStates) })),
  /** The first step that is `open`, or `null` when none is. */
  next: z.enum(setupStepIds).nullable(),
});

export const setupRouter = router({
  /** The checklist, derived from the tables: where each step stands (F-076). */
  status: memberProcedure.output(setupStatusSchema).query(async ({ ctx }) => {
    const { db } = ctx.deps;
    const organizationId = ctx.scope.organizationId;
    const [providers, github, linear, setting, projects, runners, tasks] = await Promise.all([
      db.modelProvider.count({ where: { organizationId } }),
      db.connection.count({ where: { organizationId, kind: "github" } }),
      db.connection.findFirst({ where: { organizationId, kind: "linear", state: { not: "revoked" } }, select: { state: true } }),
      db.organizationSetting.findUnique({ where: { organizationId }, select: { linearSkippedAt: true } }),
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
    const steps = setupStepIds.map((id) => ({ id, state: states[id] }));
    return { steps, next: steps.find((step) => step.state === "open")?.id ?? null };
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
});
