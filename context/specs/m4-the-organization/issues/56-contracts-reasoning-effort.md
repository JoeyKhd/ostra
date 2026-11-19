# 56: Contracts: reasoning effort (protocol, DB and domain)

Status: ready-for-agent
Builder: core (contracts, first)
Blocked by: 01, 05, 06, 45
Features: F-137
Packages: `packages/protocol` (`src/common.ts` or a new `src/agent/effort.ts`, `src/task/spec.ts`, `src/runner/commands.ts`, `src/events/agent-events.ts`, the minor-3 codec), `packages/db` (`prisma/schema.prisma`, `prisma/migrations/`, `src/enums.ts`, `src/mappers.ts`, `src/testing/isolation-models.ts`), `packages/domain` (`src/effort/` new, `src/access.ts`, the audit actions, the use-case signatures)
Spec: `../spec.md`, section 5.6; ADR 0066; `context/research/opencode-reasoning-effort.md`

## What to build

- **The protocol, in ticket 01's minor 3:**
  - `effortLevelSchema`, a closed union, `default`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` and `on`, with `EFFORT_SCALE`, the order `none` < `minimal` < `low` < `medium` < `high` < `xhigh` < `max` (models.dev's own, research section 2.1).
  - `reasoningControlsSchema`, models.dev's v2 shape as ostra stores it: `{ supported: false }`, or `{ supported: true, toggle?, effort?, budget?: { min?, max? } }`. `effort` is a non-empty list from the scale, with no `default`. A strict object, since ostra owns it here.
  - The task spec's `agent` gains `effort` (missing means `default`), `reasoning` and `limits: { contextWindow, maxOutputTokens }` (each a positive integer or `null`). A minor-2 runner gets the old shape.
  - A runner command, `set-effort { sessionId, level, changeId }`, applied once by `changeId`.
  - `turn.started` gains `effort` (the level the turn ran at) and `adjustedFrom` (the level asked for, when the clamp changed it). `usage.recorded` gains `reasoningTokens`, a part of `outputTokens`.
  - A server-only event, `effort.changed { from, to, memberId }`, for the thread.
- **The migration,** after ticket 45's, additive only:
  - the enum `EffortLevel`
  - `Model` + `catalogReasoning` and `adminReasoning` (JSON, parsed by the protocol's schema, both nullable)
  - `AgentProfile` + `effort` and `Task` + `effort`, both defaulting to `default`
  - `Turn` + `effort` and `effortAdjustedFrom` (nullable, for turns before this release) and `reasoningTokens` (default 0)
  - `Session` + `reasoningTokens` (default 0)

  Nothing to backfill: ticket 59's next catalog sync fills `catalogReasoning`.
- **The pure core,** each with an exhaustive table test:
  - `effectiveReasoning(model)`: the admin's controls, else the catalog's, else `{ supported: false }`
  - `clampEffort(requested, offered)` → `{ level, adjusted }`, by ADR 0066's rules. `default` stays. An offered level stays. On a toggle-only model, `none` stays and anything else is `on`. `on` on a model with effort levels is `default`. Anything else goes to the nearest offered level on the scale, the higher of two equally near. A model with no levels runs at `default`.
- **Access:** `canSetTaskEffort` is the task's driver (F-024). Ticket 09's matrix gains its row.
- **Use-case signatures,** with fakes:
  - `setModelReasoning(modelId, controls | null)`: `null` goes back to the catalog's
  - `setTaskEffort(taskId, level)`, under the task's counter lock, as a steer is (F-024)
  - the profile save's `effort`

  Each writes its audit entry in its transaction: `model.reasoning-changed`, `task.effort-changed`, and the profile save's entry carries the level.
- **The isolation list** (ticket 09) covers the new columns' models. No new model.

## Done when

- [ ] `pnpm db:migrate` applies to an empty database and to one at ticket 45's head, and every existing profile and task reads `default` after it.
- [ ] Tests named `it("F-137: ...")`:
  - the schemas refuse an unknown level, an unknown field in ostra's own shapes, and an effort list holding `default`
  - a minor-2 encoding of a spec and of `turn.started` drops the new fields; a `set-effort` is never encoded for a minor-2 peer
  - the clamp table: every level against no levels, a toggle, a budget (`high`, `max`), and each of the fifteen most common effort sets of the live catalog (research section 2.2), ties going up
  - `effectiveReasoning`'s order, and that a catalog refresh's value never replaces an admin's
  - `setTaskEffort` is refused for a member who isn't the driver, and a take-over racing it never lets the old driver's change land (the counter lock's race test, as F-024's)
  - every use case writes its audit entry, and a rollback leaves none
- [ ] Nothing is renamed or dropped, and Prisma's generated types compile in every package.
- [ ] The whole-repo checks pass (spec section 9): it changes the schema and the runner protocol.
- [ ] Committed as `✨ add the reasoning effort contracts`.

## Comments
