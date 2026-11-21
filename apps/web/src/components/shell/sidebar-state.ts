import { z } from "zod";

// The context panel's state (F-147; app-shell.md, "Collapsing, the peek and narrow widths"): the
// member's choice, kept in a cookie the panel's layout reads on the server so a reload draws it at
// once (no flash), the width bands, and the panel's width. Pure, so each rule is tested alone.

/** The cookie: `open` or `closed`, a colon, then the width in px (`open:240`). It holds no secret. */
export const SIDEBAR_COOKIE = "ostra-sidebar";

export const PANEL_WIDTH = { min: 200, max: 320, initial: 240 } as const;

export type SidebarChoice = { readonly collapsed: boolean; readonly width: number };

export const defaultSidebar: SidebarChoice = { collapsed: false, width: PANEL_WIDTH.initial };

/** A width dragged to anywhere, kept from 200 to 320 px and whole. */
export const clampWidth = (width: number): number => (Number.isFinite(width) ? Math.round(Math.min(PANEL_WIDTH.max, Math.max(PANEL_WIDTH.min, width))) : PANEL_WIDTH.initial);

/** The cookie's value, read from outside: anything malformed is the default, never an error. */
const cookieSchema = z.string().regex(/^(open|closed):\d{1,4}$/);

export const readSidebarCookie = (raw: string | undefined): SidebarChoice => {
  const parsed = cookieSchema.safeParse(raw);
  if (!parsed.success) return defaultSidebar;
  const [state, width] = parsed.data.split(":");
  return { collapsed: state === "closed", width: clampWidth(Number(width)) };
};

export const sidebarCookieValue = (choice: SidebarChoice): string => `${choice.collapsed ? "closed" : "open"}:${String(clampWidth(choice.width))}`;

/** The `document.cookie` line that keeps the choice for a year, for every page of the panel. */
export const sidebarCookieLine = (choice: SidebarChoice, secure: boolean): string =>
  `${SIDEBAR_COOKIE}=${sidebarCookieValue(choice)}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`;

/**
 * The width bands:
 * - `wide` (1280 and up): the rail and the docked panel, as the member left it;
 * - `narrow` (1024 to 1279): the panel starts collapsed, the peek works, and docking pushes the page;
 * - `rail` (768 to 1023): the rail alone; docking the panel lays it over the page with a scrim;
 * - `phone` (under 768): no rail; the top bar's menu opens the rail and the panel as one sheet.
 */
export const bands = ["phone", "rail", "narrow", "wide"] as const;
export type Band = (typeof bands)[number];

export const bandOf = (width: number): Band => (width >= 1280 ? "wide" : width >= 1024 ? "narrow" : width >= 768 ? "rail" : "phone");

/**
 * Whether the panel shows docked beside the rail. Wide follows the saved choice. Narrow and rail
 * follow what the member did since the window last crossed into the band (`opened`), and start
 * collapsed: the automatic collapse is never saved over the member's choice.
 */
export const panelShown = (band: Band, choice: SidebarChoice, opened: boolean): boolean => {
  switch (band) {
    case "wide":
      return !choice.collapsed;
    case "narrow":
    case "rail":
      return opened;
    case "phone":
      return false;
    default:
      return band satisfies never;
  }
};

/** What `[` (or the head's button) does in a band: wide saves the choice; the narrower bands only open or close for now. */
export const toggled = (band: Band, choice: SidebarChoice, opened: boolean): { readonly choice: SidebarChoice; readonly opened: boolean; readonly save: boolean } => {
  switch (band) {
    case "wide":
      return { choice: { ...choice, collapsed: !choice.collapsed }, opened, save: true };
    case "narrow":
    case "rail":
      return { choice, opened: !opened, save: false };
    case "phone":
      return { choice, opened, save: false };
    default:
      return band satisfies never;
  }
};
