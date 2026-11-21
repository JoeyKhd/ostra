# Milestone 5: The fleet

**Status:** spec, 2026-11-19. Tickets in `issues/`, one file each (`docs/agents/issue-tracker.md`).
**Milestone:** 5 (`context/build-order.md`).
**Features:** F-091, F-092, F-014, F-015, F-093, F-120, F-095, F-067, F-069, F-061, F-039, F-116, F-118, F-117, and F-013 grown (the HTTP fallback). Its demo signs in as milestone 1's default first admin, and the second member is milestone 4's invited Sam.
**Decisions it builds on:** ADR 0016 (any number of `web` and `core` replicas), 0022 (versions), 0025 (everything is an adapter), 0029 (pools, executors, boxes, the allowed differences, drain and revoke), 0030 (no credential in the agent's container), 0031 (the safety minimum, the egress baseline), 0034 (the runner protocol, the HTTP carrier, the task token, versions), 0035 (the event rates the load test replays), 0037 (background work; a share is counted from ostra's rows, never from a queue's limit), 0038 (environments, snapshots, the registry), 0039 (idle boxes; a pod is deleted when its box stops), 0046 (one CLI, three images), 0053 (proving isolation for every kind of record; several organizations and a new organization's pool come after v1 since 2026-11-19, F-134). **New for this spec:** ADR 0059 (capacity, the queue and choosing a runner), 0060 (the `kubernetes` executor, the snapshot registry and the Helm charts), 0061 (proofs on machines this one isn't, and the load test), and amendments to 0029 (a `host` pool's OS user, what a runner reports, the server's address under the egress baseline), 0034 (minor 4, and how a runner is pinned) and 0046 (how the images are built before they're published).
**Spikes it ports from:** 6 (`runner-transport`: the HTTP carrier, the fallback triggers, the network proxies, the load generator and its harness) and 3 (`what-is-inside-a-box`: the pod, the NetworkPolicy, the rootless BuildKit pod, the egress checks and their controls), section 10. Product code never imports `spikes/`. A builder copies the code into the product's package and adapts it, with a one-line provenance comment (`// Ported from spikes/<spike>/<path>.`).
**Builds on milestones 1 to 4** as they were built (`../m1-first-pr/spec.md`, `../m1-first-pr/demo.md`, `../m2-tickets-in/spec.md`, `../m3-step-in/spec.md`, `../m4-the-organization/spec.md`), not only as they were specified. Milestones 2 and 3 are being built and milestone 4 is specced while this spec is written. Where their code ends up different from their specs, this spec follows the code, and the ticket that meets the difference says so in its `## Comments`.

Terms follow `context/GLOSSARY.md`. Lifecycles follow `context/domain-model.md`.

---

## 1. What milestone 5 ends with

Pools on Docker hosts and on a Kubernetes cluster, plus laptops. Any number of runners join with a token. The load test holds 1,000 tasks (`build-order.md`).

In more words: an organization admin makes named pools, each with join tokens that are shown once and expire, and can require that every new runner be approved. A runner joins with `ostra runner` from the npm CLI, with one `docker run` of the runner image, or with the runner's Helm chart on a cluster, and is pinned to its server's version when it starts. The Runners page is the fleet: every pool with its busy boxes, its queue, its runners' versions and labels, and every runner with its state and executor; admins approve, drain, resume and revoke from it. Each task goes to a pool its project may use, by the labels its profile asks for and by free capacity counted in slots and box sizes, and waits in that pool's queue, in ticket priority order, when there's no room; no project takes more than its share. Members' laptops run their own tasks beside the pools. The `kubernetes` executor runs a box as a pod, pulls the project's snapshot from the organization's registry, and says "waiting for a node" while the cluster grows. Boxes on `docker` and `kubernetes` can't reach private ranges, the metadata address or another box. One Helm chart installs the server, a second a `kubernetes` pool runner. A runner behind a proxy that blocks WebSockets falls back to HTTP by itself. The load test runs simulated runners against three core replicas and one Postgres.

### What milestones 1 to 4 leave that milestone 5 starts from

Read from the code on `main` on 2026-11-19, and from milestones 2 to 4's specs for what they add, so builders don't rebuild what exists:

- **Pools, join tokens and runners are in the schema and mostly wired.** `RunnerPool` (`isDefault`, `requiresApproval`, `maxBoxes`), `JoinToken` (hashed, `bootstrap`, `expiresAt`, `revokedAt`, `lastUsedAt`), `Runner` (`kind`, `executor`, `capacity` as one number, `labels`, `version`, `os`, `state`, `approvedAt`), `RunnerPresence` (`carrier`, `minor`) and `ProjectPool` (`maxBoxes`). Core accepts any unexpired, unrevoked token of a pool and keeps a joined runner `joining` while its pool requires approval (milestone 1's ticket 42, Q130). Every organization has a default pool (milestone 4 seeds one in each new organization). `revokeRunner` exists with its tests (milestone 2's ticket 41). The runner lifecycle has `drain` and `resume`, but no procedure drains, nothing resumes, and the protocol has no `resume` command.
- **The Runners page exists** after `context/brand/app-targets/m1/runners.md`: pools, runners, "Your machine", the connect command and a join token shown once. It has no row actions, no queue, no labels and no pool page.
- **Two executors exist.** `host` contains a task's processes with a Windows job object through `koffi` or the marker sweep (milestone 2's ticket 42), and declares no services, no box sizes and `host-cache` snapshots. `docker` is written in full against a fake engine (`packages/adapters/adapter-executor-docker/src/testing/fake-engine.ts`), owns its subnets, builds its egress rules in `egress.ts` with `deploy/egress-baseline.sh` beside them, and has never run on Docker. Milestone 3 adds checks, snapshots without a registry and services to both. There is no `kubernetes` executor.
- **Dispatch is first fit.** A task goes to the first online runner of the project's pools with a free slot, or to the personal runner its member picked (`Task.runnerId`). There is no order among waiting tasks, no share per project, no label match and no size. Why a task waits is stored as a typed reason (`Task.dispatchWait`, milestone 2's ticket 43), and a task with services is offered only to an executor that declares them (milestone 3).
- **The protocol is at minor 1 in the code,** and milestones 2, 3 and 4 take it to minor 3. Only the WebSocket carrier exists. `version.ts` holds the window of one minor either way, `/runner/v1/info` answers the server's version, and a refused runner logs the fix and retries every 5 minutes. Spike 6 has the HTTP carrier, its fallback triggers, its proxies and a load generator, all throwaway.
- **Snapshots are built on `docker` without a registry** (milestone 3, ADR 0038 amended): the runner that builds one keeps it, scanned before use, and `host` gets a mirror and a dependency cache.
- **The three images and the compose file are written and never built** (milestone 1's ticket 22): `deploy/Dockerfile.server`, `Dockerfile.runner`, `Dockerfile.base` and `compose.yaml`, checked without Docker by `deploy.test.ts`. The base image's OpenCode pin uses `pinnedChecksums` from `@ostra/adapter-opencode`.
- **The task token and the sidecar's peer exist** (milestone 1's ticket 41): core mints a token per lease at `POST /runner/v1/tasks/:taskId/token` and accepts a sidecar's connection with it (`apps/core/src/gateway/sidecars.ts`). Only the fake engine has used it.
- **Notifications, needs-you items with audiences and the audit log's viewer exist** (milestones 3 and 4). Nothing notifies admins about runners. *Changed 2026-11-19: this also said several organizations exist after milestone 4. They moved after v1 (F-134): an install runs one organization, and milestone 4's isolation test makes a second one from fixtures.*

### What is in, and what is not

**In:** pools with their settings; join tokens with lifetimes, revocation and rotation; approval of new runners, with an audit entry and a notice to admins for every join; the fleet view with drain, resume and revoke; personal runners in full (containment on every system, two at once by default, the provider switch); pool runners with boxes whose sidecars connect on their own; a `host` pool with the agent as a separate OS user; the `kubernetes` executor with its pod, services, snapshots built by BuildKit, the egress policy and "waiting for a node"; the organization's registry for snapshots; box sizes, project defaults, pool caps and project shares; capacity and the queue per pool in priority order, with cancel; labels on runners and profiles; choosing a runner; version checks, the pin and the compatibility matrix; the three images built from source; the egress baseline on `docker` and `kubernetes` with its checks; the two Helm charts; the HTTP fallback; the load test and its harness.

**Not in** (and when it comes):
- publishing the images and the CLI: milestone 7 (ADR 0045, ADR 0046). F-039 stays `building`
- the load test as the launch gate: milestone 7. F-117 stays `building` until the full-scale run on Linux
- signed runner binaries: F-085, after v1
- egress allowlists per environment: F-052, after v1
- pools shared between organizations (ADR 0029)
- intake rules, schedules and Linear's agent mode, whose tasks go to pools: F-011, F-106, F-012, milestone 6. The rule that sends them to pools is built and tested here with the task sources that exist
- a box size picked per task: not in v1. A project's default applies, and a profile can't change it
- ECR pushes, which need AWS's SDK: section 11, item 11, and ticket 38
- gVisor as the box's runtime: the docs recommend it and the executors pass it through (`OSTRA_DOCKER_RUNTIME`, `OSTRA_K8S_RUNTIME_CLASS`), and spike 3's gVisor bar stays with spike 3

### On this machine

This is a Windows 11 machine (an i9-13900K with 32 threads and 32 GB) with no Docker, no Kubernetes and no Linux. Three things follow, and section 9.1 says which proof waits on which:

