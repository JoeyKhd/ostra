import { describe, expect, it } from "vitest";

import { tokenDetail } from "./join-token-list";

// A join token's second line on a pool's page (F-091, milestone 5's ticket 37): a token past its
// lifetime says it expired, as a revoked one says it was revoked, and never "expires" in the past.

const day = 86_400_000;
const now = Date.UTC(2026, 10, 20, 12, 0, 0);

describe("a join token's line", () => {
  it("F-091: a live token gives its expiry, an expired one says it expired, a revoked one when it was revoked", () => {
    expect(tokenDetail({ expiresAt: now + 30 * day, lastUsedAt: null, revokedAt: null, uses: 0 }, now)).toBe("expires 2026-12-20 · never used");
    expect(tokenDetail({ expiresAt: now - 60_000, lastUsedAt: null, revokedAt: null, uses: 0 }, now)).toBe("expired 2026-11-20 · never used");
    expect(tokenDetail({ expiresAt: null, lastUsedAt: null, revokedAt: null, uses: 2 }, now)).toBe("never expires · never used · 2 runners");
    expect(tokenDetail({ expiresAt: now - day, lastUsedAt: null, revokedAt: now - day, uses: 1 }, now)).toMatch(/^revoked /);
  });
});
