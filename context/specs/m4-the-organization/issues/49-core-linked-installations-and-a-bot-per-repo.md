# 49: Core: linked installations, their webhooks and each repo's bot

Status: resolved
Builder: core
Blocked by: 46, 47
Features: F-136, F-078, F-098
Packages: `apps/core` (`src/webhooks/inbox.ts`, `src/webhooks/process.ts`, `src/dispatch/task-spec.ts`, `src/code-host/`, `src/cleanup/`, `src/snapshots/`), `packages/domain` (`src/use-cases/issue-task-credentials.ts`, `src/use-cases/dispatch-task.ts`, `src/postgres-plumbing.ts`)
Spec: `../spec.md`, sections 4 ("Linked installations") and 5.5; ADR 0065

## What to build

- **The inbox** reads the installation ID of a verified GitHub delivery, and stores the delivery only when that installation is linked to the delivery's connection. Otherwise it answers 202, stores nothing, and logs `webhook.installation-not-linked` with the connection's and the installation's IDs. The exceptions are the `installation` events: `created` on the App owner's own account links it, and `deleted` marks a linked installation removed.
- **Every token mint** goes through the repo's installation row and is refused when `installationUsable` says no: the credentials, the PR opener, the PR reconcile, the cleanup, the snapshots and environment detection. List each call site under `## Comments`.
- **A bot per repo.** The spec gives each repo its own App's bot as `repos[].gitIdentity`, read as the first repo's is today (the connection's stored bot, else `getBotIdentity`). The top-level `gitIdentity` stays the first repo's, for a minor-2 runner. The dispatch sends a task whose repos have different bots only to a minor-3 runner.
- **A repo whose installation was unlinked or removed** stops new tasks with the reason, a dispatch wait code with its message key.
- **The owner's own installation** is linked when `listInstallations` or an `installation` event shows it.

## Done when

- [x] Tests named `it("F-136: ...")`:
  - a delivery from an unlinked installation stores no `WebhookDelivery` and changes nothing, and one from a linked installation is processed. Break-it: the check removed fails it
  - no mint for an unlinked or removed installation, on every call site. Break-it: the check removed from the credentials fails it
  - the owner's own installation is linked when seen
  - a task across two Apps' repos has each repo's bot in its spec, and a minor-2 runner gets no offer for it
- [x] The break-its are recorded in `context/proof/F-136.md`.
- [x] The whole-repo checks pass (webhooks, credentials, the protocol; spec section 9).
- [x] Committed as `✨ use only linked installations`.

## Comments

- 2026-11-19, `✨ use only linked installations`: the inbox reads a verified GitHub delivery's `installation.id` and stores it only when that installation is linked to the delivery's connection; otherwise 202, nothing stored, and `webhook.installation-not-linked` with the connection's and the installation's IDs (`apps/core/src/webhooks/inbox.ts`). The `installation` event is stored whatever its state: `created` links the App owner's own (`linkOwnInstallationInTx`, the owner read once by `readApp` and kept on the connection), `deleted` marks a linked one removed (`installationGoneInTx`), each with its audit entry by the system (`apps/core/src/code-host/pull-requests.ts`). `github.installations` links the owner's own when its listing shows it, and `createProject` writes no installation row any more: it links the owner's own when it hasn't seen it, keeps the admin's choice when the host doesn't name the App's owner, and refuses a removed or another account's waiting installation. A repo whose installation isn't usable stops new tasks with the dispatch wait `installation-not-linked` (its repo named; `dispatchNoteFor` gives the sentence). The spec gives each repo its own App's bot as `repos[].gitIdentity` at minor 3, the top-level one stays the first repo's, and the dispatch sends a task across two Apps only to a minor-3 runner (`SEVERAL_APPS_MINOR`).
  - **Every mint site, each refused through `installationUsable` before the App's key is read:** the credentials (`packages/domain/src/use-cases/issue-task-credentials.ts`, 403 `installation-not-linked` from `apps/core/src/dispatch/endpoints.ts`); the task spec (`apps/core/src/dispatch/task-spec.ts`); the dispatch (`dispatch-task.ts`, the wait); the PR opener (`open-pull-requests.ts`); the PR reconcile (`apps/core/src/code-host/pull-requests.ts`, linked repos only); the hidden-ref cleanup (`apps/core/src/cleanup/cleanup.ts`); the snapshot's build inputs and build credentials (`packages/domain/src/use-cases/snapshots.ts`) and its push compare (`apps/core/src/snapshots/snapshots.ts`); `repoAccessFor` (milestone 3's compares, drafts, PR comments and reactions); the branch checks (`repo-checks.ts`); environment detection (`packages/api/src/routers/environments.ts`); the CLI's branches (`packages/api/src/services/cli-http.ts`).
  - Tests: `apps/core/src/code-host/linked-installations.test.ts`, `packages/api/src/routers/linked-installations.test.ts`; 19 break-its in `context/proof/F-136.md`, the credentials' among them. Proved with the fake code host; the live run with a second GitHub organization is ticket 55.
  - Left to others: `github.repos` and `github.detect` still take any installation ID an admin passes (ticket 51 refuses a waiting one, with `projects.addRepo`); the runner still authors every repo's commits with the top-level `gitIdentity`, so a task across two Apps commits as the first App's bot until the runner reads `repos[].gitIdentity`, which no ticket names yet; the wait code's panel words are ticket 54's.
