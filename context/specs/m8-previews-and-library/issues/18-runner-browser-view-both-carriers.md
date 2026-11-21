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
