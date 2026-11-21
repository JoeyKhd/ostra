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
  "shell-phone-menu": ["shell-phone.html", "view=menu", 1440, 956],
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
  // Ticket 09's second batch (section 13's targets 5, 7, 8, 9, 11, 13 and 15).
  "environment-app-processes": ["environment-app-processes.html", "", 1440, 956],
  "environment-app-processes-light": ["environment-app-processes.html", "theme=light", 1440, 956],
  "environment-app-process-sheet": ["environment-app-processes.html", "sheet=api", 1440, 956],
  "environment-app-processes-no-browser": ["environment-app-processes.html", "browser=none", 1440, 956],
  "preview-viewer": ["preview-viewer.html", "", 1440, 956],
  "preview-viewer-light": ["preview-viewer.html", "theme=light", 1440, 956],
  "preview-viewer-states": ["preview-viewer.html", "view=states", 1440, 956],
  "preview-native": ["task-preview.html", "pane=native", 1440, 956],
  "preview-native-light": ["task-preview.html", "pane=native&theme=light", 1440, 956],
  "instance-preview-domain": ["instance-preview-domain.html", "", 1440, 956],
  "instance-preview-domain-unset": ["instance-preview-domain.html", "domain=unset", 1440, 956],
  "library-install": ["library-install.html", "", 1440, 956],
  "library-install-server": ["library-install.html", "kind=mcp", 1440, 956],
  "library-install-refusals": ["library-install.html", "kind=refusals", 1440, 956],
  "library-suggestions": ["library-suggestions.html", "", 1440, 956],
  "library-suggest-form": ["library-suggestions.html", "view=member", 1440, 956],
  "agent-profile-library": ["agent-profile-library.html", "", 1440, 956],
  "agent-profile-library-light": ["agent-profile-library.html", "theme=light", 1440, 956],
  "agent-profile-library-limit": ["agent-profile-library.html", "state=limit", 1440, 956],
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
