# 61: API: effort on profiles, models and tasks

Status: done
Builder: api
Blocked by: 50, 59
Features: F-137, F-021, F-088
Packages: `packages/api` (`src/routers/agent-profiles.ts`, `src/routers/agent-profile-view.ts`, `src/routers/providers.ts`, `src/routers/tasks.ts`, `src/routers/task-usage.ts`, `src/routers/stream.ts`)
Spec: `../spec.md`, section 5.6; ADR 0066

## What to build

- **Profiles:**
  - `profiles.modelOptions` (ticket 50) gives each model name's levels for the profile's agent, with each one's label key
  - `agentProfiles.get` returns the profile's `effort` and its model's levels
  - `agentProfiles.save` takes `effort`, and refuses with `BAD_REQUEST`, naming the levels, a level the model doesn't have
- **Models:**
  - `providers.updateModel` (organization admin) takes `reasoning` on any model row: a custom model's controls (reasons no, or reasons with the levels its endpoint takes), or a catalog model's override, where `null` means the catalog's
  - the rule that a catalog model takes the catalog's name, limits and prices stays; reasoning is the one field an admin can override on one
  - every change is an audit entry
  - the model list gains each model's effective reasoning, its source (`catalog` or `admin`), its levels and `reasoningPriceDiffers`
- **Tasks:**
  - `tasks.get` returns the task's level, the levels of its session's model, and each turn's level, `adjustedFrom` and reasoning tokens
  - `tasks.setEffort { taskId, level }` calls ticket 59's use case, and is `FORBIDDEN` for anyone but the driver
  - the live stream carries `effort.changed`

## Done when

- [x] Tests named `it("F-137: ...")`:
  - the access matrix for each procedure: an organization admin, a project admin, the driver, a member who isn't the driver, and an outsider of a restricted project
  - a level outside the model's refused on a save and on `setEffort`
  - a custom model that doesn't reason has no levels until an admin says it does
  - an admin's override survives a catalog refresh, and `null` returns to the catalog's
  - a turn's level and reasoning tokens in `tasks.get`
- [x] Committed as `✨ add reasoning effort to the API`.

## Comments

- 2026-11-19: built against ticket 56's contracts and ticket 58's catalog entry, with tickets 50, 57 and 59 not yet landed. `agentProfiles.get` returns `effort` and `effortOptions` (the levels, `runsAt` by the clamp, `adjusted`, the controls' source, `customModel`, `agentTakesEffort`); `agentProfiles.save` takes `effort` and refuses a level the model lacks with `BAD_REQUEST` naming its levels. Ticket 50's `profiles.modelOptions` doesn't exist yet, so the editor reads a model's levels from a new `agentProfiles.effortLevels { adapter, modelId, stored? }` (any member); ticket 50 adds the levels to `modelOptions` when it builds it. `providers.updateModel` takes `reasoning` on any model (ticket 56's `setModelReasoningInTx`, its audit entry in the transaction); a catalog model still refuses every other field with `CONFLICT`. `providers.models` gains `reasoning { controls, source, catalog, levels, reasoningPriceDiffers }`. `tasks.get` gains `effort { level, levels }`, `capabilities.setEffort` (the driver), and per turn `effort`, `adjustedFrom` and `reasoningTokens` (with `reasoningTokens` in the totals); `tasks.setEffort { taskId, level, changeId? }` calls ticket 56's `setTaskEffort` (ticket 59's check of the session model's levels is done here, in the router). The levels come from an `AgentEffort` port on `ApiDeps` (`packages/api/src/services/agent-effort.ts`), which reads them off the model's controls for OpenCode and gives `default` alone for any other agent until ticket 57's adapters declare their own. Tests: `packages/api/src/routers/reasoning-effort.test.ts`, ten cases, each with a break-it; proof rows in `context/proof/F-137.md`. Commit: `✨ add reasoning effort to the API`.
- 2026-11-20: the final check of F-137 replaced the interim `controlsAgentEffort` with `adapterAgentEffort` over the adapters' own `reasoningEffort` and `effortLevels` (OpenCode's through `@ostra/adapter-opencode/effort`), in the API's runtime and core's registry, with two tests (an OpenAI-compatible toggle offers Default alone, a manual Claude High and Max; an agent with `none` offers Default alone on the task page). Demo step 18 ran live (`../demo.md`). Commit: `🐛 offer the levels the agent itself sends`.
