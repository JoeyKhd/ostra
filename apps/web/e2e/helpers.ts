import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { e2eAdmin, e2eBaseUrl } from "./settings.ts";

/** Records every request whose origin isn't the panel's: the page must call no third party. */
export const watchOrigins = (page: Page): { readonly foreign: () => readonly string[] } => {
  const own = new URL(e2eBaseUrl).origin;
  const foreign: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol === "data:" || url.protocol === "blob:") return;
    if (url.origin !== own) foreign.push(url.origin);
  });
  return { foreign: () => foreign };
};

/** No horizontal scroll at this width (F-075). */
export const expectNoHorizontalScroll = async (page: Page): Promise<void> => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
};

export const signIn = async (page: Page, identifier: string = e2eAdmin.username): Promise<void> => {
  await page.goto("/sign-in");
  await page.getByLabel("Username or email").fill(identifier);
  await page.getByLabel("Password").fill(e2eAdmin.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/");
};
