import type { IdempotencyRecord, IdempotencyStore, RateBudget, RateBudgetStore } from "@ostra/adapter-sdk";
import type { Db, Prisma } from "@ostra/db";
import { organizationIdSchema } from "@ostra/protocol";
import type { OrganizationId } from "@ostra/protocol";

// The server's Postgres side of the adapters' plumbing (ADR 0011, ADR 0025, F-046, ticket 15): the
// `IdempotencyStore` on `IdempotencyRecord` and the `RateBudgetStore` on `RateBudget`, behind the
// interfaces `@ostra/adapter-sdk` declares. Both tables are keyed per organization, so a store is
// made for one organization, or with a resolver that names the organization a key belongs to (the
// one GitHub adapter the server holds serves every organization's App).
//
// A record holds IDs and results, never content; nothing here logs.

/** Which organization a key belongs to, or `null` when it can't tell: the call then runs unrecorded. */
export type OrganizationOfKey = (key: string) => Promise<OrganizationId | null>;

type Scope = OrganizationId | OrganizationOfKey;

const resolve = async (scope: Scope, key: string): Promise<OrganizationId | null> => (typeof scope === "function" ? scope(key) : scope);

/** A result as stored: its JSON text, wrapped, so `null` and plain values keep their shape. */
const toJson = (value: unknown): Prisma.InputJsonValue | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const text = JSON.stringify(value);
  return typeof text === "string" ? { value: text } : undefined;
};

/** Reads back what `toJson` stored. */
const fromJson = (value: Prisma.JsonValue | null): unknown => {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const text = value["value"];
    if (typeof text === "string") {
      try {
        const parsed: unknown = JSON.parse(text);
        return parsed;
      } catch {
        return null;
      }
    }
  }
  return null;
};

/** The idempotency keys of one organization (or of whichever organization `scope` names), on Postgres. */
export const postgresIdempotencyStore = (db: Db, scope: Scope): IdempotencyStore => ({
  claim: async (key, now) => {
    const organizationId = await resolve(scope, key);
    if (organizationId === null) {
      // No organization to record it under: the call runs, as with no store at all.
      return { claimed: true };
    }
    const inserted = await db.idempotencyRecord.createMany({
      data: [{ organizationId, key, state: "pending", claimedAt: new Date(now) }],
      skipDuplicates: true,
    });
    if (inserted.count === 1) {
      return { claimed: true };
    }
    const row = await db.idempotencyRecord.findUnique({
      where: { organizationId_key: { organizationId, key } },
      select: { state: true, claimedAt: true, doneAt: true, result: true },
    });
    if (row === null) {
      // Released between the two statements: claim it again.
      const again = await db.idempotencyRecord.createMany({
        data: [{ organizationId, key, state: "pending", claimedAt: new Date(now) }],
        skipDuplicates: true,
      });
      return again.count === 1 ? { claimed: true } : { claimed: false, existing: { state: "pending", claimedAt: now } };
    }
    const existing: IdempotencyRecord =
      row.state === "done"
        ? { state: "done", result: fromJson(row.result), doneAt: (row.doneAt ?? row.claimedAt).getTime() }
        : { state: "pending", claimedAt: row.claimedAt.getTime() };
    return { claimed: false, existing };
  },
  complete: async (key, result, now) => {
    const organizationId = await resolve(scope, key);
    if (organizationId === null) {
      return;
    }
    const json = toJson(result);
    await db.idempotencyRecord.upsert({
      where: { organizationId_key: { organizationId, key } },
      create: { organizationId, key, state: "done", claimedAt: new Date(now), doneAt: new Date(now), ...(json === undefined ? {} : { result: json }) },
      update: { state: "done", doneAt: new Date(now), ...(json === undefined ? {} : { result: json }) },
    });
  },
  release: async (key) => {
    const organizationId = await resolve(scope, key);
    if (organizationId === null) {
      return;
    }
    await db.idempotencyRecord.deleteMany({ where: { organizationId, key, state: "pending" } });
  },
});

/** The rate budgets of one organization's credentials (or of whichever organization `scope` names), on Postgres. */
export const postgresRateBudgetStore = (db: Db, scope: Scope): RateBudgetStore => ({
  get: async (key) => {
    const organizationId = await resolve(scope, key);
    if (organizationId === null) {
      return undefined;
    }
    const row = await db.rateBudget.findUnique({
      where: { organizationId_key: { organizationId, key } },
      select: { remaining: true, limit: true, resetAt: true },
    });
    return row === null ? undefined : { remaining: row.remaining, limit: row.limit, resetAt: row.resetAt.getTime() };
  },
  set: async (key, budget: RateBudget) => {
    const organizationId = await resolve(scope, key);
    if (organizationId === null) {
      return;
    }
    const data = { remaining: budget.remaining, limit: budget.limit, resetAt: new Date(budget.resetAt) };
    await db.rateBudget.upsert({
      where: { organizationId_key: { organizationId, key } },
      create: { organizationId, key, ...data },
      update: data,
    });
  },
});

/**
 * The organization a GitHub App key names (`app:<appId>`, `inst:<appId>:<installationId>`, the
 * GitHub adapter's budget keys): the organization whose connection holds that App.
 */
export const organizationOfGitHubKey =
  (db: Db): OrganizationOfKey =>
  async (key) => {
    const match = /^(?:app|inst):(\d{1,20})(?::|$)/.exec(key);
    const appId = match?.[1];
    if (appId === undefined) {
      return null;
    }
    const rows = await db.connection.findMany({ where: { kind: "github", appId }, select: { organizationId: true }, take: 2 });
    const [only, second] = rows;
    // An App connected by two organizations can't say whose budget it is: none is kept.
    return only === undefined || second !== undefined ? null : organizationIdSchema.parse(only.organizationId);
  };
