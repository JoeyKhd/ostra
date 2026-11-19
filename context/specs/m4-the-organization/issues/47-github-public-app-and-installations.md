# 47: GitHub adapter: a public App, installation events and removing an installation

Status: ready-for-agent
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

- [ ] Tests named `it("F-136: ...")`: the manifest's `public` and homepage for both answers; a removal calls the endpoint once, and an unknown installation is not-found; each event parsed from GitHub's documented payloads, with an unknown field tolerated.
- [ ] The contract suite passes on the fake code host and on the GitHub adapter against the fake GitHub.
- [ ] The whole-repo checks pass (webhooks, spec section 9).
- [ ] Committed as `✨ add installations to the GitHub adapter`.

## Comments
