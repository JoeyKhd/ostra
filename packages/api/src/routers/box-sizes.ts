import { BOX_SIZE_MAX, BOX_SIZE_MIN, DEFAULT_BOX_SIZES, setBoxSizes } from "@ostra/domain";
import { boxSizeNameSchema } from "@ostra/protocol";
import { z } from "zod";

import { adminProcedure, memberProcedure, router, unwrap } from "../trpc/init.ts";

// F-095 (milestone 5's ticket 27): the organization's three box sizes. Every member reads them (a
// project's default names one, and New task shows it); an organization admin changes one at a
// time, at least half a vCPU and 1 GiB *(working values)*, each change an audit entry.

const sizeSchema = z.object({ name: boxSizeNameSchema, cpuMillis: z.number().int(), memoryMiB: z.number().int(), updatedAt: z.number().int().nullable() });

export const boxSizesRouter = router({
  /** The three sizes in order: small, medium, large. One the organization lacks reads as its default. */
  list: memberProcedure.output(z.array(sizeSchema)).query(async ({ ctx }) => {
    const rows = await ctx.deps.db.boxSize.findMany({
      where: { organizationId: ctx.scope.organizationId },
      select: { name: true, cpuMillis: true, memoryMiB: true, updatedAt: true },
    });
    return boxSizeNameSchema.options.map((name) => {
      const row = rows.find((candidate) => candidate.name === name);
      return row === undefined
        ? { name, ...DEFAULT_BOX_SIZES[name], updatedAt: null }
        : { name, cpuMillis: row.cpuMillis, memoryMiB: row.memoryMiB, updatedAt: row.updatedAt.getTime() };
    });
  }),

  /** An admin sets one size's limits. */
  update: adminProcedure
    .input(
      z.strictObject({
        name: boxSizeNameSchema,
        cpuMillis: z.number().int().min(BOX_SIZE_MIN.cpuMillis).max(BOX_SIZE_MAX.cpuMillis),
        memoryMiB: z.number().int().min(BOX_SIZE_MIN.memoryMiB).max(BOX_SIZE_MAX.memoryMiB),
      }),
    )
    .output(z.object({ changedAt: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const changed = unwrap(
        await setBoxSizes({ db: ctx.deps.db, ...ctx.deps.ports }, ctx.scope, { sizes: { [input.name]: { cpuMillis: input.cpuMillis, memoryMiB: input.memoryMiB } } }),
        { forbidden: "FORBIDDEN", "invalid-input": "BAD_REQUEST" },
      );
      return { changedAt: changed.changedAt };
    }),
});
