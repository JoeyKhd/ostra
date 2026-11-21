# 21: Web: the preview pane, sharing and the viewer page

Status: ready-for-agent
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

- [ ] The targets' approval is recorded in ticket 09's `## Comments` before the UI is built.
- [ ] Tests named for `F-141` (this ticket's own browser spec file only):
  - the pane streams the fixture app;
  - a click counts the counter;
  - "Expand" keeps the same element (no reload: the counter's count survives);
  - the box stays warm while the pane is open, with the clock moved;
  - "Start the app" brings the pane live.
- [ ] Tests named for `F-142`:
  - a signed-out viewer sees the stream from a watch-only link and their clicks change nothing;
  - a link with input lets them click;
  - a revoked link shows its state;
  - the viewer page shows nothing else of the task.
- [ ] Milestone 7's keyboard walk and contrast check pass on the pane, the dialog and the viewer page, in both themes, and the pane works at 390 px.
- [ ] Checks for `apps/web` and `packages/task-view` pass (spec section 10).
- [ ] Committed as `✨ add the preview pane and sharing`.

## Comments

- 2026-11-21, api (ticket 20): the data is in. `previews.list` gives the pane its previews, primary first, each with `sharing` (`level`, `memberIds`, `links` with state, expiry, maker, first and last use, `opens`) and `watchers`, plus `box`, `can`, `carrier`, `lastScreenshot`, `publicLinks` and `linkMaxDays`. `previews.open` answers `{ ok, viewId, input, label, port }` or `{ ok: false, reason }`; heartbeat it with `previews.heartbeat` (`opening`, `open`, `closed`) and close it with `previews.close`. The frames are `GET /api/previews/<viewId>/stream` (records for `createPanelStreamReader`), the input `POST /api/previews/<viewId>/input` with `{ events }` as `application/json`; refusals are `{ error: { code } }` (`previewRouteErrorCodeSchema` in `@ostra/api`). The viewer page's server side is `loadPreviewViewer(token)` in `app/p/[token]/viewer-data.ts`: a union on `state` (`live` with its `viewId`, `not-running`, `runner-too-old`, `expired`, `revoked`, `not-allowed`, `unknown`, `too-many-tries`). The page sends the token in `x-ostra-preview-link` (`PREVIEW_LINK_HEADER`) to the two routes, and calls only `previews.link.heartbeat` and `.close` (and `.open` again to pick a stopped app up). `setLevel` to members or named people ends the preview's links; `createLink` answers the URL once.
- 2026-11-21, runner (ticket 18): the box streams now. Every runner reports `{ stream: true, tunnel: true }` (on HTTP `tunnel: false`), so `previews.open` gives a browser view and "Take a screenshot" reaches the box. The box applies all four of core's controls to the shared page: `viewport` (the width preset, the last one chosen across every view of it; up to a tablet's width it's a touch device), `navigate` (a path on the preview's origin), `reload` and `input`, each acked once applied. Only input has a way there today (`POST /api/previews/<viewId>/input`, core's `hub.sendInput`): the pane's width preset, path field and reload need a route on core that sends `{ kind: "viewport" | "navigate" | "reload" }` as a `control` on the view's connection (on the HTTP carrier the protocol has no command for them yet). A preview opened at a preset (`previews.open`'s `viewport`) already moves the page. A watcher who joins gets the newest frame at once, even on a still page.
- 2026-11-21, core (the pane's controls, ticket 18's gap): the width preset, the path field and reload can be sent now, through the input route the pane already posts to.
  - **How:** `POST /api/previews/<viewId>/input` as `application/json` with `{ control }` in place of `{ events }`: `{ control: { kind: "viewport", viewport: { width, height } } }`, `{ control: { kind: "navigate", path: "/settings?tab=2" } }` (a path from `/` on the preview's own origin) or `{ control: { kind: "reload" } }`, one control per request (`panelPreviewInputBodySchema`, `PreviewPageControl` in `@ostra/protocol`). Answered 204, or `{ error: { code } }` as input is.
  - **Who:** the same rules as input: a viewer who may only watch gets 403 `watch-only` for a control too, so a watch-only pane or viewer page should show the preset, path and reload as unavailable. Each moves the page every viewer shares (Q314): the width is the last one chosen.
  - **Both carriers:** core sends it on the view's connection, or down the HTTP carrier's long poll as `preview.input`; the pane doesn't need to know which. A preset's frames come at its size once the page moves (the next frame's `header.width`).
  - **The tablet:** 834×1112 is taller than a browser view's page may be (at most 1440×900), so it's refused 400 as it is. Send the tablet as 834×900 (its width, the page's height cap), in `previews.open`'s `viewport` and in the control alike, until the maintainer decides otherwise (Q326; ADR 0068's note of 2026-11-21).
