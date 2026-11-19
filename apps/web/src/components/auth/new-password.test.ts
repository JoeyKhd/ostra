import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@ostra/domain/accounts";
import { describe, expect, it } from "vitest";

import { brokenRuleOf, changeFailureOf, ruleLineOf, ruleText } from "./new-password";

const short = "x".repeat(MIN_PASSWORD_LENGTH - 1);
const enough = "x".repeat(MIN_PASSWORD_LENGTH);
const tooLong = "x".repeat(MAX_PASSWORD_LENGTH + 1);

describe("brokenRuleOf", () => {
  it("holds a password to the policy's length", () => {
    expect(brokenRuleOf("")).toBe("min");
    expect(brokenRuleOf(short)).toBe("min");
    expect(brokenRuleOf(enough)).toBeNull();
    expect(brokenRuleOf("x".repeat(MAX_PASSWORD_LENGTH))).toBeNull();
    expect(brokenRuleOf(tooLong)).toBe("max");
  });
});

describe("ruleLineOf", () => {
  it("stays quiet while a short password is still being typed", () => {
    expect(ruleLineOf("", null)).toEqual({ tone: "plain", rule: "min" });
    expect(ruleLineOf(short, null)).toEqual({ tone: "plain", rule: "min" });
  });

  it("checks the rule off once it is met", () => {
    expect(ruleLineOf(enough, null)).toEqual({ tone: "met", rule: "min" });
  });

  it("turns red once a short password is flagged, and at once when it is too long", () => {
    expect(ruleLineOf(short, "min")).toEqual({ tone: "error", rule: "min" });
    expect(ruleLineOf(tooLong, null)).toEqual({ tone: "error", rule: "max" });
  });

  it("shows the server's rule when it refused one the form let through", () => {
    expect(ruleLineOf(enough, "min")).toEqual({ tone: "error", rule: "min" });
  });

  it("says the policy's numbers, never typed into the copy", () => {
    expect(ruleText("min")).toBe(`At least ${String(MIN_PASSWORD_LENGTH)} characters.`);
    expect(ruleText("max")).toBe(`At most ${String(MAX_PASSWORD_LENGTH)} characters.`);
  });
});

describe("changeFailureOf", () => {
  it("sends a lost session to sign in", () => {
    expect(changeFailureOf(401, "UNAUTHORIZED")).toEqual({ kind: "signedOut" });
  });

  it("reads the policy's refusals as the rule they break", () => {
    expect(changeFailureOf(400, "PASSWORD_TOO_SHORT")).toEqual({ kind: "rejected", rule: "min" });
    expect(changeFailureOf(400, "PASSWORD_TOO_LONG")).toEqual({ kind: "rejected", rule: "max" });
  });

  it("reads anything else as a plain failure", () => {
    expect(changeFailureOf(500, undefined)).toEqual({ kind: "unknown" });
    expect(changeFailureOf(0, undefined)).toEqual({ kind: "unknown" });
    expect(changeFailureOf(400, "INVALID_PASSWORD")).toEqual({ kind: "unknown" });
  });
});
