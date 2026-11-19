import { z } from "zod";

// A database error's code and SQLSTATE, as Prisma (its P-code) and the pg driver (`originalCode`)
// carry them. The thrown value is external data: it is read through a schema, and every level is
// optional so one missing level doesn't hide the code above it. Neither field holds content, so
// both are safe to log.
const databaseErrorSchema = z.looseObject({
  code: z.string().optional(),
  meta: z
    .looseObject({
      driverAdapterError: z.looseObject({ cause: z.looseObject({ originalCode: z.string().optional() }).optional() }).optional(),
    })
    .optional(),
});

export type DatabaseErrorCodes = { readonly code: string | undefined; readonly sqlState: string | undefined };

export const databaseErrorCodes = (error: unknown): DatabaseErrorCodes => {
  const parsed = databaseErrorSchema.safeParse(error);
  if (!parsed.success) {
    return { code: undefined, sqlState: undefined };
  }
  return { code: parsed.data.code, sqlState: parsed.data.meta?.driverAdapterError?.cause?.originalCode };
};
