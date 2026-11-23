// Renders the post-v1 Trello targets: each page at its CSS size, at 2x, to ../<name>.png.
// `to-webp.py` then writes the 1x .webp beside it. Playwright comes from a checkout's
// node_modules: `node render.mjs <path to playwright's index.mjs> [name ...]`.
// The pages load milestone 8's tokens and shell, the m10 gaps' parts and milestone 11's
// tracker parts.
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const [playwrightPath, ...only] = process.argv.slice(2);
if (!playwrightPath) {
  console.error("usage: node render.mjs <path to playwright/index.mjs> [name ...]");
  process.exit(2);
}
const { chromium } = await import(pathToFileURL(playwrightPath).href);

// name: [page, query, width, height, scene]. Every desktop target also renders `<name>-light`,
// and every core screen also renders at 390×844 as `<name>-phone` and `<name>-phone-light`.
const desktop = {
  "trackers-trello": ["trackers.html", ""],
  "trello-picker": ["trackers.html", "view=picker"],
  "trello-connect-app": ["connection.html", "view=app"],
  "trello-connect-consent": ["connection.html", "view=consent"],
  "trello-connect-token": ["connection.html", "view=token"],
  "trello-connect-polling": ["connection.html", "view=polling"],
  "connection-trello": ["connection.html", "view=connected"],
  "boards-trello": ["boards.html", "view=mapping"],
  "boards-attach-trello": ["boards.html", "view=attach"],
  "ticket-chips-trello": ["chips.html", ""],
};
const phoneScenes = {
  "trackers-trello": "list",
  "trello-picker": "picker",
  "trello-connect-app": "app",
  "trello-connect-consent": "consent",
  "trello-connect-token": "token",
  "trello-connect-polling": "polling",
  "connection-trello": "settings",
  "boards-trello": "boards",
  "boards-attach-trello": "attach",
  "ticket-chips-trello": "chips",
};
const targets = {};
for (const [name, [page, query]] of Object.entries(desktop)) {
  targets[name] = [page, query, 1440, 956];
  targets[`${name}-light`] = [page, query ? `${query}&theme=light` : "theme=light", 1440, 956];
  const scene = phoneScenes[name];
  targets[`${name}-phone`] = ["phone.html", `scene=${scene}`, 390, 844];
  targets[`${name}-phone-light`] = ["phone.html", `scene=${scene}&theme=light`, 390, 844];
}
targets["trello-states"] = ["states.html", "", 1440, 956];

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
    await tab.waitForTimeout(250);
    await tab.screenshot({ path: path.join(here, "..", `${name}.png`) });
    await ctx.close();
    console.log(`${name}.png ${width}x${height} @2x`);
  }
} finally {
  await browser.close();
}
