import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { t } from "@/lib/messages";

import { DefaultPasswordBanner } from "./default-password-banner";

// F-001: the panel warns while the account still has the default password it was seeded with.

describe("the default-password banner", () => {
  it("shows, with a link to change it, while the default password is allowed and still in use", () => {
    const html = renderToStaticMarkup(<DefaultPasswordBanner passwordChange="suggested" />);
    expect(html).toContain('role="alert"');
    expect(html).toContain(t("defaultPassword.banner"));
    expect(html).toContain('href="/change-password"');
  });

  it("shows while a change is required too (the panel asks for it first, so it is rarely seen)", () => {
    expect(renderToStaticMarkup(<DefaultPasswordBanner passwordChange="required" />)).toContain(t("defaultPassword.action"));
  });

  it("is gone once the account has its own password", () => {
    expect(renderToStaticMarkup(<DefaultPasswordBanner passwordChange="none" />)).toBe("");
  });
});
