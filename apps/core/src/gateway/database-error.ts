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

// Prisma's own codes for a value or constraint the database refused, for when the driver's SQLSTATE
// isn't on the error: P2000 value too long, P2002 unique, P2003 foreign key, P2004 constraint,
// P2011 null constraint.
const prismaDataCodes: ReadonlySet<string> = new Set(["P2000", "P2002", "P2003", "P2004", "P2011"]);

/**
 * Whether the database refused the data itself: SQLSTATE class 22 (data exception: bad text, a value
 * out of range) or class 23 (integrity constraint). The same data is refused again on every try, so
 * a caller must not retry it as it was. Anything else (a lost connection, a deadlock, a timeout) is
 * transient and worth a retry.
 */
export const isDataRefusal = (codes: DatabaseErrorCodes): boolean => {
  if (codes.sqlState !== undefined) {
    return codes.sqlState.startsWith("22") || codes.sqlState.startsWith("23");
  }
  return codes.code !== undefined && prismaDataCodes.has(codes.code);
};
