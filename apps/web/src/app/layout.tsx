// From next/types, not "next": the root module also loads Next's globals (tsconfig.next.json).
import type { Metadata, Viewport } from "next/types";
import type { ReactNode } from "react";

import { ApiProvider } from "@/lib/trpc";
import { t } from "@/lib/messages";

import { fontVariables } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: t("meta.title"), template: t("meta.titleTemplate") },
  description: t("meta.description"),
  icons: { icon: "/brand/ostra-mark.svg" },
};

export const viewport: Viewport = { themeColor: "#0D0E10", colorScheme: "dark" };

const RootLayout = ({ children }: { readonly children: ReactNode }) => (
  <html lang="en" data-theme="dark" className={fontVariables}>
    <body>
      <ApiProvider>{children}</ApiProvider>
    </body>
  </html>
);

export default RootLayout;