- **The demo runs pool runners on `host`, on a personal runner, and on a fake cluster.** A `host` pool runs the agent as a separate OS user, which v1 supports on Linux and macOS only (section 11, item 13). On this machine the demo's `host` pool runners set `OSTRA_DEV_HOST_POOL_SAME_USER=true`, a development-only switch that core refuses outside development and test, and the panel labels them "not isolated, same user (development only)". The `kubernetes` executor runs against ticket 06's fake Kubernetes API, whose process mode runs each container of a pod as a local process, so a task goes through the real executor, the real sidecar and the task token, without isolation and without limits.
- **Everything that needs Linux, Docker, a cluster or a Mac runs in ticket 35's jobs**, by hand, on GitHub's hosted runners: `ubuntu-24.04` for Docker, gVisor, kind, Calico, a local registry, BuildKit, Helm and real nginx, and `macos-15` for the `host` executor's macOS case. Their logs are kept in the repo as live evidence. Until a job has passed, the rows it proves stay `building` (section 2).
- **Two things need more than a hosted runner:** a cluster whose autoscaler really adds a node (F-093's "waiting for a node"), and the full-scale load test at 1,000 tasks on three core replicas (F-117). Both are the maintainer's, in ticket 38, on a Linux machine and a cluster of their choosing. This machine runs the load test as far as it holds (ticket 34).

---

## 2. The features, and where each one lives

"At M5's end" is the ledger status the demo ticket (37) sets, if and only if every condition in the row's "done when" holds. "If ticket 35's job passes" means the row is `done` when that job's run is kept in the repo with every condition it covers proved; otherwise it stays `building`, with what's proved so far.

| F-ID | What milestone 5 builds | Packages | Tickets | At M5's end |
|---|---|---|---|---|
| F-091 Runner pools and join tokens | Named pools with their settings; a project's ordered pool list; join tokens with a lifetime (30 days, another or none), shown once, hashed, revoked; rotation that disconnects nobody; approval of each new runner, enforced wherever a token is accepted; every join an audit entry and a notice to admins | `packages/db`, `packages/domain`, `apps/core`, `packages/api`, `apps/web` | 03, 04, 05, 12, 19, 25, 30, 31 | done |
| F-092 Fleet view | The Runners page and a page per pool and per runner: busy boxes, the queue, versions, labels, state and executor, carrier and containment; "not isolated" on `host` pools and "the agent has direct internet access" on `kubernetes` pools; Approve, Reject, Drain, Resume and Revoke, with the `resume` command | `packages/protocol`, `apps/core`, `apps/runner`, `packages/api`, `apps/web` | 01, 15, 26, 30, 31 | done |
| F-013 Runner (grown) | The HTTP carrier on the server and the fallback in the runner (non-101, three quick deaths, no `welcome` in 10 s), WebSocket again every 10 minutes, `--transport`; the runner from the packed npm CLI and from the runner image | `packages/protocol`, `apps/core`, `apps/runner` | 01, 11, 18, 19, 22 | done (the "or" of its first sentence is met by the npm CLI here; the image is ticket 35's) |
| F-014 Personal runner | What its first slice left: two tasks at once by default, the containment line on every system, the macOS marker sweep and the Linux cgroup run for real | `adapter-executor-host`, `apps/runner`, `apps/core`, `packages/api`, `apps/web` | 10, 13, 19, 27, 31, 35 | done if ticket 35's Linux and macOS jobs pass |
| F-015 Pool runners | Pool runners on `docker` and `kubernetes` that only create and remove boxes, each box's sidecar on its task token; credentials never saved on the host; a `host` pool with the agent as a separate OS user, labelled "not isolated" | `adapter-executor-docker`, `adapter-executor-kubernetes` (new), `adapter-executor-host`, `apps/runner`, `apps/core` | 07, 09, 10, 19, 20, 35 | done if ticket 35's Linux job passes |
| F-093 `kubernetes` executor | A box as one pod (the agent, the sidecar and the services as native sidecars); its own namespace and a scoped service account; the snapshot from the registry; "waiting for a node" with the dispatch accepted at once; Kubernetes 1.29 or later, checked | `adapter-executor-kubernetes`, `apps/runner`, `apps/core`, `deploy/helm` | 02, 06, 07, 08, 20, 23, 35 | building: every condition is proved on the fake API and on kind (ticket 35) except the autoscaler's, which needs a real autoscaled cluster (ticket 38) |
| F-120 Snapshot registry | The organization's registry with push and pull credentials, checked from the panel; `docker` hosts push and pull, and keep milestone 3's local build without one; a `kubernetes` pool refuses to start a box without one, and its snapshots are built by a rootless BuildKit pod | `packages/protocol`, `adapter-sdk`, `adapter-executor-docker`, `adapter-executor-kubernetes`, `apps/core`, `apps/runner`, `packages/api`, `apps/web` | 01, 02, 04, 08, 09, 17, 21, 28, 33, 35 | done if ticket 35's Linux job passes |
| F-095 Box sizes | Three named sizes per organization; a project's default; a pool's cap in total and per project; `docker` and `kubernetes` enforce a size as a limit; `host` counts slots | `packages/protocol`, `adapter-sdk`, the three executors, `packages/domain`, `apps/core`, `packages/api`, `apps/web` | 01, 02, 04, 05, 07, 09, 10, 13, 27, 32, 35 | done if ticket 35's Linux job passes |
| F-067 Capacity and queue | A pool's capacity from its runners' free slots and resources; a personal runner's two at once; one queue per pool in ticket priority order, which admins see and cancel from; the share counted in the admitting transaction | `packages/domain`, `apps/core`, `packages/api`, `apps/web` | 04, 05, 13, 26, 30 | done |
| F-069 Choosing a runner | The project's pools in order, the profile's labels, free capacity; a member's own personal runner; tasks no member started go to pools; services never to `host` (milestone 3's rule, kept) | `packages/domain`, `apps/core`, `packages/api`, `apps/web` | 05, 14, 27, 33 | done |
| F-061 Runner versions | The window enforced on both carriers with the message; the pin at start from `/runner/v1/info`; each runner's version and its state in the panel; the compatibility matrix over recorded fixtures, and a real build one minor apart | `packages/protocol`, `apps/core`, `apps/runner`, `apps/web` | 01, 16, 19, 31 | done |
| F-039 Three images | The server, runner and base images built from source by `pnpm images:build`, the base image's pins checked against the repo, tagged with the release | `deploy/`, `packages/deploy-checks` (new) | 22, 35 | building: built in ticket 35's job; `done` when published, in milestone 7 |
| F-116 Egress baseline | Host rules on `docker` and a NetworkPolicy on `kubernetes`, with the server's address as their one exception; every check from a shell in the agent's container with its positive control, the gateway probed, a timeout inconclusive, the control pod, the canary | `adapter-executor-docker`, `adapter-executor-kubernetes`, `deploy/`, `apps/runner` | 08, 09, 24, 35 | done if ticket 35's Linux job passes |
| F-118 Helm chart | `ostra-server` (the `web` and `core` replicas, an external Postgres, one generated secret) and `ostra-runner` (a namespace, a scoped service account, the join token from a secret, the egress policy); only required values; each value in the configuration reference | `deploy/helm/` (new), `packages/deploy-checks`, `docs/` | 23, 35 | done if ticket 35's Linux job installs both on kind |
| F-117 Scale-out | The load test's harness: simulated runners on the real protocol, three core replicas, one Postgres, spike 10's rates, steers timed, Postgres CPU recorded, the generator as several processes, a reconnect storm, real browsers with partial text on | `e2e/load` (new), `apps/runner` (its peer as a library) | 06, 34, 38 | building: this machine's run records the scale it holds; the 1,000-task run is on Linux (ticket 38), and the gate is milestone 7 |

**Rows this milestone touches without finishing, or finishes on the way:**
- **F-086 Projects:** the project's pool list, in order, with its shares, was the last part missing (milestone 4's note). Ticket 37 sets it `done` if milestones 2 to 4 left nothing else.
- **F-017 A box per task:** its live test runs in ticket 35's Linux job, on core's acceptance of a sidecar's connection with its task token, which is on `main` since 2026-11-19 (milestone 1's ticket 41). `done` if that job passes.
- **F-001 One-command install:** `docker compose up` runs in ticket 35's Linux job; its other conditions are milestone 1's. Ticket 37 adds a dated note with the run.
- **F-051, F-094, F-096:** their `docker` and `kubernetes` halves run in ticket 35's job (a box from a snapshot sees its repos, services by name, a stopped pod deleted). Each gets a dated note; each is set `done` only if every condition of its row is then proved.
- **F-036:** gains the runner notices for admins, and stays `building` for milestone 6's audiences.
- **F-045:** a box's sidecar dropping out runs for real in ticket 35's job.

**Built in from the first milestone** (`build-order.md`), checked again by ticket 37:
- Organization-scoped data: every new row carries `organizationId`, every project record `projectId` with the composite key (04). Milestone 4's generated isolation test covers the new models (ticket 04 adds their fixtures).
- The event log and the durable queue: a join, an approval, a drain, a cancel, an admission and a registry check are each saved before they're acted on, and their notices and commands go through the outbox or the queue (12, 13, 15, 17).
- No credential in the agent's container: the task token is a Kubernetes secret mounted only into the sidecar container; a registry's pull credential goes to the runner for one pull, or to a per-box pull secret, and never into a container (07, 09, 20, 21). The executor suite checks it on every executor (02).
- ACP as the only way to talk to an agent: unchanged; the sidecar drives the agent the same way in a pod.
- Strict typing, dark first, responsive, English text in message files: as milestones 1 to 4.

