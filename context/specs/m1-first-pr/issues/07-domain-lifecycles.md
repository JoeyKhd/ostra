# 07: Domain: the lifecycle unions and transitions

Status: resolved
Builder: contracts
Blocked by: 02, 06
Features: F-097, F-025, F-065 (task states); `context/domain-model.md`
Packages: `packages/domain`
Spec: `../spec.md`, section 5.4

## What to build

Each lifecycle in `context/domain-model.md` as a discriminated union, a pure transition function and tests. No I/O.

- `src/lifecycles/task.ts`: `TaskState` per kind (`code`, `refine`, `review`), sharing the six common states. Code's `in_review` carries its sub-state. `transitionTask(state, input)` returns `{ ok: true, state } | { ok: false, reason }`, with an exhaustive `switch` and `satisfies never` in each default.
  - Milestone 1's path: queued → preparing → running → in review (`waiting_for_reviewer`, because the CI and AI review rounds are off until milestone 6), or → needs you (no changes, crash, setup failure), or → stopped.
- `src/lifecycles/session.ts`, `box.ts` (the `host` worktree uses the same states), `runner.ts`, `approval.ts`, `needs-you.ts`, `task-repo.ts`, `snapshot.ts`, `lease.ts`.
- `src/lifecycles/mapping.ts`: the mapping between the union and ticket 06's columns, both ways, with a round-trip test for every state.

## Done when

- [x] Every state and every arrow in `domain-model.md` is a test case. A transition the model doesn't draw is refused, with a test per state for at least one refused input.
- [x] Every union round-trips through the column mapping.
- [x] No `as` except `as const`, no `!`, every `switch` exhaustive.
- [x] Package checks pass.
- [x] Committed as `✨ add the domain lifecycles`.

## Comments

- 2026-11-18, contracts: done in 8ddb044 (`✨ add the domain lifecycles`). Task (per kind), session, box, runner, approval, needs-you item, task repo, snapshot and lease, each a union with a pure transition function; every drawn arrow is a case, every state refuses at least one input, and every union round-trips through `mapping.ts`. Reasons and sub-states come from the schema's enums. A session's `stopped` and `crashed` carry no detail, because the schema has no column for it: the events say why.
