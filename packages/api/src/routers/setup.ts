import { z } from "zod";

import { memberProcedure, router } from "../trpc/init.ts";

// F-076 (ticket 30): the first-run checklist. The first admin isn't made here: the server seeds it
// at start (F-001, `auth/first-admin.ts`), so the checklist's first step is always done.

/** The setup checklist's steps, in the order the panel shows them (spec section 3). */
export const setupStepIds = ["admin", "model-provider", "github", "project", "runner", "first-task"] as const;
export type SetupStepId = (typeof setupStepIds)[number];

const setupStatusSchema = z.object({
  steps: z.array(z.object({ id: z.enum(setupStepIds), done: z.boolean() })),
  /** The first step not done, or `null` when the whole checklist is. */
  next: z.enum(setupStepIds).nullable(),
});

export const setupRouter = router({
  /** The checklist, derived from the tables: which steps are done (F-076). */
  status: memberProcedure.output(setupStatusSchema).query(async ({ ctx }) => {
    const { db } = ctx.deps;
    const organizationId = ctx.scope.organizationId;
    const [providers, github, projects, runners, tasks] = await Promise.all([
      db.modelProvider.count({ where: { organizationId } }),
      db.connection.count({ where: { organizationId, kind: "github" } }),
      db.project.count({ where: { organizationId } }),
      db.runner.count({ where: { organizationId, state: "online" } }),
      db.task.count({ where: { organizationId } }),
    ]);
    const done: Record<SetupStepId, boolean> = {
      // Reaching a member procedure means an admin exists.
      admin: true,
      "model-provider": providers > 0,
      github: github > 0,
      project: projects > 0,
      runner: runners > 0,
      "first-task": tasks > 0,
    };
    const steps = setupStepIds.map((id) => ({ id, done: done[id] }));
    return { steps, next: steps.find((step) => !step.done)?.id ?? null };
  }),
});
