import localFont from "next/font/local";

// The brand's three faces (context/brand/brief.md), self-hosted with the site: no font request
// leaves it.

export const plexSans = localFont({
  src: "../fonts/ibm-plex-sans.ttf",
  weight: "100 700",
  display: "swap",
  variable: "--font-plex-sans",
  fallback: ["ui-sans-serif", "system-ui", "sans-serif"],
});

export const plexMono = localFont({
  src: "../fonts/ibm-plex-mono.ttf",
  weight: "400",
  display: "swap",
  variable: "--font-plex-mono",
  fallback: ["ui-monospace", "monospace"],
});

export const manrope = localFont({
  src: "../fonts/manrope.ttf",
  weight: "200 800",
  display: "swap",
  variable: "--font-manrope",
  fallback: ["sans-serif"],
});

export const fontVariables = `${plexSans.variable} ${plexMono.variable} ${manrope.variable}`;
