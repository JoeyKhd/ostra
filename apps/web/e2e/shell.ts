import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

// The double sidebar (F-147, milestone 8's ticket 10) as the specs reach it: the rail of spaces, the
// open space's context panel, and below 768px the top bar's menu sheet that holds them both.

/** The rail: the `Spaces` landmark. Below 768px it's inside the menu sheet. */
export const rail = (page: Page): Locator => page.getByRole("navigation", { name: "Spaces" }).filter({ visible: true });

/** The context panel docked beside the rail (1280px and up, or opened from 1024). */
export const contextPanel = (page: Page): Locator => page.locator("[data-shell-panel='docked']");

/** The phone's menu sheet: the rail and the open space's panel. */
export const navSheet = (page: Page): Locator => page.getByRole("dialog", { name: "Navigation" });

/** The top bar's menu button, below 768px: its name gains the needs-you count when there is one. */
export const menuButton = (page: Page): Locator => page.getByRole("button", { name: /^Open navigation/ }).filter({ visible: true });

export const isPhoneWidth = (page: Page): boolean => (page.viewportSize()?.width ?? 0) < 768;

export const openNavSheet = async (page: Page): Promise<void> => {
  await menuButton(page).click();
  await expect(navSheet(page)).toBeVisible();
};

export type RailSpace = "Home" | "Needs you" | "Projects" | "Organization" | "Settings";

/** A space of the rail, by its accessible name (`Needs you` carries its count after a comma). */
export const railSpace = (page: Page, space: RailSpace): Locator => rail(page).getByRole("link", { name: new RegExp(`^${space}(,|$)`) });

/** Opens a space from the rail, as a click does: its last page this session, or its home. */
export const openSpace = async (page: Page, space: RailSpace): Promise<void> => {
  await railSpace(page, space).click();
  await expect(railSpace(page, space)).toHaveAttribute("aria-current", "page");
};

/** Opens the palette from the rail's Search: in the menu sheet on a phone. */
export const openSearchFromShell = async (page: Page): Promise<void> => {
  if (isPhoneWidth(page)) await openNavSheet(page);
  await rail(page).getByRole("button", { name: "Search" }).click();
};

/** The member's menu, at the rail's foot: on a phone, inside the menu sheet (opened unless it is). */
export const openUserMenu = async (page: Page): Promise<void> => {
  const menu = page.getByTestId("user-menu").filter({ visible: true });
  if (isPhoneWidth(page) && (await menu.count()) === 0) await openNavSheet(page);
  await menu.first().click();
};

/** Opens a project by its name through the Projects space and the panel's project switcher. */
export const openProjectFromShell = async (page: Page, name: string): Promise<void> => {
  // Until the member's projects have loaded, the space can only offer New project.
  await expect(railSpace(page, "Projects")).toHaveAttribute("href", /^\/projects\/(?!new$)/);
  await railSpace(page, "Projects").click();
  await page.waitForURL(/\/projects\/(?!new$)/);
  const switcher = contextPanel(page).getByRole("button", { name: /^Switch project, / });
  if ((await switcher.getAttribute("aria-label")) !== `Switch project, ${name}`) {
    await switcher.click();
    await page.getByRole("menuitem").filter({ has: page.getByText(name, { exact: true }) }).first().click();
  }
  await expect(switcher).toHaveAttribute("aria-label", `Switch project, ${name}`);
};

/**
 * Puts the focus on one item of the rail with the keyboard alone: Tab to the rail's one stop, then
 * Home and the down arrow to the item.
 */
export const focusRailItem = async (page: Page, target: Locator): Promise<void> => {
  for (let presses = 0; presses < 40; presses += 1) {
    if (await page.evaluate(() => (document.activeElement?.closest("[data-shell-rail]") ?? null) !== null)) break;
    await page.keyboard.press("Tab");
  }
  await page.keyboard.press("Home");
  for (let presses = 0; presses < 12; presses += 1) {
    if (await target.evaluate((node) => node === document.activeElement).catch(() => false)) return;
    await page.keyboard.press("ArrowDown");
  }
  throw new Error("the rail's arrows never reached the target");
};
