# 29: API: onboarding and environment proposals

Status: ready-for-agent
Builder: api
Blocked by: 21
Features: F-113
Packages: `packages/api` (`src/routers/environments.ts`)
Spec: `../spec.md`, section 4 ("The onboarding task")

## What to build

- `environments.startOnboarding({ projectId })` for a project admin, refused while one is open; `environments.proposal({ projectId })` → the open proposal as a diff per repo against the current version (setup script, checks, variable names, services), its notes and its task; `environments.decideProposal({ proposalId, decision: "accept" | "edit-and-accept" | "reject", edited | null, reason | null })` for a project admin.

## Done when

- [ ] Tests: start and decide by a project admin only; one open onboarding task; the diff per repo; an edit that adds a secret's value refused by the scan.
- [ ] The touched packages' checks pass (spec section 9).
- [ ] Committed as `✨ add the onboarding API`.

## Comments
