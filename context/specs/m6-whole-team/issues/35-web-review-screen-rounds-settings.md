# 35: Web: the review screen, the task's rounds and review settings

Status: done
Builder: web
Blocked by: 28, 30
Features: F-102, F-100, F-101, F-035, F-105, F-111
Packages: `apps/web` (`src/routes/tasks/$taskId/review.tsx`, the task page, the project's settings)
Spec: `../spec.md`, section 12 (`review-screen`, `task-rounds`, `review-settings`, and the checks tab, Home and memory proposals growing)

## What to build

- The review screen with its tabs per PR, file tree, findings inline, "Fix this", "Remember this", the ticket's acceptance criteria, the reviewers and "Open on GitHub to approve".
- The task page's stage line, "automatic turns N of 4", the round cards in the thread, the held round, the cap's needs-you with "Keep working"; the Checks tab's code-host CI with log files.
- The project's "Review" settings; "Waiting for your review" and the round cap on Home; "AI finding" as a proposal's source on the Memory page.

## Done when

- [x] Playwright, on the fake code host with the reviewing fake: a task through a CI round and a findings round to "waiting for a reviewer"; "Fix this" and "Send to agent"; "Remember this".
- [x] Each screen checked against its target at 1440 px and at phone width, in dark and light.
- [x] The touched packages' checks pass (spec section 9).
- [x] Committed as `✨ add the review screens`.

## Comments

- 2026-11-20: built in `✨ add the review screens`. The review screen is `/tasks/{id}/review` (`apps/web/src/components/tasks/review/review-screen.tsx`, the Next.js path for the ticket's `routes/tasks/$taskId/review.tsx`): a tab per PR, milestone 3's Changes tab reused with the AI review's findings drawn on their lines (`rowsOf` and `DiffView` gain an additive findings slot: on the line before its comments, newest round first; off the diff under "Not on a changed line"; outdated after the last hunk), "Fix this" (`review.fixThis`, then the bar's "Send to agent"), "Remember this" (`review.rememberFinding`, with a link to the proposal), the round line (the viewer's own review in amber), and the panel's ticket with its criteria, reviewers and PR, with "Open on GitHub to approve" on the PR's files. The task page gains the `Review` button, the stage line with "automatic turns N of 4", a card per round in the Activity tab, the cap's needs-you with "Keep working", "Open the checks" and "Open the review", and the Rounds group; the Checks tab gains the code host's CI per PR; the project gains Settings > Review (`review-settings-view.tsx`): the AI review switch, the review and refine profiles, the install's limits, "Outside tasks need approval" (ticket 26's switch), and each repo's CI as ostra last saw it.
- Additive server changes, each tested: `tasks.get` gains `roundCounts` (the counters, their limits, `lastPersonActionAt`); `projects.reviewSettings` gains `repos` (each repo's newest CI run); milestone 3's `keepWorking` also answers a `round_cap` item, with its own words, as ticket 18's comment planned (a member message, so the counters reset).
- Choices: the round cards render at the end of the Activity tab's thread (its `tail`), oldest first, not interleaved with the messages by time; a capped round has no card (the cap's needs-you says it); the files column is milestone 3's list (paths shortened), not a nested tree; a reviewer who isn't the driver may press "Send to agent" (open point 1); "Fix this" makes a draft (open point 2), on nits too (open point 3). The cap's stage line isn't drawn (the schema keeps a sub-state only in review). Not built: the review bar's reviewer-specific hints, `f` and `[`/`]` keys, and "Show the turn" folding.
- Proof: `apps/web/e2e/19-review.spec.ts` on the desktop and phone projects, against the fake GitHub: the project is made through New project on `test1`, and the rows core's loop leaves after a CI round and a findings round are seeded as core writes them (`seed-review-world.ts`: the CI round's failing check and log, round 1's blocking finding resolved, the reviewing fake's nit open, a requested reviewer and a CODEOWNERS team), because the e2e stack runs no agent; the loop itself is proved by tickets 16 to 18's core tests. The cases read the stage line, the round cards and the Checks tab, open the review screen, press "Fix this" and "Send to agent" and "Remember this", press "Keep working" at the CI cap, and switch the AI review off and on. Break-it: no findings passed to the review screen failed the case. Unit and API break-its, each failing its case: no finding on its line, every earlier stage done, every viewer still to review, every cap read as CI, `keepWorking` refusing a cap, no CI for a repo whose newest run failed. Rows in `context/proof/F-102.md`, `F-100.md`, `F-101.md`, `F-035.md` and `F-111.md`.
- Checked against `review-screen.webp`, `task-rounds.webp` and `review-settings.webp` at 1440 px and at phone width, in dark and light; the finals are `C:/Users/santi/ow/_lead/ui-check/m6-review-screen*-final.png`, `m6-task-rounds*-final.png` and `m6-review-settings*-final.png`.
