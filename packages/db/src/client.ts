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

/**
 * The URL with `options=-c TimeZone=UTC`, so every session the server opens runs in UTC (ADR 0037,
 * Q158): Prisma's driver adapter writes a `Date` into `timestamptz` as its UTC fields with no
 * offset, which Postgres reads in the session's time zone. Options already in the URL are kept.
 */
export const utcConnectionString = (databaseUrl: string): string => {
  const url = new URL(databaseUrl);
  const existing = url.searchParams.get("options");
  if (existing?.includes("TimeZone=") === true) {
    return databaseUrl;
  }
  url.searchParams.set("options", existing === null || existing === "" ? "-c TimeZone=UTC" : `${existing} -c TimeZone=UTC`);
  return url.toString();
};

/**
 * How long an interactive transaction waits for one of the pool's connections before it fails
 * (P2028, "Unable to start a transaction in the given time"). Prisma's own default is 2 s, which
 * turns any burst the pool can't start within 2 s into errors instead of a queue: on CI's runner,
 * 50 answers at once on 10 connections lost their tail (ticket 38's rehearsal, F-012), and core's
 * jobs went back to the queue's backoff. `pg`'s pool hands out connections first come, first
 * served, so waiting its turn is right; a caller with a deadline of its own (the webhook inbox's
 * insert) passes its own `maxWait`. Once started, a transaction still has Prisma's 5 s `timeout`.
 */
export const TRANSACTION_MAX_WAIT_MS = 10_000;

/**
 * How long the pool keeps a connection nobody uses before it closes it. `pg`'s own default is 10 s,
 * and the pool hands out the connection released last, so a server that's busy but not bursting
 * keeps one connection warm and closes the rest every 10 s; its next burst then opens them again,
 * inside each transaction's `maxWait`. Opening one is the slow part: a new Postgres backend and its
 * SCRAM sign-in, 30 to 150 ms on an idle Windows machine and up to 0.6 s on a loaded one, measured,
 * and longer still under a whole test run, where two answers at once outlasted Prisma's 2 s
 * (`plans-questions.test.ts`). A minute keeps a burst's connections for the next one, within the 15
 * a replica may hold (`docs/configuration.md`), and well under the idle limits of NATs and proxies.
 * Idle connections don't hold the process open (`allowExitOnIdle`), so a script that ends without
 * `$disconnect` doesn't wait out the minute.
 */
export const POOL_IDLE_MS = 60_000;

/** A client for the database at `databaseUrl`. The URL holds credentials: never log it. */
export const createDb = (databaseUrl: string, options: CreateDbOptions = {}): Db =>
  new PrismaClient({
    transactionOptions: { maxWait: TRANSACTION_MAX_WAIT_MS },
    adapter: new PrismaPg({
      connectionString: utcConnectionString(databaseUrl),
      idleTimeoutMillis: POOL_IDLE_MS,
      allowExitOnIdle: true,
      ...(options.maxConnections === undefined ? {} : { max: options.maxConnections }),
    }),
  });
