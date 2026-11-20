# 06: Domain: lifecycles, filters, cron, starts, the review loop, templates

Status: done
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

- [x] Every lifecycle test, the cron reference test, the filter tests, the matching tests and the templates' tests pass.
- [x] Break-it checks for the proofs these tests carry (the cron's daylight-saving case, the filter's label exclusion, the counters' reset), recorded in the proof files of F-106, F-011 and F-101.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add the milestone 6 domain`.

## Comments

- 2026-11-20, core: built as `✨ add the milestone 6 domain`, on ticket 05's `c4bd5d33` (`✨ add the milestone 6 migration`). Readings and differences:
  - **Lifecycles** in `src/lifecycles/m6.ts`: an automation, an occurrence or match, a bulk item, an agent session, a draft (versions; only the latest applies; ready after applied; an edit after that is a draft again), a CI run per head, a round, a review run, a finding and an environment proposal, each edge tested in `src/milestone-6.test.ts`. An outside task's approval and the code task's in-review sub-states were already milestone 1's union (`task.ts`); the test now walks every edge `domain-model.md` draws, and refuses what it doesn't.
  - **Intake filters** (`src/automations/intake-filter.ts`): labels any or all (case-folded), exclusions, status by ID or category, assignee (a user, nobody, the app), boards and the tracker's projects. A filter must name one condition, so no rule matches every ticket; a closed ticket never matches. The cached ticket has no tracker-project column yet, so `trackerProjectId` is `null` until ticket 11's ingest fills it (a filter on it then matches nothing).
  - **The cron evaluator** (`src/automations/cron.ts`): ostra's own, on `Intl`. A skipped local time fires at the gap's end, a repeated one at its first instant; Vixie's rule when both day fields are set. Checked over every minute of 2026 in `UTC`, `Europe/Amsterdam` and `America/New_York` against a minute-by-minute reference, and the daylight-saving days by hand. `planOccurrences` is the missed rule (the latest under the window fires; older ones are missed, at most 50 named and the rest counted); `minimumIntervalOk` checks a leap year and a month on the wall clock.
  - **Starts** (`src/starts/start-task.ts`): the origin union (the ticket's seven), `taskOriginOf`, `startRuleFor` (an outside task: the project's default profile, pools only, approval while the switch is on; a matched Linear member runs at once on the default code profile; a rule's or an occurrence's task may ask for approval), `leavesToStart`, the one-active-task error. A review task isn't a `startTask` origin: `startReview` makes it, with `pr_review`. **Member matching** compares folded, trimmed addresses; two active members with one address are called outside rather than guessed. The fixture set is `trackerUserFixtures` in `@ostra/domain/testing`, with `ciCheckRun`, `ciResults`, `filterTicket` and `ticketTree` for the builders.
  - **The review loop** (`src/review-loop/`): `ciVerdict` (ostra's own App's runs left out; `startup_failure` fails too, since nothing ran), `failingChecks`, `roundAllowed`, `countRound` and `resetOnPersonAction`, `placeFindings` and the review's body (a suggestion fenced past any backticks it holds), the CODEOWNERS parser with `ownersFor`.
  - **Prompts** (`src/prompts/m6.ts`): refine, review, onboarding, and the three rounds on `@ostra/protocol`'s `roundPrompt`; every piece of ticket, PR, check, finding or reviewer text a marked block, tested with shell syntax, an instruction and the block's own closing marker. `draftAsDescription` leaves the criteria out where the tracker has the field. **The agent-session copy** (`src/linear/agent-session-copy.ts`): one renderer per moment, plus a member's follow-up, an outsider's, and no board for the team; the inputs have no field for any text not ostra's.
  - **Mails:** the five kinds join milestone 3's `MomentDetail` and `renderNeedsYouEmail`, with ticket 04's headings (`teamMomentHeading`); an automation's mail names the automation where a task's names the task.
  - **The budget gate's origins** `changes-requested` and `linear-follow-up` landed with ticket 05, which needed them for the schema's enum.
  - **Signatures, jobs and settings:** `src/use-cases/m6-signatures.ts` (each of section 5.4's, with `SubmitReview` and `SeedBuiltInProfiles` beside them); the 16 jobs with their keys and queues (`packages/jobs`); the 17 settings with their defaults, read as `settings.team`, each with its line in `docs/configuration.md`.
  - **Proofs:** rows in F-106, F-011 and F-101 (all `partial` until core and api finish them). Break-its: a repeated hour at its last instant, and a skipped time before its gap, each failed the zone references and the daylight-saving list; the missed rule firing whatever the lateness failed its test; the filter ignoring exclusions failed the exclusion test; a person's action keeping the automatic turns failed the reset test; a paused automation refusing `resume` failed the lifecycle test; nits quoted as findings failed the findings-round test.
