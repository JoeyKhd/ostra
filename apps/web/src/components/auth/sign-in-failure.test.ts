import { describe, expect, it } from "vitest";

import { t } from "@/lib/messages";

import { signInFailureOf, signInFailureText } from "./sign-in-failure";

describe("signInFailureOf", () => {
  it("reads a refused sign-in as wrong credentials, without naming the wrong half", () => {
    expect(signInFailureOf(401)).toBe("credentials");
    expect(signInFailureOf(400)).toBe("credentials");
    expect(signInFailureText("credentials")).toBe("That username or email and password don't match.");
  });

  it("tells the rate limit apart", () => {
    expect(signInFailureOf(429)).toBe("tooMany");
  });

  it("reads a server error or no reply as a plain failure", () => {
    expect(signInFailureOf(500)).toBe("unknown");
    expect(signInFailureOf(503)).toBe("unknown");
    expect(signInFailureOf(0)).toBe("unknown");
    expect(signInFailureText("unknown")).toBe(t("errors.unknown"));
  });
});
