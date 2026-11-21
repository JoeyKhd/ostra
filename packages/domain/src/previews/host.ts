import { previewIdSchema } from "@ostra/protocol";
import type { PreviewId } from "@ostra/protocol";

// The native preview's hosts and its proxy's header rules (milestone 8, F-144, ADR 0068). A
// preview's host is one label under the preview domain, `<port>-<previewId>.<domain>`; reading one
// gives a key to look up, never a decision, since a host's text comes from the browser. The
// rewrites are pure, over header maps whose names are lower-case: the strips, the `Host`,
// `Origin` and `Location` rewrites, and the framing headers.

/** The preview's cookie, set by the handshake on the preview's own host. Stripped before the app sees a request. */
export const PREVIEW_COOKIE = "__Host-ostra-preview";

/** The handshake's path on a preview host: `/.ostra/enter?code=…`. */
export const PREVIEW_ENTER_PATH = "/.ostra/enter";

/** A preview's host: its port and its task's preview ID, one label under the domain. */
export const previewHost = (port: number, previewId: PreviewId, domain: string): string =>
  `${String(port)}-${previewId}.${domain.toLowerCase().replace(/\.$/, "")}`;

/** What a preview host names: a port and a preview ID to look a task up by. Not a decision: the row and the cookie decide. */
export type PreviewHostKey = { readonly port: number; readonly previewId: PreviewId };

const LABEL = /^([1-9]\d{3,4})-([a-z2-7]{26})$/;

/**
 * Reads a request's `Host` against the preview domain: the port and the preview ID, or `null` for
 * anything else (another host, a malformed or too-long label, a port out of range, a nested
 * label). A `:port` suffix and a trailing dot are ignored; case is folded, as DNS does.
 */
export const parsePreviewHost = (host: string, domain: string): PreviewHostKey | null => {
  if (host.length > 253) {
    return null;
  }
  const bare = host.toLowerCase().replace(/:\d{1,5}$/, "").replace(/\.$/, "");
  const suffix = `.${domain.toLowerCase().replace(/\.$/, "")}`;
  if (!bare.endsWith(suffix)) {
    return null;
  }
  const label = bare.slice(0, bare.length - suffix.length);
  if (label.length === 0 || label.length > 63 || label.includes(".")) {
    return null;
  }
  const found = LABEL.exec(label);
  if (found === null) {
    return null;
  }
  const port = Number(found[1]);
  const previewId = previewIdSchema.safeParse(found[2]);
  if (port < 1024 || port > 65_535 || !previewId.success) {
    return null;
  }
  return { port, previewId: previewId.data };
};

/** A `Host` header's name without its port and trailing dot, lower-case. */
const bareHost = (host: string): string => host.toLowerCase().replace(/:\d{1,5}$/, "").replace(/\.$/, "");

/**
 * Whether a request's `Host` is the preview domain or a name under it, at any depth (ticket 25):
 * core answers such a host with the preview proxy alone, and none of its own routes.
 */
export const isPreviewDomainHost = (host: string | undefined, domain: string): boolean => {
  if (host === undefined || host.length > 253) {
    return false;
  }
  const bare = bareHost(host);
  const root = domain.toLowerCase().replace(/\.$/, "");
  return bare === root || bare.endsWith(`.${root}`);
};

// ---------- how a browser reaches a preview host ----------

export type PreviewScheme = "http" | "https";

/**
 * How the browser reaches a preview host (ticket 25): on core's public address's scheme and port
 * (`OSTRA_CORE_PUBLIC_URL`), since the wildcard record points at the ingress in front of core. A
 * real preview domain needs `https`: browsers drop a `__Host-` cookie on plain `http`, except
 * under `localhost` (spike 08 §3.5). `port` is empty for the scheme's default.
 */
export type PreviewOrigin = { readonly scheme: PreviewScheme; readonly port: string };

export const previewOriginOf = (corePublicUrl: string): PreviewOrigin => {
  const url = new URL(corePublicUrl);
  return { scheme: url.protocol === "http:" ? "http" : "https", port: url.port };
};

/** A preview host's origin as the browser names it, such as `https://5173-k3f9….previews.example.com`. */
export const previewHostOrigin = (host: string, origin: PreviewOrigin): string => `${origin.scheme}://${bareHost(host)}${origin.port === "" ? "" : `:${origin.port}`}`;

/**
 * The panel's CSP `frame-src` for the preview domain (ADR 0068): its hosts, on core's scheme and
 * port, and nothing wider. Only when the domain is set; the panel itself keeps `frame-ancestors 'none'`.
 */
