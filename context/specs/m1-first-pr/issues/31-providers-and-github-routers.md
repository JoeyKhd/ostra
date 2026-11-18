# 31: Routers: model providers and the GitHub connection

Status: ready-for-agent
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

- [ ] Tests against the stub models and the fake GitHub: each procedure works for an admin, is `FORBIDDEN` for a member and invisible to another organization; the manifest `state` can't be replayed from another session.
- [ ] Gated live: `connectExisting` with App 5821041 lists the `ostra-test` installation and `test1`.
- [ ] The whole-repo checks pass (spec section 9: credentials).
- [ ] Committed as `✨ add provider and GitHub routers`.

## Comments
