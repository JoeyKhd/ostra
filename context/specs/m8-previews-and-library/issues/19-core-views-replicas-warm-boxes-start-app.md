# 19: Core: views, replicas, warm boxes and starting the app

Status: done
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

- [x] Tests named for `F-141`:
  - a view opened, streamed and closed;
  - a stale epoch refused;
  - with two core processes on one database, a view whose box connection is on the other replica streams, and a forwarded request with a wrong signature is refused (break-it: skip the signature check, and the case fails);
  - the warm hold to its cap and the idle after it, by the `Clock`;
  - "Start the app" admitting an `app` lease, dispatching no agent, and a message then starting a turn on it;
  - a minor-6 runner's refusal.
- [x] Tests named for `F-142`: input from a watch-only link dropped before the runner.
- [x] The whole-repo checks pass (spec section 10).
- [x] Committed as `✨ add preview views and warm boxes to core`.

## Comments

- 2026-11-21, core: built as `✨ add preview views and warm boxes to core`. Tests: `apps/core/src/previews/previews.test.ts` (`F-141/c1`, `c2`, `c4`, `c5`, `c6`, `F-142/c1`, and the HTTP carrier's 2 frames a second) and `replicas.test.ts` (`F-141/c3`: two core processes from milestone 6's `spawnCore`, one database, each with its own `OSTRA_CORE_REPLICA_URL`; the wrong MAC, another key, a 60 s old signature and another path's are each refused, and the shared key's is served, so skipping the check fails the case). Readings and decisions:
  - **Where things live:** the rows' bodies in `packages/domain/src/previews/views.ts` (`openView`, `closeView`, `heartbeatView`, `checkViewInput`, the presence, the sweeps) and `start-app.ts`; the bytes in `apps/core/src/previews/` (`previews.ts`: the upgrade, the HTTP carrier's frames, the panel's routes and forwarding; `hub.ts`: one replica's views; `sweeps.ts`; `replica-url.ts`; a small `multipart.ts`, since undici's `formData()` is marked not for untrusted bodies and no dependency was wanted). Ticket 20 calls the domain bodies; ticket 23 takes the tunnel at the upgrade, which refuses a non-`stream` view until then.
  - **The warm hold, where the idle timer is:** the code's idle timer is the runner's (`limits.idleMinutes`), with no command to move it, so the open view is the hold: the runner keeps a box while it has a view open (noted on ticket 18), and core's `preview.views-sweep` closes views by `warmHold` (no heartbeat for 2 minutes, or the box past the cap, the new close reason `warm-cap`), each with `preview.close`. A new view of a box past the cap is refused (`no-box`). A box in a turn is never past it; an `app` box counts from its lease's start. Recorded in ADR 0068 ("How core holds them") and `domain-model.md`.
  - **A runner's report:** `hello` and `status` carry `preview` at minor 7, and nothing kept it, so a small additive migration (`20261201150000_runner_preview_report`) adds `Runner.preview`, written by `recordRunnerReport`; `isPreviewable` reads it with the presence's minor and carrier, and a box's `app.browser { available: false }` takes the browser view away. Ticket 04's schema test said its migration was the last one; it now says it follows minor 7's.
  - **"Start the app"** calls `dispatchTask` with `app`: no budget gate, no provider hold or cap, minor 7 only, the lease's purpose `app`, `purpose: "app"` in the dispatch, the task's own state untouched. It admits at once or writes nothing (`no-runner`, `runner-needs-upgrade`), since the signature has no queued answer. A declined or timed-out `app` offer ends the lease with no requeue (`endAppLeaseInTx`); accepting it doesn't move the task. Pressed while the box runs, it sends `app.start`. A kept `stopped` box the dispatch resumes counts as the task's live box while its lease is active.
  - **A message on an `app` lease** (`sendMemberMessageInTx`) is a turn on that lease and session: the budget gate, the purpose to `turn` (`transitionLeasePurpose`), a `steer`, and the task moved as a reopen would (queued, then preparing once the runner took the box, running at the turn's start), with the driver, the needs-you items and `task.reopened`. A merged task reopens as before.
  - **The view's "audit entry"** is the task's `preview.opened` event: the audit list has no view action, and ADR 0068 audits levels, links and first uses only.
  - **Routing:** the six minor-7 box commands go to a `docker` or `kubernetes` box's sidecar (`postgres-outbox.ts`'s `sidecarKinds`), as the runner's own handlers already said. Input goes as a `control` on the box's socket; on the HTTP carrier as `preview.input` through the outbox.
  - **Replicas:** presence is `PreviewView.replicaUrl`, written by the replica that takes the box's connection (the HTTP carrier's first frames), cleared when it goes. A forwarded request is taken on its signature alone; a signed one is never forwarded again. Helm's core container gets `POD_IP` from the downward API and `OSTRA_CORE_REPLICA_URL=http://$(POD_IP):<port>` (an `OSTRA_`-named helper would be refused as an unknown setting), and the kept renders in `m5-the-fleet/demo/helm/` show it. `helm` isn't on this machine, so only the schema check ran; an IPv6-only cluster would need brackets.
  - **Left open:** the runner's half (ticket 18); `listPreviews` for the pane (ticket 20's router can build it from `previewBoxInTx`, `boxPreviewability` and `taskPreviewTargetsInTx`); a held turn released on an `app` lease leaves the lease's purpose to the release; an `app` start jumps a pool's queue order, since it's admitted at once.
  - **Checks**, on the lead's rules of 2026-11-20: typecheck and lint of protocol, db, domain, core and api (and their builds); tests of protocol, db, domain and core. Break-it passes are dropped (the maintainer, 2026-11-21).
