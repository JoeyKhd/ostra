// Renders the milestone 8 targets: each page at its CSS size, at 2x, to ../<name>.png.
// `../to-webp.py` then writes the 1x .webp beside it. Playwright comes from a checkout's
// node_modules: `node render.mjs <path to playwright's index.mjs> [name ...]`.
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const [playwrightPath, ...only] = process.argv.slice(2);
const { chromium } = await import(pathToFileURL(playwrightPath).href);

// name: [page, query, width, height]
const targets = {
  "shell-home": ["shell-home.html", "", 1440, 956],
  "shell-home-light": ["shell-home.html", "theme=light", 1440, 956],
  "shell-project-tasks": ["shell-project-tasks.html", "", 1440, 956],
  "shell-project-tasks-light": ["shell-project-tasks.html", "theme=light", 1440, 956],
  "shell-peek": ["shell-project-tasks.html", "panel=none&peek=org", 1440, 956],
  "shell-phone": ["shell-phone.html", "", 1440, 956],
  "task-preview-pane": ["task-preview.html", "", 1440, 956],
  "task-preview-pane-light": ["task-preview.html", "theme=light", 1440, 956],
  "task-preview-expanded": ["task-preview.html", "view=expanded&panel=none", 1440, 956],
  "task-preview-starting": ["task-preview.html", "pane=loading", 1440, 956],
  "task-preview-stopped": ["task-preview.html", "pane=asleep", 1440, 956],
  "task-preview-none": ["task-preview.html", "pane=none", 1440, 956],
  "task-preview-services": ["task-preview.html", "menu=services", 1440, 956],
  "preview-share": ["task-preview.html", "menu=access", 1440, 956],
  "task-attachments": ["task-attachments.html", "", 1440, 956],
  "task-attachments-viewer": ["task-attachments.html", "viewer=1", 1440, 956],
  "library": ["library.html", "", 1440, 956],
  "library-update": ["library-update.html", "", 1440, 956],
  "library-browse": ["library-browse.html", "", 1440, 956],
};

const browser = await chromium.launch();
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
await browser.close();
