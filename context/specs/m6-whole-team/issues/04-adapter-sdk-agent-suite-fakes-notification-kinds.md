# 04: Adapter SDK: the agent suite's new cases, the fakes, and five notification kinds

Status: ready-for-agent
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

- [ ] Each new suite case passes on the scripted fakes, and its control fails as it should.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✅ add the milestone 6 agent cases and fakes`.

## Comments
