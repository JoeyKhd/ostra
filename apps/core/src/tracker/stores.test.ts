import { createRateBudget, withIdempotency } from "@ostra/adapter-sdk";
import { manualClock } from "@ostra/adapter-sdk/testing";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { organizationOfGitHubKey, postgresIdempotencyStore, postgresRateBudgetStore } from "@ostra/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Ticket 15: the plumbing's Postgres stores, behind the interfaces every adapter's plumbing takes.

let test: TestDatabase;
let fixture: IsolationFixture;

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
});

afterAll(async () => {
  await test.dispose();
});

describe("the Postgres idempotency store", () => {
  it("claims a key once, reports a pending claim, records the result, and releases a failed call", async () => {
    const store = postgresIdempotencyStore(test.db, fixture.a.organization.id);
    expect(await store.claim("k:1", 1000)).toEqual({ claimed: true });
    expect(await store.claim("k:1", 2000)).toEqual({ claimed: false, existing: { state: "pending", claimedAt: 1000 } });
    await store.complete("k:1", { externalId: "c-1", n: null }, 3000);
    expect(await store.claim("k:1", 4000)).toEqual({ claimed: false, existing: { state: "done", result: { externalId: "c-1", n: null }, doneAt: 3000 } });
    expect(await store.claim("k:2", 1000)).toEqual({ claimed: true });
    await store.release("k:2");
    expect(await store.claim("k:2", 5000)).toEqual({ claimed: true });
    // A done record isn't released.
    await store.release("k:1");
    expect((await store.claim("k:1", 6000)).claimed).toBe(false);
  });

  it("keeps each organization's keys apart", async () => {
    const a = postgresIdempotencyStore(test.db, fixture.a.organization.id);
    const b = postgresIdempotencyStore(test.db, fixture.b.organization.id);
    expect(await a.claim("shared", 1)).toEqual({ claimed: true });
    expect(await b.claim("shared", 1)).toEqual({ claimed: true });
  });

  it("runs a call once through the plumbing's withIdempotency", async () => {
    const store = postgresIdempotencyStore(test.db, fixture.a.organization.id);
    const clock = manualClock();
    let calls = 0;
    const call = () => {
      calls += 1;
      return Promise.resolve({ prNumber: 7 });
    };
    expect(await withIdempotency(store, clock, "task:t:open-pr:r", call)).toEqual({ kind: "ran", result: { prNumber: 7 } });
    expect(await withIdempotency(store, clock, "task:t:open-pr:r", call)).toEqual({ kind: "replayed", result: { prNumber: 7 } });
    expect(calls).toBe(1);
  });
});

describe("the Postgres rate budget store", () => {
  it("keeps a credential's budget, and the guard waits when it's spent", async () => {
    const store = postgresRateBudgetStore(test.db, fixture.a.organization.id);
    expect(await store.get("linear:conn")).toBeUndefined();
    const clock = manualClock(1_700_000_000_000);
    const guard = createRateBudget({ store, clock });
    await guard.record("linear:conn", { remaining: "0", limit: "5000", reset: String(Math.floor(clock.now() / 1000) + 60) });
    expect(await store.get("linear:conn")).toMatchObject({ remaining: 0, limit: 5000 });
    expect(await guard.check("linear:conn")).toMatchObject({ go: false });
    expect(await postgresRateBudgetStore(test.db, fixture.b.organization.id).get("linear:conn")).toBeUndefined();
  });

  it("files a GitHub App's budget under the organization whose App it is, and none for an unknown App", async () => {
    await test.db.connection.create({ data: { organizationId: fixture.a.organization.id, kind: "github", appId: "99001" } });
    const resolve = organizationOfGitHubKey(test.db);
    expect(await resolve("inst:99001:777")).toBe(fixture.a.organization.id);
    expect(await resolve("app:99001")).toBe(fixture.a.organization.id);
    expect(await resolve("inst:12345:1")).toBeNull();
    expect(await resolve("something-else")).toBeNull();
    const store = postgresRateBudgetStore(test.db, resolve);
    await store.set("inst:99001:777", { remaining: 10, limit: 5000, resetAt: 1_700_000_060_000 });
    expect(await postgresRateBudgetStore(test.db, fixture.a.organization.id).get("inst:99001:777")).toMatchObject({ remaining: 10 });
    // An unknown App's budget isn't kept, and its idempotent calls run unrecorded.
    await store.set("inst:12345:1", { remaining: 1, limit: null, resetAt: 1 });
    expect(await store.get("inst:12345:1")).toBeUndefined();
    expect(await postgresIdempotencyStore(test.db, resolve).claim("inst:12345:x", 1)).toEqual({ claimed: true });
  });
});
