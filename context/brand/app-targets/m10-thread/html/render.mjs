// Renders the milestone 10 thread targets: each page at its CSS size, at 2x, to ../<name>.png.
// `to-webp.py` then writes the 1x .webp beside it. Playwright comes from a checkout's
// node_modules: `node render.mjs <path to playwright's index.mjs> [name ...]`.
// The pages load milestone 8's tokens, shell and demo app and milestone 9's parts.
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const [playwrightPath, ...only] = process.argv.slice(2);
const { chromium } = await import(pathToFileURL(playwrightPath).href);

// name: [page, query, width, height]
const targets = {
  // S1: a code task mid-turn (s1.md)
  "s1": ["thread.html", "scene=s1", 1440, 956],
  "s1-working": ["thread.html", "scene=s1-working", 1440, 956],
  // S2: three turns later, with a PR (s2.md)
  "s2": ["thread.html", "scene=s2", 1440, 956],
  // S3: a review task (s3.md)
  "s3": ["thread.html", "scene=s3", 1440, 956],
  // S4: a run opened, the question off screen (s4.md)
  "s4": ["thread.html", "scene=s4", 1440, 956],
  // S5: plan first (s5.md)
  "s5-plan": ["thread.html", "scene=s5", 1440, 956],
  "s5-approved": ["thread.html", "scene=s5-approved", 1440, 956],
  // S6: S1 on a phone (s6.md)
  "s6-phone": ["phone.html", "scene=s1", 390, 844],
  "s6-phone-open": ["phone.html", "scene=s1-open", 390, 844],
  // S7: the light theme (s7.md)
  "s7-s1-light": ["thread.html", "scene=s1&theme=light", 1440, 956],
  "s7-s3-light": ["thread.html", "scene=s3&theme=light", 1440, 956],
  // The states the approved targets list (states-steps.md, states-asks.md, states-messages.md)
  "states-steps": ["states.html", "sheet=steps", 1440, 956],
  "states-asks": ["states.html", "sheet=asks", 1440, 956],
  "states-messages": ["states.html", "sheet=messages", 1440, 956],
};

const browser = await chromium.launch();
try {
  for (const [name, [page, query, width, height]] of Object.entries(targets)) {
    if (only.length > 0 && !only.includes(name)) continue;
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
    const tab = await ctx.newPage();
    tab.on("pageerror", (e) => console.error(`${name}: ${e.message}`));
    await tab.goto(`${pathToFileURL(path.join(here, page)).href}?${query}`);
    await tab.waitForSelector("body[data-settled='1']");
    await tab.evaluate(() => document.fonts.ready);
    await tab.waitForTimeout(150);
    await tab.screenshot({ path: path.join(here, "..", `${name}.png`) });
    await ctx.close();
    console.log(`${name}.png ${width}x${height} @2x`);
  }
} finally {
  await browser.close();
}
