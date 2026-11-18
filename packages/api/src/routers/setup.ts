import { createFirstAdmin, createFirstAdminInputSchema } from "@ostra/domain";
import { organizationIdSchema, userIdSchema } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { memberProcedure, publicProcedure, router, unwrap } from "../trpc/init.ts";

// F-001, F-002, F-076 (ticket 30): the first run, and the checklist that follows it.

/** The setup checklist's steps, in the order the panel shows them (spec section 3). */
export const setupStepIds = ["admin", "model-provider", "github", "project", "runner", "first-task"] as const;
export type SetupStepId = (typeof setupStepIds)[number];

const setupStatusSchema = z.object({
  steps: z.array(z.object({ id: z.enum(setupStepIds), done: z.boolean() })),
  /** The first step not done, or `null` when the whole checklist is. */
  next: z.enum(setupStepIds).nullable(),
});

const firstAdminResultSchema = z.object({
  userId: userIdSchema,
  organizationId: organizationIdSchema,
});

export const setupRouter = router({
  /**
   * Whether this install still needs its first admin. Public: the sign-in page asks before anyone
   * has an account. It says nothing else.
   */
  state: publicProcedure.query(async ({ ctx }) => {
    const accounts = await ctx.deps.db.user.count();
    return { needsFirstAdmin: accounts === 0, openSignup: ctx.deps.settings.openSignupAccounts };
  }),

  /**
   * Creates the first account: the instance admin and the admin of the first organization, which
   * ostra creates with it. It needs the setup token from the server's log, and stops working once
   * an account exists. On success the response signs the new admin in (a session cookie).
   */
  createFirstAdmin: publicProcedure
    .input(createFirstAdminInputSchema)
    .output(firstAdminResultSchema)
    .mutation(async ({ ctx, input }) => {
      const { deps } = ctx;
      const created = unwrap(
        await createFirstAdmin(
          {
            db: deps.db,
            expectedSetupToken: deps.setupToken,
            hashPassword: deps.hashPassword,
            audit: deps.ports.audit,
            notices: deps.ports.notices,
            clock: deps.ports.clock,
          },
          input,
        ),
        {
          "wrong-setup-token": "FORBIDDEN",
          "already-set-up": "CONFLICT",
          "username-taken": "CONFLICT",
          "email-taken": "CONFLICT",
        },
      );
      // Sign the new admin in: the same session a sign-in makes, its cookie on this response.
      const { headers } = await deps.auth.api.signInUsername({
        body: { username: input.username, password: input.password },
        returnHeaders: true,
      });
      const cookies = headers.getSetCookie();
      if (cookies.length === 0) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The account exists, but signing in failed: sign in by hand" });
      }
      for (const cookie of cookies) {
        ctx.resHeaders.append("set-cookie", cookie);
      }
      deps.logger.info("setup.first_admin_created", { organizationId: created.organizationId, memberId: created.memberId });
      return { userId: created.userId, organizationId: created.organizationId };
    }),

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
