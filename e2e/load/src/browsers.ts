import { chromium } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";

// Real browsers on the receiving end (ticket 34, F-117, ADR 0035): a sample of Chromium pages,
// each signed in as the admin and open on a task with partial text on. The harness has the
// task's runner write a line of partial text with a marker in it; the page notes the moment the
// marker shows in its DOM. The time from the runner's write to the DOM is what a person watching
// would see. A marker the page never shows counts as unseen.

export type BrowserWatch = {
  readonly pages: number;
  /** When each marker showed in a page's DOM, by this machine's clock. */
  readonly seen: ReadonlyMap<string, number>;
  readonly close: () => Promise<void>;
};

/** Marks look like `mk-<step>-<n>`. */
const MARKER_SCRIPT = `
(() => {
  const found = new Set();
  const scan = (text) => {
    if (!text) return;
    for (const match of text.matchAll(/mk-[a-z0-9]+-[0-9]+/g)) {
      if (found.has(match[0])) continue;
      found.add(match[0]);
      window.__ostraSeen(match[0]);
    }
  };
  const start = () => {
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "characterData") scan(record.target.textContent);
        for (const node of record.addedNodes) scan(node.textContent);
      }
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
`;

const signIn = async (page: Page, email: string, password: string): Promise<void> => {
  await page.goto("/sign-in");
  await page.getByLabel("Username or email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname !== "/sign-in", { timeout: 120_000 });
};

export const openBrowsers = async (input: {
  readonly webUrl: string;
  readonly admin: { readonly email: string; readonly password: string };
  readonly taskIds: readonly string[];
}): Promise<BrowserWatch> => {
  const browser: Browser = await chromium.launch();
  const seen = new Map<string, number>();
  try {
    const context = await browser.newContext({ baseURL: input.webUrl, viewport: { width: 1280, height: 900 } });
    await context.exposeFunction("__ostraSeen", (marker: unknown) => {
      if (typeof marker === "string" && !seen.has(marker)) seen.set(marker, Date.now());
    });
    await context.addInitScript({ content: MARKER_SCRIPT });
    const first = await context.newPage();
    await signIn(first, input.admin.email, input.admin.password);
    const pages: Page[] = [first];
    for (let index = 1; index < input.taskIds.length; index += 1) pages.push(await context.newPage());
    await Promise.all(pages.map((page, index) => page.goto(`/tasks/${input.taskIds[index] ?? ""}`, { timeout: 180_000 })));
    return {
      pages: pages.length,
      seen,
      close: () => browser.close(),
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
};