export const previewFrameSource = (domain: string, corePublicUrl: string): string => previewHostOrigin(`*.${domain}`, previewOriginOf(corePublicUrl));

/**
 * Whether the preview domain is the panel's site or another, as the install's settings read the two
 * hosts (ADR 0068, Q307). It's the fallback for a handshake whose browser doesn't say
 * (`previewCookieSameSite`, Q325), and the settings page's reading:
 * - a panel on an IP address or a one-label name (`localhost`) shares a site with no domain under
 *   it: browsers treat `localhost` as a suffix of its own (spike 08 §3.5);
 * - otherwise the domain is the panel's site when it's under the panel's host, or under the
 *   panel's parent name when the panel's host has three labels or more (`ostra.acme.dev` and
 *   `preview.acme.dev`).
 * Without the public suffix list (a dependency ostra doesn't take), a panel on a two-part suffix's
 * apex (`acme.co.uk`) beside a preview domain on another name of it reads as one site. Every other
 * mistake it can make reads `cross-site`. A browser's own `Sec-Fetch-Site` corrects both.
 */
export type PreviewSiteLayout = "same-site" | "cross-site";

export const previewSiteLayout = (panelUrl: string, domain: string): PreviewSiteLayout => {
  const panelHost = new URL(panelUrl).hostname.toLowerCase().replace(/\.$/, "");
  const root = domain.toLowerCase().replace(/\.$/, "");
  const labels = panelHost.split(".");
  if (panelHost.includes(":") || panelHost.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(panelHost) || labels.length < 2) {
    return "cross-site";
  }
  const base = labels.length >= 3 ? labels.slice(1).join(".") : panelHost;
  return root === base || root.endsWith(`.${base}`) ? "same-site" : "cross-site";
};

// ---------- the handshake's cookie ----------

/** The longest a preview's cookie lives, whatever the session or the link allows *(working value)*. */
export const PREVIEW_COOKIE_MAX_MS = 12 * 60 * 60_000;

/** The cookie's `SameSite`: `Lax`, or `None; Partitioned`, which a frame on another site than the panel's needs. */
export type PreviewCookieSameSite = "lax" | "none-partitioned";

/** A request's own Fetch Metadata as the browser sent it: `Sec-Fetch-Site` and `Sec-Fetch-Dest`, `undefined` when absent. */
export type PreviewFetchMetadata = { readonly site: string | undefined; readonly dest: string | undefined };

/**
 * The handshake's cookie, and what read the site: the browser's `Sec-Fetch-Site`, or the install's
 * site layout where the browser didn't say.
 */
export type PreviewCookieChoice = { readonly sameSite: PreviewCookieSameSite; readonly site: PreviewSiteLayout; readonly readBy: "browser" | "layout" };

/**
 * The handshake's `SameSite`, per request (ADR 0068, Q325): from the browser's own Fetch Metadata,
 * which reads "site" by the real public suffix list, with the install's site layout as the fallback.
 * - **The site:** `Sec-Fetch-Site: cross-site` is another site than the panel's, always, whatever
 *   the layout says; `same-site` is the panel's. `same-origin` (the preview's own page sent it),
 *   `none` (a person typed it), an unknown value or none at all don't name the panel's site, so the
 *   layout reads it.
 * - **The attributes:** `None; Partitioned` on another site, except in a tab of its own
 *   (`Sec-Fetch-Dest: document`), where the preview's host is the page's own site and a `Lax`
 *   cookie is set and sent; `Lax` on the panel's site, in a frame or a tab.
 */
export const previewCookieSameSite = (metadata: PreviewFetchMetadata, layout: PreviewSiteLayout): PreviewCookieChoice => {
  const said = metadata.site?.trim().toLowerCase();
  const tab = metadata.dest?.trim().toLowerCase() === "document";
  const browser: PreviewSiteLayout | null = said === "cross-site" ? "cross-site" : said === "same-site" ? "same-site" : null;
  const site = browser ?? layout;
  return { sameSite: site === "cross-site" && !tab ? "none-partitioned" : "lax", site, readBy: browser === null ? "layout" : "browser" };
};

/**
 * A `Set-Cookie` for the preview's cookie (ADR 0068): `__Host-ostra-preview`, host-only (no
 * `Domain`), `Path=/`, `Secure`, `HttpOnly`, and `SameSite=None; Partitioned` or `SameSite=Lax`
 * (`previewCookieSameSite`). `maxAgeSeconds` 0 clears it.
 */
