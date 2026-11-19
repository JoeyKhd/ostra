# 06: Domain: lifecycles, filters, cron, starts, the review loop, templates

Status: ready-for-agent
Builder: core (contracts, first; bodies by core and api)
Blocked by: 01, 05
Features: every F-ID of the spec's section 2
Packages: `packages/domain`
Spec: `../spec.md`, section 5.4

## What to build

Pure code and signatures; the bodies that touch Postgres or the queue are core's and api's tickets.

- **Lifecycles** of spec section 5.4, each a discriminated union with an exhaustive transition table and a test per edge, including the code task's in-review sub-states as `domain-model.md` draws them.
- **`intakeFilterSchema` and `matchesFilter`,** with a test per field and a near miss for each.
- **The cron evaluator:** `parseCron`, `nextOccurrence(cron, timeZone, after)` and `occurrencesBetween`, ostra's own, on `Intl.DateTimeFormat`. Tested against a reference list over a year of minutes in `UTC`, `Europe/Amsterdam` and `America/New_York`, across both daylight-saving changes (a skipped local time fires at the next valid minute, a repeated hour fires once). `minimumIntervalOk(cron, minutes)` for the setting.
- **`startTask`,** the one start use case's signature and its pure part: the origin union (`member`, `intake-rule`, `occurrence`, `bulk-item`, `sub-issue`, `linear`, `onboarding`), the outside rule, the profile and pool rule for an outside task, the sub-issue tree walk (`leavesToStart(tree, boards, depth, max)`), the one-active-task check's error.
- **Member matching** (ADR 0057): `matchTrackerUser(user, members, project)`, with the fixture set of spec section 8.
- **The review loop:** `ciVerdict`, `roundAllowed`, the counters and their reset, `placeFindings`, the CODEOWNERS parser and `ownersFor`.
- **Templates and prompts** of spec section 5.4, and the agent-session copy, each a pure renderer with a snapshot test and a test that untrusted input is quoted as data, never spliced into instructions.
- **Mail templates** for the five new kinds, on milestone 3's renderers: the task's title and key, the moment, one line, a link, never task content.
- **The budget gate's origins** gain `changes-requested` and `linear-follow-up`; a rule's, an occurrence's and a bulk item's starts are `dispatch`, and `automatic-round` is milestone 4's.
- **Use-case signatures, jobs and settings** as spec section 5.4 lists them, each setting with its default and its line in `docs/configuration.md`.

## Done when

- [ ] Every lifecycle test, the cron reference test, the filter tests, the matching tests and the templates' tests pass.
- [ ] Break-it checks for the proofs these tests carry (the cron's daylight-saving case, the filter's label exclusion, the counters' reset), recorded in the proof files of F-106, F-011 and F-101.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add the milestone 6 domain`.

## Comments
