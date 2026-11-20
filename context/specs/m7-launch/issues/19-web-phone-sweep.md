# 19: Web: the phone sweep

Status: resolved
Builder: web
Blocked by: 12
Features: F-075
Packages: `apps/web`, `apps/web/e2e/phone/` (new)
Spec: `../spec.md`, section 10.1

## What to build

The final check of F-075 over every screen milestones 1 to 7 built: every route at 390 px with no horizontal scroll of the page (a table or a diff may scroll inside itself), every control at least 44 px tall to touch, nothing hidden that the desktop shows except what the target says; and the "needs you" moments done by touch end to end: approve, answer, reopen (milestone 3's `phone-approval`). Fix what fails, in the screen's own code.

## Done when

- [x] Tests named for `F-075` (Playwright, a touch device at 390 × 844): no route scrolls sideways; approve, answer and reopen work by tap from "Needs you" to the task's new state (break-it: a fixed-width element added to the task page fails the scroll check).
- [x] Typecheck, lint and tests of `apps/web` pass.
- [x] Committed as `✅ check every screen at phone width`.

## Comments

- 2026-11-20: done in the commit `✅ check every screen at phone width` (its hash is on `origin/main`; this ticket's next edit records it).
  - **The sweep** is its own Playwright project, `phone-sweep` (Chromium as a touch phone at 390 × 844), in `apps/web/e2e/phone/sweep.spec.ts`. It seeds its own admin and world (`e2e/seed-routes-world.ts`: an approval, a question and a no-changes task each with its notification, notes, a pool and runner, an invitation), so it runs alone after `next build` and doesn't wait on the desktop specs, several of which fail on `main` today (the checklist's Linear step, ticket 24's work). Every `page.tsx` must be listed in `e2e/routes.ts`, or the naming test fails; ticket 20's pseudo-locale pass walks the same list.
  - **What failed, and the fix:** no route scrolled sideways, but every route had controls under 44 px (30 px buttons, 26 px small ones, 34 px fields, 40 px tabs). The fix is one rule in `globals.css` under `@media (pointer: coarse)`: buttons, links drawn as buttons (`data-slot="button"`, now on `Button`), fields, selects, tabs and comboboxes are at least 44 px tall on a touch screen, and a mouse keeps the desktop's dense sizes. A checkbox, a switch or a radio is pressed through its row.
  - **By tap:** "Approve once" on Needs you leaves the task `running`; "Send answer" queues its next turn (no runner holds the seeded session, so the answer reopens it); the no-changes row's "Open task", then the composer's Reopen, leave it `queued`; Done lists both answers. The task page's state line now carries `data-state` for the check.
  - **Break-its:** a 600 px element after the task page's title failed the scroll check on `/tasks/[task-id]` alone (226 px); the touch rule set to 0 listed every route's controls; "Approve once" made a no-op failed the tap test; a route left out of `routes.ts` failed the naming test.
  - **Proof:** `context/proof/F-075.md`. Its first sentence is proved; "There's no mobile app" and "built with shadcn/ui ... desktop first" are statements of scope no test can fail on, left `missing` for ticket 32, so F-075 is `building`.
