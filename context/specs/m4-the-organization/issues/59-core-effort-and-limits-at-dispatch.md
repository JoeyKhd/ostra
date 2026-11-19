# 59: Core: effort and limits at dispatch, and a change for the next turn

Status: ready-for-agent
Builder: core
Blocked by: 48, 56, 57, 58
Features: F-137, F-024, F-084
Packages: `packages/domain` (`src/use-cases/sync-provider-models.ts`, `src/use-cases/dispatch-task.ts`, the task creation use case, `src/use-cases/agent-profile-setup.ts`), `apps/core` (`src/dispatch/task-spec.ts`, `src/dispatch/profile-spec.ts`, the ingest of `turn.started` and `usage.recorded`, the runner outbox)
Spec: `../spec.md`, sections 4 ("Reasoning effort") and 5.6; ADR 0066

## What to build

- **The catalog sync** writes each model row's `catalogReasoning` from ticket 58's entries, and never touches `adminReasoning`.
- **A new task** copies its profile's `effort` into `Task.effort`.
- **The dispatch.** After ticket 48 resolves the session's model row:
  - it takes the row's effective controls and the agent adapter's levels for them (core's agent registry, `apps/core/src/core.ts`)
  - it clamps the task's level (ticket 56's `clampEffort`)
  - it puts `agent.effort`, `agent.reasoning` and `agent.limits` (the row's `contextWindow` and `maxOutputTokens`) in the spec
  - a task whose level isn't `default` waits with `needs-protocol` for a minor-3 runner
  - a reopen in a fresh box and a rebuild-template session carry the task's level the same way
- **`setTaskEffort`'s body:**
  - in the task's counter lock, for the driver only
  - the level must be one of the session's model's levels; any other is refused, naming the levels
  - in one transaction: `Task.effort`, `effort.changed` in the thread, the audit entry, and a `set-effort` in the outbox of the runner holding the session
  - with no session running, nothing goes to a runner: the next dispatch carries the level
- **Ingest:**
  - `turn.started`'s `effort` and `adjustedFrom` go on the `Turn`
  - `usage.recorded`'s `reasoningTokens` is summed on the `Turn` and the `Session`
  - spend still prices all of `outputTokens` at the output price

## Done when

- [ ] Tests named `it("F-137: ...")`:
  - the spec of a task on a catalog model with a 1,000,000-token window and a 128,000-token output carries both
  - a custom model with no limits carries `null` for each
  - the spec carries the clamped level after the profile's model moved to one without it
  - a minor-2 runner is never offered a task with a level
  - `setTaskEffort`: the driver only; event, audit entry and command in one transaction, and a rollback leaves none; nothing is sent to a runner when the session is idle with no box
  - a reopen in a fresh box and a rebuild-template session start at the task's level
  - a turn stores its level and its reasoning tokens, and the session sums them
- [ ] The whole-repo checks pass (spec section 9): it changes what goes over the runner protocol.
- [ ] Committed as `✨ carry reasoning effort to the runner`.

## Comments
