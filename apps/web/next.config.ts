import type { NextConfig } from "next/types";

// The panel (ADR 0016, ticket 35). Every header that holds for every response is here; the Content
// Security Policy needs a nonce per request, so `src/proxy.ts` sets it.
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Next's dev-only badge sits bottom left by default, over the sidebar's account row. Bottom right
  // keeps it clear of the shell; it never ships in a production build.
  devIndicators: { position: "bottom-right" },
  // `next dev` logs each request's URL. An invitation's URL holds its ID, a verification or reset
  // link its token, and the panel's reads of them carry the same in their input: bearer secrets,
  // which stay out of every log line (spec m4 section 3, "Nothing leaked").
  logging: {
    incomingRequests: { ignore: [/\/invite\//, /\/reset(\/|\?|$)/, /[?&](token|verify)=/, /invitation/i, /resetPreview/, /\/api\/auth\//] },
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
    ]),
};

export default config;
