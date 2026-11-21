# 26: API and web: the native preview and its settings

Status: done
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

- [x] The targets' approval is recorded in ticket 09's `## Comments` before the UI is built. *(The lead recorded the second batch's approval, 2026-11-21.)*
- [ ] Tests named for `F-144` (this ticket's browser spec file only, on `preview.localhost` here, in Chromium and Firefox):
  - the pane frames the fixture app, and the app's own state survives "Expand" (no reload);
  - "Open in a new tab" makes its own handshake;
  - the settings page's check reports a missing record.

  *2026-11-21: all three pass in Chromium (`e2e/25-native-preview.spec.ts`, `e2e/25-preview-domain-missing.spec.ts`). Firefox is open: the e2e config has no Firefox project, so its case with `network.cookie.cookieBehavior` 5 (spike 08) isn't written.*
- [x] Tests named for `F-142`: a watch-only link gets no code (break-it: let one through, and the case fails). *(No break-it pass: dropped with the proof paperwork, 2026-11-21.)*
- [x] Safari's partitioned cookie in the frame is checked by hand on a Mac (ticket 34), and recorded under `## Comments` as seen or as waiting. *Changed 2026-11-21: it was F-144's proof file, gone with the proof files.* *Recorded as waiting, 2026-11-21: it waits for the launch-gate run on a Mac (ticket 34).*
- [x] Checks for `packages/api` and `apps/web` pass (spec section 10). *Run as the lead's rules of 2026-11-20 say: typecheck, lint and tests of the touched packages (db, domain, api, web, core, runner); GitHub CI runs the rest.*
- [x] Committed as `✨ add the native preview to the pane`.

## Comments

- 2026-11-21, core (ticket 25): the seams. `previews.enter` calls `enterNativePreview(deps, opener, { taskId, key, path? })` from `@ostra/domain`: `deps` is `{ db, clock, settings: settings.previews, corePublicUrl: settings.corePublicUrl }`, and a member's opener carries `loginSessionId: ctx.user.sessionId`, so the cookie ends with the panel session. It answers `{ url, origin, previewId, expiresAt }`, or `watch-only` (a named person, a link without input: the case this ticket tests), `runner-cannot-tunnel` (the HTTP carrier), `no-preview-domain`, `no-box`, `port-not-allowed` and the access refusals. `url` is the preview host's `/.ostra/enter?code=…&path=…`: frame it, or open it in a new tab after a second call. Core keeps the native view and its heartbeat itself while the browser uses it, so the pane sends no `previews.heartbeat` in this mode. The settings page's check is `instance.previewDomainCheck` (a mutation, instance admins), whose answer is `previewDomainCheckSchema` (four rows, `dns`, `certificate`, `proxy` and `upgrade`, each `passed`, `failed`, `skipped` or `not-needed`); keeping its last result isn't built. The site layout is `previewSiteLayout(OSTRA_PUBLIC_URL, domain)` (`@ostra/domain/preview-host`), for the page's same-site warning; the cookie's `SameSite` is the browser's own `Sec-Fetch-Site` and `Sec-Fetch-Dest` at each handshake, with that layout only as the fallback (Q325, settled 2026-11-21). The panel's CSP already has `frame-src` when the domain is set.
- 2026-11-21, web (ticket 26): built as `✨ add the native preview to the pane`, to the approved targets (`preview-native.md`, `instance-preview-domain.md`).
  - **The API** (`packages/api/src/routers/previews.ts`, `instance.ts`): `previews.enter` (a member who can open the task, bound to `ctx.user.sessionId`) and `previews.link.enter` (a link that allows input) call `enterNativePreview` and answer `{ url, origin, host, expiresAt }` or a `reason`; a watch-only viewer gets `watch-only` and no code. `previews.link.open` answers `native` (the URL to frame) for a link with input once the native preview is on, and the browser view otherwise; `previews.link.state` is the viewer page's check of its link while core keeps the native view. `previews.list` gains `native` (`not-set`, `unchecked`, `failing`, `passed`) and each preview's `framing`. `instance.previewDomainCheck` now keeps its result per install with who ran it, and audits the run (`instance.preview_domain_checked`, with `passed` and no result text); `instance.previews` is the settings page's data (the domain, the record to add, `CNAME` or `A`/`AAAA` for an IP, the shared site for the warning, the cookie's `SameSite` by the layout, a real preview's host as the example, the last check, the organization's switch and whether the viewer is its admin, the docs' link).
  - **The schema** (`20261201190000_preview_domain_check_and_framing`, additive): `InstanceSetting.previewCheckDomain`, `previewCheck`, `previewCheckAt`, `previewCheckByUserId`; `PreviewView.framingHeader`, `framingValue`. A kept result for another domain counts as none.
  - **Core's framing report** (ticket 25 left it): `rewriteResponse` now names the header it replaced and its value (`framing`), and the native proxy records it once per view (`recordPreviewFraming`), never in a log line.
  - **The web:** `PreviewFrame` is a union on `mode`, `stream` (the canvas) or `native` (the `<iframe>` with `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"`, its `src` set once, so Expand and a new code never reload it; `bg-white`, the browser's own canvas, for an app that sets none). The pane (`preview-pane.tsx`) opens "in your browser" by default once the domain's check passed and the runner can tunnel; `&mode=native|stream` in the address, then the member's choice per preview (this browser's `localStorage`). It signs in (10 s, then the failure block with `Try again` and `Use the box's browser`), shows the framing notice until dismissed per preview, sends no heartbeat, keeps screenshots on the box's browser, loads the path field and reload on the preview's own host, and "Open in a new tab" opens the tab at the click and sends it on after its own code. The stream's footer offers `Open it in your browser`, says why not on the HTTP carrier, or sends an instance admin to `Previews in settings` while the check isn't passing. The viewer page (`/p/<token>`) frames the native preview for a link with input. Instance › Previews (`/instance/previews`, `components/instance/previews-view.tsx`, `preview-domain-check.tsx`, `public-links-setting.tsx`) is built set and unset, and runs the check once on the first visit after the domain changes. The shell's Instance group gains `Previews` (`app-window`).
  - **Tests:** `packages/api/src/routers/previews-native.test.ts` (`F-144/c1`, `c2`, `c3`, `c8`, `c9`, `F-142/c1`, `c4`), `instance.test.ts` (the new procedure refused to everyone but the instance admin), `packages/domain/src/milestone-8-previews.test.ts` (`F-144/c4`: the header named), `apps/web/src/components/previews/native-preview.test.tsx` (12: the frame's sandbox, the default view, the states, the footer's offer, the notice, the viewer page, the settings page set and unset with a missing record), and the browser specs `apps/web/e2e/25-native-preview.spec.ts` (5, on `preview.localhost`, against core's real native proxy and the `test-web` fixture, the box's side being the runner's own tunnel code in `apps/runner/src/testing/native-box-child.ts`: the check passing on the first visit, the frame with the app's count surviving Expand, a new tab's own code, the framing notice on a page that sent `X-Frame-Options: DENY`, and the switch between the views) and `25-preview-domain-missing.spec.ts` (on the second stack, whose domain is under `.invalid`: the record and certificate to add, and the check's missing record). The e2e stack sets `OSTRA_PREVIEW_DOMAIN=preview.localhost` (`OSTRA_E2E_PREVIEW_DOMAIN` names another, `none` leaves it unset). `e2e/a11y` walks `/instance/previews` in both themes at 1440 and 390.
  - **Differs from the targets:**
    - **No Organization › Settings page exists** in the panel, so the shared `PublicLinksSetting` is on Instance › Previews alone. An organization admin who isn't the instance admin can't reach the switch in the panel until that page exists (`organization.setPublicPreviewLinks` stands); its words for a non-admin say whose choice it is instead of naming that page. Raised for the lead.
    - **The pane's view is `&mode=native|stream`**, not `&view=`: ticket 21 uses `&view=full` for Expand.
    - **"The browser keeps no cookie in a frame"** isn't detected: the panel can't read a cross-origin frame, and core's refusal page loads as a page. A refused code shows as core's small page in the frame; only a refusal of `previews.enter` itself, or a frame that doesn't load in 10 s, shows the failure block.
    - **⌘. can't be caught inside the cross-origin frame**; Tab and Shift+Tab leave it. The `?` sheet doesn't say so yet.
    - **The unset page** is checked by the component test only: the e2e stacks are one with `preview.localhost` and one with the missing record. The example host is the pattern `<port>-<preview>.<domain>` until the organization has opened a native preview.
    - **Firefox:** the e2e config has no Firefox project (Chromium projects only), so its case with `cookieBehavior` 5 isn't written. **Safari** waits for ticket 34 on a Mac.
