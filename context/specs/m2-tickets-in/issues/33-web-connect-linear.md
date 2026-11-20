# 33: Web: connect Linear, and the checklist's Linear step

Status: done
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

- [x] Component tests for each state (not connected, pending, active by webhooks, active by polling, silent webhooks, failed token, revoked, an `api_key` connection), and `AdminOnly` for a member.
- [x] A Playwright run against the fake Linear server goes from "Connect Linear" to `active`.
- [x] Committed as `✨ add the Linear connection screen`.

## Comments

- 2026-11-19, web: the screen is built and committed (`✨ add the Linear page's views and step circles`, `99410e1`, then `✨ add the Linear connection screen`, `414dd04`), to `connect-linear` and `home-first-run`, checked side by side at 1440×956 (connected by webhooks from a fixture, then against ticket 27's router with a dev `api_key` connection to ostra-test: polling, `Personal API key (development)`, no Authorize).
  - `components/linear/`: `linear-types.ts` (aliases of `linear.status`), `linear-status.ts` (the page's words), `linear-panel.tsx` (the three steps, the connected sections, the panel; tested state by state), `linear-view.tsx` (the router calls: `saveApp` and `authorizeUrl` take the `connectionId`; `Start again` is `disconnect` then `start`). The page is `AdminOnly` for a member (`page.test.tsx`), and the sidebar's `Linear` row (`ticket`) shows to admins only.
  - Home: `StepTick` (`components/ui/step-tick.tsx`, with the `skipped` look) replaces the checklist's `Tick`; `SetupSteps` renders the six Linear states and `Skip for now`; the right column is the Deep water picture while the checklist shows (`PageFrame` gained `decorative`).
  - **Still open: the Playwright run against the fake Linear server.** The panel has no setting that points `createApiRuntime`'s `linearEndpoints` at another server, so a browser run can't reach the fake. It needs a dev-only setting (say `OSTRA_DEV_LINEAR_URL`, with its line in `docs/configuration.md`) read in `apps/web/src/server/deps.ts`, and `e2e/stack.ts` starting `createFakeLinear()` and registering the app's callback. Left for the next web pass.
- 2026-11-20, m2-linear-e2e: the Playwright run is in (`✨ follow OSTRA_LINEAR_API_URL in Connect Linear`, `d7ebfae`, then `✅ prove Connect Linear and the Inbox end to end`, `bd3b538`). Every box holds.
  - **The setting, without a new one:** Connect Linear's endpoints follow `OSTRA_LINEAR_API_URL` (`linearAppEndpoints` in `adapter-linear`): Linear's own on `api.linear.app`, and for any other address (only a fake Linear sets it) the same paths on its origin, the new-app form the manifest link opens included. `deps.ts` passes them to `createApiRuntime`, and core refreshes the token at the same place. `docs/configuration.md` says so.
  - **The app is made from the link:** the fake Linear serves `/settings/api/applications/new`: it registers the app from the manifest at once (as Create does) and shows the client ID, client secret and webhook secret, so the spec pastes what the page shows, with the panel's real callback.
  - `apps/web/e2e/22-linear-inbox.spec.ts`, first case (`F-005/c1, F-076/c1`), in an organization of its own (`seed-linear-world.ts`; every other spec's seed connects the first organization with an API key): the mode line says polling (core is on loopback), Create the app opens the fake's form, two values, Authorize through the fake's consent and back to `/api/linear/callback`, `Connected`, `Polling every 60 s`, the app user, and Home's Linear step `done`. It never reaches the real Linear (the run aborts `*.linear.app`). Passed on the production build (desktop), twice on one stack. Break-it: `linearAppEndpoints` answering Linear's own for the fake: the case failed, with the endpoints' unit test and `linear.test.ts`.
  - Still the maintainer's: the first Authorize on real Linear (ticket 40). A webhooks-mode run needs a public https core, which the local stack hasn't.
