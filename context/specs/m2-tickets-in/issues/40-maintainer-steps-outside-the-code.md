# 40: The maintainer's steps outside the code

Status: ready-for-human
Builder: maintainer
Blocked by: none for the decisions; 27 and 33 for the Linear app
Features: F-005, F-096, F-055, F-114, and the screens of ticket 32
Packages: none (decisions and settings outside the repo, recorded here)
Spec: `../spec.md`, sections 3, 10, 11 and 12

## Why a person

Each step needs an account, a click or a yes that an agent doesn't have.

1. **Create the Linear app** in `ostra-test` from ostra's own "Connect Linear" page, once ticket 33 is in: click Create on the manifest link, paste the three values, Authorize. Save the client ID, the client secret, the webhook secret and the refresh token in `~/.config/ostra-dev/linear.env` (as `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`, `LINEAR_REFRESH_TOKEN`), so the scripted demo can seed the connection. `docs/development.md` gets the names, never the values.
2. **A push-triggered workflow in `test1`** (`.github/workflows/ci.yml` with `on: push` and one `echo` step), so the demo can check that a hidden ref starts no CI (F-096; spike 2's open B2 check).
3. **Branch rules on the test repos:** `test1`'s default branch protected; `test2`'s unprotected, plus a ruleset requiring signed commits that the demo can switch on and off (F-055, F-060).
4. **A yes or no to an S3 client library** for ticket 11 (Q127; the candidate is `@aws-sdk/client-s3`). Without a yes, F-114 ends milestone 2 `building`.
5. **Approve the milestone 2 screen targets** (ticket 32), recorded there with the date.
6. **Confirm spec section 11's choices** (items 2 to 5 and 8 to 12; items 1, 6 and 7 are already decided), or move the ones you disagree with to `context/open-questions.md`.
7. **Confirm Linear's GitHub integration** is installed on `ostra-test` (or not), so the demo knows who moves the ticket to done.

## Done when

- [ ] Each step is done or answered, with the date, under `## Comments`.

## Comments
