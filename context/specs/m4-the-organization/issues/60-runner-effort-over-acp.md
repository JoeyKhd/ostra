# 60: Runner: the effort set over ACP, at every session start and before the next turn

Status: done
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

- [x] Tests named `it("F-137: ...")`, with the fakes and with OpenCode against the e2e stub endpoint:
  - the level is set before the first prompt on `session/new` and on `session/load`
  - a `set-effort` during a turn changes none of that turn's requests and every request of the next
  - a `set-effort` while idle reaches the next prompt
  - a runner restarted mid-task resumes at the task's level
  - a replayed `set-effort` is applied once
  - an agent with `none` gets no call
  - `turn.started` carries the level and `adjustedFrom`
  - `usage.recorded` carries reasoning tokens for OpenAI-compatible and Anthropic Messages
- [x] Runner parity (`AGENTS.md`): the same cases pass on `host` and on the `docker` executor's fake engine.
- [x] The whole-repo checks pass (spec section 9): it touches the runner protocol and runs agent output.
- [x] Committed as `✨ set reasoning effort over ACP`.

## Comments

- 2026-11-19: built on tickets 56, 57 and 59. The task run (`apps/runner/src/task-host/task-run.ts`) keeps the level the session should run at (the spec's, then each `set-effort`'s) and asks the adapter's `setEffort` for it before every prompt, so a new session is set after `session/new` (none for `default`), a loaded one after `session/load` whatever its level (a reopen, a restore, a restart onto a fresh box, and plan mode's relaunch), and a held change lands before the next prompt. `set-effort` is applied once per `changeId`: at once while the session waits (`done`), held during a turn or before the agent runs (`accepted`); a level that can't be set never fails the session. The base class's `prompt` takes the turn's `effort` and `adjustedFrom` for `turn.started`. `prepareLaunch` gets the spec's `reasoning` and `limits`. The key proxy puts `reasoningTokens` on `usage.recorded` when the endpoint reports any, in both formats. The task host routes `set-effort` to its run; on a pool runner the box's sidecar takes it, as before. Tests: `apps/runner/src/task-host/effort.test.ts` (the fakes, every case on `host` and through a `docker` box's sidecar), `apps/runner/src/task-host/effort.opencode.test.ts` (the pinned OpenCode, request bodies at the stub endpoint) and `apps/runner/src/sidecar/key-proxy.test.ts`, each broken once; proof rows in `context/proof/F-137.md`. Commit: `✨ set reasoning effort over ACP`.
