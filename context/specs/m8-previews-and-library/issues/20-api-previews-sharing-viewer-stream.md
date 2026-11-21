# 20: API: previews, sharing and the viewer's stream

Status: done
Builder: api
Blocked by: 19
Features: F-141, F-142
Packages: `packages/api`, `apps/web/src/app/api/previews/` (route handlers, new), `apps/web/src/app/p/` (the viewer page's server side, new)
Spec: `../spec.md`, sections 4 ("Opening a view", "A share") and 5.4; ADR 0068 ("Who can open a preview")

## What to build

- **tRPC, `previews.*`:**
  - `list`, `open`, `close`, `heartbeat`, `startApp` and `takeScreenshot`, for a member who can open the task;
  - `setLevel` and `createLink` (expiring, or public only where `OrganizationSetting.publicPreviewLinks` allows it), with "allow input", an expiry within `OSTRA_PREVIEW_LINK_MAX_DAYS`, and the link's URL shown once;
  - `revokeLink`;
  - `organization.setPublicPreviewLinks`, for an organization admin, audited.
- **The route handlers** on the web app, since Next.js can't upgrade to a WebSocket (ADR 0035):
  - `GET /api/previews/:viewId/stream` relays core's stream as a streamed response;
  - `POST /api/previews/:viewId/input` relays a batch of input.

  Each checks the member's session, or the link's token, and asks core with a panel token for that one view.
- **Named people:** a named member who can't open the project gets `previews.open` for that preview only. Every other procedure on the task still refuses them, and the matrices prove it.
- **The viewer page's server side** (`/p/<token>`): it resolves the link by its token's hash, checks its expiry and revoke, opens a view for the link, and gives the page only the preview's label, the organization's name, the expiry and whether input is allowed. The first use writes `preview.link_first_used` once.
- **Fail closed:** every refusal comes with its reason as a code the panel words through `t`.
- **Access:** milestone 4's query and write matrices get rows for each procedure, with a named person and a link as viewers.

## Done when

- [x] Tests named for `F-142`:
  - each level for each kind of viewer;
  - a named person seeing the preview and refused everything else of the task (break-it: let `tasks.get` through for a named person, and the matrix fails);
  - an expired, a revoked and a forbidden public link each refused with their reason;
  - the link's token shown once and stored as its hash;
  - the first use audited once;
  - the viewer page's data holding nothing else of the task.
- [x] Tests named for `F-141`: the stream and input routes relay for a member and refuse without a session or link.
- [x] Checks for `packages/api` and `apps/web` pass, and the whole-repo checks, since this touches auth (spec section 10). *On the lead's rules of 2026-11-20: the touched packages' checks (domain, api, web) ran here; GitHub CI runs the rest.*
- [x] Committed as `✨ add preview and sharing procedures`.

## Comments

- 2026-11-21, core (ticket 19): the bodies to call are in `@ostra/domain` (`previews/views.ts`, `previews/start-app.ts`): `openView` (it takes `panelTokens`, `createPanelPreviewTokens(<the secrets key>)`, and the warm cap, and answers the view's panel token), `closeView` (it checks no caller: the router does), `heartbeatView`, `startApp` (`no-runner` and `runner-needs-upgrade` mean nothing was written). Core's routes are `panelPreviewPaths.stream(viewId)` and `.input(viewId)` on `OSTRA_CORE_INTERNAL_URL`, with `Authorization: Bearer <panel token>`. The stream is `application/octet-stream` records the pane reads with `createPanelStreamReader` (`@ostra/protocol`); relay it as it is. Input is `{ events }` (`panelPreviewInputBodySchema`), answered 204, or `{ error: { code } }` with `watch-only`, `forbidden`, `view-closed`, `not-connected`, `unauthorized`. A stream asked for before the box's connection arrives waits up to 10 s, then answers 409 `not-connected`.
- 2026-11-21, api: built as `✨ add preview and sharing procedures`. Tests: `packages/api/src/routers/previews.test.ts` (`F-142/c2` each level for each kind of viewer, `c3` a named person, `c4` expired, revoked and forbidden public links, `c5` the token once and its hash, `c6` the first use once, `c7` the viewer page's data; `F-141/c7` the routes for a member and for a link, against a fake core that checks the panel's token), and the isolation suites: `every-record.test.ts` (`previews.list`'s row and matrix row, readers for the seven preview models and `organization.get` for `OrganizationSetting`, and `F-142/c3`: a person named on a restricted task's preview opens it watch-only while every query procedure, called on that very task, gives them the "not listed" column, so letting `tasks.get` through fails it) and `every-write.test.ts` (`F-142/c3`: each preview write and four task writes by an organization admin, the project's member, a named person, an outsider, another organization's admin and a link's holder, with a guard for new `previews.*` writes). Readings and decisions:
  - **Where things live:** the use cases' bodies in `packages/domain/src/previews/sharing.ts` (`setPreviewLevel`, `createPreviewLink`, `revokePreviewLink`, `resolvePreviewLinkInTx`, `usePreviewLink`, `setPublicPreviewLinks`, `listPreviews`, `takeMemberScreenshot`), beside ticket 19's; their signatures grew additively (`ListPreviews` gains each preview's sharing and watchers, the organization's switch and the link cap; `UsePreviewLink` answers a `PreviewLinkResolution`; `SetPublicPreviewLinks` is new). The router is `packages/api/src/routers/previews.ts`; the routes' bodies `services/preview-relay.ts` (`servePreviewStream`, `servePreviewInput`), with thin files at `apps/web/src/app/api/previews/[view-id]/{stream,input}/route.ts`. The viewer page's server side is `apps/web/src/app/p/[token]/viewer-data.ts` (`loadPreviewViewer`), which ticket 21's `page.tsx` calls: no page is built, since the targets wait for approval.
  - **Procedures:** `previews.list` (a query), `open`, `heartbeat`, `close`, `startApp`, `takeScreenshot`, `setLevel`, `createLink`, `revokeLink`; `previews.link.open`, `.heartbeat`, `.close` (public, with the token); `organization.setPublicPreviewLinks` (admin, audited), and `organization.get` gains `publicPreviewLinks`. Refusals a person can act on are `{ ok: false, reason }` codes; a task, a preview, a view or a link the caller can't reach is NOT_FOUND, never FORBIDDEN, so a restricted task's existence doesn't leak. The panel's token for core never reaches the browser: each route request makes its own, for that view and viewer, a minute long.
  - **One level at a time** (`task-preview.md`'s radio group): `setLevel` to the members or named people revokes the preview's active links (audited) and closes every view of someone who no longer qualifies, in one transaction; `revokeLink` closes its views; turning public links off closes every public link's view. Recorded in ADR 0068 ("As built (ticket 20)") and `domain-model.md`.
  - **Who may share:** any member who can open the task, as ADR 0068 says. `task-preview.md`'s open point 4 recommends the driver and the project's admins instead; it waits for the targets' approval, and narrowing it is a small change in `sharing.ts`.
  - **The routes:** a member's session, or the viewer page's token in `x-ostra-preview-link` (not `Authorization`, which better-auth's bearer plugin reads as a session). The view must be the one that member or link opened, and the access is read again on each request (`checkViewInput`); a watch-only viewer's input is answered 403 `watch-only` before core. Input is JSON from the panel's own origin. Error bodies are `{ error: { code } }` from `previewRouteErrorCodeSchema`; core's codes are relayed, anything else is `core-unreachable`.
  - **Rate limits:** a token that opens nothing counts against its address (20 a minute, then the address waits out the minute, the right token too); the viewer page's opens count apart (30 a minute). Per replica, as the invitation preview's.
  - **The viewer page's states:** `live`, `not-running` (no box, or the preview gone from it; the page polls `link.open`), `runner-too-old`, `expired`, `revoked`, `not-allowed` (public links off), `unknown`, and the server side's own `too-many-tries`. Strict output schemas, so nothing else of the task can reach it. `next.config.ts` sends `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex` on `/p/`, and `next dev` doesn't log its URLs.
  - **The first use** is audited when a good link resolves on the viewer page, whether or not a box runs, once (`firstUsedAt` set by one `updateMany`); the actor is `system`, with the link's ID.
  - **"Start the app" from the panel** passes the dispatch the panel's `personalSlots` and effort levels, and `reopen` with an optional `ApiDeps.agentArchives` that `apps/web` doesn't set: the web bundle doesn't carry `@ostra/adapter-opencode`'s main module, so a turn later started on that box restores from the rebuild template, not the archive. Left open below.
  - **Left open:** a named person isn't notified (it needs a `NotificationKind`, so a migration); "Start the app"'s archive restore from the panel (a light export of OpenCode's `sessionArchive` capability, or core taking the start); the named person's own page (`preview-viewer.md`'s open point 2); the native preview's `open` (ticket 26: `previews.open` takes the browser view only).
  - **Checks**, on the lead's rules: typecheck, lint and tests of `packages/domain`, `packages/api` and `apps/web`.
