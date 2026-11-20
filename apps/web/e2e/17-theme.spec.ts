import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { inflate } from "node:zlib";

import { expect, test } from "@playwright/test";
import type { Browser, Page, TestInfo } from "@playwright/test";

import { seedTask, signIn } from "./helpers.ts";
import { seedM4Member } from "./m4.ts";

// F-082 (milestone 7, ticket 18): the light theme and each member's choice of dark, light or
// "match my system", saved on their account and painted before the first frame. Each test seeds
// members of its own, named per project, so the phone run starts from dark too.

const shots = process.env["OSTRA_E2E_SHOTS"];

const dark = { bg: "rgb(13, 14, 16)", hex: "#0d0e10" } as const;
const light = { bg: "rgb(250, 250, 251)", hex: "#fafafb" } as const;
/** Light's two page greys (`--bg`, `--side`), as a screenshot's pixel reads them. */
const lightPixels = new Set(["fafafb", "f3f3f5"]);

const member = async (who: string, info: TestInfo): Promise<string> => {
  const username = `e2e-theme-${who}-${info.project.name === "phone" ? "p" : "d"}`;
  await seedM4Member(username);
  return username;
};

/** A page in a browser of its own (the project's options, no cookies). */
const contextFor = async (browser: Browser): Promise<Page> => (await browser.newContext()).newPage();

/** The member menu, at the sidebar's foot: on a phone, inside the navigation drawer (opened unless it is). */
const openUserMenu = async (page: Page): Promise<void> => {
  const menu = page.getByTestId("user-menu").filter({ visible: true });
  if ((page.viewportSize()?.width ?? 0) < 1024 && (await menu.count()) === 0) {
    await page.getByRole("button", { name: "Open navigation" }).click();
  }
  await menu.first().click();
};

const signOut = async (page: Page): Promise<void> => {
  await openUserMenu(page);
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.waitForURL((url) => url.pathname === "/sign-in");
};

const themeOf = (page: Page) => page.evaluate(() => document.documentElement.getAttribute("data-theme"));
const backgroundOf = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

/** Records, at the page's first animation frame (before its first paint), the theme and the page's colour. */
const probeFirstFrame = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    requestAnimationFrame(() => {
      const root = document.documentElement;
      Reflect.set(window, "__firstFrame", { theme: root.getAttribute("data-theme"), background: getComputedStyle(document.body).backgroundColor });
    });
  });
};

const firstFrame = async (page: Page): Promise<{ theme: string | null; background: string }> => {
  await page.waitForFunction(() => Reflect.has(window, "__firstFrame"));
  return page.evaluate(() => {
    const frame: unknown = Reflect.get(window, "__firstFrame");
    const theme: unknown = typeof frame === "object" && frame !== null ? Reflect.get(frame, "theme") : null;
    const background: unknown = typeof frame === "object" && frame !== null ? Reflect.get(frame, "background") : "";
    return { theme: typeof theme === "string" ? theme : null, background: typeof background === "string" ? background : "" };
  });
};

/** The first screenshot that can be taken: right after a navigation commits, the page may have no frame yet. */
const firstScreenshot = async (page: Page, clip: { x: number; y: number; width: number; height: number }): Promise<Buffer> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await page.screenshot({ clip });
    } catch (error) {
      if (attempt >= 20 || !String(error).includes("Unable to capture screenshot")) throw error;
    }
  }
};

/** One pixel of the first screenshot, as `rrggbb`: a 1×1 PNG's only scanline, after its filter byte. */
const pixelAt = async (page: Page, x: number, y: number): Promise<string> => {
  const png = await firstScreenshot(page, { x, y, width: 1, height: 1 });
  const chunks: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    if (type === "IDAT") chunks.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  return (await promisify(inflate)(Buffer.concat(chunks))).subarray(1, 4).toString("hex");
};

/** The response that saves `theme` (not the cookie's sync a fresh sign-in sends for the account's own). */
const saveTheme = (page: Page, theme: "dark" | "light" | "system") =>
  page.waitForResponse((response) => response.url().includes("account.setTheme") && (response.request().postData() ?? "").includes(`"theme":"${theme}"`));

const choices = { Dark: "dark", Light: "light", "Match my system": "system" } as const;

const choose = async (page: Page, label: keyof typeof choices): Promise<void> => {
  const saved = saveTheme(page, choices[label]);
  const radio = page.getByTestId("theme-choice").getByRole("radio", { name: label });
  // A click before hydration does nothing: click until the radio holds it.
  await expect(async () => {
    await radio.click();
    await expect(radio).toBeChecked({ timeout: 1000 });
  }).toPass();
  expect((await saved).ok()).toBe(true);
};

const shoot = async (page: Page, name: string): Promise<void> => {
  if (shots === undefined) return;
  await mkdir(shots, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: path.join(shots, `m7-${name}-final.png`) });
};

