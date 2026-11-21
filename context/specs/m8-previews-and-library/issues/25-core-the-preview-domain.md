# 25: Core: the preview domain

Status: ready-for-agent
Builder: core
Blocked by: 22, 23
Features: F-144
Packages: `apps/core` (`previews/proxy`, the HTTP server's routing), `apps/web/src/proxy.ts` (the CSP), `packages/domain` (bodies), `deploy/compose.yaml` and `deploy/helm/` (the optional wildcard)
Spec: `../spec.md`, sections 4 ("A tunnel") and 5.4; ADR 0068 ("The native preview")

## What to build

Only when `OSTRA_PREVIEW_DOMAIN` is set; unset, nothing below listens or changes.
- **Routing by host.** A request whose `Host` is under the preview domain reaches only the preview proxy, and no other route of core answers on such a host. A request on core's own host never reaches the proxy. `parsePreviewHost` (ticket 05) gives a key, and the proxy looks up the task by its `previewId` and the port, never trusting the host's text beyond that.
- **The handshake:**
  - `GET /.ostra/enter?code=…` on a preview host redeems the one-time code (ticket 05; 60 s, single use, bound to the member or link, the task, the port and the epoch);
  - it sets `__Host-ostra-preview` (HttpOnly, Secure, `Path=/`, no `Domain`), with `SameSite=None; Partitioned` when the preview domain is another site than the panel's, and `Lax` when it's the same site;
  - its lifetime is at most the member's session or the link, and 12 hours;
  - then it redirects to the path.

  Without a valid cookie, a preview host answers a small page that says to open the preview from ostra, and nothing else.
- **On every request, as ADR 0068 lists them:**
  - strip the preview cookie and every client `X-Forwarded-*`;
  - pass no member identity;
  - check `Origin` on WebSocket upgrades;
  - apply `rewriteRequest` and `rewriteResponse` (ticket 05), with `hostRewrite` from the app process, and the browser's `Origin` kept on an outside link's upgrades;
  - remove `X-Frame-Options` and set `frame-ancestors` to the panel's origin.

  Each request goes to the view's tunnel as an HTTP/2 request, or an extended CONNECT for an upgrade.
- **Re-checks:** membership or the link, and the lease, on each new connection and every 5 minutes. A stale lease ends the cookie's view, and a reopen's new lease is picked up by the same `previewId`.
- **The panel's side** (`apps/web/src/proxy.ts`): `frame-src https://*.<preview domain>` (or `http://*.<domain>:*` for `preview.localhost` in development) only when the domain is set. `frame-ancestors 'none'` and `X-Frame-Options: DENY` stay for the panel.
- **The panel's own defences, checked here:**
  - the session cookie is host-only (`__Host-` or no `Domain`), with a test;
  - the panel refuses a state-changing request whose `Origin` isn't its own;
  - every WebSocket core serves checks `Origin`.

  Each gets a test that runs a request from a preview host's origin.
- **The settings check:** `instance.previewDomainCheck` resolves a random name under the domain, fetches it over HTTPS, and reports the DNS record and the certificate as present or missing, for ticket 26's page.
- **Deploy:** `compose.yaml` and the Helm chart show the wildcard host as an optional, commented route to core, with the docs' pointer.

## Done when

- [ ] Tests named for `F-144`:
  - a host with no matching row answers nothing of an app;
  - a code's binding, single use and expiry;
  - the cookie's attributes in both site layouts;
  - the strips, the `Origin` check, the rewrites on and off, and the kept `Origin` for outside links;
  - the framing header replaced on a page that sent `X-Frame-Options: DENY`;
  - the Vite and Next.js 16 fixtures loading with HMR through it on `host`;
  - a request from the preview origin to the panel's tRPC refused, and the panel's cookie not sent (break-it: scope the panel's cookie to the parent domain, and the case fails).
- [ ] The CSP test: `frame-src` only with the domain set.
- [ ] The whole-repo checks pass, since this touches auth (spec section 10).
- [ ] Committed as `✨ serve native previews on a preview domain`.

## Comments
