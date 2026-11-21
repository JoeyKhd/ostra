import { previewFrameSource } from "@ostra/domain/preview-host";

// The panel's Content Security Policy (ticket 35): a nonce per request for Next's own scripts, and
// no third-party origin anywhere. Agent text never becomes HTML (ADR 0036), and this is the backstop.
// In development React needs `eval` for its error overlays, and the dev server's websocket.
//
// Milestone 8 (ticket 25, F-144, ADR 0068): with a preview domain set, the pane frames the app on
// its preview host, so `frame-src` names the preview domain's hosts on core's public scheme and
// port, and nothing wider. Unset, the panel frames nothing, as before. The panel itself is never
// framed: `frame-ancestors 'none'` stays, beside `X-Frame-Options: DENY` (`next.config.ts`).

export type PolicyOptions = {
  readonly nonce: string;
  readonly dev: boolean;
  /** `OSTRA_PREVIEW_DOMAIN`, or `undefined` when it's unset. */
  readonly previewDomain: string | undefined;
  /** `OSTRA_CORE_PUBLIC_URL`: preview hosts are served on its scheme and port. */
  readonly corePublicUrl: string;
};

/** The preview domain as the server reads it: trimmed, lower-case, without a trailing dot; empty is unset. */
const domainOf = (raw: string | undefined): string | undefined => {
  const domain = raw?.trim().toLowerCase().replace(/\.$/, "");
  return domain === undefined || domain === "" ? undefined : domain;
};

export const contentSecurityPolicy = (options: PolicyOptions): string => {
  const domain = domainOf(options.previewDomain);
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${options.nonce}' 'strict-dynamic'${options.dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self'${options.dev ? " ws://localhost:* ws://127.0.0.1:*" : ""}`,
    ...(domain === undefined ? [] : [`frame-src ${previewFrameSource(domain, options.corePublicUrl)}`]),
    "object-src 'none'",
    "base-uri 'self'",
    // The one exception: "Create a new App" posts its manifest to GitHub (F-006). It's a navigation
    // the admin starts, never a request the page makes on its own.
    "form-action 'self' https://github.com",
    "frame-ancestors 'none'",
  ].join("; ");
};