---

## 3. The end-to-end demo

Ticket 37 runs it and records the result under its `## Comments` and in `demo.md` next to this spec. Everything runs against the Linear workspace `ostra-test` (team `OST`) and the GitHub org `ostra-test` (repos `test1` and `test2`). Secrets come from `~/.config/ostra-dev/` with `set -a; . ~/.config/ostra-dev/<file>; set +a`, and are never printed, logged or committed.

**Before:** a fresh clone, `pnpm install`, `pnpm dev:reset`, `tunnel.env` loaded, and `pnpm dev` with three core replicas (`OSTRA_DEV_CORE_REPLICAS=3`). Milestones 1 to 4's setup is done by their scripts' helpers: a model provider from `model.env` with its prices, the test App, projects `test1` and `test2`, Linear's `OST` on `test1`, Sam invited and joined. The panel signs in as the **default first admin, `demo@demo.com` / `demo`**; the scripted run sets `OSTRA_ALLOW_DEFAULT_PASSWORD=true`, `OSTRA_DEV_HOST_POOL_SAME_USER=true`, milestone 2's idle timer at one minute, and `OSTRA_RUNNER_WS_RETRY_MINUTES=1`. Ticket 36's dev tools run: `pnpm dev:fake-kube --process`, `pnpm dev:registry`, `pnpm dev:npm-registry` and `pnpm dev:net-proxies`. The CLI is packed (`pnpm --filter ostra pack`) and installed from the tarball into a folder of its own, so every runner below is the npm CLI a person would run.

