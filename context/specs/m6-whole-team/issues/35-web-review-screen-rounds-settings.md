# 35: Web: the review screen, the task's rounds and review settings

Status: ready-for-agent
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

- [ ] Playwright, on the fake code host with the reviewing fake: a task through a CI round and a findings round to "waiting for a reviewer"; "Fix this" and "Send to agent"; "Remember this".
- [ ] Each screen checked against its target at 1440 px and at phone width, in dark and light.
- [ ] The touched packages' checks pass (spec section 9).
- [ ] Committed as `✨ add the review screens`.

## Comments
