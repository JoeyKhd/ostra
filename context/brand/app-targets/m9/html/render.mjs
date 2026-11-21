// Renders the milestone 9 targets: each page at its CSS size, at 2x, to ../<name>.png.
// `to-webp.py` then writes the 1x .webp beside it. Playwright comes from a checkout's
// node_modules: `node render.mjs <path to playwright's index.mjs> [name ...]`.
// The pages load milestone 8's tokens, shell and demo app from `../../m8/html/`.
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const [playwrightPath, ...only] = process.argv.slice(2);
const { chromium } = await import(pathToFileURL(playwrightPath).href);

// name: [page, query, width, height]
const targets = {
  // 1. The message box with attachments (composer-attachments.md)
  "composer-attachments": ["task-composer.html", "", 1440, 956],
  "composer-attachments-light": ["task-composer.html", "theme=light", 1440, 956],
  "composer-drop": ["task-composer.html", "view=drop", 1440, 956],
  "composer-states": ["composer-states.html", "", 1440, 956],
  "composer-phone": ["composer-phone.html", "", 1440, 956],
  // 2. A member's message with attachments in the thread (message-attachments.md)
  "message-attachments": ["message-attachments.html", "", 1440, 956],
  "message-attachments-light": ["message-attachments.html", "theme=light", 1440, 956],
  "message-attachments-viewer": ["message-attachments.html", "viewer=1", 1440, 956],
  // 3. The ticket's context on a task from Linear (ticket-context.md)
  "ticket-context": ["ticket-context.html", "", 1440, 956],
  "ticket-context-light": ["ticket-context.html", "theme=light", 1440, 956],
  "ticket-context-skipped": ["ticket-context.html", "state=skipped", 1440, 956],
  "ticket-context-failed": ["ticket-context.html", "state=failed", 1440, 956],
  // 4. The new-task page with files attached (new-task-attachments.md)
  "new-task-attachments": ["new-task-attachments.html", "", 1440, 956],
  "new-task-attachments-light": ["new-task-attachments.html", "theme=light", 1440, 956],
};

const browser = await chromium.launch();
try {
  for (const [name, [page, query, width, height]] of Object.entries(targets)) {
    if (only.length > 0 && !only.includes(name)) continue;
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
    const tab = await ctx.newPage();
    await tab.goto(`${pathToFileURL(path.join(here, page)).href}${query ? `?${query}` : ""}`);
    await tab.waitForSelector("body[data-ready='1']");
    await tab.evaluate(() => document.fonts.ready);
    await tab.waitForTimeout(150);
    await tab.screenshot({ path: path.join(here, "..", `${name}.png`) });
    await ctx.close();
    console.log(`${name}.png ${width}x${height} @2x`);
  }
} finally {
  await browser.close();
}
