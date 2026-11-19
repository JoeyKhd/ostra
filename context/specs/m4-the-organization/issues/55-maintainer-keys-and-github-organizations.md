# 55: The maintainer's steps for keys per project and GitHub organizations

Status: ready-for-human
Builder: maintainer
Blocked by: none for the decisions; 41 for the review of the run
Features: F-135, F-136, and the targets of ticket 52
Packages: none (settings outside the repo; `docs/development.md` gets the names, never the values)
Spec: `../spec.md`, sections 3 (steps 15 to 17) and 11 (items 20 to 24); ADR 0065

## Why a person

Each step needs an account, a click or a yes that an agent doesn't have. The test workspaces hold one GitHub organization, `ostra-test`, and one model key (`docs/development.md`), so the live run of steps 15 to 17 needs a second of each. Without them, the scripted run uses the fake GitHub's second account and two stub model endpoints, `demo.md` says so, and the tests still prove every condition of F-135 and F-136.

1. **A second test GitHub organization,** for example `ostra-test-b`, with one repo, `testb1`, holding a README. Keep its names and a token in `~/.config/ostra-dev/github-test.env` as `GITHUB_TEST_ORG_B`, `GITHUB_TEST_REPO_B` and `GITHUB_TEST_ORG_B_TOKEN`, the last with contents write on `testb1` only, for the demo's push.
2. **Make the test App public, once, and install it on `testb1`.** On the App's GitHub settings, under "Advanced", "Danger zone", "Make public". GitHub won't make it private again while another account has it installed ("Public apps cannot be made private if they're installed on other accounts", [GitHub](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration)), so do it for the test App only. Then install it on `ostra-test-b`, choosing `testb1`. The installation stays, and each fresh dev stack sees it waiting to be linked.
3. **Optionally, an App owned by `ostra-test-b`,** for the "Connect another App" case: created on that organization's settings with F-006's permissions, and installed on `testb1`. Keep its ID and the private key's path in `~/.config/ostra-dev/github-b.env`. Without it, that case is proved on the fake GitHub only.
4. **A second model key** in `~/.config/ostra-dev/model-b.env`, as `OSTRA_DEV_MODEL_B_BASE_URL` and `OSTRA_DEV_MODEL_B_API_KEY`, serving the model of `model.env` under the same models.dev ID. A second key on the same endpoint is enough.
5. **Approve ticket 52's targets,** recorded there with the date.
6. **Review Q270 to Q284** (`context/open-questions.md`; ADR 0065; spec section 11, items 20 to 24), all settled on the delegation of 2026-11-19, and move back to the open list any you disagree with. The lead asks you to look at these in particular:
   - **Only organization admins choose a project's keys,** among its list too. A project admin sees them and can't pick (Q277).
   - **No pin on a profile** (Q272).
   - **No budget per key in v1:** a client with several projects has a budget per project, and no single cap across them (Q276).
   - **A provider added later joins no list** until an admin ticks one, which keeps a new client's key out of every project; a team with one client then ticks the default list by hand (Q270).
   - **Making the App public is one-way** once a client installs it (Q281).
   - **A client's PRs are authored by your App's bot** when the client installs your App, and by the client's own bot only when it connects its own App (Q279, Q283).
   - **"Connect another App" in v1** (Q279, option (b)): it could move after v1 if milestone 4 should be smaller.
   - **The one case an upgrade changes:** two existing profiles naming one model on two providers get one provider, marked for an admin to confirm (Q278).

## Done when

- [ ] Each step is done or answered, with the date, under `## Comments`.

## Comments
