import { THEME_COOKIE, themeFromCookie } from "@ostra/domain/theme";
import type { ThemePreference } from "@ostra/domain/theme";
import { cookies, headers } from "next/headers";
import type { Viewport } from "next/types";
import { cache } from "react";

import { getServerApi } from "./api";

// F-082 (ticket 18): the theme the root layout paints before the first frame. A signed-in member's
// own account wins, so every browser they sign in to follows their choice; the cookie covers the
// pages before sign-in, and a cookie that disagrees with the account is rewritten by the panel
// (`ThemeProvider`'s `syncCookie`), which is how a new browser gets it.

export type ResolvedTheme = {
  readonly theme: ThemePreference;
  /** Signed in, and the cookie doesn't hold the account's theme yet. */
  readonly syncCookie: boolean;
};

/** One lookup per request, shared by the root layout and its viewport. */
export const resolveTheme = cache(async (): Promise<ResolvedTheme> => {
  const raw = (await cookies()).get(THEME_COOKIE)?.value;
  const fromCookie = themeFromCookie(raw);
  const { theme } = await getServerApi();
  if (theme === null) {
    // A preview link's visitor (milestone 8, preview-viewer.md) who never chose a theme here: the
    // browser's own, as `prefers-color-scheme` says.
    const path = (await headers()).get("x-ostra-path") ?? "";
    if (raw === undefined && path.startsWith("/p/")) return { theme: "system", syncCookie: false };
    return { theme: fromCookie, syncCookie: false };
  }
  return { theme, syncCookie: raw !== theme };
});

const pageColour = { dark: "#0D0E10", light: "#FAFAFB" } as const;

/** The browser chrome's colour and `color-scheme`, to match the theme. */
export const viewportFor = (theme: ThemePreference): Viewport => {
  switch (theme) {
    case "dark":
    case "light":
      return { themeColor: pageColour[theme], colorScheme: theme };
    case "system":
      return {
        themeColor: [
          { media: "(prefers-color-scheme: dark)", color: pageColour.dark },
          { media: "(prefers-color-scheme: light)", color: pageColour.light },
        ],
        colorScheme: "light dark",
      };
    default:
      return theme satisfies never;
  }
};
