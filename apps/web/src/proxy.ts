import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { contentSecurityPolicy } from "./lib/content-security-policy";

// The Content Security Policy on every page (`lib/content-security-policy.ts`): a nonce per request
// for Next's own scripts, and frames from the preview domain only when one is set (F-144).

/** Core's public address when the setting is unset: the server's own default (`OSTRA_CORE_PUBLIC_URL`). */
const CORE_PUBLIC_URL_DEFAULT = "http://localhost:8787";

export const proxy = (request: NextRequest): NextResponse => {
  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy({
    nonce,
    dev: process.env["NODE_ENV"] === "development",
    previewDomain: process.env["OSTRA_PREVIEW_DOMAIN"],
    corePublicUrl: process.env["OSTRA_CORE_PUBLIC_URL"] ?? CORE_PUBLIC_URL_DEFAULT,
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  // Where the member was going, so sign-in can bring them back (the device page's code, a task link).
  requestHeaders.set("x-ostra-path", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
};

export const config = {
  // Pages only: not the API, Next's static files or the fonts and images in public/.
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|fonts|brand|model-logos|sign-in-illustration|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
