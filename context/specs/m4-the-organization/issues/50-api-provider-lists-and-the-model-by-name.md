# 50: API: provider lists, model choices and the model by name

Status: ready-for-agent
Builder: api
Blocked by: 27 (the spend router), 48
Features: F-135, F-021, F-037, F-087
Packages: `packages/api` (`src/routers/providers.ts`, `src/routers/projects.ts`, the agent profiles router, `src/routers/tasks.ts`, ticket 27's spend router)
Spec: `../spec.md`, sections 3 (steps 16 and 17) and 5.5; ADR 0065

## What to build

- **`providers.list`** gains each provider's projects (through the default list or their own) and the month's spend. **`providers.setDefaultList`** (organization admin) sets the default list. **`providers.confirmChoice`** clears an upgrade's marked choice, or changes it.
- **`projects.providers`** (anyone who can open the project): the mode, the providers on the list (name, base URL's host, format) and each model the project's profiles use with the provider that serves it. Never a token.
- **`projects.previewProviders`** and **`projects.setProviders`** (organization admin): the mode and the list. The preview returns the plan from `planProviderChange`; the save applies it only if nothing changed since the preview, and answers `CONFLICT` otherwise.
- **`projects.chooseModelProvider`** (organization admin): the provider that serves one model there.
- **Agent profiles:** the save takes `model: ModelName`. **`profiles.modelOptions`** lists the model names any provider lists, each with its providers and the projects where none serves it.
- **Tasks:** `tasks.get` gains the session's provider name; `tasks.create` and the New task check return the "no key" reason.
- **Spend** (ticket 27) gains the grouping per provider.

## Done when

- [ ] Tests named `it("F-135: ...")`:
  - the access matrix for each procedure: an organization admin, a project admin, a member, and an outsider of a restricted project
  - no view holds a token (searched by value)
  - the preview and the save, with a stale preview refused
  - spend per provider equals the sum of its sessions' spend
  - a profile saved by model name, and its options
- [ ] Committed as `✨ add provider lists to the API`.

## Comments

## Added 2026-11-19 (the lead): fields the approved screens need

The web builder (tickets 53 and 63) found these missing from the API draft. The targets need them:
1. `agentProfiles.list` and `agentProfiles.get`: each profile's saved model by name, `modelName: ModelName | null`. The profile editor starts its draft from it, and saving by name needs it.
2. **The upgrade's choices to confirm** (`models-keys.md`, "To confirm"): a read of the `ModelChoice` rows with `needsConfirm`, on the default list and on each project's own list. Each row has:
   - the project ID and name, or null for the default list
   - the model name and its display text
   - the kept provider
   - the providers on that list that also list the model

   `providers.confirmChoice` already exists.
3. `tasks.startCheck`, when it answers `open`: the serving provider's name, for New task's "Key · <provider>" row. The `no-provider` wait already has `modelName`.
4. Nice to have: `providers.list` rows carry `host` (the base URL's host).
5. The needs-you view for `no_provider_for_model` carries the model name, so the row can read "No key for {model}" as the target shows.
