import { readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { z } from "zod";

import { pseudoText } from "@/lib/pseudo-locale";
import { memberRoutes, seedRoutesWorld, settleRoute, visitorRoutes } from "./routes.ts";
import type { PanelRoute, RoutesWorld } from "./routes.ts";
import { e2eAdmin } from "./settings.ts";

// F-083 (ticket 20): the pseudo-locale pass, on the pseudo-locale build (playwright.pseudo.config.ts).
// Every message reads `⟦…⟧` there, so any visible text left outside the brackets is a word that
// bypassed `t`. The exceptions are the seed's user data (titles, names, a note's text, which
// `seed-routes-world.ts` marks as such) and the names `messages/allowed-literals.json` lets
// through. Every route of the panel, signed in and signed out, and the refusals it words from a
// code: a role refusal and a budget stop.

let world: RoutesWorld;
let allowed: readonly string[];
let messages: unknown;

/** A message as the pseudo-locale build shows it: the spec reads en.json itself (no JSON import here). */
const pseudo = (key: string): string => {
  const text: unknown = key.split(".").reduce<unknown>((node, segment) => (typeof node === "object" && node !== null ? Reflect.get(node, segment) : undefined), messages);
  if (typeof text !== "string") throw new Error(`no message ${key}`);
  return pseudoText(text);
};

const stackSchema = z.object({ databaseUrl: z.string() });

test.beforeAll(async () => {
  messages = JSON.parse(await readFile(path.join(import.meta.dirname, "..", "messages", "en.json"), "utf8"));
  const stack = stackSchema.parse(JSON.parse(await readFile(path.join(import.meta.dirname, ".stack-pseudo.json"), "utf8")));
  world = await seedRoutesWorld(stack.databaseUrl, `pseudo-${Date.now().toString(36)}`);
  const file = z.object({ allowed: z.array(z.object({ text: z.string() })) }).parse(JSON.parse(await readFile(path.join(import.meta.dirname, "..", "messages", "allowed-literals.json"), "utf8")));
  allowed = file.allowed.map((entry) => entry.text);
});

/** Signs in through better-auth's own route: the form's labels are pseudo here. */
const signIn = async (page: Page, username: string): Promise<void> => {
  const base = test.info().project.use.baseURL ?? "";
  const response = await page.request.post("/api/auth/sign-in/username", { data: { username, password: e2eAdmin.password }, headers: { origin: base } });
  expect(response.ok()).toBe(true);
};

/**
 * What a translator never words: machine values the panel sets in mono or as code (an ID, a
 * setting's name, a command, a size, a runner's labels, which the brief's type rules put in mono),
 * and an element marked `translate="no"` (a member's initials, an editor holding a project's own
 * text). The pass reads every other text node.
 */
const NOT_WORDS = 'code, kbd, pre, samp, .font-mono, [translate="no"]';

/**
 * The page's visible text that isn't the panel's pseudo words, the seed's user data, an allowed
 * name or the locale's own month and weekday names (Intl writes those, from the locale, not the
 * message file): what's left after the `⟦…⟧` spans (nested ones too) are cut out, one line per
 * piece. A line with no two letters in a row (a lone initial, `0.0s`) is no word.
 */
const unwrapped = (page: Page): Promise<string[]> =>
  page.evaluate(
    ({ userData, allowed, notWords }) => {
      const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const cut = (text: string, words: readonly string[]) =>
        [...words].sort((a, b) => b.length - a.length).reduce((rest, word) => rest.replace(new RegExp(`(?<![\\p{L}\\d])${escape(word)}(?![\\p{L}])`, "gu"), " "), text);
      const calendar: string[] = [];
      for (let month = 0; month < 12; month += 1) {
        for (const style of ["long", "short"] as const) calendar.push(new Intl.DateTimeFormat("en-GB", { month: style, timeZone: "UTC" }).format(Date.UTC(2026, month, 15)));
      }
      for (let day = 0; day < 7; day += 1) {
        for (const style of ["long", "short"] as const) calendar.push(new Intl.DateTimeFormat("en-GB", { weekday: style, timeZone: "UTC" }).format(Date.UTC(2026, 10, 15 + day)));
      }
      let outside = "";
      let depth = 0;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const parent = node.parentElement;
        const shown = parent !== null && parent.closest("script, style, template, noscript") === null && parent.checkVisibility() && parent.closest(notWords) === null;
        for (const char of node.textContent ?? "") {
          if (char === "⟦") depth += 1;
          else if (char === "⟧") depth = Math.max(0, depth - 1);
          else if (depth === 0 && shown) outside += char;
        }
        outside += "\n";
      }
      return cut(cut(cut(outside, userData), allowed), calendar)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /\p{L}{2}/u.test(line));
    },
    { userData: world.userData, allowed, notWords: NOT_WORDS },
  );

type Leftover = { readonly route: string; readonly text: readonly string[] };

const pass = async (page: Page, routes: readonly PanelRoute[]): Promise<Leftover[]> => {
  const leftovers: Leftover[] = [];
  for (const route of routes) {
    await page.goto(route.path);
    await settleRoute(page);
    const text = await unwrapped(page);
    if (text.length > 0) leftovers.push({ route: route.pattern, text });
  }
  return leftovers;
};

test("F-083/c1: the pseudo-locale pass finds no unwrapped text on any route", async ({ page }) => {
  await signIn(page, world.username);
  const member = await pass(page, [...memberRoutes(world), { pattern: "/tasks/[task-id] (an approval)", path: `/tasks/${world.approval.taskId}` }, { pattern: "/tasks/[task-id] (a question)", path: `/tasks/${world.question.taskId}` }]);
  await page.context().clearCookies();
  const visitor = await pass(page, visitorRoutes(world));
  expect([...member, ...visitor]).toEqual([]);
});

test("F-083/c1: a refusal the panel shows reaches it as a code, worded through t: a role refusal and a budget stop", async ({ page }) => {
  // A budget stop: the task stopped at its spend cap (`stopReason: spend_cap`, a code), and the
  // page words it in its limit block.
  await signIn(page, world.username);
  await page.goto(`/tasks/${world.capped.taskId}`);
  const limit = page.getByTestId("limit-block");
  await expect(limit).toHaveAttribute("data-limit", "spend-cap");
  await expect(limit).toContainText(pseudo("taskPage.limit.title").replace("{what}", pseudo("taskPage.limit.spend-cap")));
  expect(await unwrapped(page)).toEqual([]);

  // A role refusal: a member who isn't an admin opens an admin's page.
  await page.context().clearCookies();
  await signIn(page, world.memberUsername);
  await page.goto("/organization/models");
  await expect(page.getByText(pseudo("common.adminsOnly"))).toBeVisible();
  expect(await unwrapped(page)).toEqual([]);
});
