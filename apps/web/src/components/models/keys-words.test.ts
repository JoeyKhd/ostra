import { describe, expect, it } from "vitest";

import { servesText } from "./keys-words";

// F-135 (models-keys.md): the words of a key's panel.

describe("a key's listed models", () => {
  it("F-135/c15: each model names the projects where this key is the one serving it, or none", () => {
    expect(servesText([{ name: "northwind-portal" }])).toBe("serves northwind-portal");
    expect(servesText([{ name: "calculator" }, { name: "web-storefront" }])).toBe("serves calculator, web-storefront");
    expect(servesText([])).toBe("serves no project");
  });
});
