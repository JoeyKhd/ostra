# 45: Contracts: keys per project (DB and domain)

Status: done
Builder: core (contracts, first)
Blocked by: 05, 06
Features: F-135, F-021 (the model by name)
Packages: `packages/db` (`prisma/schema.prisma`, `prisma/migrations/`, `src/enums.ts`, `src/mappers.ts`, `src/testing/isolation-models.ts`), `packages/domain` (`src/providers/` new, `src/dispatch-wait.ts`, `src/access.ts`, `src/use-cases/agent-profile-setup.ts`, the use-case signatures)
Spec: `../spec.md`, section 5.5; ADR 0065

## What to build

- **The migration:** the keys half of section 5.5's table, in a migration after ticket 05's, additive only. New tables carry `organizationId`. A row of a project's list or choices carries `projectId` with the composite key to the project; the organization's default rows have a null `projectId`, with a partial unique index, as ticket 05's `Budget` has.
- **The backfill,** in the same migration's SQL, so a fresh upgrade behaves as before:
  - every existing provider on its organization's default list, and every project following it (`ownProviders` false)
  - each profile's model name from its `Model` row (`catalogId`, else `endpointModelId`)
  - each model name's default choice from the oldest profile that names it, with `needsConfirm` where profiles named it on different providers
  - each session's `providerId` and `modelId` from its profile's model row
- **`ModelName`,** branded and Zod first: `{ kind: "catalog", catalogId } | { kind: "custom", endpointModelId }`, its parse from a `Model` row, and the key the unique index uses.
- **The pure core,** each with an exhaustive table test:
  - `resolveProjectModel(list, choices, models, name)`: the choice, else the only provider on the list that lists the model, else `no-provider`; a chosen row its provider no longer lists is `not-listed`, never another provider
  - `planProviderChange(before, after)`: every model that keeps, moves or loses its provider, and the choices the keep rule records (a model that would get a second provider keeps the one serving it)
  - `keepChoicesOnRefresh(lists, refreshedModels)`: the same rule for a provider's daily model refresh
  - `providerGate(session, project)`: `open`, `moved { providerId, modelId }` or `none { modelName }`
- **Access:** `canEditProviderLists` (organization admin) and `canSeeProjectProviders` (anyone who can open the project, names only). Ticket 09's matrix gains their rows.
- **Wait codes and needs-you:** `no-provider-for-model { modelName }` and `provider-not-allowed` in `dispatchWaitSchema`, with their message keys; a `no_provider_for_model` needs-you item with the `organization_admins` audience.
- **Use-case signatures,** with fakes: `setDefaultProviders`, `setProjectProviders`, `previewProviderChange`, `chooseModelProvider`, `confirmUpgradeChoice`, `resolveSessionModel`. Each writes its audit entry in its transaction (`providers.default-changed`, `project.providers-changed`, `project.model-choice-changed`).
- **The profile's save** (milestone 3's `agent-profile-setup.ts`) takes a model name. It still writes `modelId`, as the default list's row for that name when there is one, so a rollback to the previous release works.
- **The isolation list** (ticket 09) gains the new models.

## Done when

- [x] `pnpm db:migrate` applies to an empty database and to one at ticket 05's head with providers, profiles, projects and sessions in it. After it, every existing task resolves the provider it used before (a test over a fixture of two organizations).
- [x] Tests named `it("F-135: ...")`:
  - a list naming another organization's provider is refused by the key
  - each unique index refuses its duplicate, the default's where `projectId` is null
  - the resolution table: a choice, the only provider, none, two with no choice, a chosen row no longer listed
  - the keep rule on adding a provider to a list, and on a refresh
  - the upgrade marks a model that two profiles named on different providers
  - every use case writes its audit entry, and a rollback leaves none
- [x] Nothing is renamed or dropped, and Prisma's generated types compile in every package.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add the keys-per-project contracts`.

## Comments

- 2026-11-19: migration `20261121010000_keys_per_project` with its backfill (the default list, the profile's model by name, the default choices with `needsConfirm`, each session's provider and model row) and checks; `ModelChoice.modelKey` is the key the unique index uses (`modelNameKey`). Domain in `packages/domain/src/providers/`: `ModelName`, `resolveProjectModel`, `planProviderChange`, `keepChoicesOnRefresh`, `providerGate`, and the six use cases against Postgres, each with its audit entry in its transaction; `canEditProviderLists` and `canSeeProjectProviders`; the wait codes `no-provider-for-model` and `provider-not-allowed`; the `no_provider_for_model` reason with the `organization_admins` audience (worded on Home and in the task list); the job `providers.release-boxes`; the profile's save takes an optional `modelName` and still writes `modelId`. Tests: `packages/db/src/schema-keys.test.ts`, `packages/domain/src/keys-per-project.test.ts`, `packages/api/src/services/keys-per-project.test.ts`, each with break-its; proof rows in `context/proof/F-135.md`. Not done here: the isolation list of ticket 09 doesn't exist yet (`packages/db/src/testing/isolation-models.ts`), so ticket 09 adds `ProviderListEntry` and `ModelChoice` when it builds it; the panel's words for the two wait codes come with ticket 53. Commit: `✨ add the keys-per-project contracts`.
