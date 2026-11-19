# 19: Web: the phone sweep

Status: ready-for-agent
Builder: web
Blocked by: 12
Features: F-075
Packages: `apps/web`, `apps/web/e2e/phone/` (new)
Spec: `../spec.md`, section 10.1

## What to build

The final check of F-075 over every screen milestones 1 to 7 built: every route at 390 px with no horizontal scroll of the page (a table or a diff may scroll inside itself), every control at least 44 px tall to touch, nothing hidden that the desktop shows except what the target says; and the "needs you" moments done by touch end to end: approve, answer, reopen (milestone 3's `phone-approval`). Fix what fails, in the screen's own code.

## Done when

- [ ] Tests named for `F-075` (Playwright, a touch device at 390 × 844): no route scrolls sideways; approve, answer and reopen work by tap from "Needs you" to the task's new state (break-it: a fixed-width element added to the task page fails the scroll check).
- [ ] Typecheck, lint and tests of `apps/web` pass.
- [ ] Committed as `✅ check every screen at phone width`.

## Comments