1. **A pool that requires approval.** Organization, "Runners", "New pool": `build-fleet`, "Require approval for new runners" on, at most 3 boxes, tokens that last 30 days. The token is shown once, with three ways to start a runner: `ostra runner` with `OSTRA_JOIN_TOKEN`, one `docker run` of the runner image, and the Helm values for the runner chart. `test1`'s settings, "Runners": the pools `build-fleet`, then `Default`, in that order, with `test1`'s share of `build-fleet` at 2 boxes and its default size `small`.
2. **A runner joins and waits.** The script starts `build-01` from the installed CLI, on `host`, with labels `tier:fast`. It's `joining`; Demo's "Needs you" and mail say "`build-01` wants to join `build-fleet`", with its host, system, executor, labels, version and the token it used. A task in `test1` isn't offered to it. The audit log has `runner.joined` naming the token. Demo presses "Approve": `build-01` is online, and the audit log has `runner.approved`.
3. **Rotation.** Demo makes a second token for `build-fleet` and revokes the first. `build-01` stays connected. `build-02` (no labels) joins with the second token and Demo approves it. A runner started with the revoked token is refused with "This join token was revoked", and one started with a token whose lifetime the script moves past is refused with "This join token expired"; neither appears as a runner.
4. **The fleet view.** "Runners" lists `Default`, `build-fleet` ("not isolated, same user (development only)") and, after step 12, `k8s-fake` ("the agent has direct internet access"), each with busy boxes, its queue, its runners' versions and labels; every runner with its state, executor, carrier and containment; and "Your machine". `build-fleet`'s page lists both runners, its join tokens with the revoked one marked, and its empty queue.
5. **Box sizes.** Organization, "Box sizes" shows small (2 vCPU, 4 GB), medium (4, 8) and large (8, 16), with the line that `host` counts slots only. Demo sets large to 8 vCPU and 32 GB; the audit log has it.
6. **Capacity and the queue.** The script starts five prompt tasks in `test1` and creates one `OST` ticket at priority Urgent and one at Low; Demo starts both from the Inbox, and starts one prompt task in `test2`. `test1` runs two (its share), `test2`'s runs on the third slot, and the rest wait in `build-fleet`'s queue: the Urgent ticket first, then the prompts in the order they came, then the Low ticket. Each queued task's page says "3rd in `build-fleet`'s queue" (or its place) and why ("`test1` is at its share of `build-fleet`: 2 boxes"). When a box frees, the Urgent ticket starts next. Demo cancels the Low ticket's task from the pool's queue: it stops as "Cancelled by Demo", and the audit log has `task.cancelled`.
7. **Choosing a runner.** Demo makes a profile `Fast` asking for the label `tier:fast`. A task on `Fast` runs on `build-01` only, even with `build-02` free. A profile asking for `gpu` leaves its task waiting with "No runner in `build-fleet` or `Default` has the labels `gpu`". A ticket task started by the script as the system (the task source milestone 6's rules will use, made by ticket 14's test helper) goes to a pool and is never offered to a personal runner.
8. **Personal and pool runners side by side.** Sam runs `ostra runner` on this machine with a device code, approves it in the browser, and sees "Your machine: connected, personal, not isolated, contained by a job object, 2 tasks at once". Sam's New task offers "Your machine" beside "A pool"; Sam sends two tasks to it and a third waits with "Your machine is busy (2 of 2)". Demo's tasks never go to Sam's runner. An organization provider is refused on it until Demo switches on "Allow on personal runners" for that provider, as milestone 1 built.
9. **Drain, resume, revoke.** While `build-01` runs a task, Demo presses "Drain": the task finishes, nothing new is offered to it, and the fleet view shows "draining". The script kills `build-01`'s process and starts it again: it reconnects still draining. Demo presses "Resume": it's online and takes the next queued task. Demo revokes `build-02` while it runs a task: the task stops as `runner_lost` at once and reopens on `build-01`, and `build-02` can't connect again.
10. **Runner versions.** The script builds milestone 4's runner (minor 3) from its tag and joins it: it works, and the fleet view shows "one minor behind, update when you can". A build from milestone 3 (minor 2) is refused with "This runner speaks protocol 1.2; this server accepts 1.3 to 1.5. Update it to vX.Y.Z", and appears as outdated. The installed CLI at version N+1 starts against the server at N: it reads `/runner/v1/info`, installs N from `pnpm dev:npm-registry` into its data folder, and runs that; the fleet view shows N.
11. **The HTTP fallback.** `build-03` starts through `dev:net-proxies`'s TLS proxy that refuses WebSockets: it's on HTTP within 30 s, the fleet view shows its carrier as "HTTP", a steer reaches its task, and every event is stored once. The proxy is switched to pass WebSockets: within the one-minute retry the runner is back on WebSocket. Through the CONNECT proxy, with Basic auth, a runner stays on WebSocket.
12. **The `kubernetes` executor, on the fake cluster.** Demo makes a pool `k8s-fake`. The script renders the runner chart with `helm template` and applies it to the fake API (with ticket 38's yes to Helm on this machine; without it, the script makes the same objects from the chart's default values through `@kubernetes/client-node`, and `demo.md` says the chart itself wasn't rendered here): the namespace `ostra-boxes`, the service account and its role, the join token's secret, the NetworkPolicy. It starts a runner with `--executor kubernetes` against the fake API. `test2` lists `k8s-fake`. A task in `test2` waits with "`k8s-fake` needs a registry for snapshots" until step 13. After it, a task in `test2`: the fake API has one pod with the agent container, the sidecar and the service as native sidecars, limits of `small`, `automountServiceAccountToken: false`, the task token's secret mounted only into the sidecar, and the snapshot pulled by digest with a pull secret owned by the pod. The fake holds the pod unschedulable with a scale-up event for 40 s: the task page says "Waiting for a node" and the dispatch was accepted at once. The process mode then runs it: the agent works, the PR opens on `test2`. After the idle minute the pod and its secrets are deleted.
13. **The registry.** Organization, "Registry": `dev:registry`'s address, a push credential and a pull credential. "Check" pushes nothing and answers "Push and pull both allowed for `ostra-dev/`". A snapshot of `test2`'s environment is queued for `k8s-fake`: the fake API has the BuildKit pod in `ostra-builds` with its own egress policy, and its result (the fake's process mode doesn't build images, so the demo's image is the fake registry's seeded one; the real build is ticket 35's) is recorded with its digest on the environment page.
14. **The three images, the Helm charts and the egress baseline, here.** `pnpm check:images` reads the three Dockerfiles: pinned base digests, OpenCode's SHA-256 from the repo and never from its download, the init program, no secret in a `RUN` or `ARG`. `pnpm check:helm` lints and renders both charts with only their required values and with every example, and checks the rendered manifests. The docker executor's rules from `egressRules` and the NetworkPolicy the runner chart renders each match the baseline's list. The live versions of all three are ticket 35's job, and `demo.md` links its run.
15. **The load test, here.** `pnpm load:run --ramp` runs 100, 250, 500 and 1,000 simulated tasks against the three core replicas and the embedded Postgres, at spike 10's event mix, with 5 real browsers on Playwright watching tasks with partial text on for 1 task in 4, a steer every 10 s per 100 tasks, and a reconnect storm of every simulated runner at once at each step. `demo.md` records the largest step that held every bar, and where the next one failed.

**The checks after the run** (ticket 37 scripts what it can, in `e2e/m5-the-fleet/`):
- **Nothing leaked.** Join tokens, runner keys, access tokens, task tokens, registry credentials and the GitHub and model keys appear in no log line, no event, no command, no pod spec or annotation, and no worktree (searched by value, never printed). The task token and the pull credential appear in the fake API only inside their `Secret` objects, which were deleted with their pod.
- **Isolation.** Milestone 4's generated test passes with the new models. A runner of a second organization made by that test's fixtures is offered none of `Demo`'s tasks, and `Demo`'s join tokens don't join a runner to its pools. *Changed 2026-11-19: the second organization was milestone 4's demo's `Second`, which moved after v1 with several organizations (F-134).*
- **Join tokens.** A revoked token, an expired token, another pool's token and a token with no lifetime that a revoke ended are each refused; approval holds whichever token joined; every join is an audit entry and a notice (F-091).
- **The share and the queue.** Fifty admissions raced from three replicas never put a project past its share or a pool past its cap, and the queue's order is priority, then queued time (F-067).
- **Choosing.** Every reason a task waits is the right one, from a table of runner and pool states in the test (F-069).
- **Versions.** The compatibility matrix (runner N-1, N and N+1 against server N, over recorded fixtures, on both carriers) passes, and the refused minors print the fix (F-061).
- **Drain.** A drained runner stays drained through a disconnect, a restart and a server restart (F-092).
- **The fake cluster's objects.** Every pod, secret and policy the executor made is gone after release, and no object outside the runner's namespace and its build namespace was touched (F-093).
- **Clean-up:** the demo's tickets archived in `OST`, its PRs closed, branches and hidden refs deleted, in `test1` and `test2` only.

---

## 4. How it fits together in milestone 5

```
 browser ──▶ apps/web: Runners, Pool, New pool, Join, Runner, Approve, Box sizes, Project runners,
                │      Registry, the task's waiting line, New task's runner picker
                ▼
             packages/api ──▶ Postgres: pools, tokens, runners, sizes, shares, labels, queue order,
                │                       registries, snapshots, the outbox
                ▼                                 ▲
 apps/core: gateway (WebSocket and HTTP carriers), dispatch: queue.admit, runner.join-notice,
            registry.check, snapshot.schedule
                │
 runner ──WS or HTTP──▶ gateway          ostra runner --executor docker | kubernetes | host
   ├─ docker:      a box = agent container + sidecar + services, sizes as limits, egress rules
   ├─ kubernetes:  a box = one pod in its namespace, sidecar and services as native sidecars,
   │               the task token as a Secret, NetworkPolicy, BuildKit pod for snapshots
   └─ host:        a worktree; on a pool, the agent as a separate OS user
 sidecar ──WS, task token──▶ gateway (docker, kubernetes)
 registry ◀── push (the building runner) / pull (docker hosts, kubelets)
 e2e/load ──▶ simulated runners ×N ──▶ three core replicas ──▶ one Postgres
```

**The flows:**
- **A pool and its tokens.** `pools.create` writes the pool, its first join token (hashed) and an audit entry in one transaction, and answers the token once. `joinTokens.create` and `joinTokens.revoke` do the same per token. A token's lifetime is the pool's setting or the admin's choice, or none.
- **A join.** The runner posts the token and its new public key to milestone 1's register endpoint. Core accepts any token of the pool that hasn't expired or been revoked (Q130), makes the runner (`joining`), records the token it used, writes `runner.joined`, enqueues `runner.join-notice` and, when the pool requires approval, a needs-you item for its admins, all in one transaction. A runner in a pool that requires approval is offered nothing until `runners.approve` moves it to `online` (or offline, when it isn't connected); `runners.reject` is a revoke.
- **What a runner reports.** `hello` and every `status` carry its executor, its capabilities, its labels (with the built-in `executor:`, `os:` and `arch:` labels), its version and minor, its containment, and its capacity: slots, and for `docker` and `kubernetes` the CPU and memory it offers. Core keeps them on the runner's row.
- **Admission.** Every change that can free or need room (a task queued, a box released, a runner online, approved, resumed or reporting more room, a share or a cap changed) enqueues `queue.admit` keyed by pool, and a sweep every 5 s catches the rest. `queue.admit` takes the pool's lock, reads the queued tasks the pool could run in priority order, and for each, in one transaction, counts the pool's and the project's boxes from ostra's own rows, chooses a runner (`chooseRunner`), and makes the lease and the offer, or records why the task still waits. A project at its share is passed over and the next task considered, so one project's backlog never blocks another's.
- **Choosing a runner.** For a task a member started with their personal runner, that runner only. Otherwise the project's pools in its order; in each, the runners that are `online`, approved, carry every label the profile asks for, declare the capabilities the task needs (services, a registry), and have a free slot and room for the project's size; the one with the most free room, then the one holding the project's snapshot, then the least recently offered. No match in any pool leaves the task queued with the reason of the nearest miss.
- **Drain and resume.** `runners.drain` sets `draining` and queues a `drain` command; `runners.resume` moves it back and queues `resume`. Offers go to `online` runners only, so the hold is the server's.
- **The pin.** At start, `ostra runner` reads `/runner/v1/info`. When its version differs from the server's and it was installed from npm, it installs the server's version into `<dataDir>/versions/<version>` from the configured registry, checks the package's integrity, and runs it. From the image it installs nothing and reports its version, which the panel shows against the server's.
- **A box on `kubernetes`.** The runner accepts the offer at once, asks for the task token, creates a `Secret` with it (and with the snapshot's pull credential, when there is one) and the pod, owned by nothing but labelled with the box, and watches the pod. Unschedulable with a scale-up under way, it emits `box.waiting { reason: "node" }`; once scheduled, `box.scheduled`. The sidecar container starts first, reads the token from its mounted file, connects, and drives the agent over the bridge on the pod's loopback. Stop deletes the pod and its secrets; a pod is never kept stopped (ADR 0039).
- **A snapshot with a registry.** Milestone 3's `snapshot.schedule` gains the registry: on `docker` the building runner pushes the scanned image with the push credential it fetched for that build, and records the digest; on `kubernetes` the runner starts a rootless BuildKit pod in its build namespace, which pushes after the scan. A box's spec names the image by digest; the runner pulls it with a pull credential fetched for that lease.
- **The HTTP carrier.** `POST /runner/v1/hello` answers `welcome` with a connection epoch; `POST /runner/v1/up` takes a batch and answers acks; `GET /runner/v1/down?after=` holds up to 25 s. Every request carries the epoch and `x-ostra-minor`, and a newer connection's epoch gets `409`. Behind them, the same session code as the WebSocket.
- **The load test.** `e2e/load` starts three core replicas and one Postgres, then N simulated runners in several generator processes, each a real `apps/runner` peer with an in-memory spool and a scripted agent that emits spike 10's event mix. Tasks are created through `packages/api`, dispatched by the real dispatcher, and their events ingested by the real gateway. The harness times steers from the API call to the runner's receipt, samples Postgres's CPU, and drives a few Playwright browsers on task pages.

---

## 5. The contracts

Every contract change in milestone 5 is **additive**: a new optional field, a new union member, a new endpoint, a new table, column or enum value. Nothing is renamed or dropped (`AGENTS.md`). Each lands as one small commit that names the contract and updates every caller in the same commit. Tickets 01 to 06 make them first, each with the fakes its callers test against; everything else builds on them.

### 5.1 `packages/protocol`: minor 4 (ticket 01)

- **The version.** The protocol goes to minor 4, after milestone 4's minor 3. The window stays one minor either way, so a minor-3 runner still works: core sends it no `resume` (the panel says a resumed minor-3 runner takes tasks after it restarts), no box size (a minor-3 `docker` runner counts slots only, and its pool page says "sizes not enforced: update this runner"), and no registry image (it builds and keeps its own snapshot, as milestone 3). A `kubernetes` runner below minor 4 can't exist and is refused at `hello`. A minor-2 runner is outside the window and refused, with the fix.
- **`hello` and `status`, new optional fields:**
  - `resources: { slots, cpuMillis, memoryMiB } | null`: what the runner offers; `null` on `host`, which counts `capacity` as slots
  - `capabilities: { isolation, services, boxSizes, snapshots, registry: "required" | "optional" | "none", nodeWait: boolean }`, where minor 2 hasn't added the first four
  - `install: "npm" | "image" | "source"`: how the runner was installed, for the pin and the panel
- **Commands:**
  - new: `resume {}`
  - `dispatch` gains `box: { size: { name, cpuMillis, memoryMiB } | null, image: { ref, digest } | null }`
  - milestone 3's `snapshot-build` gains `push: { ref } | null` and `builder: "docker" | "buildkit"`
- **Events, new runner events:** `box.waiting { boxId, reason: "node" | "image-pull", since }` and `box.scheduled { boxId, afterMs }`. Server-only, new: `task.cancelled { memberId }` and `runner.drained` / `runner.resumed { memberId }` for the runner's own timeline.
- **The HTTP carrier** in `src/runner/http.ts`: `POST /runner/v1/hello` (the `hello` body, answered with `welcome` and `connectionEpoch`), `POST /runner/v1/up` (an up frame batch, answered with acks), `GET /runner/v1/down?after=<seq>` (commands, or `204` after 25 s), the headers `x-ostra-epoch` and `x-ostra-minor`, and the `409 { code: "superseded" }` answer.
- **Runner HTTP, new** (the runner's access token, after the lease check):
  - `POST /runner/v1/tasks/:taskId/pull-credential` → `{ registry, username, token, expiresAt }`, for the lease's image only
  - `POST /runner/v1/snapshots/:snapshotId/push-credential` → the same shape, for the runner the build was given to, while it's `building`
- **`GET /runner/v1/info`** gains `version` (where it isn't there), `minorWindow`, and `npm: { package, registry } | null`, which the pin reads.
- **Labels:** `runnerLabelSchema` keeps its shape (at most 64, lowercase, `[a-z0-9._:/-]`, 63 characters); the built-in prefixes `executor:`, `os:` and `arch:` are reserved, and a runner can't set them itself.
- The schemas' descriptions say what's never logged: a token, a credential, a key.

### 5.2 `packages/adapter-sdk` (tickets 02 and 03)

**`ExecutorAdapter`** (ticket 02):
- **Capabilities, new:** `registry: "required" | "optional" | "none"` and `nodeWait: boolean`. `host` declares `none` and `false`; `docker` `optional` and `false`; `kubernetes` `required` and `true`. `boxSizes` exists.
- **`capacity()`, new:** `{ slots, cpuMillis, memoryMiB } | null`, what the executor offers now: `docker` from the engine's `info` minus its reserve, `kubernetes` from the namespace's `ResourceQuota` when one is set and the runner's setting otherwise, `host` `null`.
- **`create` input, new optional fields:** `size: { cpuMillis, memoryMiB } | null` (refused by an executor whose `boxSizes` is false), `image: { ref, digest, pull: { username, token } | null } | null`, `taskToken: string | null` (on `docker` and `kubernetes`: written where only the sidecar reads it), and `onWaiting(reason)`.
- **`buildSnapshot` input gains** `push: { ref, credential } | null`; its result gains `digest`.
- **The executor contract suite** gains, on every executor: a box with a size gets exactly its limits, read back through the executor's own inspection, and `host` refuses a size; a box from an image pulls it by digest and its pull credential is in no container's environment, files or process list, the agent's included; the task token is readable from the sidecar's mount only; a pending box reports waiting and then scheduled (`kubernetes`); release removes every object the box made, secrets included; the egress probes of ticket 24 (live only, from its live test file).

**`NotificationAdapter`** (ticket 03): `Notification.kind` gains `runner_joined` and `runner_awaiting_approval`, audience the organization's admins, in the panel and by mail; the tracker channel refuses both. A needs-you reason `runner_awaiting_approval`, resolved by the approval or the reject.

### 5.3 `packages/db`: the milestone 5 migration (ticket 04)

One new migration, after milestone 4's, additive only. Every row carries `organizationId`; every project record carries `projectId` with the composite key to the project.

| Change | What |
|---|---|
| `RunnerPool` | + `joinTokenDays` (null for the default; `0` for no expiry), `updatedByMemberId` |
| `JoinToken` | + `revokedByMemberId`, `useCount` |
| `Runner` | + `joinTokenId` (the token it joined with), `install` (`npm`, `image`, `source`), `minor`, `cpuMillis`, `memoryMiB`, `slots`, `capabilities` (JSON, parsed by the protocol's schema), `containment`, where earlier milestones haven't added them; `drainedAt`, `drainedByMemberId`, `lastOfferedAt` |
| New `BoxSize` | `name` (`small`, `medium`, `large`), `cpuMillis`, `memoryMiB`, `updatedByMemberId`. Unique `(organizationId, name)`. The migration inserts the three defaults for every organization; the first admin's seed (`seedFirstAdmin`, milestone 1) inserts them for an install that first starts after it. *Changed 2026-11-19: this said `createOrganization` (milestone 4) seeds them, which moved after v1 with several organizations (F-134) and will seed them then* |
| `ProjectPool` | + `position` (existing rows numbered by creation). `maxBoxes` is the project's share |
| `Project` | `defaultBoxSize` exists; its values are checked against `BoxSize` |
| `AgentProfile` | + `runnerLabels` (text array, default empty) |
| `Task` | + `queuePriority` (smallint: 1 urgent to 4 low; prompt tasks and tickets without one are 3), `queuedAt`, `requiredLabels` (text array, from the profile at queue time), `cancelledByMemberId` |
| `Box` | + `size`, `cpuMillis`, `memoryMiB`, `imageRef`, `imageDigest`, `waitingReason` (`node`, `image-pull`), `waitingSince`, `scheduledAt` |
| New `Registry` | One per organization: `url`, `repositoryPrefix`, `auth` (`basic`, `node`), `pushSecretId`, `pullSecretId` (secret store references), `checkedAt`, `checkResult` (JSON), `updatedByMemberId` |
| `Snapshot` | + `registryId`, `builder` (`docker`, `buildkit`), `pushedAt`, `runnerId` where milestone 3 hasn't added it |
| Enums | `TaskStopReason` + `cancelled`. `CommandKind` + `resume`. `NeedsYouReason` + `runner_awaiting_approval`. The notification kinds + `runner_joined`, `runner_awaiting_approval`. New `RunnerInstall`, `BoxWaitingReason`, `RegistryAuth`, `SnapshotBuilder` |
| Indexes | `Task (organizationId, state, queuePriority, queuedAt)` for the queue; `Box (runnerId, state)` and `Box (projectId, state)` for the counts |

The migration backfills `queuedAt` from `createdAt` for queued tasks, `queuePriority` from each ticket's priority, and the box sizes. Nothing else.

### 5.4 `packages/domain` (ticket 05)

- **Lifecycles,** new or grown, each with exhaustive tests: a join token (`active` → `expired` | `revoked`, expiry read from the `Clock`); the runner's `approve` and `reject` from `joining` (milestone 2 built the rest); a queued task's `cancel` to `stopped` with `cancelled`; the box's `creating` with its waiting reason (no new state).
- **Capacity:** `runnerRoom(runner, boxes)` → free slots, CPU and memory; `fits(room, size)`; a pool's capacity and use; a project's use of a pool, counted from `Box` rows that hold a slot (`creating`, `preparing`, `ready` and `idle`; a `stopped` box holds none). A personal runner's capacity is 2 unless its member sets another.
- **The queue:** `queueOrder` (priority, then `queuedAt`, then ID), the pool's queue as a query over tasks the pool could run, and a task's place in it.
- **Choosing a runner:** `chooseRunner(task, project, pools, runners, boxes)` → `{ runnerId, poolId }` or `waits { reason }`, pure, over the reasons `no-runner-online`, `no-runner-with-labels { labels }`, `needs-services`, `needs-registry { poolId }`, `pool-full { poolId }`, `project-share-reached { poolId, cap }`, `size-too-large { size }`, `queued { poolId, place }` and milestone 2's reasons, all new members of `dispatchWaitSchema`. Labels match as a subset, exactly.
- **Versions:** `runnerVersionState(server, runner)` → `current`, `behind`, `ahead` or `outside`, with the window from `version.ts`.
- **The registry:** the image name `<url>/<prefix>/<projectId>:<snapshotId>`, referenced by digest; the check's result shape.
- **Use-case signatures:** `createPool`, `updatePool`, `createJoinToken`, `revokeJoinToken`, `registerPoolRunner` (milestone 1's, grown), `approveRunner`, `rejectRunner`, `drainRunner`, `resumeRunner`, `recordRunnerReport`, `setBoxSizes`, `setProjectPools`, `setProfileLabels`, `queueTask`, `admitQueued`, `cancelQueuedTask`, `chooseRunner`, `setRegistry`, `checkRegistry`, `issuePullCredential`, `issuePushCredential`.
- **Jobs, new names** (IDs only in payloads, ADR 0037): `queue.admit` (key: pool, `singletonSeconds` 1; plus a 5 s sweep), `runner.join-notice` (key: runner), `registry.check` (key: organization and the settings' version).
- **Settings, new,** each with a working default and its line in `docs/configuration.md`:

| Setting | Where | Default |
|---|---|---|
| `OSTRA_JOIN_TOKEN_DAYS` | core | `30` |
| `OSTRA_PERSONAL_RUNNER_CAPACITY` | core | `2` |
| `OSTRA_QUEUE_SWEEP_SECONDS` | core | `5` |
| `OSTRA_DEV_HOST_POOL_SAME_USER` | runner, core | `false`; refused unless `NODE_ENV` is `development` or `test` |
| `OSTRA_RUNNER_LABELS` | runner | empty |
| `OSTRA_RUNNER_SLOTS` | runner | `docker`: the host's CPUs ÷ 2; `kubernetes`: `20`; `host` (pool): `2` |
| `OSTRA_RUNNER_RESERVE_CPU_MILLIS`, `OSTRA_RUNNER_RESERVE_MEMORY_MIB` | runner (`docker`) | `1000`, `2048` |
| `OSTRA_RUNNER_TRANSPORT` | runner | `auto` (`--transport`) |
| `OSTRA_RUNNER_WS_RETRY_MINUTES` | runner | `10` |
| `OSTRA_RUNNER_PIN` | runner | `true` |
| `OSTRA_RUNNER_NPM_REGISTRY` | runner | npm's public registry |
| `OSTRA_HOST_POOL_AGENT_USER` | runner (`host` pool) | none: a `host` pool runner refuses to start without it |
| `OSTRA_K8S_NAMESPACE` | runner | the service account's namespace |
| `OSTRA_K8S_BUILD_NAMESPACE` | runner | `<namespace>-builds` |
| `OSTRA_K8S_NODE_WAIT_MINUTES` | runner | `15` |
| `OSTRA_K8S_RUNTIME_CLASS` | runner | none |
| `OSTRA_EGRESS_ALLOW` | runner (`docker`, `kubernetes`) | the server's address only |
| `OSTRA_SIDECAR_CPU_MILLIS`, `OSTRA_SIDECAR_MEMORY_MIB` | runner | `1000`, `256` |
| `OSTRA_SERVICE_CPU_MILLIS`, `OSTRA_SERVICE_MEMORY_MIB` | runner (a service without its own) | `1000`, `1024` |

---

## 6. Packages, licenses and owners

| Package | License | New in M5 | Built by |
|---|---|---|---|
| `packages/protocol` | Apache-2.0 | minor 4, the HTTP carrier's shapes | core (01) |
| `packages/adapter-sdk` | Apache-2.0 | sizes, capacity, registry images, the task token's handoff, the fleet's suite cases, the runner notices, the fake OCI registry | adapters (02, 03, 06) |
| `packages/adapters/adapter-executor-kubernetes` (new) | Apache-2.0 | the executor, the fake Kubernetes API and its process mode | adapters (06, 07, 08) |
| `packages/adapters/adapter-executor-docker` | Apache-2.0 | sizes as limits, registry pulls and pushes, the egress pool's rules | adapters (09, 24) |
| `packages/adapters/adapter-executor-host` | Apache-2.0 | a pool's separate OS user, slots | adapters (10) |
| `apps/runner` | Apache-2.0 | the HTTP fallback, reports, the pin, `kubernetes` boxes, registry builds and pulls; its peer exported for the load test | runner (18 to 21) |
| `packages/db` | Sustainable Use | the M5 migration, the isolation fixtures | core (04) |
| `packages/domain` | Sustainable Use | capacity, the queue, choosing, versions, the registry, use cases, jobs, settings | core (05) |
| `apps/core` | Sustainable Use | the HTTP carrier, joins and approval, admission, choosing, drain and resume, versions, the registry | core (11 to 17) |
| `packages/api` | Sustainable Use | pools, tokens, the fleet, sizes, project pools, labels, the registry | api (25 to 28) |
| `apps/web` | Sustainable Use | the M5 screens | web (30 to 33) |
| `deploy/` and `deploy/helm/` (new) | Apache-2.0 (files, not a package) | the images' build, the two charts, the egress script | core (22, 23, 24) |
| `packages/deploy-checks` (new, private) | Apache-2.0 | the Dockerfiles' and charts' checks, the values schemas in Zod | core (22, 23) |
| `e2e/load` (new) | Sustainable Use | the load test | core (34) |
| `e2e/m5-the-fleet` (new) | Sustainable Use | the demo and the dev tools | core (36, 37) |

The license line holds (ADR 0045, ADR 0048): no Apache-2.0 package depends on a Sustainable Use one. The `kubernetes` executor and the runner import only `protocol` and `adapter-sdk`; `e2e/load` may import both sides, as a test package. `pnpm check:licenses` runs on every commit.

---

## 7. The builders and their tickets

Five builders: **core**, **runner**, **web**, **api** and **adapters**. Core and adapters make the contracts first (01 to 06), each with the fakes its callers need. Ticket 38 is the maintainer's.

| # | Ticket | Builder | Blocked by |
|---|---|---|---|
| 01 | Protocol: minor 4 | core | none |
| 02 | Adapter SDK: sizes, capacity, registry images and the fleet's suite cases | adapters | 01 |
| 03 | Adapter SDK: the runner notices | adapters | none |
| 04 | DB: the milestone 5 migration | core | none |
| 05 | Domain: capacity, the queue, choosing a runner, versions, the registry | core | 01, 04 |
| 06 | Test seams: the fake Kubernetes API, the fake registries and the network proxies | adapters | 02 |
| 07 | Kubernetes executor: a box as a pod | adapters | 02, 06 |
| 08 | Kubernetes executor: services, BuildKit snapshots, the egress policy, waiting for a node | adapters | 07 |
| 09 | Docker executor: sizes, registry images and pushes | adapters | 02, 06 |
| 10 | Host executor: a pool's OS user, and slots | adapters | 02 |
| 11 | Core: the HTTP carrier | core | 01 |
| 12 | Core: join tokens, approval and the join notices | core | 03, 05 |
| 13 | Core: capacity, the pool queue and admission | core | 05 |
| 14 | Core: choosing a runner | core | 05, 13 |
| 15 | Core: drain and resume | core | 01, 05 |
| 16 | Core: runner versions and the matrix | core | 01, 05 |
| 17 | Core: the registry, and snapshots for `kubernetes` pools | core | 05, 06 |
| 18 | Runner: the HTTP fallback | runner | 01, 06 |
| 19 | Runner: reports, labels, the pin and a pool runner's start | runner | 01, 06, 10 |
| 20 | Runner: `kubernetes` boxes and the task token's secret | runner | 07 |
| 21 | Runner: snapshot pushes and image pulls | runner | 08, 09, 17 |
| 22 | The three images | core | none |
| 23 | The Helm charts | core | 07, 22 |
| 24 | The egress baseline on `docker` and `kubernetes` | adapters | 08, 09 |
| 25 | API: pools, join tokens and approval | api | 12 |
| 26 | API: the fleet, drain, resume, revoke and the queue | api | 13, 15 |
| 27 | API: box sizes, project pools, profile labels and the runner picker | api | 13, 14 |
| 28 | API: the registry | api | 17 |
| 29 | Milestone 5 screen targets | web | none |
| 30 | Web: the Runners page, a pool, a new pool and joining | web | 25, 26, 29 |
| 31 | Web: a runner, approval, drain, resume and revoke | web | 25, 26, 29 |
| 32 | Web: box sizes, project runners and profile labels | web | 27, 29 |
| 33 | Web: the registry, the task's waiting line and the runner picker | web | 27, 28, 29 |
| 34 | The load test | core (lead) | 11, 13, 18, 19 |
| 35 | The Linux and macOS proof jobs | core | 09, 10, 20, 21, 22, 23, 24 |
| 36 | Dev tools: the fake cluster, the registries and the proxies | core | 06 |
| 37 | The end-to-end demo and the ledger | core (lead) | 12 to 21, 24, 30 to 36 |
| 38 | The maintainer's steps outside the code | maintainer | none for the decisions; 35 and 37 for the runs |

**Who starts when.** core takes 01, 04 and 22 at once, then 05 and 11; adapters take 03 at once and 02 after 01, then 06, 10, 07 and 09. runner takes 18 after 06 and 20 after 07. api starts on 25 once 12 is in. web takes 29 at once; its screen tickets wait for the targets' approval (section 12). Milestones 2 to 4's tickets come first wherever both touch a file: a milestone 5 ticket that meets an earlier milestone's ticket still open on the same package waits for it, and says so in its `## Comments`.

---

## 8. Test seams

Agreed here so builders don't each invent one.

- **Postgres:** milestone 1's helper, a database per test file. Every test that reads data also checks another organization's rows stay invisible.
- **Pools and runners:** `seedPool(db, { requiresApproval, maxBoxes })`, `seedRunner(db, { pool, executor, slots, cpuMillis, memoryMiB, labels, state })` and `seedQueuedTask(db, { project, priority, labels })` in `@ostra/domain/testing`, used by every capacity, queue and choosing test.
- **The fake peer:** milestone 1's fake gateway peer, grown to report resources, labels and capabilities, to accept or decline offers, and to speak the HTTP carrier.
- **The fake Kubernetes API** (`@ostra/adapter-executor-kubernetes/testing`, ticket 06): an in-process HTTP server that `@kubernetes/client-node` talks to for real, holding namespaces, pods, secrets, service accounts, roles, network policies, resource quotas and events, with `watch`, server-side validation of the fields the executor sets (native sidecars need `restartPolicy: Always` on an init container), a version endpoint the executor reads (refusing under 1.29), a switch that holds pods unschedulable with a scale-up event, and a **process mode** that runs each container's command as a local process with its environment and its mounted secret files written to a folder of its own, mapping ostra's images to local commands (the runner image to the built `ostra`, the base image to the machine's shell and agent). The process mode has no isolation and no limits, and says so in every log line it writes.
- **The fake OCI registry** (`@ostra/adapter-sdk/testing`, ticket 06): `/v2/` with Basic and bearer-token auth, blob uploads, manifests by tag and digest, a push-only and a pull-only credential, and a seeded image.
- **The fake npm registry** (ticket 06): a packument and tarballs of the CLI packed at two versions, for the pin.
- **The network proxies** (ticket 06, ported from spike 6): a CONNECT proxy with and without Basic auth, a TLS-inspecting proxy with its own CA in three modes (pass, refuse WebSockets, answer 101 then hold), a cut that holds or resets, and an emulation of nginx's defaults. Real nginx in ticket 35's job.
- **The Docker engine:** milestone 1's fake engine, grown to record limits, pulls by digest with credentials, pushes and runtimes; the live cases in `*.live.test.ts`, run by ticket 35's job only.
- **Agents:** milestone 3's scripted fakes; the load test's agent is a scripted event source, not an ACP agent.
- **Time:** token expiry, the node wait, the fallback's retry, the offer timeout and the queue sweep read the `Clock` port or a setting.
- **Live tests:** a test that needs Docker, a cluster, Linux or macOS is a `*.live.test.ts` file, never a conditional test in a CI file. Ticket 35's jobs run them, once, at the launch gate (*changed 2026-11-21: they kept their logs as live evidence*).

---

## 9. Every ticket's checks and commit

As milestones 1 to 4 (`../m1-first-pr/spec.md`, section 9). In short:
- `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for the touched packages, and `pnpm check:licenses` passes.
- Tickets that touch auth, credentials, the schema, the runner protocol or anything that runs agent output (01, 02, 04, 07, 08, 09, 10, 11, 12, 16, 17, 18, 19, 20, 21, 24, 37) run all the checks for the whole repo.
- Every new setting has a working default and its line in `docs/configuration.md`. A fresh install with only the required settings still works, with no registry, no Kubernetes and one pool.
- **Proof** (`AGENTS.md`; *changed 2026-11-21, the maintainer: "keep tests, drop extras"*): each condition of a row's "done when" has a test named with its key (`it("F-nnn/c1: ...")`) that exercises it through the real code path, and CI runs it. No break-it pass, no proof file. A condition only a live run shows (Linux, macOS, kind, the e2e workflow) waits for the launch-gate Proof run.
- No secret in the commit. Logs carry IDs and fields, never join tokens, runner keys, access or task tokens, registry credentials, prompts or agent output. No runner label, pool name or registry URL is interpolated into a shell command: the executors pass arguments as arrays, and the Kubernetes objects are built as typed values, never from templates of strings.
- A `package.json` change goes with its `pnpm-lock.yaml`. `@kubernetes/client-node` is confirmed (ADR 0007) and joins the `kubernetes` executor in ticket 07; nothing else new is added without the maintainer's yes (section 10).
- Stage only the ticket's own paths, a gitmoji message of at most 50 characters, no AI attribution, `git pull --rebase origin main`, `git push origin main`, retrying on a rejected push.
- The ticket file gets its `Status:` updated and a line under `## Comments` with the commit's hash.

### 9.1 How each row gets proved

Each condition of a row's "done when" gets a test named with its key. This is where those tests are expected to come from; the building tickets write them, and ticket 37 checks every one. The last column is the honest part: what this machine can't prove, where it's proved instead (the launch-gate Proof run, since 2026-11-21), and what keeps a row `building` until then.

| F-ID | Proved by tests (kind, ticket) | Live evidence here (step of section 3) | Needs what this machine lacks |
|---|---|---|---|
| F-091 | Integration on core's register endpoint: each token kind accepted or refused, expiry by the clock, shown once, stored hashed, a rotation that keeps joined runners connected, approval on every accepting path, the audit entry and the notice in the join's transaction (12, 25) | Steps 1 to 3 | Nothing |
| F-092 | The fleet's procedures and their counts against seeded pools; drain through disconnect, restart and server restart; resume to online and to offline; the `resume` command applied once; "not isolated" and the `kubernetes` line from the capabilities (15, 26, 31) | Steps 4 and 9 | Nothing |
| F-013 | The fallback's three triggers and its retry against ticket 06's proxies; one event stored once over HTTP; a steer over HTTP; the packed CLI's `engines` and its start (11, 18, 19) | Step 11 | Real nginx's defaults and the runner image (ticket 35) add to the proof; neither is needed for the row, since the nginx emulation is spike 6's and the npm CLI meets its "or" |
| F-014 | Two at once; the containment the runner reports on each system; the panel's line (10, 19, 31) | Step 8, with the job object on Windows | **macOS** (the marker sweep, a detached helper found) and **Linux** (a delegated cgroup, killed as a unit): ticket 35's `macos-15` and `ubuntu-24.04` jobs. Until then those rows are `partial` |
| F-015 | Against the fake engine and the fake API: the runner creates and removes boxes only; a runner restart leaves its boxes' sidecars connected; credentials reach the sidecar's mount only and nothing is written to the host; a `host` pool refuses to start without its agent user (07, 09, 10, 19, 20) | Step 12, on the fake cluster's process mode | **Linux with Docker:** real boxes whose sidecars connect on their task token while the runner restarts, and the `host` pool's separate OS user (`useradd`, a sudoers rule for that user only) reading nothing of the runner's: ticket 35 |
| F-093 | Against the fake API: the pod's shape, the namespace and service account only, the registry image by digest, the dispatch accepted at once and "waiting for a node" from the scale-up event, the 1.29 check (07, 08, 20) | Step 12 | **A cluster:** kind 1.29 and the current release in ticket 35 (a box ready in under 60 s on a warm node, measured; native sidecars). **An autoscaler that really adds a node:** ticket 38's cluster. The autoscaler's row is `partial` until then, so the row stays `building` |
| F-120 | Against the fake registry: the check, push with the push credential and pull with the pull one, by digest; a `kubernetes` pool's box refused without a registry; a `docker` host without one builds and keeps its own (milestone 3's test, kept) (09, 17, 21, 28) | Step 13 | **Linux with Docker:** a real push to `registry:2` and a pull on a second runner; **kind:** the kubelet pulls with the per-box secret, and the rootless BuildKit pod builds, scans and pushes: ticket 35 |
| F-095 | The sizes per organization; a project's default; caps in total and per project at admission; the fake engine's and the fake API's limits equal the size; `host` refuses a size and counts slots (05, 09, 07, 10, 13, 27) | Step 5 | **Linux with Docker and kind:** the limits read back from the running containers' cgroups, and a stress inside the box held at them: ticket 35 |
| F-067 | Capacity from slots and resources; the personal runner's two; the queue's order; admins see and cancel; the share under fifty raced admissions from three replicas, counted from rows (05, 13, 26) | Step 6 | Nothing |
| F-069 | `chooseRunner`'s table: pools in order, labels, capacity, personal runners only for their member's own tasks, tasks no member started to pools, services never to `host` (05, 14, 27) | Step 7 | Nothing |
| F-061 | The window on both carriers with its message; the pin against the fake npm registry; the panel's version state; the compatibility matrix over recorded fixtures (16, 19, 31) | Step 10, with real builds one minor apart | Nothing |
| F-039 | The Dockerfiles' static checks: pins, the checksum from the repo, no secret (22) | Step 14 | **Linux with Docker:** the three images built, sized, and each started (the server's `all` answers its health check, `ostra --version` in the runner, OpenCode's version and checksum in the base): ticket 35. The row is `done` only when published, in milestone 7 |
| F-116 | The rules `egressRules` builds and the NetworkPolicy the chart renders, against the baseline's list; the sidecar's exception for the server's address only (08, 09, 24) | Step 14 | **Linux with Docker:** every probe from a shell in the agent's container, with its positive control, the gateway probed, a timeout counted inconclusive. **kind with Calico, and a second kind cluster without NetworkPolicy:** the control pod tells them apart. The canary in the event log on both. All ticket 35 |
| F-118 | The values schemas in Zod against `values.yaml` and every example; `helm lint` and `helm template` with only the required values when Helm is installed (ticket 23's decision), the rendered manifests checked: the runner's role is namespaced, the shared secret is made once, every value is in the configuration reference (23) | Step 14, with the render's log | **A cluster:** both charts installed on kind with only their required values, the server answering and the runner joining: ticket 35 |
| F-117 | The harness's own tests: a simulated runner speaks the real protocol, the steer timer, the Postgres CPU sampler (34) | Step 15: the largest step that held | **Linux, at full scale:** 1,000 tasks on three core replicas and one Postgres, with the generator as several processes: ticket 38's machine (a hosted runner's 4 vCPUs are too small). The row stays `building`; the gate is milestone 7 |
| F-086 | The project's pool list in order, with its shares (27) | Step 1 | Nothing |

---

## 10. What each ticket ports

| From | What | To (ticket) |
|---|---|---|
| `spikes/runner-transport/src/server/replica.ts` | the HTTP carrier's endpoints: `hello`, `up`, the 25 s `down`, the epoch and `409` | 11 |
| same, `src/runner/peer.ts`, `src/runner/run-runner.ts` | the fallback's three triggers, the WebSocket retry, `--transport` | 18 |
| same, `src/harness/net-proxies.ts`, `src/harness/certs.ts` | the CONNECT and TLS-inspecting proxies, the cut, the nginx emulation, per-run certificates | 06 |
| same, `src/loadgen/loadgen.ts`, `src/harness/cluster.ts`, `src/harness/spike1-rate.ts` | many peers in one process, the replicas' start, the event rate's source | 34 |
| `spikes/what-is-inside-a-box/deploy/k8s/box-pod.yaml` | the pod's security context, volumes and the shared loopback bridge | 07 |
| same, `deploy/k8s/egress-baseline.networkpolicy.yaml`, `namespace.yaml` | the baseline's ranges, DNS, the namespace's labels | 08, 23 |
| same, `deploy/k8s/buildkit-rootless.yaml`, `deploy/snapshot/build-rootless.sh` | the rootless BuildKit pod and its build | 08 |
| same, `src/attack/checklist.ts`, `src/sidecar/box-network.ts` | the egress probes, their positive controls and the inconclusive timeout, the control pod | 24 |

**Dependencies.** `@kubernetes/client-node` (Apache-2.0, confirmed in ADR 0007) joins the `kubernetes` executor; its `loadAllYaml` also reads the charts' rendered manifests in `packages/deploy-checks`, so no YAML library is added. Helm and kind are tools on the machine, not dependencies: Helm is installed by hand here when the maintainer agrees (ticket 38), and both are set up in ticket 35's job by their official release, pinned with a SHA-256. ECR pushes would need `@aws-sdk/client-ecr`, which isn't added (section 11, item 11).

---

## 11. Choices this spec makes

The maintainer delegated every decision of this spec on 2026-11-19. Each choice below is the recommendation applied, recorded in `context/open-questions.md` under its number and, where it's hard to reverse, in an ADR. If the maintainer disagrees with one, it moves back to the open list and the ticket that holds it changes.

1. **Where the proofs that need other machines run** (Q230, ADR 0061). In jobs of the manual `proof.yml` workflow on GitHub's hosted runners (`ubuntu-24.04` for Docker, kind, Calico, a registry, BuildKit, Helm and nginx; `macos-15` for `host` on macOS), never in `ci.yml`, with their logs kept in the repo as live evidence. The real autoscaler and the full-scale load test on the maintainer's own machine and cluster.
2. **What a runner offers** (Q231, ADR 0059). Slots everywhere, and CPU and memory on `docker` and `kubernetes`, reported in every `status`. A box needs a slot and, where sizes apply, its size's CPU and memory. A personal runner offers 2 slots by default.
3. **The queue** (Q232, ADR 0059). One per pool: the queued tasks that pool could run, in ticket priority order (Urgent, High, then Medium with prompt tasks and tickets without a priority, then Low), then by when they were queued. Admins see it and cancel a task from it, which stops the task as `cancelled`. Admission is a pool-keyed job and a 5 s sweep.
4. **A project's share** (Q233, ADR 0059). A cap in boxes per project and pool (`ProjectPool.maxBoxes`), none by default, counted from ostra's rows in the admitting transaction under the pool's lock. A project at its share is passed over, so the next project's task starts.
5. **Labels** (Q234, ADR 0059). A runner's labels from `OSTRA_RUNNER_LABELS`, plus `executor:`, `os:` and `arch:`, which only ostra sets. A profile names the labels its tasks need; a runner must carry every one. No expressions.
6. **Which runner** (Q235, ADR 0059). The project's pools in the project's order; in a pool, the fitting runner with the most free room, then the one with the project's snapshot, then the least recently offered. A member's personal runner only for tasks that member starts and picks it for; tasks no member started go to pools only.
7. **Box sizes** (Q236, ADR 0059). Three named sizes per organization, values editable, no more names in v1. A size limits the agent's container; the sidecar and each service have their own fixed limits, and capacity counts all three. On `kubernetes` requests equal limits.
8. **The pod** (Q237, ADR 0060). One pod per box: the agent as its container, the sidecar and the services as native sidecars (the sidecar first). The task token and the pull credential in `Secret`s the runner makes per box, mounted only where each is needed, deleted with the pod. No service account token in the pod.
9. **Waiting for a node** (Q238, ADR 0060). Unschedulable with a scale-up event: `box.waiting { reason: "node" }`, and the dispatch already accepted. After 15 minutes the box fails as "no node" and the task goes back to the queue, not counted as a crash.
10. **The server under the egress baseline** (Q239, ADR 0060, ADR 0029 amended). The baseline's one exception is the ostra server's address (and DNS on `kubernetes`), plus `OSTRA_EGRESS_ALLOW` for a private model endpoint an admin names. On `kubernetes` the agent shares the pod's network, so it can reach the server's address too: it holds no token there, and the runner page says so with the internet line.
11. **The registry** (Q240, ADR 0060). One per organization, Basic credentials (GHCR, Harbor, Docker Hub, GitLab, Quay, ACR tokens), a push credential and a pull credential that may differ, or "the cluster's own identity" for pulls on `kubernetes`. Images are named per project and snapshot and used by digest. ECR pushes need AWS's SDK and wait for the maintainer's yes (ticket 38); ECR pulls work through the node's identity.
12. **The Helm charts** (Q241, ADR 0060). `deploy/helm/ostra-server` and `deploy/helm/ostra-runner`, versioned with the release, values schemas written in Zod and generated as `values.schema.json`. The server's shared secret is made once on install (`lookup`, kept on upgrade) or named with `existingSecret`. Checked with `helm lint` and `helm template` where Helm is installed, and always with the schema check.
13. **A `host` pool's OS user** (Q242, ADR 0029 amended). Linux and macOS: the admin makes the user and a sudoers rule for it alone, and the runner starts the agent through `sudo -n -u`. Windows: a `host` pool runner refuses to start in v1, with the reason. `OSTRA_DEV_HOST_POOL_SAME_USER` for development only.
14. **The pin** (Q243, ADR 0034 amended). At every start, an npm-installed runner whose version differs from the server's installs the server's into its data folder, checks the package's integrity, and runs it. An image runner installs nothing: its tag is the pin, and the panel shows when it differs. `OSTRA_RUNNER_PIN=false` turns it off.
15. **The images before they're published** (Q244, ADR 0046 amended). `pnpm images:build` on Linux, in ticket 35's job and on the maintainer's machine; `pnpm check:images` everywhere. Tags are the release version; nothing is pushed anywhere public before milestone 7.
16. **The load test here and on Linux** (Q245, ADR 0061). A ramp of 100, 250, 500 and 1,000 tasks on this machine, the largest step that holds every bar recorded; the 1,000-task run on Linux with a real Postgres. The bars are F-117's.
17. **The protocol window** (Q246). Minor 4. A minor-3 runner keeps working with no resume, no sizes and no registry image; a `kubernetes` runner needs minor 4.
18. **Runner notices** (Q247). Every join notifies the organization's admins in the panel and by mail; a join that waits for approval is also a needs-you item for them, resolved by the approval or the reject.
19. **Cancelling a queued task** (Q248). A new stop reason `cancelled`; the task can be reopened like any stopped task, and the audit log has `task.cancelled`.

---

## 12. Screens that need a design target

`build-order.md`: a milestone's screens are designed first, image first. The maintainer requires the `ui-taste` skill and Higgsfield targets, approved before building, against `context/brand/brief.md` and `context/brand/app-design.md`. **This spec names them; ticket 29 makes them,** in the form milestones 1 to 4's approved targets have (`context/brand/app-targets/m1/README.md`: a picture, a build spec and a prompt per screen). Until they're approved (recorded in ticket 29's `## Comments`), tickets 30 to 33 don't start their UI; their routers and tests can go ahead.

**New targets**, for what's new in milestone 5:

| # | Target | Screen | Feature | Starts from |
|---|---|---|---|---|
| 1 | `pool` | A pool's page: its runners (state, executor, version, labels, carrier, containment, busy slots), its busy boxes per project against each share, its queue in order with each task's priority, project, wait and "Cancel", its caps, its join tokens, the approval switch, and the "not isolated" or "the agent has direct internet access" line | F-092, F-067, F-091 | `app-targets/m1/runners` |
| 2 | `pool-new` | The New pool sheet: name, "Require approval for new runners", the box cap, the token lifetime (30 days, another, none) and the projects allowed on it | F-091 | `app-targets/m4/member-invite` |
| 3 | `pool-join` | A join token shown once, with three ways to start a runner (`ostra runner`, `docker run` of the runner image, the Helm chart's values), "Copy", the token's expiry, and the list of the pool's tokens with "Revoke" | F-091, F-013, F-118 | `app-targets/m4/member-invite-link` |
| 4 | `runner` | A runner's page: state with its connection, carrier (WebSocket or HTTP), version against the server's with its state and fix, executor, containment, install, slots and resources, labels, the token it joined with and who approved it, its boxes now, and "Drain", "Resume", "Revoke" with their confirms | F-092, F-061, F-013 | `app-targets/m1/runners` |
| 5 | `runner-approval` | A runner waiting to join: the needs-you row for admins and the approval panel (host, system, executor, labels, version, the token used, when it joined, its key's fingerprint), "Approve" and "Reject" | F-091 | `app-targets/m3/task-approval` |
| 6 | `box-sizes` | Organization, "Box sizes": small, medium and large with vCPU and memory, where each is the default, and the line that `host` counts slots only | F-095 | `app-targets/m2/storage-settings` |
| 7 | `project-runners` | A project's settings, "Runners": the allowed pools in order with drag to reorder, the project's share of each, its default box size, and the line on personal runners | F-069, F-095, F-086 | `app-targets/m4/project-access` |
| 8 | `registry` | Organization, "Registry": address and prefix, the push and pull credentials (or "the cluster's own identity"), "Check" with its result, the pools that need it, and the snapshots it holds with their digests | F-120 | `app-targets/m2/storage-settings` |

**Screens that only grow**, built against their existing targets with the changes listed in the ticket that builds them:
- `app-targets/m1/runners`: the pools table gains Queue and Labels, and the `kubernetes` chip; a row opens its pool's page; runner rows gain the carrier, an "outdated" chip and the row menu (Drain, Resume, Revoke); "Your machine" gains its containment and "2 tasks at once"; the connect command moves into `pool-join`.
- `app-targets/m1/task-new`: the runner picker ("A pool" by default, "Your machine", each disabled with its reason) and the box size it will get.
- `app-targets/m1/task` and `app-targets/m2/task-limits`: the waiting line for each new reason (the queue's place, a share reached, "Waiting for a node", labels no runner has, a pool that needs a registry, "Cancelled by Demo"), and the runner and box size in the properties panel.
- `app-targets/m3/agent-profile`: a "Runner labels" field.
- `app-targets/m3/environment-services`: the snapshot's registry reference and digest, where it was built, and the `kubernetes` build's state.
- `app-targets/m1/home` and `app-targets/m3/needs-you`: the "wants to join" row for admins.
- `app-targets/m3/email-needs-you`: the runner-joined and awaiting-approval mail variants.
- `app-targets/m1/device`: no change; the personal runner's sign-in stays as it is.
