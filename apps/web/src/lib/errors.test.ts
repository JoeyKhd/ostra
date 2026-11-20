import { afterEach, describe, expect, it, vi } from "vitest";

import messages from "../../messages/en.json";
import { errorText } from "./errors";
import { t } from "./messages";
import { pseudoText } from "./pseudo-locale";

// F-083 (ticket 20): a refusal the panel shows reaches it as a code and is worded through `t`,
// never as the server's English: a role refusal (FORBIDDEN) here. Under the pseudo-locale it comes
// back bracketed; `e2e/pseudo-locale.spec.ts` finds it and a budget stop so on the page.

const roleRefusal = { message: "You may not do this in this organization", data: { code: "FORBIDDEN" } };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("a refusal is a code the panel words", () => {
  it("F-083/c1: a role refusal is worded through t, not the server's message", () => {
    expect(errorText(roleRefusal)).toBe(t("errors.forbidden"));
    expect(errorText(roleRefusal)).not.toContain("You may not");
  });

  it("F-083/c1: under the pseudo-locale, a role refusal comes back pseudo", async () => {
    vi.stubEnv("OSTRA_PSEUDO_LOCALE", "1");
    vi.resetModules();
    const errors = await import("./errors");
    expect(errors.errorText(roleRefusal)).toBe(pseudoText(messages.errors.forbidden));
  });
});
