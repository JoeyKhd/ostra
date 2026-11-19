import { z } from "zod";

import { instanceAdminProcedure, router } from "../trpc/init.ts";

// The install's own settings (ticket 31): instance admins only, apart from organization admins.

export const instanceRouter = router({
  /**
   * Sets how long finished tasks' histories, archives and blobs are kept (F-079): a number of days,
   * or `null` to keep them while the task exists. What is saved here wins over `OSTRA_RETENTION_DAYS`,
   * and a saved "keep" wins too (spec section 11, item 11). Audited.
   */
  saveRetention: instanceAdminProcedure
    .input(z.strictObject({ days: z.number().int().min(1).max(36_500).nullable() }))
    .output(z.object({ days: z.number().int().nullable(), savedAt: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const now = ports.clock.now();
      await db.$transaction(async (tx) => {
        await tx.instanceSetting.upsert({
          where: { id: "instance" },
          create: { id: "instance", retentionDays: input.days, retentionSetAt: new Date(now) },
          update: { retentionDays: input.days, retentionSetAt: new Date(now) },
        });
        await ports.audit.recordInTx(tx, {
          organizationId,
          projectId: null,
          actor: { kind: "member", id: ctx.scope.memberId },
          action: "retention.saved",
          entity: "organization",
          entityId: organizationId,
          data: { days: input.days },
        });
      });
      return { days: input.days, savedAt: now };
    }),
});
