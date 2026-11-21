# 21: Web: the preview pane, sharing and the viewer page

Status: done
Builder: web
Blocked by: 09, 20
Features: F-141, F-142
Packages: `apps/web`, `packages/task-view`
Spec: `../spec.md`, section 13 (targets 1, 2, 3, 6 and 7)

## What to build

To the approved targets `task-preview-pane`, `task-preview-expanded`, `task-preview-stopped`, `preview-share` and `preview-viewer`:
- **The pane** beside the thread:
  - the previews, primary first, with their labels and sources;
  - the path field, reload, the width preset, "Take a screenshot" and "Share";
  - the watchers' count, and the view's line;
  - "Keep it" on an announced preview.
- **The frames:** the pane reads `/api/previews/:viewId/stream` with `fetch`'s body reader, and draws each JPEG frame into a canvas from a `blob:` URL, revoked after use.
- **Input:** the member's mouse, wheel, keys and pasted text, batched, through `/api/previews/:viewId/input`. While the pane has focus, its keys go to the app and not to the panel's shortcuts, and Escape leaves the pane, so milestone 7's keyboard rules hold.
- **The heartbeat** every 30 s while the pane is open and the tab visible.
- **"Expand"** widens the same element to the page's width without a reload, and hides the thread behind a floating steer bar (`task-preview-expanded`). *Changed 2026-11-21: the maintainer approved the steer bar over the thread folded to a strip.*
- **The stopped pane:** the last screenshot, "Start the app" with its progress (the setup, the processes, ready), and the states for a runner below minor 7 and on the HTTP carrier.
- **The share dialog:** the levels, the named-people picker, a link's expiry and "Allow input", public greyed with why, the existing links with their first use and "Revoke".
- **The viewer page** at `/p/<token>`, for a signed-out person: the stream alone, the label, the organization's name, "watch only" or input, the expiry, and the expired and revoked states. It loads none of the panel's shell, and its route reaches no tRPC procedure but the link's own.
- **Words** through `t`, and the CSP unchanged (frames are `blob:` images).

## Done when

