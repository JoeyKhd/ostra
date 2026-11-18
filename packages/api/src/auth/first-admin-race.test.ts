import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBareHarness, TEST_PASSWORD } from "../testing/index.ts";
import type { BareHarness } from "../testing/index.ts";

// Spike 9, surprise 2: several people reaching a brand-new install at the same moment must still
// produce exactly one admin, one organization and one member.

const CONCURRENT_ATTEMPTS = 6;

let harness: BareHarness;

beforeAll(async () => {
  harness = await createBareHarness();
});

afterAll(async () => {
  await harness.dispose();
});

describe("a race of first sign-ups", () => {
  it("gives exactly one admin and one organization", async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: CONCURRENT_ATTEMPTS }, (_, index) =>
        harness.anonymous().setup.createFirstAdmin({
          setupToken: harness.setupToken,
          username: `first-${String(index)}`,
          email: `first-${String(index)}@example.com`,
          password: TEST_PASSWORD,
          organizationName: `Organization ${String(index)}`,
        }),
      ),
    );
    const created = attempts.filter((attempt) => attempt.status === "fulfilled");
    expect(created).toHaveLength(1);
    for (const attempt of attempts) {
      if (attempt.status === "rejected") {
        expect(attempt.reason).toMatchObject({ code: "CONFLICT" });
      }
    }
    expect(await harness.test.db.user.count()).toBe(1);
    expect(await harness.test.db.user.count({ where: { role: "admin" } })).toBe(1);
    expect(await harness.test.db.organization.count()).toBe(1);
    expect(await harness.test.db.member.count({ where: { role: "admin" } })).toBe(1);
  });
});
