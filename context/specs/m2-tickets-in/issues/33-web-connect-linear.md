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
- Admins only: a member gets `AdminOnly`, as on the GitHub page (decided below). Every string in `messages/en.json`. Dark first, responsive.

## Decided 2026-11-19 (ticket 40)

The lead, on the maintainer's delegation, settled the open points the milestone 2 targets (`context/brand/app-targets/m2/`) and ticket 40 left. They're part of what to build:

- **Admins only.** The page is `AdminOnly`, and the sidebar shows Linear (`ticket`, after GitHub) to admins only. This replaces "a member sees the state without the controls" above (ticket 27). The component tests drop the member case and add `AdminOnly`.
- **The mode before the click** comes from `linear.status`'s `none` state (ticket 27).
- **The checklist's Linear step** follows `home-first-run.md` in full: the six states, `Skip for now` through `setup.skip`, and the outline `New task` in the top bar while the checklist shows. While `next` isn't null, the right column shows the Deep water illustration.
- **Shared pieces:** move `Tick` out of `setup-checklist.tsx` into a shared component. Add `AlertDialog` and `Skeleton` with the shadcn CLI (`radix-ui` is already a dependency).
- **An `api_key` connection** shows `Personal API key (development)` in place of the app user, and has no Authorize.

## Done when

- [ ] Component tests for each state (not connected, pending, active by webhooks, active by polling, silent webhooks, failed token, revoked, an `api_key` connection), and `AdminOnly` for a member.
- [ ] A Playwright run against the fake Linear server goes from "Connect Linear" to `active`.
- [ ] Committed as `✨ add the Linear connection screen`.

## Comments