export const previewCookieHeader = (value: string, sameSite: PreviewCookieSameSite, maxAgeSeconds: number): string =>
  `${PREVIEW_COOKIE}=${value}; Path=/; Secure; HttpOnly; ${sameSite === "none-partitioned" ? "SameSite=None; Partitioned" : "SameSite=Lax"}; Max-Age=${String(Math.max(0, Math.floor(maxAgeSeconds)))}`;

/**
 * The `Set-Cookie` lines that clear the preview's cookie, whichever one the browser holds: the
 * partitioned one a frame on another site got, and the `Lax` one. A refused request's own Fetch
 * Metadata names its initiator (often the preview's own page), not the frame's top, so it can't say
 * which; a context drops the line it can't take.
 */
export const previewCookieClears = (): readonly string[] => [previewCookieHeader("", "none-partitioned", 0), previewCookieHeader("", "lax", 0)];

/** The preview's cookie's value in a `Cookie` header, or `null`. The first one wins, as browsers send the most specific first. */
export const previewCookieValue = (cookie: string | readonly string[] | undefined): string | null => {
  const lines = cookie === undefined ? [] : typeof cookie === "string" ? [cookie] : cookie;
  for (const part of lines.flatMap((line) => line.split(";"))) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${PREVIEW_COOKIE}=`)) {
      return trimmed.slice(PREVIEW_COOKIE.length + 1);
    }
  }
  return null;
};

/** Where the handshake redirects: a path on the preview's own host (`/…`, never `//…` or `/\…`), else `/`. */
export const previewRedirectPath = (path: string | null | undefined): string =>
  path !== null && path !== undefined && path.length <= 2048 && path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\") && !/[\s\\]/.test(path) ? path : "/";

// ---------- the proxy's rewrites ----------

/** HTTP headers, lower-case names. A repeated header is a list. */
export type HeaderMap = Readonly<Record<string, string | readonly string[]>>;

const headerValues = (headers: HeaderMap, name: string): readonly string[] => {
  const value = headers[name];
  if (value === undefined) {
    return [];
  }
  return typeof value === "string" ? [value] : value;
};

const firstHeader = (headers: HeaderMap, name: string): string | undefined => headerValues(headers, name)[0];

/** The cookie header without the preview's own cookie; `null` when nothing is left. */
const cookiesWithoutOurs = (headers: HeaderMap): string | null => {
  const kept = headerValues(headers, "cookie")
    .flatMap((line) => line.split(";"))
    .map((part) => part.trim())
    .filter((part) => part !== "" && !part.startsWith(`${PREVIEW_COOKIE}=`));
  return kept.length === 0 ? null : kept.join("; ");
};

/** Whether a request asks for a WebSocket. */
const isUpgrade = (headers: HeaderMap): boolean => (firstHeader(headers, "upgrade") ?? "").toLowerCase() === "websocket";

export type RewriteRequestOptions = {
  /** The app's port in the box. */
  readonly port: number;
  /** The preview's host, as the browser named it (its `Host`, with a port when the browser sent one). */
  readonly previewHost: string;
  /** The app process's `hostRewrite` (Q304): off, the app gets the real host. */
  readonly hostRewrite: boolean;
  /** The viewer came by a link for people outside the project: the browser's `Origin` is kept on a WebSocket upgrade. */
  readonly outsideLink: boolean;
  /** The scheme the browser reached the preview on (`previewOriginOf`): `https` unless core's public address is `http`. */
  readonly scheme?: PreviewScheme;
};

export type RewrittenRequest =
  | { readonly ok: true; readonly headers: HeaderMap }
  /** A WebSocket upgrade whose `Origin` isn't the preview's own host: refused (ADR 0068). */
  | { readonly ok: false; readonly reason: "bad-origin" };

/**
 * A request's headers as the app gets them (ADR 0068, "What the proxy does on every request"):
 * - the preview's cookie, every `X-Forwarded-*` and `Forwarded` the client sent, and every
 *   `X-Ostra-*` and `Ostra-*` are removed, so nothing names the member to the app and no client
 *   names another port to the box (`ostra-target-port`, which only core sets);
 * - a WebSocket upgrade must come from the preview's own origin, or it's refused;
 * - with `hostRewrite` on, `Host` becomes `localhost:<port>`, and `Origin` too when it's the
 *   preview's own, except on an outside link's WebSocket upgrade, which keeps the browser's;
 * - with it off, `Host` stays the preview's host, with `X-Forwarded-Host` and `X-Forwarded-Proto`.
 */
export const rewriteRequest = (headers: HeaderMap, options: RewriteRequestOptions): RewrittenRequest => {
  const scheme = options.scheme ?? "https";
  const ownOrigin = `${scheme}://${options.previewHost}`;
  const origin = firstHeader(headers, "origin");
  const upgrade = isUpgrade(headers);
  if (upgrade && origin !== ownOrigin) {
    return { ok: false, reason: "bad-origin" };
  }
  const out: Record<string, string | readonly string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name === "cookie" || name === "host" || name === "origin" || name === "forwarded" || name.startsWith("x-forwarded-") || name.startsWith("x-ostra-") || name.startsWith("ostra-")) {
      continue;
    }
    out[name] = value;
  }
  const cookie = cookiesWithoutOurs(headers);
  if (cookie !== null) {
    out["cookie"] = cookie;
  }
  const local = `localhost:${String(options.port)}`;
  if (options.hostRewrite) {
    out["host"] = local;
    if (origin !== undefined) {
      out["origin"] = origin === ownOrigin && !(upgrade && options.outsideLink) ? `http://${local}` : origin;
    }
  } else {
    out["host"] = options.previewHost;
    out["x-forwarded-host"] = options.previewHost;
    out["x-forwarded-proto"] = scheme;
    if (origin !== undefined) {
      out["origin"] = origin;
    }
  }
  return { ok: true, headers: out };
};

