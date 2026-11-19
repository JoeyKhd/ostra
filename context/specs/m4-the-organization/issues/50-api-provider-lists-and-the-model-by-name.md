# 50: API: provider lists, model choices and the model by name

Status: resolved
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

- [x] Tests named `it("F-135: ...")`:
  - the access matrix for each procedure: an organization admin, a project admin, a member, and an outsider of a restricted project
  - no view holds a token (searched by value)
  - the preview and the save, with a stale preview refused
  - spend per provider equals the sum of its sessions' spend
  - a profile saved by model name, and its options
- [x] Committed as `✨ add provider lists to the API`.

## Comments

- 2026-11-19 (api builder B): built and pushed as `✨ add provider lists to the API`. New `packages/api/src/routers/provider-lists.ts` (the default list: `providers.previewDefaultList`, `setDefaultList`, `confirmChoice`, `chooseDefaultModelProvider`, and each provider's lists, projects and month's spend on `providers.list`) and `project-providers.ts` (`projects.providers`, `previewProviders`, `setProviders`, `chooseModelProvider`). A save carries the preview's `version`, a fingerprint of the list and its choices; when the list changed since, it's `CONFLICT`. `agentProfiles.save` takes `modelName`; `agentProfiles.modelOptions` lists the names any provider lists, with their providers and the projects where none serves them. `tasks.get`'s session gains `providerName`; `tasks.startCheck` now words "no key" with the domain's `noProviderMessage`. Fixed on the way: `resolveStartProfileInTx` refused a profile named by name only (no `modelId` row on the default list) as having no model; it now lets the project's list answer, so such a task gets the no-key reason. Spend per provider (ticket 27's `byProvider`) is proved through the real ingest. All of it is proved with two stub endpoints; the live two-client run is ticket 55.

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

6. A display name beside `text` wherever a model name is returned: `projects.providers` `models[]`, and the plan lines of `previewProviders`, `setProviders`, `previewDefaultList` and `setDefaultList`. The screens show "Claude Sonnet 5.5", not the catalog ID; `modelOptions` already has `displayName`.
7. The preview's "What happens" counts:
   - `released`: idle boxes whose key leaves the list
   - `waiting`: tasks that would wait with no key

   Each count needs the provider names and the model text the sentences cite.
8. `providers.list`: this month's task count per provider, beside `monthSpentMicroUsd` (the panel's "This month · Tasks").
9. Optional: for each model a provider lists, the projects it serves (`serves: string[]`, for "Models it lists").

The web builder falls back where any of these are missing (catalog ID text, no "What happens", no task count), so none of them blocks it.

10. `agentProfiles.modelOptions`: for each project, which provider serves the model there, as `projects: [{ projectId, name, providerName: string | null }]`, not only `projectsWithout`. The profile editor's "{model} in each project" lists every project with its key.
11. A `logoPath` beside the display name in item 6, where the catalog has one.

(2026-11-19, 23:55, from the web builder's e2e run against the draft: items 3 and 6 are still the open ones, besides 10.)

- 2026-11-20 (api builder B): the lead's items 1 to 8, 10 and 11 are built in the same commit: `modelName` on `agentProfiles.list` and `get`; `providers.choicesToConfirm` (project or `null`, the model with its display text, the kept provider, the alternatives on that list); `providerName` on an open `tasks.startCheck`; `host` and `monthTaskCount` on `providers.list`; `displayName` beside `text` in `projects.providers` and every plan line; each preview's `whatHappens` (`released` with provider names, `waiting` with model texts); the no-key needs-you row's `detail.modelName`; `modelOptions`' `projects` with each project's key (item 10); `logoPath` beside `displayName` (item 11). Item 9 (optional) isn't built. Each has a test and a break-it in `context/proof/F-135.md`.
