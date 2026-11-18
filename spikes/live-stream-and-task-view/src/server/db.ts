import { Pool, type PoolClient } from "pg";
import type { z } from "zod";

export type Db = Pool;
export type Queryable = Pick<Pool | PoolClient, "query">;

// `idleTimeoutMs` 0 keeps every connection open. The harness does that so the database's process set stays the
// same through a measurement (a backend that exits takes its CPU time out of the total the load test sums).
export const createPool = (databaseUrl: string, max: number, idleTimeoutMs = 10_000): Db =>
  new Pool({ connectionString: databaseUrl, max, idleTimeoutMillis: idleTimeoutMs });

// Rows are parsed with a Zod schema at the boundary, and the inferred type is trusted after that.
export const rows = async <S extends z.ZodType>(
  db: Queryable,
  schema: S,
  text: string,
  values: readonly unknown[] = [],
): Promise<z.infer<S>[]> => {
  const result = await db.query<Record<string, unknown>>(text, [...values]);
  return result.rows.map((row) => schema.parse(row));
};

export const exec = async (db: Queryable, text: string, values: readonly unknown[] = []): Promise<number> => {
  const result = await db.query(text, [...values]);
  return result.rowCount ?? 0;
};

export const withTx = async <T>(db: Db, fn: (client: PoolClient) => Promise<T>): Promise<T> => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // the original error is the one that matters
    }
    throw error;
  } finally {
    client.release();
  }
};
