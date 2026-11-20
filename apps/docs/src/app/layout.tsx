import "./globals.css";

import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { Providers } from "@/components/providers";
import { basePath, siteUrl } from "@/lib/site";

import { fontVariables } from "./fonts";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: "ostra docs", template: "%s · ostra docs" },
  description: "Install, run and extend ostra, the source-available, self-hosted control plane for coding agents.",
  icons: { icon: `${basePath}/favicon.svg` },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0D0E10" },
    { media: "(prefers-color-scheme: light)", color: "#FBFAF6" },
  ],
};

// Dark is the default for a first visit (docs-home.md, open point 1); a chosen theme is kept in
// localStorage and applied here before the first paint, so a reload never flashes the other one.
const themeScript = `try{var t=localStorage.getItem("theme");if(t==="light"||t==="dark"){document.documentElement.dataset.theme=t}}catch(e){}`;

const RootLayout = ({ children }: { readonly children: ReactNode }) => (
  <html lang="en" data-theme="dark" className={fontVariables} suppressHydrationWarning>
    <head>
      <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      <noscript>
        <style>{".needs-js{display:none!important}"}</style>
      </noscript>
    </head>
    <body>
      <Providers>{children}</Providers>
    </body>
  </html>
);

export default RootLayout;
