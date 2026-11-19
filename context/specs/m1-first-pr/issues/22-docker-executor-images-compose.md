# 22: The `docker` executor, the three images and the compose file

Status: resolved
Builder: runner
Blocked by: 21
Features: F-017, F-001, F-019 (the base image pin), F-050 (the base image)
Packages: `packages/adapters/adapter-executor-docker` (new, Apache-2.0), `apps/runner` (`ostra sidecar`), `deploy/` (new: Dockerfiles and `compose.yaml`), `docs/configuration.md`
Spec: `../spec.md`, sections 1 and 2

**This machine has no Docker.** Everything here is written in full and unit-tested. The live suite is written too, and skips itself unless `docker version` answers. It runs on the Linux machine (`build-order.md`, "Outside the code"), and until it passes F-017 stays `planned` and F-001 `building`.

## What to build

- **`DockerExecutor extends ExecutorAdapter`** (`isolation: "container"`), on `dockerode` (answers 4.6: confirm its license on npm, then pin exactly) or the Engine API over its socket with `node:http` if that's simpler. A box per task (ADR 0029):
  - a private network per box
  - the agent's container from the environment's base image (default: ostra's base image), with the repos and tools and no credential, as a non-root agent user
  - the sidecar container from the runner image, running `ostra sidecar` with a task token tied to the lease, holding the credentials, both proxies, the MCP tools and the ACP driver; it reaches the agent through a bridge (spike 3's `AgentHost` seam)
  - the egress baseline as host rules: no private ranges, no metadata address, no other box (F-116's first part; documented as unverified until the live run)
  - stop, release, and the box's states
- **`ostra sidecar`:** the task host (21) with a sidecar `ServerLink` that connects with the `sidecar` peer of ticket 01.
- **The images** in `deploy/`: the server (`ostra-server`, entrypoint `web`, `core` or `all`, built with `turbo prune --docker`), the runner (the CLI, which is also the sidecar), and the base (the tools, `@opencode/cli` 2.3.2 installed with scripts off and its platform binary's SHA-256 checked, the catalog as a file, a small init).
- **`deploy/compose.yaml`** (F-001): the server (`all`), Postgres, and one pool runner on the `docker` executor with the Docker socket mounted, and a comment saying that socket is root on the host and pools belong on dedicated hosts (Q97). Only the required settings, with defaults. The runner joins the organization's default pool with the **bootstrap join token** that core writes into a shared volume at first start (ticket 24), read through `OSTRA_JOIN_TOKEN_FILE`. Creating, listing and revoking join tokens in the panel is F-091, milestone 5.
- Unit tests against a fake Engine API: the containers, network, mounts, users and environment a box gets; that no credential is in the agent container's spec; release removes everything.

## Port from

`spikes/what-is-inside-a-box/` (the sidecar, bridge, init, snapshot Dockerfile, `deploy/`) once that spike is committed; until then ADR 0029, ADR 0030 and ADR 0046.

## Done when

- [x] Unit tests pass on this machine. The live suite exists and skips with "no Docker on this machine".
- [x] The executor contract suite runs against the fake Engine API.
- [x] The Dockerfiles and compose file are linted (`hadolint` is not added; a test parses the compose file and checks its services and that no secret value is in it).
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add the docker executor and images`.

## Comments

- 2026-11-18, runner: done in 9a3db82 (`✨ add the docker executor and images`), with the docker runner's settings added to the protocol's runner config, additively, in 0de13d0. **This machine has no Docker: the live suite skips with "no Docker on this machine", F-017 stays planned and F-001 building.** The split follows ADR 0029 and spike 3. The runner creates and removes boxes on the Engine API, over its socket with `node:http` (no new dependency): an `internal` box network, a task volume, the agent's container (the base image, the box's init as root under tini, every process as uid 1000, no credential in its spec) and the sidecar (the runner image, `ostra sidecar` as 1000, a read-only root, on the box network as `sidecar` and on a shared egress network with inter-container traffic off). Inside the box, `ostra sidecar` runs the same task host with `DockerExecutor`: the host executor's logic on the shared volume, with its processes run in the agent's container over the bridge (ported from spike 3, with a deadline on every request). The egress baseline is `iptables` rules for `DOCKER-USER` (`egress.ts`, `deploy/egress-baseline.sh`), unverified. `deploy/` holds the server, runner and base Dockerfiles, the server's entrypoint (`web`, `core`, `all`) and `compose.yaml` (the server, Postgres, and one pool runner joining with the bootstrap token through `OSTRA_JOIN_TOKEN_FILE`, with the socket's warning). Tests: the box specs, release and cleanup against a fake Engine API, the box dispatcher, the compose file parsed (no secret value), and the base image's OpenCode SHA-256s equal to the adapter's pins. **Two deviations:** the executor contract suite runs against `DockerExecutor` through the real bridge to a local init, not against the fake Engine API, because the Engine is the runner's side and isn't in the task's path. And the protocol has no task-scoped token for a sidecar, so a box's sidecar reads the runner's own 10-minute access token from a file the runner rewrites every 4 minutes. A token for one task, tied to its lease, is the contract change this waits on. Whole-repo checks green.
