# 02: Adapter SDK: sizes, capacity, registry images and the fleet's suite cases

Status: ready-for-agent
Builder: adapters (contracts, first)
Blocked by: 01
Features: F-015, F-093, F-095, F-120 (the executor contract)
Packages: `packages/adapter-sdk` (`src/executor/`, `src/testing/executor-suite.ts`, `src/test-adapters/`), `packages/adapters/adapter-executor-host`, `packages/adapters/adapter-executor-docker` (their declarations only)
Spec: `../spec.md`, section 5.2 ("`ExecutorAdapter`"); ADR 0059, ADR 0060

## What to build

- **Capabilities:** `registry` and `nodeWait`, declared by `host` (`none`, false), `docker` (`optional`, false) and the tiny executor in the same commit. `kubernetes` declares `required` and true when ticket 07 adds it.
- **`capacity()`:** `{ slots, cpuMillis, memoryMiB } | null`. The base class documents that it's read at every `status` and must not block.
- **`create`'s new input:** `size`, `image` (with its pull credential), `taskToken` and `onWaiting`. An executor with `boxSizes: false` refuses a size with `{ code: "sizes-unsupported" }`; one with `registry: "none"` refuses an image.
- **`buildSnapshot`:** `push: { ref, credential } | null` in, `digest` out.
- **The task token's handoff,** `writeTaskTokenFile(dir, owner)`, used by `docker` and `kubernetes` alike: a file readable only by the sidecar's user, never an environment variable or an argument (ADR 0034).
- **The executor contract suite** gains the cases of spec section 5.2: limits equal to the size, read back through the executor's own inspection; `host` refusing a size; an image pulled by digest with its credential found in no container; the task token readable only at the sidecar's mount; waiting, then scheduled, where `nodeWait` is true; release removing every object the box made. Cases that need a real engine or cluster go in the suite's live part, which ticket 35's jobs run from `*.live.test.ts` files.

## Done when

- [ ] Tests: the suite passes against the tiny executor and `host`; the `docker` cases pass against the fake engine; the `kubernetes` cases are ready for ticket 07's fake API.
- [ ] Every caller compiles.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add executor sizes, capacity and images`.

## Comments
