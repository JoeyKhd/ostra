# 22: The `docker` executor, the three images and the compose file

Status: ready-for-agent
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

- [ ] Unit tests pass on this machine. The live suite exists and skips with "no Docker on this machine".
- [ ] The executor contract suite runs against the fake Engine API.
- [ ] The Dockerfiles and compose file are linted (`hadolint` is not added; a test parses the compose file and checks its services and that no secret value is in it).
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add the docker executor and images`.

## Comments
