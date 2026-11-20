import { describe, expect, it } from "vitest";

import { signedUpOutcomeOf } from "./sign-up-by-invitation";

describe("the page after a sign-up through an invitation", () => {
  it("F-002/c10: with email set up, a sign-up that signed the account in still says Check your inbox, not Home", () => {
    expect(signedUpOutcomeOf("session-token", true)).toEqual({ kind: "verify" });
    expect(signedUpOutcomeOf(null, true)).toEqual({ kind: "verify" });
  });

  it("F-002/c10: with no email, the invitee joins and goes Home at once", () => {
    expect(signedUpOutcomeOf("session-token", false)).toEqual({ kind: "joined" });
  });
});
