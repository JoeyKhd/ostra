// Renders the four ledger gaps' targets: each page at its CSS size, at 2x, to ../<name>.png.
// `to-webp.py` then writes the 1x .webp beside it. Playwright comes from a checkout's
// node_modules: `node render.mjs <path to playwright's index.mjs> [name ...]`.
// The pages load milestone 8's tokens and shell and milestone 9's parts.
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const [playwrightPath, ...only] = process.argv.slice(2);
const { chromium } = await import(pathToFileURL(playwrightPath).href);

// name: [page, query, width, height]
const targets = {
  // 1. "Make a ticket for every prompt task" on a project's Boards page (prompt-tickets.md)
  "prompt-tickets": ["boards.html", "", 1440, 956],
  "prompt-tickets-light": ["boards.html", "theme=light", 1440, 956],
  "prompt-tickets-states": ["states.html", "sheet=prompt", 1440, 956],
  "prompt-tickets-new-task": ["new-task.html", "", 1440, 956],
  "prompt-tickets-phone": ["phone.html", "scene=prompt", 390, 844],
  // 2. Organization › Spend: Keys (spend-keys.md)
  "spend-keys": ["spend.html", "", 1440, 956],
  "spend-keys-light": ["spend.html", "theme=light", 1440, 956],
  "spend-keys-states": ["states.html", "sheet=spend", 1440, 956],
  "spend-keys-phone": ["phone.html", "scene=spend", 390, 844],
  // 3. Organization › GitHub: turning on events later (github-events.md)
  "github-events": ["github.html", "view=off", 1440, 956],
  "github-events-turn-on": ["github.html", "view=once", 1440, 956],
  "github-events-turn-on-light": ["github.html", "view=once&theme=light", 1440, 956],
  "github-events-states": ["states.html", "sheet=github", 1440, 956],
  "github-events-phone": ["phone.html", "scene=github", 390, 844],
  // 4. Environment: a new repo's draft beside the saved setup (environment-repo-draft.md)
  "environment-repo-draft": ["environment.html", "view=draft", 1440, 956],
  "environment-repo-draft-light": ["environment.html", "view=draft&theme=light", 1440, 956],
  "environment-repo-draft-edit": ["environment.html", "view=edit", 1440, 956],
  "environment-repo-draft-states": ["states.html", "sheet=env", 1440, 956],
  "environment-repo-draft-phone": ["phone.html", "scene=env", 390, 844],
};

const browser = await chromium.launch();
try {
  for (const [name, [page, query, width, height]] of Object.entries(targets)) {
    if (only.length > 0 && !only.includes(name)) continue;
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
    const tab = await ctx.newPage();
    tab.on("pageerror", (e) => console.error(`${name}: ${e.message}`));
    await tab.goto(`${pathToFileURL(path.join(here, page)).href}${query ? `?${query}` : ""}`);
    await tab.waitForSelector("body[data-ready='1']");
    await tab.evaluate(() => document.fonts.ready);
    await tab.waitForTimeout(200);
    await tab.screenshot({ path: path.join(here, "..", `${name}.png`) });
    await ctx.close();
    console.log(`${name}.png ${width}x${height} @2x`);
  }
} finally {
  await browser.close();
}
