# 26: API and web: the native preview and its settings

Status: ready-for-agent
Builder: web
Blocked by: 09, 21, 25
Features: F-144, F-142
Packages: `packages/api`, `apps/web`
Spec: `../spec.md`, section 13 (targets 8 and 9); ADR 0068 ("The native preview")

## What to build

To the approved targets `preview-native` and `instance-preview-domain`:
- **`previews.enter`** (tRPC): for a member who can open the task, or a link that allows input, `enterNativePreview` (ticket 05) mints the one-time code and returns the preview host's `/.ostra/enter?code=…` URL. A watch-only link never gets one.
- **The pane, when the domain is set:**
  - "In your browser": the app in an iframe on the preview host, with `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"` and no `allow-top-navigation`;
  - "Open in a new tab", which makes its own handshake;
  - the note that the framing headers were replaced;
  - a switch back to the browser view.

  "Expand" resizes the same frame and never moves it in the DOM, so it doesn't reload.
- **A link with input,** when the domain is set, opens the native preview on the viewer page instead of the stream.
- **The instance settings page:**
  - the preview domain as configured (read-only: it's a setting);
  - the one DNS record and the certificate to add, in the self-hoster's words;
  - "Check" with its result (ticket 25's check);
  - the recommendation of a domain of its own, and the warning on a subdomain of the panel's (Q307).
- **The organization's "Allow public preview links"** switch, on its settings page, with its words on what a public link means.
- **Words** through `t`.

## Done when

- [ ] The targets' approval is recorded in ticket 09's `## Comments` before the UI is built.
- [ ] Tests named for `F-144` (this ticket's browser spec file only, on `preview.localhost` here, in Chromium and Firefox):
  - the pane frames the fixture app, and the app's own state survives "Expand" (no reload);
  - "Open in a new tab" makes its own handshake;
  - the settings page's check reports a missing record.
- [ ] Tests named for `F-142`: a watch-only link gets no code (break-it: let one through, and the case fails).
- [ ] Safari's partitioned cookie in the frame is checked by hand on a Mac (ticket 34), and recorded under `## Comments` as seen or as waiting. *Changed 2026-11-21: it was F-144's proof file, gone with the proof files.*
- [ ] Checks for `packages/api` and `apps/web` pass (spec section 10).
- [ ] Committed as `✨ add the native preview to the pane`.

## Comments

- 2026-11-21, core (ticket 25): the seams. `previews.enter` calls `enterNativePreview(deps, opener, { taskId, key, path? })` from `@ostra/domain`: `deps` is `{ db, clock, settings: settings.previews, corePublicUrl: settings.corePublicUrl }`, and a member's opener carries `loginSessionId: ctx.user.sessionId`, so the cookie ends with the panel session. It answers `{ url, origin, previewId, expiresAt }`, or `watch-only` (a named person, a link without input: the case this ticket tests), `runner-cannot-tunnel` (the HTTP carrier), `no-preview-domain`, `no-box`, `port-not-allowed` and the access refusals. `url` is the preview host's `/.ostra/enter?code=…&path=…`: frame it, or open it in a new tab after a second call. Core keeps the native view and its heartbeat itself while the browser uses it, so the pane sends no `previews.heartbeat` in this mode. The settings page's check is `instance.previewDomainCheck` (a mutation, instance admins), whose answer is `previewDomainCheckSchema` (four rows, `dns`, `certificate`, `proxy` and `upgrade`, each `passed`, `failed`, `skipped` or `not-needed`); keeping its last result isn't built. The site layout is `previewSiteLayout(OSTRA_PUBLIC_URL, domain)` (`@ostra/domain/preview-host`), for the page's same-site warning; the cookie's `SameSite` is the browser's own `Sec-Fetch-Site` and `Sec-Fetch-Dest` at each handshake, with that layout only as the fallback (Q325, settled 2026-11-21). The panel's CSP already has `frame-src` when the domain is set.
