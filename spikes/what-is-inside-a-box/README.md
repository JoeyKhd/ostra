# Spike 3: what is inside a box?

Milestone 0, spike 3 (`context/build-order.md`). Throwaway code: it answers one
question, and its finding goes into `context/research/` once the runs that need
a host with Docker and a Kubernetes cluster are in.

Builds on spike 1 (`spikes/how-should-the-runner-drive-opencode`). Spikes never
import each other, so the ACP driver, the key proxy, the stub model servers, the
process-tree helpers and the OpenCode launch helper are **copied** into
`src/lib/`, with one change to the driver: the agent's process comes from an
`AgentHost` seam, so the same driver runs the agent as a local child (spike 1's
way, and the `host` executor) or, in a box, through the bridge to the agent's
container.

## The question

Does the box (agent container, sidecar, services) hold on Docker and on
Kubernetes?

**Tests the decisions:** Q26, Q27, Q38, Q95, Q96 (ADR 0029 the box and its
sidecar, ADR 0030 no credential in the agent's container, ADR 0031 the safety
minimum, ADR 0038 snapshots and services, ADR 0046 the three images).

**Passes when** (copied from `context/build-order.md`):

- From a shell in the agent's container, none of these works: reading a model
  key or a GitHub token from the environment, the process list, files or the
  network; answering its own approval; reaching a private address, the metadata
  address or another box, another box's git proxy port included (the proxy has
  no per-task secret in its URL, ADR 0030). The shell also can't use OpenCode's
  loopback port: it calls the port with no password and fails, and the password
  can't be read from the process list, `/proc/<pid>/environ` or
  `/proc/<pid>/cmdline` (spike 1, item 5).
- The bridge between sidecar and agent carries a 20-minute turn, and stopping a
  task leaves no process.
- A box is ready in under 10 s on Docker with the image present, and under 60 s
  on a warm Kubernetes node *(working values)*. 50 boxes run on one host. The
  sidecar stays under 100 MB, a number to set after measuring the driver alone
  on Linux first: it was 83 to 88 MB on Windows in spike 1.
- A snapshot builds from a generated Dockerfile on both. A setup secret isn't
  found in any layer. A database service is reachable from the agent's
  container.
- The same checks pass with gVisor as the runtime.

**If it fails:** one container per box, with the runner as a separate OS user
(Q27 as first written).

## Architecture

A box is the agent's container (repos and tools, no credentials), an ostra
sidecar (the credentials, both proxies, the ACP driver) and the environment's
services, on a private network (ADR 0029).

```
server stand-in (the harness)
  │ 1. handoff: the task's credentials, from OUTSIDE the box
  │    (Docker: TCP on host loopback; k8s: kubectl exec to a sidecar-only Unix socket)
  │ 3. control API: turns, approvals, cancel, stop, status, attack (same transport)
  ▼
agent container (ostra/base)              sidecar (ostra/runner)
  tini (PID 1)                              credentials in memory
   └─ init (root; SETUID/SETGID/KILL)       ├─ key proxy ── stub, or the model.env endpoint
        │ connects out to the bridge once   ├─ git proxy ── stub http-backend
        ▼ (then the bridge port closes)     ├─ ACP driver ─ drives via the bridge
     opencode acp (uid 1000, fake key) ◀────┘ bridge: prepare/spawn/stdio/ps/kill
     attack checklist (uid 1000, the agent's exact env; POST /attack)
                                            services: postgres
```

- **The bridge** (`src/bridge/`) is one TCP connection the box's init opens *out*
  to the sidecar. The sidecar accepts the first connection with the box's
  one-time nonce, then closes the port. Over it the sidecar spawns `opencode acp`
  as the agent's user, carries its stdio, and lists and kills its processes.
  Newline-delimited JSON, every frame strict-Zod-validated; request and process
  ids are branded.
- **The handoff** (`src/sidecar/handoff.ts`) delivers the credentials to the
  sidecar from outside the box; the listener then closes. On Docker it is a TCP
  port published to the host loopback, and connections from the box network are
  refused by address. In a pod the agent shares loopback, so no address can tell
  the runner from the agent: there the handoff and control API listen on Unix
  sockets in an emptyDir only the sidecar container mounts, reached with
  `kubectl exec -c sidecar … handoff-client.ts` / `control-client.ts`.
