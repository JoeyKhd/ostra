import { describe, expect, it } from "vitest";

import { errorText } from "./errors";
import { plural, t } from "./messages";

describe("t", () => {
  it("reads a nested key", () => {
    expect(t("signIn.title")).toBe("Sign in");
  });

  it("fills placeholders and leaves unknown ones", () => {
    expect(t("checklist.progress", { done: 2, total: 6 })).toBe("2 of 6");
    expect(t("checklist.progress", { done: 2 })).toBe("2 of {total}");
  });

  it("picks the singular or plural key", () => {
    expect(plural(1, "checklist.progress", "changePassword.rule", { done: 1, total: 1 })).toBe("1 of 1");
    expect(plural(12, "checklist.progress", "changePassword.rule")).toBe("At least 12 characters.");
  });
});

describe("errorText", () => {
  it("turns a Zod refusal into one line", () => {
    const message = JSON.stringify([{ path: ["baseUrl"], message: "Invalid URL" }]);
    expect(errorText({ message, data: { code: "BAD_REQUEST" } })).toBe("baseUrl: Invalid URL");
  });

  it("keeps the server's own words and hides an internal error", () => {
    expect(errorText({ message: "No such project", data: { code: "NOT_FOUND" } })).toBe("No such project");
    expect(errorText({ message: "boom", data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(t("errors.server"));
    expect(errorText(null)).toBeNull();
  });
});
