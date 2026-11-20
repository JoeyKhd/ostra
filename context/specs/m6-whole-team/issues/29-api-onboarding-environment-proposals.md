# 29: API: onboarding and environment proposals

Status: done
Builder: api
Blocked by: 21
Features: F-113
Packages: `packages/api` (`src/routers/environments.ts`)
Spec: `../spec.md`, section 4 ("The onboarding task")

## What to build

- `environments.startOnboarding({ projectId })` for a project admin, refused while one is open; `environments.proposal({ projectId })` → the open proposal as a diff per repo against the current version (setup script, checks, variable names, services), its notes and its task; `environments.decideProposal({ proposalId, decision: "accept" | "edit-and-accept" | "reject", edited | null, reason | null })` for a project admin.

## Done when

- [x] Tests: start and decide by a project admin only; one open onboarding task; the diff per repo; an edit that adds a secret's value refused by the scan.
- [x] The touched packages' checks pass (spec section 9).
- [x] Committed as `✨ add the onboarding API`.

## Comments

- 2026-11-20: built in `✨ add the onboarding API`. `packages/api/src/routers/environment-proposals.ts`, spread into the environments router: `environments.startOnboarding` (ticket 21's `startOnboarding`; `CONFLICT` while one is open), `environments.proposal` and `environments.decideProposal` (ticket 21's `decideEnvironmentProposal`). Proof: `context/proof/F-113.md`.
- Domain change, additive: `decideEnvironmentProposal` scans an admin's edit ("edit and accept") with milestone 4's scan, as `proposeEnvironment` scans the agent's, and refuses one holding a secret's value or a credential's shape (`secret-found`, a new member of its result). Ticket 21's decision didn't scan the edit.
- Choices: `environments.proposal` is for anyone who can open the project (the item's audience is the project's members), with `canDecide` for its admins; only an admin decides. The diff follows what "Accept" does: checks and services by name (added, changed, unchanged, and the saved ones the proposal doesn't name, which are kept, not removed); the environment's one setup script is compared with the first repo's, as the onboarding prompt shows it; the variables are the names the proposal needs, split into those without a value yet and those set. A body that doesn't parse is shown as `readable: false`, without its parts. "Edit and accept" without an edit is `BAD_REQUEST`; a reject's reason is kept only as the audit entry's "one was given", as ticket 21 decided.
- Also in this run: `✅ await each refused draft action in turn` fixes ticket 27's drafts test, which built its four refused calls at once and could leave one rejection unawaited.
- Checks: typecheck of `@ostra/api`, `@ostra/core`, `@ostra/domain` and `@ostra/web` through turbo; lint and tests of `@ostra/api`, `@ostra/core` and `@ostra/domain`; `check:licenses`; `check:proof`. Break-its, one at a time, each failing its case: the edit's scan skipped; the open-task check dropped; every repo's checks compared with every repo; anyone who can open the project deciding; anyone starting it (in the router and the domain together).
