// From next/types, not "next": the root module also loads Next's globals (tsconfig.next.json).
import type { Metadata, Viewport } from "next/types";
import type { ReactNode } from "react";

import { dataThemeFor } from "@ostra/domain/theme";

import { ThemeProvider } from "@/components/shell/theme-provider";
import { ApiProvider } from "@/lib/trpc";
import { t } from "@/lib/messages";
import { resolveTheme, viewportFor } from "@/server/theme";

import { fontVariables } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: t("meta.title"), template: t("meta.titleTemplate") },
  description: t("meta.description"),
  icons: { icon: "/brand/ostra-mark.svg" },
};

export const generateViewport = async (): Promise<Viewport> => viewportFor((await resolveTheme()).theme);

/**
 * F-082: the member's theme is set on `<html>` on the server, so the first frame is already in it:
 * `data-theme="dark"` or `"light"`, or none for "match my system", where globals.css's
 * `prefers-color-scheme` block decides.
 */
const RootLayout = async ({ children }: { readonly children: ReactNode }) => {
  const { theme, syncCookie } = await resolveTheme();
  return (
    <html lang="en" data-theme={dataThemeFor(theme) ?? undefined} className={fontVariables}>
      <body>
        <ApiProvider>
          <ThemeProvider theme={theme} syncCookie={syncCookie}>
            {children}
          </ThemeProvider>
        </ApiProvider>
      </body>
    </html>
  );
};

export default RootLayout;
