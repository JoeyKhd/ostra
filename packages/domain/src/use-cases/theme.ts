import type { Tx } from "@ostra/db";
import type { UserId } from "@ostra/protocol";
import { z } from "zod";

import type { MemberScope } from "../access.ts";
import type { Ports } from "../ports.ts";
import type { UseCaseResult } from "./common.ts";

// A member's theme (F-082; milestone 7, ticket 36; spec sections 4 and 12, item 13): dark (the
// default), light, or the system's choice. Saved on the account and in a cookie; the root layout
// reads the cookie on the server and sets `data-theme` before first paint, and `system` sets none
// so the CSS media query decides. The account's column is ticket 04's migration; the procedure,
// `account.setTheme`, is ticket 11's.

/** The three themes, as the database's `ThemePreference` enum spells them. */
export const themePreferences = ["dark", "light", "system"] as const;
export type ThemePreference = (typeof themePreferences)[number];

/** A new account's theme, and what an unreadable cookie falls back to. */
export const DEFAULT_THEME: ThemePreference = "dark";

/** The cookie the panel reads before first paint. Not a secret: it holds one of the three words. */
export const THEME_COOKIE = "ostra-theme";

/** A theme from outside (a form, a cookie, the API): one of the three, nothing else. */
export const themePreferenceSchema = z.enum(themePreferences);

export const setThemeInputSchema = z.strictObject({ theme: themePreferenceSchema });
export type SetThemeInput = z.infer<typeof setThemeInputSchema>;

/** The theme a cookie's value names, or the default for a missing or unknown one. */
export const themeFromCookie = (value: string | undefined): ThemePreference => {
  const parsed = themePreferenceSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_THEME;
};

/** The `data-theme` the root layout sets: none for `system`, so `prefers-color-scheme` decides. */
export const dataThemeFor = (theme: ThemePreference): "dark" | "light" | null => {
  switch (theme) {
    case "dark":
    case "light":
      return theme;
    case "system":
      return null;
    default:
      return theme satisfies never;
  }
};

export type SetThemeResult = UseCaseResult<{ readonly theme: ThemePreference; readonly changed: boolean }, "invalid-input">;

/**
 * Saves the asking member's own theme on their account, with `account.theme_changed` in the audit
 * log when it changed. There is no way to name another account: the user is the session's.
 */
export type SetTheme = (
  deps: Pick<Ports, "audit"> & { readonly tx: Tx; readonly scope: MemberScope; readonly userId: UserId },
  input: unknown,
) => Promise<SetThemeResult>;

/** Refuses anything but the three themes, before any write. */
export const parseSetThemeInput = (
  input: unknown,
): { readonly ok: true; readonly value: SetThemeInput } | { readonly ok: false; readonly error: "invalid-input"; readonly message: string } => {
  const parsed = setThemeInputSchema.safeParse(input);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: "invalid-input", message: "The theme is dark, light or system." };
};
