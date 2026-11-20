# 04: Adapter SDK: the agent suite's new cases, the fakes, and five notification kinds

Status: done
Builder: adapters
Blocked by: 01
Features: F-099, F-100, F-101, F-113, F-036 (its new kinds)
Packages: `packages/adapter-sdk` (`src/testing/agent-suite.ts`, `src/testing/fake-acp-agent/`, `src/notification/`, the fake core for the sidecar's endpoints)
Spec: `../spec.md`, section 5.2 (`AgentAdapter`, notifications and the suites), section 8

## What to build

- **The scripted fake agents:** a drafting fake (calls `submit_draft` with its script's fields), a reviewing fake (calls `submit_review` with scripted findings), a proposing fake (calls `propose_environment`), and an asking fake that asks an ACP question in a turn and goes on when it gets any answer, ending its turn `cancelled` when declined, as OpenCode did in spike 10.
- **The fake core** for the sidecar's endpoints (milestone 4's, for memory) answers `/draft`, `/review` and `/environment-proposal` by the protocol's schemas, with a switch for each refusal.
- **The agent contract suite** gains the cases of spec section 5.2: the neutral reply in an automatic turn (the asking fake carries on; a declined question ends the turn, as the control); a read-only task's push refused by the git proxy; a review checkout at given heads, one per repo; the tools listed per kind and absent otherwise; `commitPaths` leaving other changes uncommitted.
- **`NotificationAdapter`:** the kinds `draft_ready`, `review_requested`, `task_approval`, `round_cap` and `automation_paused`, each a `moment`; the notification suite checks each renders on every channel with no task content.

## Port from

`spikes/is-opencode-good-enough/` (the question tool's case: the decline that ends the turn `cancelled`), as the suite's control.

## Done when

- [x] Each new suite case passes on the scripted fakes, and its control fails as it should.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✅ add the milestone 6 agent cases and fakes`.

## Comments
- 2026-11-20: built in `✅ add the milestone 6 agent cases and fakes` (df04d8b6). The suite's new cases are `src/testing/agent-team-cases.ts`, read from the fixture's new `team` probes (each optional, a case skips without its probe): the neutral reply in an automatic turn (the asking fake, `ask-and-continue`, carries on with the answer; declined, the control, it ends the turn `cancelled` as spike 10 saw OpenCode do); a read-only push refused by a fetch-only upstream (`startGitUpstream({ fetchOnly: true })`, standing where the git proxy is) with no `git-receive-pack` reaching it; two repos at a review's given heads (one detached at an older commit); `submit_draft`, `submit_review` and `propose_environment` listed per kind by protocol minor 5's tool sets and absent otherwise; each tool round-tripping through the fake core with a refusal (`limit-reached`, `not-in-review`, an unknown repo refused before core is asked, `secret-found` by kind); and a turn's changes committed through `commitPaths`, the rest left uncommitted. `stageCommitPaths` (`src/executor/commit-paths.ts`, for ticket 23's runner commit) stages only the paths `commitPaths` keeps and returns the dropped ones cut to `commitFilteredPathsMax`, with their count. The fake core (`fake-memory-core.ts`) answers `/draft`, `/review` and `/environment-proposal` by the protocol's schemas, with a refusal switch each (`core.refusals`), and its MCP stand-in lists and serves only the task's tool sets. `NotificationAdapter`'s moments gain the five kinds (`teamNotificationKinds`); the notification suite checks each reaches every adapter's channel with the task's title, key and one line, none of it in a log line. The parity table now names the new cases for the four fakes (the index-only fake, without MCP, names the read-only, checkout and commit cases as `memory`'s fallback); OpenCode's rows wait for ticket 09. Spec difference: section 5.2's new `elicitation` capability is the existing `elicitationForm`, which means the same, so no second capability was added. Break-its are in `context/proof/F-099.md`, `F-100.md`, `F-101.md`, `F-113.md` and `F-036.md`. Checks: whole-repo typecheck and lint through turbo; tests of `packages/adapter-sdk`, the four notification adapters and `adapter-opencode`; `check:licenses`; `check:proof`.
