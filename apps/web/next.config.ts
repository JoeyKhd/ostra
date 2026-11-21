import type { NextConfig } from "next/types";

// The panel (ADR 0016, ticket 35). Every header that holds for every response is here; the Content
// Security Policy needs a nonce per request, so `src/proxy.ts` sets it.
// F-083 (ticket 20): the pseudo-locale, for development and tests only. `OSTRA_PSEUDO_LOCALE=1` at
// build time wraps every message as `⟦…⟧` (src/lib/messages.ts), in a build of its own
// (`.next-pseudo`), so the ordinary build beside it is never the pseudo one. `next start` takes the
// same variable to serve it.
const pseudoLocale = process.env["OSTRA_PSEUDO_LOCALE"] === "1";

const config: NextConfig = {
  reactStrictMode: true,
  ...(pseudoLocale ? { distDir: ".next-pseudo" } : {}),
  env: { OSTRA_PSEUDO_LOCALE: pseudoLocale ? "1" : "" },
  poweredByHeader: false,
  // Next's dev-only badge sits bottom left by default, over the sidebar's account row. Bottom right
  // keeps it clear of the shell; it never ships in a production build.
  devIndicators: { position: "bottom-right" },
  // `next dev` logs each request's URL. An invitation's URL holds its ID, a verification or reset
  // link its token, and the panel's reads of them carry the same in their input: bearer secrets,
  // which stay out of every log line (spec m4 section 3, "Nothing leaked").
  logging: {
    // A preview link's viewer page (`/p/<token>`) holds its token too (milestone 8, F-142).
    incomingRequests: { ignore: [/\/invite\//, /\/reset(\/|\?|$)/, /[?&](token|verify)=/, /invitation/i, /resetPreview/, /\/api\/auth\//, /\/p\//] },
  },
  // `pnpm typecheck` (tsc on tsconfig.json) is the type gate. Next's own check would see the
  // workspace's server code under Next's global types, which make NODE_ENV a required variable of
  // every child-process environment, so it runs on its own config and doesn't block the build.
  typescript: { tsconfigPath: "tsconfig.next.json", ignoreBuildErrors: true },
  // Workspace packages are TypeScript source, which Turbopack transpiles; these stay Node's own.
  // `koffi` loads a native addon (`.node`), which Turbopack can't bundle: the adapter SDK's Windows
  // process lister imports it, and without this `next build` fails.
  serverExternalPackages: ["pg", "@prisma/client", "@prisma/adapter-pg", "pg-boss", "koffi"],
  headers: () =>
    Promise.resolve([
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        // A preview link's viewer page (milestone 8, F-142, ADR 0068): its URL is a bearer token, so
        // it never leaves in a `Referer`, and no search engine keeps it.
        source: "/p/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ]),
};

export default config;
