# 18: Runner: the browser view on both carriers

Status: ready-for-agent
Builder: runner
Blocked by: 07, 13
Features: F-141
Packages: `apps/runner` (`sidecar/`, `task-host/`, `connection/`, `browser/`)
Spec: `../spec.md`, sections 4 ("Opening a view", "The browser view") and 5.1; ADR 0068 ("The browser view", "The preview connection")

## What to build

- **`preview.open` in `stream` mode:**
  - open `wss://<core>/runner/v1/preview?view=<viewId>`, with the box's task token (on `host`, the runner's access token) and the lease epoch;
  - one page per preview in the box's browser, shared by every view of it, loaded at the preview's path;
  - a screencast started when the first view of the preview opens and stopped when the last one closes, with spike 07's defaults (ADR 0068's 15 frames a second at 1440×900, quality 60, unless the spike set others);
  - each frame sent as a `frame` message;
  - acks from core given back to the screencast, so `maxFramesInFlight` holds the rate to what core takes.
- **Control from core:** `viewport` (the width preset, which applies to the shared page), `navigate`, `reload`, and `input` batches mapped to `Input.dispatchMouseEvent`, `dispatchKeyEvent` and `insertText`, in order. Input for a view whose access doesn't allow it never reaches the runner: core drops it (ticket 19). The runner checks that a batch names an open view.
- **`preview.close`** closes the view's connection, and the page when it was the last view.
- **The HTTP carrier:** a runner on it posts frames to `/runner/v1/preview/frames` at 2 a second at most, and takes `preview.input` from the long poll. `hello` says `tunnel: false`.
- **The reach rule:** a view's preview must be one of the task's previews (`mayReach`). A `preview.open` for anything else is refused with `preview.closed` and the reason.
- **What's never sent:** the page's content as text, its cookies, or anything but frames. Input text is never in a log line.

## Done when

- [ ] Tests named for `F-141`, on `host` live with the fixture app, and against the fake browser for the carriers:
  - a view streams frames and stops when it closes;
  - two views share one page;
  - a click counts the counter and typing lands;
  - the width preset applies;
  - a view for a port that isn't a preview is refused (break-it: skip the check, and the case fails);
  - frames on the HTTP carrier stay at 2 a second at most;
  - a stale epoch's connection is refused by core's fake.
- [ ] The executor suite's browser case on `docker` and `kubernetes` fakes covers the screencast's acks.
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✨ stream the box's browser to a preview`.

## Comments

- 2026-11-21, core (ticket 19): what core now expects of the runner side.
  - **The open view holds the idle timer** (ADR 0068, "How core holds them"): while a box has a view open (a `preview.open` with no `preview.close` yet), its idle timer doesn't end the session. Core's `preview.views-sweep` sends `preview.close` after 2 minutes with no heartbeat and at the warm cap; when the last view closes, the timer counts from the turn's end as before, so a box past it stops at once.
  - **Core's side of the connection** is `apps/core/src/previews/`: the upgrade wants the subprotocol `ostra-preview-stream.v1`, `?view=&leaseEpoch=`, and the task token (or the `host` runner's access token); a stale epoch gets 409 `stale-lease` with `currentEpoch`. Core acks a frame once every stream took it, and holds the ack while no stream is open (so `sendLastFrame` matters). Core sends `close { reason }` (`closed`, `stale-lease`, `box-stopping`) before it closes the socket, and `control { kind: "input" }` for input; the box's own `ack` of a control is read and ignored.
  - **The HTTP carrier:** `POST /runner/v1/preview/frames` as `multipart/form-data` (the `body` part, then `frame-<n>` parts), answered `{ ackedUpTo }`, or 429 `{ code: "too-fast" }` past 2 frames a second for a view, 409 `stale-lease`, 410 `view-closed`. `preview.input` comes down the long poll.
  - The runner reports `preview: { stream, tunnel }` in `hello` and `status`: core keeps it on `Runner.preview`, and gives no view to a runner that reported none.
- 2026-11-21, runner (ticket 22): the parts of ticket 19's note that a tunnel view needs too are built, for this ticket to build on.
  - **The view registry** is `apps/runner/src/task-host/preview-views.ts` (`createPreviewViews`), one per task run (`TaskRun.views()`), behind `TaskRun.previewOpen` and `previewClose` and the task host's `preview.open` and `preview.close` handlers. It takes `tunnel` views only; `preview.open` in `stream` mode answers `stream-not-supported` until this ticket adds its views beside them.
  - **The idle hold is done** for every view, whatever its mode: the task run's three idle timers go through `idleAfter`, which, coming due with a view open, fires once the last one closes (`views.onUnwatched`). A view counts from its `preview.open` until its `preview.close`, the box's stop, or its connection closing.
  - **The report:** every executor's runner reports `RUNNER_PREVIEW_SUPPORT` (`{ stream: false, tunnel: true }`) in `hello` and `status`, and the connection says `tunnel: false` on the HTTP carrier. This ticket turns `stream` on (from the box's browser, ticket 11's `app.browser`).
  - **The connection:** `link.openPreview` opens `tunnel` mode only; `openPreviewConnection` (`connection/preview-connection.ts`) takes any mode and hands the socket back paused, so a reader attached a few promise turns later loses nothing.
