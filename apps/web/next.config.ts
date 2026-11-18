import type { NextConfig } from "next/types";

// The panel (ADR 0016, ticket 35). Every header that holds for every response is here; the Content
// Security Policy needs a nonce per request, so `src/proxy.ts` sets it.
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // `pnpm typecheck` (tsc on tsconfig.json) is the type gate. Next's own check would see the
  // workspace's server code under Next's global types, which make NODE_ENV a required variable of
  // every child-process environment, so it runs on its own config and doesn't block the build.
  typescript: { tsconfigPath: "tsconfig.next.json", ignoreBuildErrors: true },
  // Workspace packages are TypeScript source, which Turbopack transpiles; these stay Node's own.
  serverExternalPackages: ["pg", "@prisma/client", "@prisma/adapter-pg", "pg-boss"],
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
