# 02: Adapter SDK: sizes, capacity, registry images and the fleet's suite cases

Status: done
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

- [x] Tests: the suite passes against the tiny executor and `host`; the `docker` cases pass against the fake engine; the `kubernetes` cases are ready for ticket 07's fake API.
- [x] Every caller compiles.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add executor sizes, capacity and images`.

## Comments

- 2026-11-19: built. `ExecutorCapabilities` gains `registry` and `nodeWait` (`host` `none`/false, `docker` `optional`/false, the tiny executor `none`/false, its fleet variant `optional`/true); `capacity()` defaults to `null`; `create` takes `size`, `image` (by digest, with its pull credential), `taskToken` and `onWaiting`, and `refuseUnfitBox` refuses before anything is made: a size without `boxSizes`, an image with `registry: "none"`, a task token with no sidecar (`isolation: "none"`). `buildSnapshot` takes `push` and answers `digest`; `docker` refuses a push until ticket 09 pushes. `writeTaskTokenFile` (`src/executor/task-token.ts`) is the token's handoff. The suite's six fleet cases run on every executor; the parts that read a box back come from the fixture's `fleet` (`FleetFixture`), which the tiny executor's fleet variant gives now, `docker` in ticket 09 against the fake engine and `kubernetes` in ticket 07 against ticket 06's fake API. Today `docker`'s run (`docker-executor.contract.test.ts`, the box's side through the bridge) passes the size refusal, `capacity()` and the no-wait case, and skips the image, token and release cases until ticket 09 adds its fixture. Two differences from the ticket: the refusal's code is the shared `unsupported` (`AdapterErrorCode`'s word for a missing capability, so core's four exhaustive switches stay as they are), not a new `sizes-unsupported`; and nothing here waits on ticket 01, since the SDK's types are its own and the runner maps them onto minor 4's wire shapes. Proof: `context/proof/F-095.md`, `F-120.md`, `F-093.md` and `F-015.md`, rows `partial` or with the suite's cases in their notes. Commit: see the next line.
- 2026-11-19: commit 54ccf7ae (`✨ add executor sizes, capacity and images`).
