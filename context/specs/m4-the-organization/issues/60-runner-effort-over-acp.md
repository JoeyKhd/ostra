# 60: Runner: the effort set over ACP, at every session start and before the next turn

Status: ready-for-agent
Builder: runner
Blocked by: 20, 21, 56, 57
Features: F-137
Packages: `apps/runner` (`src/task-host/task-run.ts`, `src/task-host/server-link.ts`, `src/task-host/agents.ts`, `src/sidecar/key-proxy.ts`)
Spec: `../spec.md`, sections 4 ("Reasoning effort") and 5.6; ADR 0066

## What to build

- **At every session start.** After each `session/new` and `session/load`, the runner calls the adapter's `setEffort` with the spec's level, before the first prompt, unless the level is `default`. That covers a resume, a restore, plan mode's relaunch and a restart. The turn's `turn.started` carries the level used, and `adjustedFrom` when the adapter clamped it.
- **`set-effort`:** applied once by `changeId`.
  - During a turn, it's held until the turn ends and applied before the next prompt.
  - With the session idle, it's applied at once.
  - Either way the running turn keeps its level, so every turn runs at one.
- **The launch.** `prepareLaunch` gets the spec's `reasoning` and `limits`.
- **The key proxy** puts the call's reasoning tokens on `usage.recorded`, in both formats (ticket 57's meter).

## Done when

- [ ] Tests named `it("F-137: ...")`, with the fakes and with OpenCode against the e2e stub endpoint:
  - the level is set before the first prompt on `session/new` and on `session/load`
  - a `set-effort` during a turn changes none of that turn's requests and every request of the next
  - a `set-effort` while idle reaches the next prompt
  - a runner restarted mid-task resumes at the task's level
  - a replayed `set-effort` is applied once
  - an agent with `none` gets no call
  - `turn.started` carries the level and `adjustedFrom`
  - `usage.recorded` carries reasoning tokens for OpenAI-compatible and Anthropic Messages
- [ ] Runner parity (`AGENTS.md`): the same cases pass on `host` and on the `docker` executor's fake engine.
- [ ] The whole-repo checks pass (spec section 9): it touches the runner protocol and runs agent output.
- [ ] Committed as `✨ set reasoning effort over ACP`.

## Comments
