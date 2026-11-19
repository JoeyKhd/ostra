# 61: API: effort on profiles, models and tasks

Status: ready-for-agent
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

- [ ] Tests named `it("F-137: ...")`:
  - the access matrix for each procedure: an organization admin, a project admin, the driver, a member who isn't the driver, and an outsider of a restricted project
  - a level outside the model's refused on a save and on `setEffort`
  - a custom model that doesn't reason has no levels until an admin says it does
  - an admin's override survives a catalog refresh, and `null` returns to the catalog's
  - a turn's level and reasoning tokens in `tasks.get`
- [ ] Committed as `✨ add reasoning effort to the API`.

## Comments