test("F-082/c1: a new member sees dark, before and after signing in", async ({ page }, info) => {
  const username = await member("new", info);
  await page.goto("/sign-in");
  expect(await themeOf(page)).toBe("dark");
  expect(await backgroundOf(page)).toBe(dark.bg);
  await signIn(page, username);
  expect(await themeOf(page)).toBe("dark");
  await page.goto("/account");
  await expect(page.getByTestId("theme-choice").getByRole("radio", { name: "Dark" })).toBeChecked();
  expect(await backgroundOf(page)).toBe(dark.bg);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#0D0E10");
  // Appearance's keyboard line opens the shortcut sheet (on a phone, the line is hidden).
  if (info.project.name !== "phone") {
    await page.getByRole("button", { name: "Keyboard shortcuts" }).click();
    await expect(page.getByTestId("shortcut-sheet")).toBeVisible();
  }
});

test("F-082/c2: Light survives a reload with no dark frame: the first screenshot after navigation is light", async ({ page, browser }, info) => {
  const username = await member("light", info);
  await signIn(page, username);
  await page.goto("/account");
  await choose(page, "Light");
  // Applied at once, before any reload.
  expect(await themeOf(page)).toBe("light");
  expect(await backgroundOf(page)).toBe(light.bg);
  await expect(page.getByTestId("panel-theme")).toHaveText("Light");

  // A new tab in the same browser: the server paints light, so the first frame is light.
  const tab = await page.context().newPage();
  await probeFirstFrame(tab);
  await tab.goto("/", { waitUntil: "commit" });
  expect(lightPixels).toContain(await pixelAt(tab, (info.project.use.viewport?.width ?? 1440) - 2, 4));
  expect(await firstFrame(tab)).toEqual({ theme: "light", background: light.bg });
  await expect(tab.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#FAFAFB");
  await tab.reload();
  expect(await themeOf(tab)).toBe("light");

  // Another browser, signing in for the first time: the account's choice follows, and the cookie is set.
  const other = await contextFor(browser);
  await signIn(other, username);
  await expect.poll(() => themeOf(other)).toBe("light");
  await expect.poll(async () => (await other.context().cookies()).find((cookie) => cookie.name === "ostra-theme")?.value).toBe("light");
  const fresh = await other.context().newPage();
  await probeFirstFrame(fresh);
  await fresh.goto("/account", { waitUntil: "commit" });
  expect(await firstFrame(fresh)).toEqual({ theme: "light", background: light.bg });
  // Signed out, the sign-in page keeps the browser's last theme.
  await signOut(fresh);
  await fresh.reload();
  expect(await themeOf(fresh)).toBe("light");
  await other.context().close();
});

test("F-082/c2: Match my system follows the emulated scheme both ways", async ({ page }, info) => {
  const username = await member("system", info);
  await page.emulateMedia({ colorScheme: "dark" });
  await signIn(page, username);
  await page.goto("/account");
  await choose(page, "Match my system");
  expect(await themeOf(page)).toBeNull();
  expect(await backgroundOf(page)).toBe(dark.bg);
  await expect(page.getByTestId("system-now")).toHaveText("Your system is dark now.");

  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => backgroundOf(page)).toBe(light.bg);
  await expect(page.getByTestId("system-now")).toHaveText("Your system is light now.");

  // After a reload under a light system, the first frame is light, with no data-theme to decide it.
  await probeFirstFrame(page);
  await page.reload({ waitUntil: "commit" });
  expect(await firstFrame(page)).toEqual({ theme: null, background: light.bg });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => backgroundOf(page)).toBe(dark.bg);
  await expect(page.getByTestId("system-now")).toHaveText("Your system is dark now.");
});

test("F-082/c2: the choice is per member: one member's light leaves another's dark, even in the same browser", async ({ page, browser }, info) => {
  const first = await member("one", info);
  const second = await member("two", info);
  await signIn(page, first);
  // The member menu's quick toggle.
  await openUserMenu(page);
  await page.getByTestId("theme-menu").click();
  const saved = saveTheme(page, "light");
  await page.getByRole("menuitemradio", { name: "Light" }).click();
  expect((await saved).ok()).toBe(true);
  expect(await themeOf(page)).toBe("light");

  const other = await contextFor(browser);
  await signIn(other, second);
  expect(await themeOf(other)).toBe("dark");
  await other.goto("/account");
  await expect(other.getByTestId("theme-choice").getByRole("radio", { name: "Dark" })).toBeChecked();
  await other.context().close();

  // The second member signs in where the first chose light: their own dark wins over the cookie.
  await signOut(page);
  await signIn(page, second);
  await expect.poll(() => themeOf(page)).toBe("dark");
  await page.reload();
  expect(await themeOf(page)).toBe("dark");
});

test("F-082/c2: a save that fails puts the previous theme back and says so", async ({ page }, info) => {
  const username = await member("fail", info);
  await signIn(page, username);
  await page.goto("/account");
  await page.route("**/api/trpc/account.setTheme**", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify([{ error: { message: "The database is down", code: -32603, data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 } } }]) }));
  const alert = page.getByRole("alert").filter({ hasText: "Your theme couldn't be saved" });
  await expect(async () => {
    await page.getByTestId("theme-choice").getByRole("radio", { name: "Light" }).click();
    await expect(alert).toBeVisible({ timeout: 1000 });
  }).toPass();
  await expect(alert).toContainText("Something went wrong on the server. The log has the details. It's back to dark.");
  await expect(page.getByTestId("theme-choice").getByRole("radio", { name: "Dark" })).toBeChecked();
  expect(await themeOf(page)).toBe("dark");
  await page.unroute("**/api/trpc/account.setTheme**");
  await page.reload();
  expect(await themeOf(page)).toBe("dark");
});

