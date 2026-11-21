import path from "node:path";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { hydrated } from "./helpers.ts";
import { e2eAdmin, e2eMissingPreviewDomain } from "./settings.ts";

// Milestone 8, ticket 26 (F-144): Instance › Previews on an install whose preview domain has no DNS
// record (the second stack, `playwright.config.ts`: a name under `.invalid`, which never resolves).
// The page names the record and the certificate to add, and its check, run by itself on the first
// visit, reports the missing record and runs nothing after it; the pane keeps the box's browser until
// it passes. The real check (`instance.previewDomainCheck`): nothing here is faked.

/**
 * Signs the admin in on this stack, which allows the default password (F-001), so there's no forced
 * change: with the chosen password once `06-default-password` changed it, else with the default.
 */
const signInHere = async (page: Page): Promise<void> => {
  for (const password of [e2eAdmin.password, e2eAdmin.defaultPassword]) {
    await page.goto("/sign-in");
    const field = page.getByLabel("Username or email");
    await hydrated(field);
    await field.fill(e2eAdmin.username);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    const outcome = await Promise.race([
      page.waitForURL((url) => url.pathname === "/").then(() => "in" as const),
      page.getByText("That username or email and password don't match.").waitFor().then(() => "refused" as const),
    ]);
    if (outcome === "in") return;
  }
  throw new Error("the admin couldn't sign in on the second stack");
};

test("F-144/c8: the settings page names the DNS record and the certificate to add, and its check reports the missing record", async ({ page }) => {
  await signInHere(page);
  await page.goto("/instance/previews");
  await expect(page.getByTestId("instance-previews")).toHaveAttribute("data-domain", e2eMissingPreviewDomain);
  // The one record to add: a wildcard pointing at core's host, with its Copy; and the certificate.
  const record = page.getByTestId("preview-dns-record");
  await expect(record).toContainText(`*.${e2eMissingPreviewDomain}`);
  // Core's public address on this stack is an IP, so the record is an A record.
  await expect(record.getByRole("button", { name: "Copy" })).toHaveAttribute("data-copy", `*.${e2eMissingPreviewDomain} A 127.0.0.1`);
  await expect(page.getByTestId("preview-add-certificate")).toContainText(`A wildcard certificate for *.${e2eMissingPreviewDomain}`);
  await expect(page.getByTestId("preview-add-certificate")).toContainText("Let's Encrypt issues one only through DNS-01");
  // The check ran by itself: the record is missing, so nothing after it ran.
  const row = (name: string) => page.getByTestId("preview-domain-check").locator(`[data-row="${name}"]`);
  await expect(row("dns")).toHaveAttribute("data-state", "failed", { timeout: 30_000 });
  await expect(row("dns")).toContainText(`.${e2eMissingPreviewDomain} doesn't resolve.`);
  await expect(row("proxy")).toHaveAttribute("data-state", "skipped");
  await expect(row("upgrade")).toHaveAttribute("data-state", "skipped");
  await expect(page.getByTestId("preview-check-line")).toContainText("Until it passes, previews stream from the box's browser.");
  await expect(page.getByTestId("preview-domain-status")).toHaveText("Check failing");
  await expect(page.locator("[data-action='preview-check']")).toHaveText("Check again");
  // `OSTRA_E2E_SHOTS`: the picture compared with `instance-preview-domain` (a check failing).
  const shots = process.env["OSTRA_E2E_SHOTS"];
  if (shots !== undefined) {
    await page.mouse.move(0, 0);
    await page.screenshot({ path: path.join(shots, "m8-t26-instance-previews-missing-1440.png") });
  }
});
