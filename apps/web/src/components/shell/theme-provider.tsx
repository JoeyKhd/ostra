"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import { dataThemeFor } from "@ostra/domain/theme";
import type { ThemePreference } from "@ostra/domain/theme";

import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

// F-082 (ticket 18): the member's theme in the browser. The root layout paints it on the server
// (`server/theme.ts`); choosing another repaints at once, then saves it through `account.setTheme`,
// which writes the account and the cookie. A failed save puts the previous theme back.

/** A failed save: the words, and the theme it went back to. */
export type ThemeFailure = { readonly message: string; readonly previous: ThemePreference };

export type ThemeState = {
  readonly theme: ThemePreference;
  readonly choose: (next: ThemePreference) => void;
  readonly failure: ThemeFailure | null;
};

const ThemeContext = createContext<ThemeState | null>(null);

const pageColour = { dark: "#0D0E10", light: "#FAFAFB" } as const;

/** Sets `<html data-theme>` (none for "match my system") and the browser chrome's colour to match. */
export const applyTheme = (theme: ThemePreference): void => {
  const root = document.documentElement;
  const dataTheme = dataThemeFor(theme);
  if (dataTheme === null) {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", dataTheme);
  }
  // The tags are the layout's (React's own), so only their colour changes, never the tags.
  const system = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  for (const meta of document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const media = meta.getAttribute("media");
    const scheme = dataTheme ?? (media === null ? system : media.includes("light") ? "light" : "dark");
    meta.content = pageColour[scheme];
  }
};

export const ThemeProvider = ({ theme: served, syncCookie, children }: { readonly theme: ThemePreference; readonly syncCookie: boolean; readonly children: ReactNode }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  // The served theme resets the choice whenever the server sends another (a refresh, another member).
  const [state, setState] = useState({ served, theme: served });
  if (state.served !== served) setState({ served, theme: served });
  const [failure, setFailure] = useState<ThemeFailure | null>(null);
  const save = useMutation(trpc.account.setTheme.mutationOptions({ onSettled: () => queryClient.invalidateQueries({ queryKey: trpc.me.get.queryKey() }) }));
  const { mutate } = save;
  const theme = state.theme;

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // A browser whose cookie doesn't hold the account's theme yet (a new sign-in) gets it set once.
  const synced = useRef(false);
  useEffect(() => {
    if (!syncCookie || synced.current) return;
    synced.current = true;
    mutate({ theme: served });
  }, [syncCookie, served, mutate]);

  const choose = useCallback(
    (next: ThemePreference) => {
      const previous = theme;
      if (next === previous) return;
      setFailure(null);
      setState((current) => ({ ...current, theme: next }));
      mutate(
        { theme: next },
        {
          onError: (error) => {
            setState((current) => ({ ...current, theme: previous }));
            setFailure({ message: errorText(error) ?? t("errors.unknown"), previous });
          },
        },
      );
    },
    [theme, mutate],
  );

  const value = useMemo(() => ({ theme, choose, failure }), [theme, choose, failure]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

/** The member's theme and the way to change it (Account's Appearance, the member menu, the palette). */
export const useTheme = (): ThemeState => {
  const value = useContext(ThemeContext);
  if (value === null) throw new Error("useTheme needs the root layout's ThemeProvider");
  return value;
};

const darkQuery = "(prefers-color-scheme: dark)";
const subscribe = (onChange: () => void): (() => void) => {
  const query = window.matchMedia(darkQuery);
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
  };
};

/** What the system's setting is right now, live; `null` on the server, which can't know. */
export const useSystemScheme = (): "dark" | "light" | null =>
  useSyncExternalStore(
    subscribe,
    () => (window.matchMedia(darkQuery).matches ? "dark" : "light"),
    () => null,
  );