/** Every visible text on the page whose colour falls under AA against what's composited behind it. */
const contrastFailures = (page: Page) =>
  page.evaluate(() => {
    type Rgba = readonly [number, number, number, number];
    const parse = (value: string): Rgba | null => {
      const match = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(value);
      return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4])];
    };
    const over = (top: Rgba, under: Rgba): Rgba => [
      top[0] * top[3] + under[0] * (1 - top[3]),
      top[1] * top[3] + under[1] * (1 - top[3]),
      top[2] * top[3] + under[2] * (1 - top[3]),
      1,
    ];
    const luminance = (colour: Rgba): number => {
      const [r = 0, g = 0, b = 0] = [colour[0], colour[1], colour[2]].map((channel) => {
        const c = channel / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    /** The background behind an element: its layers composited down to the first opaque one, or `null` over an image. */
    const backgroundBehind = (start: Element): Rgba | null => {
      const layers: Rgba[] = [];
      for (let node: Element | null = start; node !== null; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.backgroundImage !== "none") return null;
        const colour = parse(style.backgroundColor);
        if (colour !== null && colour[3] > 0) {
          layers.push(colour);
          if (colour[3] >= 1) break;
        }
      }
      return layers.reduceRight<Rgba>((under, layer) => over(layer, under), [255, 255, 255, 1]);
    };
    const dimmed = (element: Element): boolean => {
      for (let node: Element | null = element; node !== null; node = node.parentElement) {
        if (Number(getComputedStyle(node).opacity) < 1 || node.matches(":disabled, [aria-disabled='true']")) return true;
      }
      return false;
    };
    const failures: string[] = [];
    for (const element of document.body.querySelectorAll("*")) {
      const ownText = [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "");
      const placeholderText = (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && element.value === "" ? element.placeholder : "";
      const placeholder = placeholderText !== "";
      if (!ownText && !placeholder) continue;
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (box.width <= 1 || box.height <= 1 || style.visibility === "hidden" || box.bottom < 0 || box.top > innerHeight || dimmed(element)) continue;
      const background = backgroundBehind(element);
      const text = parse(placeholder ? getComputedStyle(element, "::placeholder").color : style.color);
      if (background === null || text === null) continue;
      const [high, low] = [luminance(over(text, background)), luminance(background)].sort((a, b) => b - a);
      const ratio = ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
      const size = Number.parseFloat(style.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) {
        failures.push(`${element.tagName.toLowerCase()} "${(placeholder ? placeholderText : element.textContent).trim().slice(0, 40)}" ${ratio.toFixed(2)}:1`);
      }
    }
    return failures;
  });

const settle = async (page: Page): Promise<void> => {
  await expect(page.locator("main")).toBeVisible();
  await expect.poll(() => page.locator(".animate-pulse").count(), { timeout: 15_000 }).toBe(0);
  await page.mouse.move(0, 0);
  // A colour mid-transition (a button turning primary once its data loads) is neither theme's.
  await page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation instanceof CSSTransition).map((animation) => animation.finished)));
};

test("F-082/c2: Home, a task waiting on an approval and Account in light: every text passes AA", async ({ page }, info) => {
  const username = await member("contrast", info);
  const taskId = await seedTask("approval");
  await page.setViewportSize(info.project.name === "phone" ? { width: 412, height: 915 } : { width: 1440, height: 956 });
  await signIn(page, username);
  await page.goto("/account");
  await choose(page, "Light");
  const routes: readonly (readonly [string, string])[] = [
    ["light-home", "/"],
    ["light-task", `/tasks/${taskId}`],
    ["light-account", "/account"],
    ["light-needs-you", "/needs-you"],
  ];
  for (const [name, route] of routes) {
    await page.goto(route);
    await settle(page);
    if (name === "light-task") {
      await expect(page.getByText("pnpm db:migrate").first()).toBeVisible();
      await page.getByRole("button", { name: "Show the diff" }).click();
      await expect(page.locator('[data-line="add"]').first()).toBeVisible();
      await settle(page);
    }
    expect(await themeOf(page)).toBe("light");
    expect(await contrastFailures(page), `${route} in light`).toEqual([]);
    await shoot(page, `${name}${info.project.name === "phone" ? "-phone" : ""}`);
  }
});

test("F-082: Appearance, match my system on a dark system: every text passes AA", async ({ page }, info) => {
  const username = await member("shot", info);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1440, height: 956 });
  await signIn(page, username);
  await page.goto("/account");
  await choose(page, "Match my system");
  await settle(page);
  expect(await contrastFailures(page)).toEqual([]);
  await shoot(page, `account-appearance${info.project.name === "phone" ? "-phone" : ""}`);
});
