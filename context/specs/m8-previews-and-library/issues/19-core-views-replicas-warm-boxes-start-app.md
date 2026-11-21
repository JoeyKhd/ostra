# 19: Core: views, replicas, warm boxes and starting the app

Status: ready-for-agent
Builder: core
Blocked by: 05, 07
Features: F-141, F-142
Packages: `apps/core` (`gateway/`, `previews/` new, `dispatch/`, `boxes/`), `packages/domain` (bodies), `deploy/helm/` (the server chart's `OSTRA_CORE_REPLICA_URL`)
Spec: `../spec.md`, sections 4 and 5.4; ADR 0068 ("The preview connection", "Warm while watched, and starting the app")

## What to build

- **The preview connection's endpoint,** `GET /runner/v1/preview?view=…`:
  - it authenticates the task token or the runner's token with the lease epoch, and refuses a stale one, as for events;
  - it writes the view's presence (`PreviewView.replicaUrl`, from `OSTRA_CORE_REPLICA_URL`);
  - it relays `stream` frames to the viewers' streams;
  - it takes `POST /runner/v1/preview/frames` on the HTTP carrier.
- **Views:**
  - `openView` checks `previewAccess` (ticket 05), writes the `PreviewView` with its audit entry, and sends `preview.open` to the box's runner;
  - `closeView` and `preview.views-sweep` close views with no heartbeat for 2 minutes;
  - core drops input from a viewer whose access doesn't allow it, before it reaches the runner.
- **The panel's endpoints on core,** with ticket 05's panel token:
  - `GET /panel/v1/previews/:viewId/stream`, a streamed response of length-prefixed frames;
  - `POST /panel/v1/previews/:viewId/input`, which batches input into `control` messages.
- **Replicas.** A replica that gets a view it doesn't hold forwards the stream and the input to the replica in the view's presence, with ticket 05's signature, and refuses a forwarded request it can't verify. A one-replica install never forwards. Helm's server chart sets `OSTRA_CORE_REPLICA_URL` from the pod's IP (the downward API).
- **Warm while watched.** `previews.heartbeat` updates `Box.previewWatchedAt`. The idle sweep (ADR 0039) skips a box for which `warmHold` says `hold`. The app's own sockets are never a heartbeat.
- **"Start the app."** `startApp`:
  - admits a lease with the purpose `app` on the task (ADR 0059's admission and the project's caps), with no budget gate, since it makes no model call;
  - dispatches with `purpose: "app"`, and writes the audit entry `app.started`;
  - a member's message on the task while that lease holds starts a turn on it, through the budget gate as any turn.
- **A minor-6 runner,** or a box with no browser, gives `openView` a refusal with the reason (`isPreviewable`).

## Done when

- [ ] Tests named for `F-141`:
  - a view opened, streamed and closed;
  - a stale epoch refused;
  - with two core processes on one database, a view whose box connection is on the other replica streams, and a forwarded request with a wrong signature is refused (break-it: skip the signature check, and the case fails);
  - the warm hold to its cap and the idle after it, by the `Clock`;
  - "Start the app" admitting an `app` lease, dispatching no agent, and a message then starting a turn on it;
  - a minor-6 runner's refusal.
- [ ] Tests named for `F-142`: input from a watch-only link dropped before the runner.
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✨ add preview views and warm boxes to core`.

## Comments
