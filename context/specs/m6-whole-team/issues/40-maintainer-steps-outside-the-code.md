# 40: The maintainer's steps outside the code

Status: ready-for-human
Builder: maintainer
Blocked by: none for the decisions; 13 and 33 for step 1; 39 for the review of the run
Features: F-012, F-035, F-102, F-105, and the screens of ticket 30
Packages: none (decisions and settings outside the repo, recorded here)
Spec: `../spec.md`, sections 3, 11 and 12

## Why a person

Each step needs an account, a click or a yes that an agent doesn't have.

1. **Authorize the Linear app with the agent scopes,** once tickets 13 and 33 are in: on "Connect Linear", press "Turn on agent mode", then Authorize on Linear's page. Save the refresh token ostra shows once as `LINEAR_REFRESH_TOKEN` in `~/.config/ostra-dev/linear.env` (milestone 2's ticket 40 named it; this click gives it). `docs/development.md` gets the name, never the value. Without it, F-012 stays `building` (spec section 3).
2. **The test App's events:** add `check_run`, `check_suite` and `status` to the App's subscribed events in GitHub's App settings, once, and check `pull_request` covers `review_requested`. New Apps get them from the manifest (ticket 08).
3. **`test1`'s workflow fails on a marker.** The App has no `workflows: write` (ADR 0040), so a person changes `.github/workflows/ci.yml` in `test1`: keep `on: push` and `pull_request`, and add a step, for `pull_request` runs, that fails when a file the PR changed under `docs/` contains `TODO-CI`, printing the file and line: after `actions/checkout` with `fetch-depth: 0`, the step `! git diff --name-only "origin/${{ github.base_ref }}...HEAD" -- docs/ | xargs grep -n TODO-CI /dev/null` (grep's `/dev/null` keeps it from reading stdin when no file changed, and `!` turns a match into the failure). Open a test PR with the marker and one without, to see it fail and pass. The demo's step 5 relies on it.
4. **`test1`'s `CODEOWNERS`:** add `.github/CODEOWNERS` with `* @<reviewer login>` (the user of `GITHUB_TEST_REVIEWER_TOKEN`), so GitHub requests their review on every PR (step 7).
5. **`test2` without `AGENTS.md`:** make sure `test2` has none at its root, so the onboarding task has one to add (step 11). If it has one, say so here, and the demo uses a repo that hasn't.
6. **Be there for one stop:** during the manual run, press "Send stop request" in Linear on the ticket the harness and the demo name (ticket 38, step 10). It's the one thing no key can do (ADR 0013).
7. **Approve the milestone 6 screen targets** (ticket 30), recorded there with the date.
8. **Review spec section 11's twenty choices** (Q210 to Q229 in `context/open-questions.md`), all settled on the delegation of 2026-11-19, and move back to the open list any you disagree with.

## Done when

- [ ] Each step is done or answered, with the date, under `## Comments`.

## Comments
