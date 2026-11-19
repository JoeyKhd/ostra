import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBareHarness, TEST_PASSWORD } from "../testing/index.ts";
import type { BareHarness } from "../testing/index.ts";
import { ensureFirstAdmin } from "./first-admin.ts";

// F-001: the server seeds the first admin at start. Spike 9, surprise 2, still holds: several
// replicas reaching a brand-new install at the same moment must produce exactly one admin, one
// organization and one member, and an install that has an account is never seeded again.

const CONCURRENT_STARTS = 6;

let harness: BareHarness;

beforeAll(async () => {
  harness = await createBareHarness();
});

afterAll(async () => {
  await harness.dispose();
});

const seedAs = (index: number) =>
  ensureFirstAdmin({
    db: harness.test.db,
    settings: {
      firstAdmin: {
        email: `first-${String(index)}@example.com`,
        username: `first-${String(index)}`,
        password: index % 2 === 0 ? TEST_PASSWORD : null,
        organizationName: `Organization ${String(index)}`,
      },
    },
    hashPassword: harness.deps.hashPassword,
    ports: harness.deps.ports,
    logger: harness.deps.logger,
  });

describe("a race of server starts on an empty install", () => {
  it("seeds exactly one admin and one organization", async () => {
    const results = await Promise.all(Array.from({ length: CONCURRENT_STARTS }, (_, index) => seedAs(index)));
    expect(results.filter((seeded) => seeded !== null)).toHaveLength(1);
    expect(await harness.test.db.user.count()).toBe(1);
    expect(await harness.test.db.user.count({ where: { role: "admin" } })).toBe(1);
    expect(await harness.test.db.account.count()).toBe(1);
    expect(await harness.test.db.organization.count()).toBe(1);
    expect(await harness.test.db.member.count({ where: { role: "admin" } })).toBe(1);
  });

  it("and a later start seeds nothing", async () => {
    expect(await seedAs(99)).toBeNull();
    expect(await harness.test.db.user.count()).toBe(1);
  });

  it("never logs the password, the email or the username", () => {
    const lines = JSON.stringify(harness.logs);
    expect(lines).not.toContain(TEST_PASSWORD);
    expect(lines).not.toContain("@example.com");
    expect(lines).not.toMatch(/"first-\d+"/);
  });
});
