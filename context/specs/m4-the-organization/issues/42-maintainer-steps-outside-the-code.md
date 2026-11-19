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
