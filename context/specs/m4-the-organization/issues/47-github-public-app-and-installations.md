# 47: GitHub adapter: a public App, installation events and removing an installation

Status: resolved
Builder: adapters
Blocked by: 03 (the same base class)
Features: F-136, F-006
Packages: `packages/adapter-sdk` (`src/code-host/base.ts`, the fake code host, the contract suite), `packages/adapters/adapter-github` (`src/manifest.ts`, `src/github-adapter.ts`, `src/fake-github.ts`)
Spec: `../spec.md`, section 5.5; ADR 0065

## What to build

- **The manifest's visibility.** `appManifest` takes `public: boolean`, and the manifest sets `public` from it; today it's always `false` (`src/manifest.ts`). A public App's `url`, its homepage, is ostra's project page, a constant in the adapter, so the App's public page doesn't name the install's address. A private App's stays the install's.
- **`removeInstallation(app, installationId)`:** `DELETE /app/installations/{installation_id}` with the App's JWT, which "Uninstalls a GitHub App on a user, organization, or enterprise account" ([GitHub](https://docs.github.com/en/rest/apps/apps#delete-an-installation-for-the-authenticated-app)). An unknown installation is not-found.
- **What it reads:** `listInstallations` returns each account's ID beside its login, and `readApp` returns the App's owner (login and ID).
- **Webhook hints:** `parseWebhook` gains `installation` (created, deleted, suspend, unsuspend) and `installation_repositories` (added, removed), each with the installation's ID and account. Vendor payloads, so the schemas tolerate unknown fields.
- **A capability:** `installableByOtherAccounts: boolean`, true for GitHub, so the next code host (F-009) says whether it has them.
- **The fake GitHub** gains a second account, a stranger's installation, `DELETE` removing one, and both events.
- **The contract suite** gains the manifest both ways, the installation events, and a removal.

## Done when

- [x] Tests named `it("F-136: ...")`: the manifest's `public` and homepage for both answers; a removal calls the endpoint once, and an unknown installation is not-found; each event parsed from GitHub's documented payloads, with an unknown field tolerated.
- [x] The contract suite passes on the fake code host and on the GitHub adapter against the fake GitHub.
- [x] The whole-repo checks pass (webhooks, spec section 9).
- [x] Committed as `✨ add installations to the GitHub adapter`.

## Comments

- 2026-11-19 (adapters builder), commits `✨ add installations to the code host contract` (107e86d) and `✨ add installations to the GitHub adapter`. The contract, additive: `AppManifestInput.public` (absent is private), `AppInfo.owner` and `Installation.accountId` (both optional, so every adapter and fake built before this still compiles; GitHub fills them), the `installation` and `installation_repositories` webhook events with the installation's ID and account (and the repos added or removed), `removeInstallation` (default `unsupported`), and the capability `installableByOtherAccounts` (GitHub: true; core's and the API's fakes: false). Core's webhook handler ignores the two new events until ticket 49. GitHub: the manifest's `public` comes from the answer, and a public App's homepage is `OSTRA_PROJECT_URL` (the OAuth callbacks and redirect stay the install's); `DELETE /app/installations/{id}` with the App's JWT, a 404 read as not-found and a malformed ID refused before any call; the owner from `GET /app` and each account's ID. GitHub sends `installation` and `installation_repositories` to every App without a subscription, so the manifest's events didn't change. The fake GitHub takes `otherAccounts` (each with its installation; a stranger's mints tokens for its own repos only), answers the uninstall, and builds both events' payloads (`installationPayload`, `installationRepositoriesPayload`). The code host suite gained four F-136 cases (the manifest both ways, the owner and account IDs, a removal, both events) and passes on the tiny host and on GitHub against the fake. Eight break-its, each failing its test: `context/proof/F-136.md`. Proved with the fake GitHub only: the live run with a second GitHub organization is ticket 55's. Checks: typecheck, lint and test of `@ostra/adapter-sdk` and `@ostra/adapter-github`, typecheck and lint of every package that depends on the SDK, core's tests that use the GitHub adapter, the API's GitHub router tests, the root `tsc`, `check:proof` and `check:licenses`.
