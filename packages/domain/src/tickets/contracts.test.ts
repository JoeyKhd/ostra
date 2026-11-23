import { describe, expect, it } from "vitest";

import { isPendingAppId, linearAppIdPlaceholders } from "./contracts.ts";

describe("a tracker row's pending placeholder (milestone 11, ADR 0071)", () => {
  it("F-152/c6: reads milestone 11's `pending:<id>` and the `pending` written before it as pending, and nothing else", () => {
    expect(isPendingAppId("pending:0193a1b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b")).toBe(true);
    expect(isPendingAppId(linearAppIdPlaceholders.pending)).toBe(true);
    // A saved client ID, a cloud ID, the development seed and a revoked row's app ID aren't pending.
    for (const appId of ["4f1c2a9e8b7d6c5e", "a436116f-02ce-4520-8fbb-7301462a1674", linearAppIdPlaceholders.apiKey, "revoked:0193a1b2", "pendingx", "pending-1"]) {
      expect(isPendingAppId(appId), appId).toBe(false);
    }
  });
});
