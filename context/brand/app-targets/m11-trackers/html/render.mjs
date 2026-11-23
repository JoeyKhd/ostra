// Renders milestone 11's tracker targets: each page at its CSS size, at 2x, to ../<name>.png.
// `to-webp.py` then writes the 1x .webp beside it. Playwright comes from a checkout's
// node_modules: `node render.mjs <path to playwright's index.mjs> [name ...]`.
// The pages load milestone 8's tokens and shell, and the m10 gaps' parts.
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const [playwrightPath, ...only] = process.argv.slice(2);
const { chromium } = await import(pathToFileURL(playwrightPath).href);

// name: [page, query, width, height]. Every desktop target also renders `<name>-light`.
const desktop = {
  // 1. Organization › Trackers (trackers.md)
  "trackers": ["trackers.html", ""],
  "trackers-picker": ["trackers.html", "view=picker"],
  "trackers-empty": ["trackers.html", "view=empty"],
  // 2. Connecting Jira (jira-connect.md)
  "jira-connect": ["connection.html", "kind=jira&view=token"],
  "jira-connect-webhook": ["connection.html", "kind=jira&view=webhook"],
  "jira-connect-polling": ["connection.html", "kind=jira&view=polling"],
  // 3. A connection's settings (connection-settings.md)
  "connection-jira": ["connection.html", "kind=jira&view=connected"],
  "connection-linear": ["connection.html", "kind=linear&view=connected"],
  // 4. A project's Boards with mixed trackers (boards-mixed.md)
  "boards-mixed": ["boards.html", "view=mixed"],
  "boards-attach": ["boards.html", "view=attach"],
  // 5. The setup checklist's step (setup-checklist.md)
  "setup-checklist": ["home.html", ""],
  // 6. Ticket chips (ticket-chips.md)
  "ticket-chips": ["chips.html", ""],
};
const targets = {};
for (const [name, [page, query]] of Object.entries(desktop)) {
  targets[name] = [page, query, 1440, 956];
  targets[`${name}-light`] = [page, query ? `${query}&theme=light` : "theme=light", 1440, 956];
}
Object.assign(targets, {
  "trackers-states": ["states.html", "sheet=trackers", 1440, 956],
  "jira-connect-states": ["states.html", "sheet=jira", 1440, 956],
  "boards-states": ["states.html", "sheet=boards", 1440, 956],
  "trackers-phone": ["phone.html", "scene=list", 390, 844],
  "jira-connect-phone": ["phone.html", "scene=jira", 390, 844],
  "boards-phone": ["phone.html", "scene=boards", 390, 844],
});

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
