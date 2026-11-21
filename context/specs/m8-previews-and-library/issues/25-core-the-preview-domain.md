# 25: Core: the preview domain

Status: done
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

- [x] Tests named for `F-144`:
  - a host with no matching row answers nothing of an app;
  - a code's binding, single use and expiry;
  - the cookie's attributes in both site layouts;
  - the strips, the `Origin` check, the rewrites on and off, and the kept `Origin` for outside links;
  - the framing header replaced on a page that sent `X-Frame-Options: DENY`;
  - the Vite and Next.js 16 fixtures loading with HMR through it on `host`;
  - a request from the preview origin to the panel's tRPC refused, and the panel's cookie not sent (break-it: scope the panel's cookie to the parent domain, and the case fails).
- [x] The CSP test: `frame-src` only with the domain set.
- [x] The whole-repo checks pass, since this touches auth (spec section 10). *Run as the lead's rules of 2026-11-20 say: typecheck, lint and tests of the touched packages (protocol, db, adapter-sdk, domain, api, web, core); GitHub CI runs the rest.*
- [x] Committed as `✨ serve native previews on a preview domain`.

## Comments

- 2026-11-21, core (ticket 25): built as `✨ serve native previews on a preview domain`. Tests: `apps/core/src/previews/native.test.ts`, core's real proxy against the runner's real tunnel side (`createPreviewViews`, `openPreviewConnection`) on `host`, with `test-web`'s real Vite and API, `test-next`'s real Next.js 16 and a probe app, on `preview.localhost` (`F-144/c1`: the preview hosts reach the proxy alone, core's routes (`/healthz`, the runner token, the frames) never answer on one, core's own host never reaches the proxy, a host with no matching row answers the small page and nothing of an app, a stale lease's view replaced under the same host, and a second replica forwarding requests and Vite's HMR socket, signed, with a forwarded request that doesn't verify refused; `c2`: unset, a preview host is core's own and no code is minted; `c3`: a code once, within 60 s, on its own host and port only (another port's or task's host refused, the code unspent), under its lease epoch, bound to the login session, kept as a hash and in no log line; a watch-only link gets no code; the cookie in both site layouts (`SameSite=None; Partitioned` across sites, `Lax` on `ostra.localhost`'s), host-only, no longer than the session, the link or 12 hours; a revoked link's cookie cleared and its socket ended; `c4`: the strips, no member identity, no client-named port, `Host`, `Origin` and `Location` rewritten, `hostRewrite` off, the `Origin` check on upgrades and an outside link's kept, `X-Frame-Options: DENY` and `frame-ancestors 'none'` replaced by the panel's origin; `c5`: Vite with `/api`, its HMR socket and an edit, the API's echo, and Next.js 16's page and HMR socket with an edit; `c7`: the runner connection, the box's preview connection and the CLI's tunnel refuse a page's `Origin`; `c9`: no code and no view over the HTTP carrier), `packages/domain/src/milestone-8-native-preview.test.ts` (`c1`, `c3`, `c4`, `c8`: the site layout, the cookie and its value, the hosts, the redirect, the strips, and the settings check against fakes and Node's own probe on a loopback TLS server), `packages/api/src/auth/panel-defences.test.ts` (`c7`: the session cookie host-only, so a preview host never gets it (scoping it to a parent domain fails the case); a tRPC mutation and better-auth's sign-out from a preview origin refused; `c8`: `instance.previewDomainCheck`) and `apps/web/src/lib/content-security-policy.test.ts` (`c6`). The keys follow F-144's sentences, as tickets 22 and 23 did: c1 a preview on its host served through the box's connection, c2 optional, c3 the code and the cookie, c4 the proxy's rewrites, c5 Vite and Next.js with HMR, c6 the CSP, c7 the panel's cookie and origin, c8 the settings check, c9 the HTTP carrier. Readings and decisions:
  - **Where things live:** the rows in `packages/domain/src/previews/native.ts` (`enterNativePreview` for ticket 26's `previews.enter`, `redeemNativeEntry`, `nativeViewFor`, the task's `previewId`), the pure parts in `host.ts` (the site layout, the cookie's header, a host's origin, `frame-src`) and `tokens.ts` (the cookie's value), the check in `domain-check.ts`; the bytes in `apps/core/src/previews/native.ts`, routed by host in `server.ts`; the panel's side in `apps/web/src/lib/content-security-policy.ts`, `packages/api/src/services/panel-origin.ts`, `trpc/http.ts` and `auth/http.ts`; the check's procedure in `routers/instance.ts`.
  - **The code is bound to the login session** (`PreviewCode.authSessionId`, a small additive migration, `20261201170000_preview_code_auth_session`), since core can't otherwise keep the cookie within "the member's session": `EnterNativePreview` takes a `NativePreviewOpener` with the session's ID (`ctx.user.sessionId` in the panel) and an optional `path`, answers `origin` and `expiresAt` too, and refuses with `watch-only` and `runner-cannot-tunnel`. `LoginSessionId` moved to the protocol so the domain names it.
  - **Preview hosts are served on `OSTRA_CORE_PUBLIC_URL`'s scheme and port** (the wildcard points at core's ingress): no new setting. The server refuses to start with core's own host under the domain, since core then answers it with the proxy alone.
  - **The view is core's,** one per viewer and lease, opened on a cookie's new connection and heartbeated by the replica with the browser's traffic while it's used, as an open `ostra preview` is (ADR 0068, "As built (ticket 25)"). So the pane needs no heartbeat of its own in this mode, and "Open in a new tab" stays warm too, to the warm cap.
  - **The cookie is stateless,** an HMAC under the secrets key, checked against the rows on each new connection and every 5 minutes; its `SameSite` follows the install's site layout, which this ticket reads without the public suffix list: raised as Q325, with a recommendation.
  - **The panel's own defences, found here:** better-auth checks `Origin` itself, but not under a test runner (its `isTest()` skips the check), and tRPC checked nothing, so `/api/trpc` and `/api/auth/*` (and the skill-file upload) now refuse a change from another origin first, in every environment (`fromPanelOrigin`). Core's runner connection and the box's preview connection now refuse an upgrade with an `Origin`, as the CLI's tunnel already did.
  - **The settings check** reports four rows, as `instance-preview-domain.md` asks: the record (and whether it reaches core's host), the certificate, core's mark on `/.ostra/check` (an HMAC over the host, so another server can't pass for it), and an upgrade there. `instance.previewDomainCheck` is a mutation for instance admins; keeping its last result per install (the target's "who ran it and when") needs a column and is left to ticket 26.
  - **Deploy:** `deploy/compose.yaml` and the Helm chart's `values.yaml` show the wildcard host as a commented route to core, pointing at `OSTRA_PREVIEW_DOMAIN` in `docs/configuration.md`, whose line says how previews are reached.
  - **Left open:** the pane, the viewer page with input and the settings page (ticket 26, whose `previews.enter` calls `enterNativePreview`); the per-preview framing report the target asks for (which header was replaced) isn't recorded; Safari's partitioned cookie on a Mac (ticket 34); Q325. The Firefox browser tests that need `network.cookie.cookieBehavior` 5 are ticket 26's.
- 2026-11-21, core (Q325, the lead on the builder's recommendation): the handshake's `SameSite` now comes from the browser's own `Sec-Fetch-Site` and `Sec-Fetch-Dest` (`previewCookieSameSite` in `packages/domain/src/previews/host.ts`): `cross-site` is always another site (`None; Partitioned`, except a tab of its own, `Lax`), `same-site` the panel's (`Lax`), and `same-origin`, `none`, an unknown value or no header fall back to `previewSiteLayout`. A refused request clears both forms of the cookie. So the `acme.co.uk` panel beside `previews.other.co.uk` gets a partitioned cookie in its frame. Tests: `F-144/c3` in `packages/domain/src/milestone-8-native-preview.test.ts` (each header value against each layout) and `apps/core/src/previews/native.test.ts` (the real handshake on an `acme.co.uk` replica, each `Sec-Fetch-Site` value and the fallback on both layouts, and the clear's two lines). ADR 0068 records it under "Decided by the lead".
