# 09: Docker executor: sizes, registry images and pushes

Status: ready-for-agent
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

- [ ] Tests against the fake engine, named for `F-095`, `F-120` and `F-015`: the limits per container equal the size and the fixed ones; a pull's credential appears in no container and no file; a push happens only after a clean scan; the token is mounted only into the sidecar.
- [ ] Break-it: dropping `MemorySwap` lets the fake engine record an unlimited swap and fails `F-095`'s test; recorded in `context/proof/F-095.md`.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add docker sizes and registry images`.

## Comments
