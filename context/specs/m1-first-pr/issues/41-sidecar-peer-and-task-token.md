# 41: Core takes a box's sidecar as a peer, with a token for its one task

Status: done
Builder: core (lead), runner
Blocked by: none (22, 24 and 26 are in)
Features: F-017, F-015, F-089, F-090, F-045
Packages: `packages/protocol` (the task token's request and response, additive), `apps/core` (`src/gateway/`, `src/dispatch/`), `packages/db` (additive columns for a sidecar's presence and commands), `apps/runner` (`src/box-dispatcher.ts`, `src/run-sidecar.ts`), `docs/configuration.md`
Spec: `../spec.md`, sections 4 and 5.1; ADR 0034, "The task token"; ADR 0029; ADR 0030

## Why

A follow-up from the demo, settled as Q129 on 2026-11-19 (`context/open-questions.md`, Settled). Ticket 22 built the box's side: the sidecar connects to the server itself, as the `sidecar` peer. Two things were missing on the other side, so no box could work and F-017's live test can't pass:
- core's gateway refuses a `hello` whose peer isn't a runner
- the sidecar reads the runner's own access token from a file the runner rewrites every 4 minutes, so a compromised sidecar could speak for the whole runner, and a runner that stops takes its boxes' tokens with it

## What to build

- **The task token** (ADR 0034). `POST /runner/v1/tasks/:taskId/token` with the runner's access token and the lease epoch. Core answers only the runner that holds the task's current lease, and only for a box on `docker` or `kubernetes`. The token is an HMAC under core's signing key over the organization, the task, the lease epoch, the box and the runner, with a prefix of its own that the log guard redacts. It has no clock: it is valid while that lease is the task's current, active one. Its request and response schemas are in `packages/protocol`, strict, with a description that says the token is never logged.
- **Checking it.** Every use reads the lease: the epoch is the task's current one, the lease is active, and the box and the runner match. A token whose lease ended gets the stale-lease answer, a 409 on HTTP and the protocol's error on the socket.
- **The sidecar peer.** The gateway accepts `hello.peer.kind: "sidecar"` when the upgrade's token is that box's task token and its task, box and epoch match the `hello`. Presence and the connection epoch are per sidecar, so a second connection of the same box evicts the first with `4409`. The task's commands (`steer`, `interrupt`, `stop`, an approval's answer) go to its sidecar when the lease's box has one, and to the runner when it's a `host` worktree. From a sidecar, core takes events, live text and command results for its own task's sessions only. The grace (F-045) starts when the sidecar's connection goes, not the runner's: a pool runner that stops doesn't start it.
- **The task endpoints.** The spec and the credentials accept the task's own token. A lease whose box is on `docker` or `kubernetes` gets its credentials through that token only: the runner's token is refused there, and still gets everything for a `host` lease. The runner's token still reads a boxed task's spec, because it needs the base image to make the box. Milestone 2's blob endpoints follow the same rule when they exist (`../../m2-tickets-in/issues/12-core-blob-service-and-bulk-path.md`).
- **The runner.** `box-dispatcher` asks for the task token once, when it makes the box, and writes it to the box's token file with the modes it uses today. The refresher goes. The sidecar reads the file when it starts and when it reconnects.
- **`host` is unchanged:** the runner's process is the sidecar and uses its own token.
- **The docs:** `docs/configuration.md`'s paragraph on the sidecar says the token file holds the task's own token, written once.

## Done when

- [x] Against the fake peer: a sidecar connects with its task token, sends its task's events, receives a `stop` and fetches its credentials. The same token is refused for another task's spec, credentials and events, for another organization, and after its lease ended by a stop, by the grace and by a new dispatch.
- [x] A runner's token gets no credentials for a boxed lease, and still gets them for a `host` lease. A second connection of a box evicts the first.
- [x] The runner's connection is closed while a fake sidecar stays connected: the task carries on, no grace starts, and the token file is never rewritten.
- [x] A test proves the task token reaches no log line.
- [x] Proof (`AGENTS.md`, `context/proof/README.md`): each test that proves a condition of a row's "done when" names the row's ID in its title and has a break-it check, its rows are in `context/proof/`, and `pnpm check:proof` passes.
- [x] The whole-repo checks pass (spec section 9: credentials, the runner protocol).
- [x] Committed as `✨ add the task token and the sidecar peer`.

A real box still waits for the Linux machine, with F-017.

## Comments

**2026-11-19:** built.
- `packages/protocol`: `POST /runner/v1/tasks/:taskId/token` (`taskTokenRequestSchema`, `taskTokenResponseSchema`, `TASK_TOKEN_PREFIX`), strict; the log guard redacts `ostra-task-`.
- `apps/core/src/gateway/task-token.ts`: the token, an HMAC under core's key over the organization, task, epoch, box and runner, with no clock; `checkTaskLease` reads the lease at every use. The endpoint answers only the runner holding the current, active lease, and a `host` lease gets `400`.
- `apps/core/src/gateway/sidecars.ts`: the `sidecar` peer, on the same `/runner/v1/connect` upgrade, picked by the bearer's prefix. Presence and the connection epoch are columns on `box`, and a sidecar's commands are rows of the new `sidecar_command` table, numbered per box. The outbox routes a boxed task's `steer`, `interrupt`, `stop` and approval answers there. A stale lease gets `409` at the upgrade and on HTTP, and `error stale-lease` and a 4403 close on the socket.
- The grace: a runner's connection holds its `host` leases only; a box's task's grace starts and stops with its sidecar's connection.
- Task endpoints: the task token reads its own task's spec and credentials; the runner's token is refused a boxed lease's credentials and still reads its spec.
- `apps/runner`: `box-dispatcher` asks once (`fetchTaskToken`) and writes the file once; the refresher is gone.
- Migration `20261119235500_sidecar_peer`, additive.

Tests: `apps/core/src/gateway/sidecar.test.ts` (8) and `apps/runner/src/box-dispatcher.test.ts` (2 new). Each was broken on purpose and restored, as `context/proof/F-015.md` and `F-045.md` list. One break, removing the `ostra-task-` pattern alone, left the log test green, because the guard's long-run rule redacts the token's body too. Turning the guard off failed it. Whole-repo checks passed.
