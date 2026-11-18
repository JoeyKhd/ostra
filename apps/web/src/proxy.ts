import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// The Content Security Policy (ticket 35): a nonce per request for Next's own scripts, and no
// third-party origin anywhere. Agent text never becomes HTML (ADR 0036), and this is the backstop.
// In development React needs `eval` for its error overlays, and the dev server's websocket.

const policy = (nonce: string, dev: boolean): string =>
  [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self'${dev ? " ws://localhost:* ws://127.0.0.1:*" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    // The one exception: "Create a new App" posts its manifest to GitHub (F-006). It's a navigation
    // the admin starts, never a request the page makes on its own.
    "form-action 'self' https://github.com",
    "frame-ancestors 'none'",
  ].join("; ");

export const proxy = (request: NextRequest): NextResponse => {
  const nonce = btoa(crypto.randomUUID());
  const csp = policy(nonce, process.env["NODE_ENV"] === "development");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
};

export const config = {
  // Pages only: not the API, Next's static files or the fonts and images in public/.
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|fonts|brand|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
