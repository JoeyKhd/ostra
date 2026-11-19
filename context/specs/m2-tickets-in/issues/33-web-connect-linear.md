# 33: Web: connect Linear, and the checklist's Linear step

Status: ready-for-agent
Builder: web
Blocked by: 27, 32 (the targets' approval, for the UI)
Features: F-005, F-042, F-076
Packages: `apps/web` (`src/app/(panel)/organization/linear/`, `src/components/linear/`, `src/components/home/setup-checklist.tsx`, `messages/en.json`)
Spec: `../spec.md`, sections 3 (step 1) and 12 (screens 1 and 2)

## What to build

To the approved targets for screens 1 and 2.

- **Connect Linear,** in three steps on one page: the manifest link (opens Linear in a new tab), with the mode it will run in and why; the three values (two in polling mode), pasted into secret fields that never show a saved value again; Authorize. Then the connected state: the workspace, the app's user, the mode ("webhooks: receiving" or "polling every 60 s"), the last event received, the token's health, a warning when webhooks have gone silent, and Disconnect with a confirmation.
- **The first-run checklist** shows Linear as a live step between GitHub and the project, done when a connection is `active`, and still skippable (a project can run on prompts alone).
- Admins only; a member sees the state without the controls. Every string in `messages/en.json`. Dark first, responsive.

## Done when

- [ ] Component tests for each state (not connected, pending, active by webhooks, active by polling, silent webhooks, failed token, revoked).
- [ ] A Playwright run against the fake Linear server goes from "Connect Linear" to `active`.
- [ ] Committed as `✨ add the Linear connection screen`.

## Comments