- **The key proxy and git proxy** are the agent's only way to a model and to
  GitHub (on Docker). The git proxy refuses any ref but the task's branch and its
  hidden ref, and any delete, before a byte reaches the upstream; its log lines
  carry a code and a count, never the ref.
- **The attack checklist** (`src/attack/`) is ostra's red-team of the box
  boundary. The sidecar runs it through the bridge as the init's child, with the
  agent's exact environment and working directory (`POST /attack`); the real-box
  mode also runs it as a shell in the agent's container (`docker exec -i -u
  1000:1000 <agent> attack --json --config-stdin`, or `kubectl exec … setpriv
  --reuid=1000 … attack`). Its config, the secret markers included, arrives on
  stdin, so the checklist never finds its own copy in env, argv or `/proc`. A
  negative control plants a marker in the agent's env and requires `EXPOSED`.
- **The lifecycle** (`src/harness/box-run.ts`) is one set of steps and
  assertions for every box: ready, the bridge port probed shut, a held approval,
  the checklist and its negative control, the approval still pending, a turn, a
  long turn, then a process tree (background server, detached grandchild, long
  sleep) and a stop, with survivors counted from the process list, not from the
  sidecar's report.
- **The loopback rehearsal** (`src/harness/box-fixture.ts`) runs the box's whole
  protocol on one machine, without containers: the init is a child process, the
  agent its child.
- **The real-box mode** (`src/harness/real-box.ts`) runs the same lifecycle on
  Docker (`docker compose -p ostra-<id>`) and Kubernetes (the pod filled in and
  `kubectl apply`'d), with a second box as the "other box" target, N boxes at
  once, and the snapshot build with a layer scan and a negative control.
- **The deploy artifacts** (`deploy/`): the two Dockerfiles, a compose file for
  one box (no fixed name, subnet or host port, so many can run), the pod, the
  namespaces (Pod Security `baseline` for boxes, `privileged` for the BuildKit
  namespace), the egress NetworkPolicy, the rootless-BuildKit build, and the
  gVisor config for both.

## Running it

From this directory only (its own `pnpm-workspace.yaml` keeps it out of the root
workspace):

```
pnpm install
pnpm check:inputs     # which inputs are present (never prints a value)
pnpm spike            # every criterion that can run here; PASS/FAIL/SKIPPED per check
pnpm validate         # the static checks of deploy/ alone
pnpm typecheck
pnpm lint
pnpm test             # unit tests
```

`pnpm spike` flags:

| Flag | What it does |
|---|---|
| `--real=docker,k8s` | the real-box mode on these targets |
| `--long=<s>` | the long turn (default 20; the bar's is `--long=1200`) |
| `--boxes=<n>` | Docker: boxes at once (default 50 with `--real=docker`; 0 skips) |
| `--runtime=runsc` | Docker: run the agent container under gVisor |
| `--runtime-class=gvisor` | Kubernetes: the pod's RuntimeClass (empty: the node's default) |
| `--no-snapshot` | Docker: skip the snapshot build |
| `--no-box` | skip the loopback rehearsal and the endpoint turn |
| `--only=P1,V1` | print only these criteria (the summary and the exit code still cover all) |
| `--json` | print the report as well |

The full set for the bar, on a Linux host with Docker and a cluster:

```
docker build -f deploy/docker/Dockerfile.base -t ostra/base:spike3 .
docker build -f deploy/docker/Dockerfile.runner -t ostra/runner:spike3 .
kubectl apply -f deploy/k8s/namespace.yaml -f deploy/k8s/egress-baseline.networkpolicy.yaml -f deploy/gvisor/runtimeclass.yaml
pnpm spike --real=docker,k8s --long=1200                                   # runc / the default runtime
pnpm spike --real=docker,k8s --long=1200 --runtime=runsc --runtime-class=gvisor   # the same under gVisor
```

### Which input each criterion needs

| Criterion | Runs here | Needs for the rest |
|---|---|---|
| P1 attack checklist | the loopback half (env, files, handoff, bridge, approval, the negative control, the held approval, the key proxy); the real-endpoint turn when `model.env` is present | `--real=docker` (Docker + the two images) and `--real=k8s` (a cluster): /proc, the OpenCode port, metadata, private, other box and its git proxy |
| P2 bridge turn + clean stop | a 20 s turn, the process tree and the stop over the real bridge | `--real=… --long=1200` for the 20-minute turn in a real box |
| P3 ready time, 50 boxes, sidecar < 100 MB | nothing (the loopback process is the harness, not the sidecar) | `--real=docker` (ready < 10 s, 50 boxes, RSS); `--real=k8s` (ready < 60 s) |
| P4 snapshot, layer scan, database | nothing | `--real=docker` with `buildctl` + rootlesskit and `OSTRA_SNAPSHOT_BASE_IMAGE` (ostra/base by digest, pullable); the database probe needs the real box |
| P5 gVisor | the gVisor config on both is valid | `--runtime=runsc` (runsc in Docker), `--runtime-class=gvisor` (a gVisor node) |
| V1 deploy artifacts (not a bullet) | all of it | — |

The model endpoint (`OSTRA_DEV_MODEL_BASE_URL`, `_API_KEY`, `_ID`, from the
environment or `~/.config/ostra-dev/model.env`) is optional. When present, one
real turn goes through the key proxy on the loopback box: the agent holds the
proxy's fake key and the proxy swaps in the real one ([endpoint] in P1). The
lifecycle itself always uses the stub model, whose scripted steps (approval,
long sleep, process tree) a real model can't be made to follow. No secret and no
model provider is hard-coded; secrets go to the tools on stdin or in env, never
in argv.

## Status on this machine (2026-11-18, win32 x64, Node 24.14.0, no Docker, no cluster)

`pnpm typecheck` and `pnpm lint`: clean. `pnpm test`: **47 passed** (8 files).
`pnpm validate`: every file ok. `pnpm spike` (run at 2026-11-18T20:01:30Z):
**1 PASS, 0 FAIL, 5 SKIPPED** of 6 criteria; **bar: 0 of 5 bullets PASS**.
`check:inputs`: the model endpoint is present (from `model.env`); Docker,
kubectl, a cluster and buildctl are missing.

| Criterion | Status here | What ran, or the input it needs |
|---|---|---|
| P1 attack checklist | **SKIPPED** | Ran as the agent, through the bridge, with the agent's env: env, files (10 files under the task root), handoff (ECONNREFUSED), bridge (ECONNREFUSED) and approval (HTTP 401 twice) **BLOCKED**. The negative control (a marker planted in the agent's env) was **EXPOSED**, as it must be. The held approval was still pending after the attack, and the key proxy swapped 3 of 3 calls. The real endpoint turn finished (`end_turn`) and the proxy swapped the fake key for the real one on 2 of 2 calls. **SKIPPED:** /proc and the OpenCode loopback port (no /proc on Windows); metadata, private, other box and its git proxy (no egress policy on one host); every [docker] and [kubernetes] check. |
| P2 bridge turn + clean stop | **SKIPPED** | Ready through the bridge in 1027 ms, a turn finished (`end_turn`), a 20 s turn finished, the tree had 5 marked processes before the stop, and **0** were alive afterwards, counted from the process list (the sidecar also reported 0). **SKIPPED:** the 20-minute turn in a real box. |
| P3 ready time / 50 boxes / sidecar RSS | **SKIPPED** | Nothing ran. Recorded: `harnessProcessRssMb = 96`, the whole harness process (sidecar, driver, stubs, harness), **not** the sidecar's RSS. |
| P4 snapshot + layer scan + database | **SKIPPED** | Nothing ran. The layer scan is unit-tested on a hand-made OCI tarball (it finds a canary in a gzipped layer and clears a clean one); that is not a built image. |
| P5 gVisor | **SKIPPED** | `daemon.json` (`runtimes.runsc.path`) and `runtimeclass.yaml` (`handler: runsc`, no provider scheduling) are valid. No check ran under runsc. |
| V1 deploy artifacts | **PASS** | All 7 YAML files parse. The pod has the init's capabilities, a templated runtime class and sidecar-only sockets. The namespaces are `baseline` for boxes and `privileged` for builds, and the RoleBinding's subjects exist. The BuildKit Job is in `ostra-build` with the AppArmor field. The compose file has the init's capabilities, no fixed name, ephemeral host ports and a templated subnet and runtime. The base Dockerfile frees uid 1000 and checks the binary's sha256. The snapshot generator mounts the secret. All of it was read, none of it was run. |

No process was left after the run (process list checked by marker), and the
run's temp dirs were removed. One empty `%TEMP%\ostra-box-TWOB3w` from an earlier
run (before the cleanup fix) is still there. It is outside this directory, so it
was left alone.

## What's left

Everything below needs inputs this machine doesn't have. The real-box mode is
written and typechecked but **has never run**.

- Build `ostra/base` and `ostra/runner` on a Linux host with Docker. This is the
  first test of the Dockerfile fixes (uid 1000 freed from `node`, the binary
  sha256 check) and of the compose file's init capabilities.
- `pnpm spike --real=docker --long=1200`: the checklist through the bridge and
  as a shell in the agent's container, egress included; the 20-minute turn; the
  stop; ready < 10 s; 50 boxes; the sidecars' RSS. Also apply
  `deploy/docker/egress-baseline.sh` for the sidecar's own egress.
- The snapshot build with rootless BuildKit (`OSTRA_SNAPSHOT_BASE_IMAGE`,
  `buildctl`): the layer scan of the built image and its negative control.
- `pnpm spike --real=k8s` on k3s or kind: the pod under Pod Security `baseline`,
  the handoff and control API over the sidecar's Unix sockets, ready < 60 s, the
  database from the agent's container, the NetworkPolicy.
- The snapshot on Kubernetes: staging the build context into the BuildKit Job
  isn't built yet, and it needs `OSTRA_REGISTRY`. The Job's
  `allowPrivilegeEscalation` was left at its default, because rootlesskit's
  setuid `newuidmap` should need it (a prediction, to confirm on the cluster).
- Both again under gVisor (`--runtime=runsc`, `--runtime-class=gvisor`).
- A Docker/Kubernetes difference to record in ADR 0031 (runner parity): in a pod
  the agent shares the sidecar's network namespace, so the NetworkPolicy's
  public-internet egress is the agent's too, and its only exit isn't the
  sidecar as it is on Docker. Standard NetworkPolicy can't select a container;
  the allowlist (F-052) or a separate network namespace for the agent closes it.
  Noted in `deploy/k8s/egress-baseline.networkpolicy.yaml`; the ADR is outside
  this spike's directory.
- The bar's OpenCode-port password half: the checklist calls every other
  loopback listener without a password, but it can't search `/proc` for a
  password it doesn't know. Spike 1's finding covers how OpenCode holds it.
- Then the finding goes in `context/research/spike-what-is-inside-a-box.md`.

## Dependencies (exact, pinned)

Runtime:

| Package | Version | License | For |
|---|---|---|---|
| `@agentclientprotocol/sdk` | 2.7.0 | Apache-2.0 | the ACP driver (copied from spike 1) |
| `zod` | 4.6.7 | MIT | boundary validation (handoff, bridge frames, control API, attack config, env, snapshot spec) |

Dev:

| Package | Version | License | For |
|---|---|---|---|
| `@opencode/cli` | 2.3.2 | MIT | the pinned OpenCode binary, for the loopback rehearsal (the base image fetches and checksum-verifies its own) |
| `typescript` | 7.0.2 | Apache-2.0 | typecheck |
| `vitest` | 5.1.1 | MIT | unit tests (the root's version; see the comment in `pnpm-workspace.yaml`) |
| `yaml` | 2.9.1 | ISC | parsing and shape-checking the deploy YAML. **Not on the pre-approved list: awaiting the maintainer's OK**, else a minimal reader replaces it |
| `@types/node` | 24.19.2 | MIT | Node types |

ESLint and typescript-eslint resolve from the root workspace, as in spike 1.

Container images referenced by the deploy artifacts (not npm packages):
`node:24.14.0-bookworm-slim`, `postgres:18.6-bookworm`,
`moby/buildkit:v0.35.0-rootless` (Apache-2.0), and gVisor `runsc` (Apache-2.0).
Tools the real-box mode calls, when present: `docker` / `docker compose`,
`kubectl`, `buildctl` + `rootlesskit`, `tar`, `bash`.

## Notes and limits

- The loopback rehearsal can't show the kernel boundary. The agent runs as the
  developer (the init isn't root), so the attack's env, files and network checks
  are real, but "as uid 1000" isn't. The address-based refusal on the handoff and
  control ports is unit-tested (`test/box-network.test.ts`), and the socket
  handoff is tested end to end with `handoff-client.ts`
  (`test/handoff-socket.test.ts`, over a named pipe on Windows).
- Stop: the init kills the agent's tree, then every process of the agent's UID
  (Linux), or every live descendant of itself (elsewhere), and reports what is
  still alive. The harness doesn't trust that report: it counts the tree's
  marked processes and the init's descendants from the process list itself.
- Rootless Docker with gVisor is fragile (ADR 0031, gVisor #12575); a known
  limitation for the real runs.
