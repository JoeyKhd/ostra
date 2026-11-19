# 51: API: GitHub organizations, installations and several Apps

Status: ready-for-agent
Builder: api
Blocked by: 30, 49
Features: F-136, F-006
Packages: `packages/api` (`src/routers/github.ts`, `src/services/github-connection.ts`, `src/routers/projects.ts`, `src/routers/environments.ts`, `src/routers/setup.ts`)
Spec: `../spec.md`, sections 3 (step 15) and 5.5; ADR 0065

## What to build

- **One App by its ID.** `loadGitHubConnection` takes a connection ID, and every router that calls it names one. The `findFirst` on kind `github` in `src/services/github-connection.ts` and `src/routers/github.ts` goes.
- **`github.connections`:** each App with its owner, its webhook state and its installations: linked, waiting (from the adapter's list, with the account) and removed.
- **`github.createApp`** takes `public`. **`github.connectExisting`** works beside another App: it returns the connection's own webhook address and a generated webhook secret, shown once.
- **`github.linkInstallation`, `github.unlinkInstallation`, `github.removeInstallation`** (organization admin), each with its audit entry.
- **Repos only from linked installations:** `github.repos` and `projects.addRepo` (ticket 30) answer `PRECONDITION_FAILED` ("This installation isn't linked") for any other.
- **Setup's checklist** counts the organization's own App, as today.

## Done when

- [ ] Tests named `it("F-136: ...")`:
  - a waiting installation's repos are offered nowhere, and `projects.addRepo` refuses them
  - link, unlink and remove, with their access and audit entries
  - two Apps listed, each with its own webhook address
  - the generated secret is shown once
  - `createApp` with each answer
- [ ] The whole-repo checks pass (connecting an App stores a key; spec section 9).
- [ ] Committed as `✨ add GitHub organizations to the API`.

## Comments

## Added 2026-11-19 (the lead): fields the approved screens need

The web builder (ticket 54) needs these from this ticket:
- **`github.connections`, per App:**
  - connectionId, slug, ownerLogin, ownerKind, public and webhookUrl
  - the webhook's state: receiving, none, or failing with the last error
  - its installations
- **Each installation:**
  - installationId, accountLogin and accountKind
  - state: linked, waiting, removed or suspended
  - isOwner and repoSelection, with its repos
  - installedAt and installedBy, removedAt and removedBy
  - the projects that use it
- **The actions:**
  - `connectExisting` returns `{ webhookUrl, webhookSecret }`, once.
  - `createApp` and `startManifest` take `public`.
  - Link, unlink and remove take `{ connectionId, installationId }`.
  - `github.repos` is grouped by installation account.
