# 05: Adapter SDK: executor additions for checks, snapshots and services

Status: ready-for-agent
Builder: adapters (contracts, first)
Blocked by: 01
Features: F-054, F-051, F-094
Packages: `packages/adapter-sdk` (`src/executor/`, `src/test-adapters/`)
Spec: `../spec.md`, section 5.2 ("`ExecutorAdapter`"); ADR 0038 (amended), ADR 0052

## What to build

- **`runChecks(input)`:** the checks in order, each with its timeout, run in the agent's environment (the box's agent container on `docker`, the worktree on `host`), each returning status, exit code, duration, the output's tail and the path of the full output for upload. The environment a check gets holds the environment's variables and never a model key, a GitHub token or the runner's own variables, and the suite asserts it.
- **`buildSnapshot(input)`** and **`hasSnapshot(snapshotId)`** for `snapshots: "image"`; **`prepareCache(input)`** for `snapshots: "host-cache"`. `create` takes the spec's `services` and `snapshot`, and an executor without `services` refuses a spec that has any.
- **Capabilities:** `services` and `snapshots`, declared by `host`, `docker` and the tiny executor in the same commit (`host`: false and `host-cache`; `docker`: true and `image`).
- **The executor contract suite** gains: checks that pass, fail and time out; a check that tries to read a model key or a GitHub token from its environment and finds none; output over the cap cut to its tail; a spec with services refused by an executor without them; a snapshot built, found and used (gated on Docker for `docker`); the host cache reused by a second task of the same project and not by another project's.

## Done when

- [ ] Tests: the suite passes against the tiny executor and `host`; the `docker` cases pass against the fake engine and are gated live on a Docker host.
- [ ] Every caller compiles.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add executor checks, snapshots, services`.

## Comments
