# 31: Routers: model providers and the GitHub connection

Status: done
Builder: api
Blocked by: 12, 13, 14, 30
Features: F-088, F-006, F-014 (allow on personal runners)
Packages: `packages/api` (`src/routers/providers.ts`, `src/routers/github.ts`), `packages/domain` (`addModelProvider`, `connectGitHubApp`)
Spec: `../spec.md`, sections 3 (steps 3 and 4) and 11 (item 3)

## What to build

All admin-only, organization-scoped, with audit entries for each change.

- **Providers:** `providers.testConnection` (base URL, token, auth scheme; returns the detected format and the models, never the token), `providers.create` (stores the token through the secret store; the form's format can override the detected one), `providers.update` (sessions-at-once cap, allow on personal runners, off by default), `providers.list`, `providers.models` (matched to the catalog, custom models editable: name, limits, price), and `agentProfiles.setDefaultModel` for the built-in OpenCode profile.
- **GitHub:**
  - `github.connectExisting` (App ID, private key PEM, webhook secret): read the App, check its permissions include `checks: write` and `actions: read` and say which are missing if not, store the PEM and secret through the secret store, store the slug and bot identity.
  - `github.startManifest` and a route handler for GitHub's callback (in `apps/web`, calling into `packages/api`): build the manifest (with the webhook only when `OSTRA_PUBLIC_URL` is public; otherwise the App has no events and the result says so, F-006), a `state` value bound to the admin's session, convert the code on return, store as above.
  - `github.installations` and `github.repos(installationId)`.
- No router returns a secret, ever. A test calls each one and searches the output for the stored values.

## Done when

- [x] Tests against the stub models and the fake GitHub: each procedure works for an admin, is `FORBIDDEN` for a member and invisible to another organization; the manifest `state` can't be replayed from another session.
- [x] Gated live: `connectExisting` with App 5821041 lists the `ostra-test` installation and `test1`.
- [x] The whole-repo checks pass (spec section 9: credentials).
- [x] Committed as `✨ add provider and GitHub routers`.

## Comments

- 2026-11-18 (api): done in `be27ef8` (`✨ add provider and GitHub routers`). `providers.testConnection` returns a result (`ok: false` with the adapter's reason) rather than an error, so the form can show it; `providers.create` tests the endpoint with the settings the form holds (the admin's correction of the detected format included) inside the transaction, so that transaction has a 60 s timeout. The models the endpoint lists are rows at once, and `syncProviderModels` (new, in `packages/domain`) matches them to the catalog; core's `provider.refresh-models` job (ticket 28) and `providers.refresh` should both call it, so they can't disagree. It never overwrites what an admin entered for a custom model.
- The catalog: `CatalogSource` is the routers' read-through cache, with a daily fetch, the last good copy kept on a failure, the bundled copy when the fetch is off or never worked, and `createModelsDevCatalogSource` wiring ticket 12's loaders. It sends a bare GET with an `accept` header and nothing else (tested).
- The manifest flow: `github.startManifest` keeps the `state` hashed in better-auth's `verification` table, bound to the admin's session, member and organization, expiring in 10 minutes. `github.completeManifest` is what the web callback calls: a state from another session (even the same admin's) is refused without using it up, and a used or expired one is refused. The webhook is in the manifest only for a public `OSTRA_CORE_PUBLIC_URL` (the GitHub adapter decides; the result says so). The webhook path in it, `/webhooks/github`, is a placeholder core hasn't routed yet.
- A sweep test (`secrets.test.ts`) calls every router that could show a secret and searches the outputs, the log, the audit trail and the change notices for each stored value and reference. The gated live case (`github.live.test.ts`) passed with App 5821041: `connectExisting` lists the `ostra-test` installation and `test1`.