- [x] The targets' approval is recorded in ticket 09's `## Comments` before the UI is built.
- [x] Tests named for `F-141` (this ticket's own browser spec file only):
  - the pane streams the fixture app;
  - a click counts the counter;
  - "Expand" keeps the same element (no reload: the counter's count survives);
  - the box stays warm while the pane is open, with the clock moved;
  - "Start the app" brings the pane live.
- [x] Tests named for `F-142`:
  - a signed-out viewer sees the stream from a watch-only link and their clicks change nothing;
  - a link with input lets them click;
  - a revoked link shows its state;
  - the viewer page shows nothing else of the task.
- [x] Milestone 7's keyboard walk and contrast check pass on the pane, the dialog and the viewer page, in both themes, and the pane works at 390 px.
- [x] Checks for `apps/web` and `packages/task-view` pass (spec section 10).
- [x] Committed as `✨ add the preview pane and sharing`.

## Comments

- 2026-11-21, api (ticket 20): the data is in. `previews.list` gives the pane its previews, primary first, each with `sharing` (`level`, `memberIds`, `links` with state, expiry, maker, first and last use, `opens`) and `watchers`, plus `box`, `can`, `carrier`, `lastScreenshot`, `publicLinks` and `linkMaxDays`. `previews.open` answers `{ ok, viewId, input, label, port }` or `{ ok: false, reason }`; heartbeat it with `previews.heartbeat` (`opening`, `open`, `closed`) and close it with `previews.close`. The frames are `GET /api/previews/<viewId>/stream` (records for `createPanelStreamReader`), the input `POST /api/previews/<viewId>/input` with `{ events }` as `application/json`; refusals are `{ error: { code } }` (`previewRouteErrorCodeSchema` in `@ostra/api`). The viewer page's server side is `loadPreviewViewer(token)` in `app/p/[token]/viewer-data.ts`: a union on `state` (`live` with its `viewId`, `not-running`, `runner-too-old`, `expired`, `revoked`, `not-allowed`, `unknown`, `too-many-tries`). The page sends the token in `x-ostra-preview-link` (`PREVIEW_LINK_HEADER`) to the two routes, and calls only `previews.link.heartbeat` and `.close` (and `.open` again to pick a stopped app up). `setLevel` to members or named people ends the preview's links; `createLink` answers the URL once.
- 2026-11-21, runner (ticket 18): the box streams now. Every runner reports `{ stream: true, tunnel: true }` (on HTTP `tunnel: false`), so `previews.open` gives a browser view and "Take a screenshot" reaches the box. The box applies all four of core's controls to the shared page: `viewport` (the width preset, the last one chosen across every view of it; up to a tablet's width it's a touch device), `navigate` (a path on the preview's origin), `reload` and `input`, each acked once applied. Only input has a way there today (`POST /api/previews/<viewId>/input`, core's `hub.sendInput`): the pane's width preset, path field and reload need a route on core that sends `{ kind: "viewport" | "navigate" | "reload" }` as a `control` on the view's connection (on the HTTP carrier the protocol has no command for them yet). A preview opened at a preset (`previews.open`'s `viewport`) already moves the page. A watcher who joins gets the newest frame at once, even on a still page.
- 2026-11-21, core (the pane's controls, ticket 18's gap): the width preset, the path field and reload can be sent now, through the input route the pane already posts to.
  - **How:** `POST /api/previews/<viewId>/input` as `application/json` with `{ control }` in place of `{ events }`: `{ control: { kind: "viewport", viewport: { width, height } } }`, `{ control: { kind: "navigate", path: "/settings?tab=2" } }` (a path from `/` on the preview's own origin) or `{ control: { kind: "reload" } }`, one control per request (`panelPreviewInputBodySchema`, `PreviewPageControl` in `@ostra/protocol`). Answered 204, or `{ error: { code } }` as input is.
  - **Who:** the same rules as input: a viewer who may only watch gets 403 `watch-only` for a control too, so a watch-only pane or viewer page should show the preset, path and reload as unavailable. Each moves the page every viewer shares (Q314): the width is the last one chosen.
  - **Both carriers:** core sends it on the view's connection, or down the HTTP carrier's long poll as `preview.input`; the pane doesn't need to know which. A preset's frames come at its size once the page moves (the next frame's `header.width`).
  - **The tablet:** send it as it is, 834×1112 (`viewportPresetSizes.tablet`), in `previews.open`'s `viewport` and in the control alike. *Updated 2026-11-21 (Q326, the lead's call; ADR 0068, "Decided by the lead"):* a browser view's page is capped by its pixels now, at most 1440×900's in all and 200 to 1920 a side (`previewViewportSchema`), so every preset fits, and the tablet's frames come at its own size. Was: send it as 834×900.
- 2026-11-21, core (a refused open, ticket 18's other gap): a view the box refuses closes at once now, and its stream says why.
  - **What the pane gets:** `GET /api/previews/<viewId>/stream` answers 200 with one record, `close` with `{ reason: "refused", refusal }`, whether it was asked before the box's answer came or after. `refusal` is one of `previewOpenRefusalSchema` (`@ostra/protocol`): `not-a-preview`, `too-many-pages` (the box's browser shows three previews at most: close another preview's pane), `session-ending`, `unknown-session`, `tunnel-needs-websocket`, `past-not-after`, or `other`. Word each through `t`; `too-many-pages` is the one a member can act on.
  - **Then:** the view is closed (`previews.heartbeat` answers `closed`, input 410 `view-closed`); opening the preview again makes a new view.
- 2026-11-21, core and runner (a view the box drops): a view the box took and then gave up before it connected closes at once now too, with the same record.
  - **What the pane gets:** the same `close` with `{ reason: "refused", refusal }` as a refused open, on a stream asked for before or after; on a stream already running (its page failed once its connection was open) the box's own `close` says it. Four reasons join the list to word through `t`: `not-servable` (the box's app didn't get ready: "Start the app" again), `no-browser` (the box has no browser: the pane's no-browser state, `app.browser` says why), `browser-failed` (the box's browser couldn't open the page: try again) and `connect-failed` (the box couldn't reach the server: try again).
  - **Then:** as a refused open: the view is closed, and opening the preview again makes a new view.
- 2026-11-21, web (ticket 21): built, to the approved targets (`task-preview.md`, `preview-viewer.md`).
  - **What's there:** the task page's `Preview | Properties` side pane (`?pane=preview&preview={key}&path=`, `&view=full` expanded): the switcher, reload, the path, the width preset, Share, a screenshot, a new tab and Expand; the frame (`components/previews/preview-frame.tsx`) reading `/api/previews/<viewId>/stream` and drawing each JPEG onto a canvas from a revoked `blob:` URL; input (mouse, wheel, keys, pasted text) and the controls (`viewport`, `navigate`, `reload`) through the input route; the heartbeat every 30 s while the tab is visible; Expand changing only the grid (the context panel held collapsed, never saved; a floating steer bar); the starting, asleep (`Wake to preview`), gone (`Start the app`), none, runner-too-old, refused (every `refusal` worded), crashed and dropped states; the share menu (members, named people, a link with its expiry and `Allow input`, public greyed with why, the links with their first use and `Revoke`); and `/p/<token>` on `loadPreviewViewer`, with only `previews.link.*` and the two routes. `p` and `f` join the registry and the `?` sheet.
  - **Tests:** `apps/web/e2e/24-preview.spec.ts` (the fixture `test-web` in a page of the spec's browser, on core's real preview connection, `e2e/preview-box.ts`), the keyed unit tests beside the components, the a11y routes gain the pane and `/p/[token]`, and `17-keys.spec.ts` checks `p` and `f`.
  - **Differs from the targets:** no detected ports and no `Open a port…` (Q313; no API yet); the starting block has no log tail (a process's log isn't in its events); the thread's `Preview` row with `Show` isn't drawn (the pane lists the agent's ports); the presets are the protocol's (Desktop 1440, Tablet 834, Phone 390); `Open in a new tab` opens the task's expanded pane; the too-old block has no docs link; the switcher, the path and the viewer's chips have `--control-line` edges and Tab leaves the frame (Escape or ⌘./Ctrl+. hand the focus back), for milestone 7's contrast and keyboard checks; a link's expiry and `Allow input` apply to the next link made (a link can't be edited), and its URL shows once; the named-people picker is a filtered checklist (the repo has no `Command`); below 1024 px the side toggle hides and the properties stack under the chat as before; a visitor with no theme cookie gets the browser's colour scheme on `/p/`.
  - **For ticket 26:** `PreviewFrame` takes `mode: "stream"`; add `"native"` (the `<iframe>`) behind the same props. The pane opens its view in `preview-pane.tsx` (`previews.open` with `mode` fixed by the API); the footer's line and the share menu are already per-mode.
