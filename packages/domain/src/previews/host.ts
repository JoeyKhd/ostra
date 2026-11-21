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
  /** The preview's host, as the browser named it. */
  readonly previewHost: string;
  /** The app process's `hostRewrite` (Q304): off, the app gets the real host. */
  readonly hostRewrite: boolean;
  /** The viewer came by a link for people outside the project: the browser's `Origin` is kept on a WebSocket upgrade. */
  readonly outsideLink: boolean;
};

export type RewrittenRequest =
  | { readonly ok: true; readonly headers: HeaderMap }
  /** A WebSocket upgrade whose `Origin` isn't the preview's own host: refused (ADR 0068). */
  | { readonly ok: false; readonly reason: "bad-origin" };

/**
 * A request's headers as the app gets them (ADR 0068, "What the proxy does on every request"):
 * - the preview's cookie, every `X-Forwarded-*` and `Forwarded` the client sent, and every
 *   `X-Ostra-*` are removed, so nothing names the member to the app;
 * - a WebSocket upgrade must come from the preview's own origin, or it's refused;
 * - with `hostRewrite` on, `Host` becomes `localhost:<port>`, and `Origin` too when it's the
 *   preview's own, except on an outside link's WebSocket upgrade, which keeps the browser's;
 * - with it off, `Host` stays the preview's host, with `X-Forwarded-Host` and `X-Forwarded-Proto`.
 */
export const rewriteRequest = (headers: HeaderMap, options: RewriteRequestOptions): RewrittenRequest => {
  const ownOrigin = `https://${options.previewHost}`;
  const origin = firstHeader(headers, "origin");
  const upgrade = isUpgrade(headers);
  if (upgrade && origin !== ownOrigin) {
    return { ok: false, reason: "bad-origin" };
  }
  const out: Record<string, string | readonly string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name === "cookie" || name === "host" || name === "origin" || name === "forwarded" || name.startsWith("x-forwarded-") || name.startsWith("x-ostra-")) {
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
    out["x-forwarded-proto"] = "https";
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
    if (name === "location") {
      const location = typeof value === "string" ? value : (value[0] ?? "");
      const local = new RegExp(`^https?://(?:localhost|127\\.0\\.0\\.1):${String(options.port)}(?=/|$)`, "i");
      out[name] = location.replace(local, `https://${options.previewHost}`);
      continue;
    }
    out[name] = value;
  }
  const [onlyPolicy, ...morePolicies] = policies;
  out["content-security-policy"] = onlyPolicy === undefined ? `frame-ancestors ${options.panelOrigin}` : morePolicies.length === 0 ? onlyPolicy : policies;
  return { headers: out, framingReplaced };
};
