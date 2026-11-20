import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { t } from "@/lib/messages";

import { DefaultPasswordBanner } from "./default-password-banner";

// F-001: the panel says so while the account still has the default password it was seeded with
// (change-password.md, "The banner").

describe("the default-password banner", () => {
  it("F-001/c6: shows as a labelled region, not an alert, with a link to change it", () => {
    const html = renderToStaticMarkup(<DefaultPasswordBanner passwordChange="suggested" path="/" />);
    expect(html).toContain('role="region"');
    expect(html).not.toContain('role="alert"');
    expect(html).toContain(`aria-label="${t("banner.defaultPassword.label")}"`);
    expect(html).toContain(t("banner.defaultPassword.lead"));
    expect(html).toContain(t("banner.defaultPassword.detail"));
    expect(html).toContain('href="/change-password"');
  });

  it("brings the member back to the page they were on", () => {
    const html = renderToStaticMarkup(<DefaultPasswordBanner passwordChange="suggested" path="/projects/p1/environment" />);
    expect(html).toContain('href="/change-password?next=%2Fprojects%2Fp1%2Fenvironment"');
  });

  it("shows while a change is required too (the panel asks for it first, so it is rarely seen)", () => {
    expect(renderToStaticMarkup(<DefaultPasswordBanner passwordChange="required" path="/" />)).toContain(t("banner.defaultPassword.action"));
  });

  it("F-001/c6: is gone once the account has its own password", () => {
    expect(renderToStaticMarkup(<DefaultPasswordBanner passwordChange="none" path="/" />)).toBe("");
  });
});
