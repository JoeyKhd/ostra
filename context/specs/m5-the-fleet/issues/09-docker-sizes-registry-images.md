# 09: Docker executor: sizes, registry images and pushes

Status: done
Builder: adapters
Blocked by: 02, 06
Features: F-095, F-120, F-015, F-017
Packages: `packages/adapters/adapter-executor-docker` (`src/docker-executor.ts`, `src/engine.ts`, `src/boxes.ts`, `src/testing/fake-engine.ts`, `src/docker.live.test.ts`)
Spec: `../spec.md`, section 5.2; ADR 0059, ADR 0060

## What to build

- **Sizes as limits:** the agent's container gets the size as `NanoCpus` and `Memory`, with `MemorySwap` equal to `Memory` and a `PidsLimit`; the sidecar and each service get their own fixed limits; `boxSizes: true`.
- **`capacity()`:** slots from `OSTRA_RUNNER_SLOTS`, CPU and memory from the engine's `info` minus `OSTRA_RUNNER_RESERVE_*` and minus what the runner's live boxes hold.
- **Registry images:** a box whose spec names an image pulls it by digest with the pull credential, passed to the engine's pull call and kept nowhere (not in `~/.docker/config.json`, not on disk); milestone 3's local snapshot stays the path when there's no registry.
- **Pushes:** `buildSnapshot` with `push` tags the scanned image as the registry's name and pushes it with the push credential; the scan still runs before any push (ADR 0038); the digest comes back.
- **The task token** through `writeTaskTokenFile`, mounted only into the sidecar's container.
- **The fake engine** grows to record limits, pulls by digest with their credentials, pushes and runtimes.
- **The live file** (`docker.live.test.ts`, run by ticket 35) gains: limits read back from `docker inspect` and from the container's cgroup, a stress that stays at its limit, a push to `registry:2` and a pull on a second engine context, a box whose sidecar keeps its connection while the runner restarts.

## Done when

- [x] Tests against the fake engine, named for `F-095`, `F-120` and `F-015`: the limits per container equal the size and the fixed ones; a pull's credential appears in no container and no file; a push happens only after a clean scan; the token is mounted only into the sidecar.
- [x] Break-it: dropping `MemorySwap` lets the fake engine record an unlimited swap and fails `F-095`'s test; recorded in `context/proof/F-095.md`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add docker sizes and registry images`.

## Comments

- 2026-11-20: built. `engine.ts` pulls `repository@digest` and pushes through the Engine API with the credential in the call's `X-Registry-Auth` header only (never `docker login`, so nothing lands in `~/.docker/config.json` or a file), and reads a refused pull or push from the stream's error line, the token scrubbed from its words. `boxes.ts`: a size is the agent's `NanoCpus`, `Memory`, `MemorySwap` equal to `Memory` and `PidsLimit`; the sidecar and each service get the runner's fixed limits (`OSTRA_SIDECAR_*`, `OSTRA_SERVICE_*`, defaults 1000m/256 MiB and 1000m/1 GiB); a registry image is pulled before anything of the box is made and wins over the host's own snapshot; `limitsOf` reads each container's limits back from the Engine's inspect, and `readCapacity` the offer from its `info`. `DockerExecutor` declares `boxSizes: true`, answers `capacity()` from its last reading (`refreshCapacity`, also run by `health()`), hands a build's `push` to the runner's snapshots (which push only after the scan and return the registry's digest), and with `pool`, the pool runner's half, makes the box's containers and its token folder (`makeTaskTokenDir`/`writeTaskTokenDirFile`, mounted into the sidecar only) in `create` and removes them in `release`; the executor contract suite drives both halves, so every fleet case now runs on `docker`. The fake engine answers `info`, records pulls and pushes with their header's credential, refuses a container from a digest it never pulled, tags, and answers inspect with Docker's own swap default (as much swap as memory again), so a missing `MemorySwap` shows. The live file gains the cgroup and stress case, the runner-replaced case and the `registry:2` push and second-Engine pull (ticket 35). Choice: the offer is the runner's whole offer (the Engine's CPUs and memory less the reserve), not less its live boxes, because ticket 05 settled that core subtracts the boxes it placed from its own rows; subtracting here too would count each box twice. The sidecar's connection held across a runner restart needs core, so the live case shows the box and its sidecar untouched by a new runner, and the connection is the demo's (ticket 37). Proof: `context/proof/F-095.md`, `F-120.md`, `F-015.md` (all `partial` until `kubernetes` and ticket 35's Linux job), break-its recorded there: `MemorySwap` dropped (the fake engine showed 8192 MiB of swap for a 4096 MiB size), the push before the scan, the token folder mounted into the agent, the pull token in the agent's environment, and the local snapshot pulled as a registry image. Commit: `a11914c3` (`✨ add docker sizes and registry images`).
