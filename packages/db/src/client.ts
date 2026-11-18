import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/prisma/client.ts";
import type { Prisma } from "./generated/prisma/client.ts";

// The database client (ticket 05). Prisma 7 runs its query compiler in JavaScript and talks to
// Postgres through the `pg` driver adapter. Creating a client doesn't connect: the pool opens on
// the first query. Ported from spikes/auth-foundation/src/db/prisma-client.ts.

/** ostra's database client. */
export type Db = PrismaClient;

/** The client inside `db.$transaction(async (tx) => …)`: what every `…InTx` function takes. */
export type Tx = Prisma.TransactionClient;

/** Either a client or a transaction: for reads that work in both. */
export type DbOrTx = Db | Tx;

export type CreateDbOptions = {
  /** The most connections the pool opens. Default: `pg`'s own (10). */
  readonly maxConnections?: number;
};

/** A client for the database at `databaseUrl`. The URL holds credentials: never log it. */
export const createDb = (databaseUrl: string, options: CreateDbOptions = {}): Db =>
  new PrismaClient({
    adapter: new PrismaPg({
      connectionString: databaseUrl,
      ...(options.maxConnections === undefined ? {} : { max: options.maxConnections }),
    }),
  });
