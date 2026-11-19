# 42: The maintainer's steps outside the code

Status: ready-for-human
Builder: maintainer
Blocked by: none for the decisions; 41 for the review of the run
Features: F-002, F-104, and the screens of ticket 31
Packages: none (decisions and settings outside the repo, recorded here)
Spec: `../spec.md`, sections 3, 11 and 12

## Why a person

Each step needs an account, a click or a yes that an agent doesn't have.

1. **The test token's rights:** confirm the token in `github-test.env` may set and remove branch protection on `ostra-test/test1` and `test2` (repository administration), and dismiss a review. If it can't, give it that right on those two repos only, or set the protection by hand before the run and remove it after.
2. **The reviewer user** of `GITHUB_TEST_REVIEWER_TOKEN` (milestone 3's step 4) is a collaborator on `test1` and `test2` who can approve, and, for the manual run, links to Sam once through the App's OAuth.
3. **The App's events:** add `pull_request_review` to the test App's subscribed events in GitHub's App settings, once. New Apps get it from the manifest (ticket 08).
4. **Addresses for the manual run:** three addresses that reach the maintainer (plus addresses work) for Demo, Sam and Rae, kept in `~/.config/ostra-dev/email.env` as `EMAIL_TO_SAM` and `EMAIL_TO_RAE`; `docs/development.md` gets the names, never the values.
5. **Approve the milestone 4 screen targets** (ticket 31), recorded there with the date.
6. **Review spec section 11's nineteen choices** (Q191 to Q209 in `context/open-questions.md`), all settled on the delegation of 2026-11-19, and move back to the open list any you disagree with.
7. **Review Q91's answer:** settled on the delegation of 2026-11-19 from `research/project-memory.md` (ADR 0044, "Q91: what the prior art changed"; spec section 11, item 13). Move it back to the open list if you disagree with any of its five changes.

## Done when

- [ ] Each step is done or answered, with the date, under `## Comments`.

## Comments

- 2026-11-19, the agent's pass (commit `📝 prepare the milestone 4 build`). What an agent could do is done; every step below still needs the maintainer.
  1. **The test token's rights:** not checkable yet. `github-test.env` holds no token today (no `GITHUB_TEST_ADMIN_TOKEN`, `GITHUB_TEST_MEMBER_TOKEN` or `GITHUB_TEST_REVIEWER_TOKEN`), and this machine has no `gh` login. **Left for the maintainer:** a token with repository administration and pull-request write on `ostra-test/test1` and `test2` only, added to `github-test.env` (the demo uses it to set and remove branch protection and to dismiss a review).
  2. **The reviewer user:** `GITHUB_TEST_REVIEWER_TOKEN` isn't in `github-test.env` yet. **Left for the maintainer:** a second GitHub user, a collaborator on `test1` and `test2` with write access (to approve), its token in `github-test.env`, and, for the manual run, one sign-in through the App's OAuth as Sam. `docs/development.md` now says what the user must be.
  3. **The App's events:** checked with the App's own JWT against `GET /app`: the test App (`ostra-sandbox-036d7c`, owned by `ostra-test`, one installation) subscribes to **no events at all** today, and holds no `administration` permission (it needs none: the token of step 1 sets the protection). **Left for the maintainer:** in the App's settings, "Permissions & events", tick `Pull request review` (and keep milestone 1's events once the webhook is on, with `GITHUB_APP_WEBHOOK_SECRET` in `github.env`). Ticket 08 adds the event to the manifest for new Apps.
  4. **Addresses:** `docs/development.md` names `EMAIL_TO_SAM` and `EMAIL_TO_RAE` in `email.env`, never the values. There's no `email.env` on this machine yet. **Left for the maintainer:** `email.env` with `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_TO`, `EMAIL_TO_SAM` and `EMAIL_TO_RAE`, for the manual run only. The scripted run needs none of it: it mails through SMTP to ticket 40's mail sink (spec section 3, "Mail"), so no Resend key is needed to build or prove milestone 4.
  5. **The screen targets:** approved by the lead on the delegation (`app-targets/m4/README.md`). Every open point in the targets' `.md` files is now settled by its recommendation, under `## Decided 2026-11-19` in the ticket that builds it: 10, 13, 22, 26, 32, 33, 34, 35, 38 and 39. **Left for the maintainer:** look at the pictures, and say which, if any, to remake.
  6. **Q191 to Q209:** settled on the delegation; **left for the maintainer** to review.
  7. **Q91:** settled on the delegation (ADR 0044); **left for the maintainer** to review.