export type RewriteResponseOptions = {
  /** The panel's origin, the one site allowed to frame the preview. */
  readonly panelOrigin: string;
  /** The preview's host, for `Location`. */
  readonly previewHost: string;
  /** The app's port in the box, whose own URLs `Location` turns back into the preview's. */
  readonly port: number;
  /** The scheme the browser reached the preview on: `https` unless core's public address is `http`. */
  readonly scheme?: PreviewScheme;
};

export type RewrittenResponse = {
  readonly headers: HeaderMap;
  /** Whether the app sent a framing header the proxy replaced: the pane says so. */
  readonly framingReplaced: boolean;
};

/** A CSP value with its `frame-ancestors` directive replaced by the panel's origin only. */
const withFrameAncestors = (policy: string, panelOrigin: string): string => {
  const kept = policy
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => directive !== "" && !/^frame-ancestors(?:\s|$)/i.test(directive));
  return [...kept, `frame-ancestors ${panelOrigin}`].join("; ");
};

/**
 * A response's headers as the member's browser gets them (ADR 0068): `X-Frame-Options` is
 * removed and `frame-ancestors` is set to the panel's origin only, replacing any the app sent, so
 * helmet, Rails, Django and Spring apps show in the pane and no other site can frame the preview;
 * and a `Location` on the app's own `localhost` goes back to the preview's host.
 */
export const rewriteResponse = (headers: HeaderMap, options: RewriteResponseOptions): RewrittenResponse => {
  const out: Record<string, string | readonly string[]> = {};
  let framingReplaced = false;
  let policies: readonly string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (name === "x-frame-options") {
      framingReplaced = true;
      continue;
    }
    if (name === "content-security-policy") {
      const sent = typeof value === "string" ? [value] : value;
      framingReplaced ||= sent.some((policy) => /(?:^|;)\s*frame-ancestors(?:\s|;|$)/i.test(policy));
      policies = sent.map((policy) => withFrameAncestors(policy, options.panelOrigin));
      continue;
    }
    if (name === "set-cookie") {
      // The app can't set, replace or clear the preview's own cookie: it's core's.
      const kept = (typeof value === "string" ? [value] : value).filter((line) => !line.trimStart().startsWith(`${PREVIEW_COOKIE}=`));
      if (kept.length > 0) {
        out[name] = kept;
      }
      continue;
    }
    if (name === "location") {
      const location = typeof value === "string" ? value : (value[0] ?? "");
      const local = new RegExp(`^https?://(?:localhost|127\\.0\\.0\\.1):${String(options.port)}(?=/|$)`, "i");
      out[name] = location.replace(local, `${options.scheme ?? "https"}://${options.previewHost}`);
      continue;
    }
    out[name] = value;
  }
  const [onlyPolicy, ...morePolicies] = policies;
  out["content-security-policy"] = onlyPolicy === undefined ? `frame-ancestors ${options.panelOrigin}` : morePolicies.length === 0 ? onlyPolicy : policies;
  return { headers: out, framingReplaced };
};
