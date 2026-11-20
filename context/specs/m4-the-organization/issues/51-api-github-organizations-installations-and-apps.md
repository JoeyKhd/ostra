# 51: API: GitHub organizations, installations and several Apps

Status: resolved
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

- [x] Tests named `it("F-136: ...")`:
  - a waiting installation's repos are offered nowhere, and `projects.addRepo` refuses them
  - link, unlink and remove, with their access and audit entries
  - two Apps listed, each with its own webhook address
  - the generated secret is shown once
  - `createApp` with each answer
- [x] The whole-repo checks pass (connecting an App stores a key; spec section 9).
- [x] Committed as `✨ add GitHub organizations to the API`.

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

## Comments (api builder B)

- 2026-11-20: built and pushed as `✨ add GitHub organizations to the API`. `loadGitHubConnection(deps, scope, connectionId)` names its App; `null` is the organization's own App (the first connected), which milestone 1 to 3's procedures still mean, so their inputs only grow an optional `connectionId` (`github.installations`, `repos`, `detect`); environment detection uses each repo's own App. New in `packages/api/src/routers/github-organizations.ts`: `github.connections` (every App, its own first: connectionId, appId, slug, ownerLogin, ownerKind, `public` (`true` once another account has it installed, else `null`: no column records the manifest's answer), `own`, its own `webhookUrl`, the webhook's state (`none`, `receiving`, `failing` with the last error), and each installation: state `linked`/`waiting`/`removed` (`suspended` is in the enum but nothing records it yet), isOwner, repoSelection, its repos when linked, installedAt/By, removedAt/By, the projects using it); `github.linkInstallation`, `unlinkInstallation` and `removeInstallation` (`{ connectionId, installationId }`, organization admins, each an audit entry; a failed uninstall leaves it linked); `github.reposByAccount` (every linked installation's repos, grouped by account, across the Apps). The lead's "`github.repos` is grouped by installation account" is this new procedure, so `github.repos` keeps its shape for today's panel. `github.repos` and `github.detect` answer `PRECONDITION_FAILED` ("This installation isn't linked") for an installation that isn't linked, and `NOT_FOUND` for one GitHub doesn't list; `projects.addRepo` and `projects.create` refuse one (ticket 49's domain rule). `connectExisting` takes an optional `webhookSecret`: without it ostra generates one and answers it with the connection's `webhookUrl` this once; beside the organization's own App it connects a client's App through ticket 46's `connectExistingApp`, with its owner from GitHub. `createApp` (the manifest flow's first step under its own name) and `startManifest` take `public`, `false` by default. Setup's checklist still counts any connected App. The API's fake GitHub gains `removeInstallation`. Tests: `packages/api/src/routers/github-organizations.test.ts` and the isolation suite's new rows, proved with the fake GitHub's second account and a stranger's installation; the live run with a second org is ticket 55.
- 2026-11-20: the commit is `9ea496a3` on main; the whole-repo checks passed on it before the push (turbo typecheck, lint and test, 98 of 98 tasks at concurrency 2; the root tsc, lint and tests; check:licenses; check:proof).
- 2026-11-20: review fix, pushed as `🐛 fix review findings in packages/domain`. `projects.addRepo` for a repo of a waiting installation (GitHub lists it, ostra hasn't linked it) now answers `PRECONDITION_FAILED` with "This installation isn't linked", as step 15 and this ticket say, instead of "can't reach that repo": `findReachableRepo` (`packages/domain/src/repos/project-repos.ts`) looks through the Apps' unlinked installations when no linked one lists the repo, and answers `not-linked`. `NOT_LINKED_MESSAGE` moved to the domain (`code-host/installations.ts`), and the API re-exports it. The F-136 waiting test asserts both messages; break-it in `context/proof/F-136.md`.
