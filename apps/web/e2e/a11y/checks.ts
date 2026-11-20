import type { Page } from "@playwright/test";

import { installA11y } from "./page-lib.ts";
import type { ContrastFinding, FocusedElement } from "./page-lib.ts";

// F-081 (ticket 17): the keyboard walk and the contrast check, run from the test on a page that
// `prepareA11y` set up. Each returns the problems it found, in words that name the place, the
// element's role and text, and the ratio.

/** The overlays a walk opens: dialogs (and popovers, sheets) are walked by Tab, menus and lists by the arrows. */
export const overlaySelector =
  '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]';

/** The checks' page code, and no transitions or animations: the checks read the end state, not a frame of a fade. */
export const prepareA11y = async (page: Page): Promise<void> => {
  await page.addInitScript(installA11y);
  await page.addInitScript(() => {
    const style = (): void => {
      const sheet = document.createElement("style");
      sheet.textContent = "*, *::before, *::after { transition: none !important; animation: none !important; caret-color: auto !important; }";
      document.head.append(sheet);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", style);
    else style();
  });
};

const round = (value: number): string => (Math.floor(value * 100) / 100).toFixed(2);

const describeFocus = (focused: FocusedElement): string => `${focused.role} "${focused.name}"`;

/** The focus indicator a focused element must show: an outline or a ring of at least 2px, at 3:1 against what's behind it. */
const indicatorProblem = (focused: FocusedElement): string | null => {
  const { indicator } = focused;
  if (indicator.kind === "none") return `${describeFocus(focused)} shows no focus outline or ring`;
  if (indicator.width < 2) return `${describeFocus(focused)}'s focus ${indicator.kind} is ${String(indicator.width)}px, under 2px`;
  if (indicator.ratio < 3) return `${describeFocus(focused)}'s focus ${indicator.kind} is ${round(indicator.ratio)}:1, under 3:1`;
  return null;
};

const focusedNow = (page: Page, scope: string | null): Promise<FocusedElement | null> =>
  page.evaluate((s) => {
    const api = globalThis.__ostraA11y;
    if (api === undefined) throw new Error("the a11y checks aren't installed");
    return api.focused(s);
  }, scope);

/**
 * The keyboard walk over a page, or over an open dialog (`scope`): Tab from the top reaches every
 * visible tabbable element once, in document order, each with a visible focus indicator, and comes
 * back round to the first (no trap). In a dialog the focus must also never leave it.
 */
export const walkByTab = async (page: Page, scope: string | null): Promise<string[]> => {
  const problems: string[] = [];
  const count = await page.evaluate((s) => globalThis.__ostraA11y?.mark(s) ?? 0, scope);
  const names = await page.evaluate(() => globalThis.__ostraA11y?.marked() ?? []);
  const reached: number[] = [];
  const twice = new Set<number>();
  let wrapped = false;
  let pageStops = 0;
  const start = await focusedNow(page, scope);
  if (start !== null && start.index >= 0) {
    reached.push(start.index);
    const problem = indicatorProblem(start);
    if (problem !== null && scope === null) problems.push(problem);
  }
  let last = start?.index ?? -1;
  // A date field takes a Tab for each of its parts: four presses an element at most, then round.
  for (let presses = 0; presses < count * 4 + 12 && !wrapped; presses += 1) {
    await page.keyboard.press("Tab");
    const focused = await focusedNow(page, scope);
    if (focused === null) {
      // Past the last element the focus leaves the page, and the next Tab starts again at the top.
      if (scope !== null) {
        problems.push("the focus left the dialog for the page");
        break;
      }
      pageStops += 1;
      if (pageStops > 1) break;
      continue;
    }
    if (!focused.inside) {
      problems.push(`the focus left the dialog for ${describeFocus(focused)}`);
      break;
    }
    // The next part of the same field (a date's month, day, year and the browser's own calendar
    // button, which draws its own ring), or a dialog's one control again.
    if (focused.index >= 0 && focused.index === last) {
      if (reached.length === count && focused.index === reached[0]) wrapped = true;
      continue;
    }
    const problem = indicatorProblem(focused);
    if (problem !== null) problems.push(problem);
    if (focused.index < 0) {
      if (!focused.scroller) problems.push(`${describeFocus(focused)} takes the focus but isn't a visible control`);
      continue;
    }
    last = focused.index;
    if (focused.index === reached[0]) {
      wrapped = true;
    } else if (reached.includes(focused.index)) {
      twice.add(focused.index);
      // Round again without passing the first: the focus is caught in a loop.
      if (twice.size > 3) break;
    } else {
      reached.push(focused.index);
    }
  }
  if (count > 0 && !wrapped && pageStops === 0) {
    problems.push(`the focus is trapped: Tab never came back round (last: ${names[reached.at(-1) ?? 0] ?? "nothing"})`);
  }
  for (const index of twice) problems.push(`${names[index] ?? String(index)} is reached twice in one round`);
  const missed = names.filter((_, index) => !reached.includes(index));
  if (missed.length > 0 && count > 0) problems.push(`Tab never reaches ${missed.slice(0, 8).join(", ")}${missed.length > 8 ? ` and ${String(missed.length - 8)} more` : ""}`);
  // Document order, starting wherever the page put the focus first.
  const lowest = reached.indexOf(Math.min(...reached));
  const order = [...reached.slice(lowest), ...reached.slice(0, lowest)];
  for (let i = 1; i < order.length; i += 1) {
    const before = order[i - 1] ?? 0;
    const after = order[i] ?? 0;
    if (after < before) {
      problems.push(`the Tab order jumps back from ${names[before] ?? ""} to ${names[after] ?? ""}`);
      break;
    }
  }
  return problems;
};

/**
 * A menu or a list walked by its arrows: Home, then the down arrow to the end, each item reached
 * once with a visible focus indicator.
 */
export const walkByArrows = async (page: Page, scope: string): Promise<string[]> => {
  const problems: string[] = [];
  // A select moves the focus in once it has placed itself.
  await page.waitForFunction((s) => document.querySelector(s)?.contains(document.activeElement) === true, scope, { timeout: 2_000 }).catch(() => undefined);
  await page.keyboard.press("Home");
  const seen = new Set<string>();
  for (let presses = 0; presses < 60; presses += 1) {
    const focused = await page.evaluate((s) => {
      const active = document.activeElement;
      const root = document.querySelector(s);
      if (!(active instanceof HTMLElement) || !(root?.contains(active) ?? false)) return null;
      if (root === null) return null;
      // The list itself holds the focus until an arrow moves it to an item.
      if (active === root) return { id: "", focused: null };
      if (!active.hasAttribute("data-a11y-item")) active.setAttribute("data-a11y-item", String(root.querySelectorAll("[data-a11y-item]").length));
      return { id: active.getAttribute("data-a11y-item") ?? "", focused: globalThis.__ostraA11y?.focused(s) ?? null };
    }, scope);
    if (focused?.id === "") {
      // An empty list (a select with nothing to pick yet) has no item to walk.
      if (presses > 0) break;
      await page.keyboard.press("ArrowDown");
      continue;
    }
    const item = focused?.focused ?? null;
    if (focused === null || item === null) {
      problems.push("the arrows move the focus out of the menu");
      break;
    }
    if (seen.has(focused.id)) break;
    seen.add(focused.id);
    const problem = indicatorProblem(item);
    if (problem !== null) problems.push(problem);
    await page.keyboard.press("ArrowDown");
    // A select moves the focus a tick after the key (it scrolls first): wait for it, or for the end.
    await page.waitForFunction((id) => document.activeElement?.getAttribute("data-a11y-item") !== id, focused.id, { timeout: 500 }).catch(() => undefined);
  }
  const items = await page.evaluate(
    (s) =>
      [...(document.querySelector(s)?.querySelectorAll<HTMLElement>('[role^="menuitem"], [role="option"]') ?? [])].filter(
        (item) => item.getAttribute("aria-disabled") !== "true" && !item.hasAttribute("data-disabled") && item.getClientRects().length > 0,
      ).length,
    scope,
  );
  if (seen.size < items) problems.push(`the arrows reach ${String(seen.size)} of the ${String(items)} items`);
  return problems;
};

/**
 * The contrast check over the page or one overlay: the failures, and apart the lines it lists but
 * doesn't fail: disabled controls, and text drawn over a picture (no colour to compute there).
 */
export const checkContrast = async (page: Page, scope: string | null): Promise<{ failures: string[]; disabled: string[] }> => {
  const findings: readonly ContrastFinding[] = await page.evaluate((s) => globalThis.__ostraA11y?.contrast(s) ?? [], scope);
  const words = (finding: ContrastFinding): string =>
    `${finding.kind === "boundary" ? "the edge of " : finding.kind === "placeholder" ? "the placeholder of " : ""}${finding.role} "${finding.text}" is ${round(finding.ratio)}:1, under ${String(finding.required)}:1 (${finding.fg} on ${finding.bg})`;
  return {
    failures: findings.filter((finding) => !finding.disabled && !finding.overImage).map(words),
    disabled: findings
      .filter((finding) => finding.disabled || finding.overImage)
      .map((finding) => `${finding.role} "${finding.text}" (${finding.disabled ? "disabled" : "over a picture"}) ${round(finding.ratio)}:1`),
  };
};

/** The page's theme as drawn: its `color-scheme`. */
export const drawnScheme = (page: Page): Promise<string> => page.evaluate(() => globalThis.__ostraA11y?.scheme() ?? "");

/**
 * The overlays a route opens from a trigger that says it opens one (`aria-haspopup`, or a select's
 * combobox), one of each name: tagged so the test can press each in turn.
 */
export const overlayTriggers = (page: Page): Promise<readonly { readonly id: string; readonly name: string }[]> =>
  page.evaluate(() => {
    const triggers: { id: string; name: string }[] = [];
    const names = new Set<string>();
    let next = 0;
    for (const element of document.querySelectorAll<HTMLElement>('[aria-haspopup]:not([aria-haspopup="false"]), button[role="combobox"]')) {
      if (element.closest("[data-a11y-overlay]") !== null || element.closest("[inert]") !== null) continue;
      if (element instanceof HTMLButtonElement && element.disabled) continue;
      if (element.getClientRects().length === 0 || !element.checkVisibility({ visibilityProperty: true })) continue;
      const name = `${element.getAttribute("role") ?? element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") ?? element.textContent).replace(/\s+/g, " ").trim().slice(0, 40)}"`;
      if (names.has(name)) continue;
      names.add(name);
      const id = String(next);
      next += 1;
      element.setAttribute("data-a11y-trigger", id);
      triggers.push({ id, name });
    }
    return triggers;
  });

/** Tags the open overlay so the checks can scope to it; returns its kind, or null when none opened. */
export const tagOpenOverlay = (page: Page): Promise<"dialog" | "menu" | null> =>
  page.evaluate((selector) => {
    for (const old of document.querySelectorAll("[data-a11y-overlay]")) old.removeAttribute("data-a11y-overlay");
    const open = [...document.querySelectorAll<HTMLElement>(selector)].filter((element) => element.getClientRects().length > 0).at(-1);
    if (open === undefined) return null;
    open.setAttribute("data-a11y-overlay", "");
    const role = open.getAttribute("role");
    return role === "menu" || role === "listbox" ? "menu" : "dialog";
  }, overlaySelector);

/** True once no overlay is open. */
export const overlayClosed = (page: Page): Promise<boolean> =>
  page.evaluate((selector) => [...document.querySelectorAll(selector)].every((element) => element.getClientRects().length === 0), overlaySelector);
