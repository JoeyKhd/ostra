# 49: Core: linked installations, their webhooks and each repo's bot

Status: ready-for-agent
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

- [ ] Tests named `it("F-136: ...")`:
  - a delivery from an unlinked installation stores no `WebhookDelivery` and changes nothing, and one from a linked installation is processed. Break-it: the check removed fails it
  - no mint for an unlinked or removed installation, on every call site. Break-it: the check removed from the credentials fails it
  - the owner's own installation is linked when seen
  - a task across two Apps' repos has each repo's bot in its spec, and a minor-2 runner gets no offer for it
- [ ] The break-its are recorded in `context/proof/F-136.md`.
- [ ] The whole-repo checks pass (webhooks, credentials, the protocol; spec section 9).
- [ ] Committed as `✨ use only linked installations`.

## Comments
