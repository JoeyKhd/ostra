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
4. ~~**A yes or no to an S3 client library** for ticket 11.~~ Done 2026-11-19: yes to `@aws-sdk/client-s3` (ADR 0043).
5. **Approve the milestone 2 screen targets** (ticket 32), recorded there with the date.
6. **Confirm spec section 11's choices** (items 2 to 5 and 8 to 12; items 1, 6 and 7 are already decided), or move the ones you disagree with to `context/open-questions.md`.
7. **Confirm Linear's GitHub integration** is installed on `ostra-test` (or not), so the demo knows who moves the ticket to done.

## Done when

- [ ] Each step is done or answered, with the date, under `## Comments`.

## Comments

- **2026-11-19, lead, on the maintainer's delegation** ("continue working on everything throughout the night, would be nice to wake up to the finished product"). An agent did what it could, as follows. The ticket stays `ready-for-human` for what's left at the end of this entry.
  - **Step 1, the Linear app: created, not authorized.** The app exists in `ostra-test`, and `linear.env` holds `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET` and `LINEAR_WEBHOOK_SECRET`. No consent has been given, so there's no `LINEAR_REFRESH_TOKEN` and no app token yet. Linear's client-credentials grant gives an app-actor token with no consent click, but this app doesn't allow it: the request answered `unauthorized_client`. The setting can only be changed on the app's page in Linear, or through `oauthApplicationUpdate` with an `oauth:create` key, and the personal key doesn't have that scope (`context/research/linear-app-token-without-consent.md`). **The fallback for tonight, set out in spec section 3:** the scripted demo seeds the Linear connection from the personal `LINEAR_API_KEY` (`credentialKind: api_key`, a development path only), and the maintainer's consent click on "Connect Linear" stays the one morning step. It's demo step 1, and it gives the refresh token that step 8 needs.
  - **Step 2, the push workflow in `test1`: already there, and the CI check ran.** `test1` already has `.github/workflows/ci.yml` (`on: push` and `pull_request`, one `echo` step), committed 2026-11-18 20:37 UTC, with 70 runs. Spike 2's B2 check was run by hand with the test App's token. A commit pushed only to `refs/ostra/wip/b2-ci-check-20261119b` got **0 workflow runs in 75 s**. The same commit, then pushed to the branch `ostra-b2-control-20261119`, got **1 `push` run within 45 s**. An earlier hidden-ref-only commit also got 0 runs in 2 min. Both refs and the branch were deleted afterwards (HTTP 204), and no `refs/ostra/wip/b2*` is left. So a hidden ref starts no CI, and F-096's row says so now. Ticket 39 repeats the check in the demo.
  - **Step 3, branch rules: not possible tonight.** Three things stand in the way:
    - `gh` isn't installed on this machine.
    - The test App's installation (`ostra-test`, all repos) has `checks: write`, `contents: write`, `pull_requests: write`, and read on `actions`, `issues`, `metadata` and `statuses`. It has no `administration`, so it can't write branch protection or rulesets. It has no `workflows` either.
    - `test1` and `test2` are **private repos in a free org**. GitHub answers both `GET /repos/ostra-test/<repo>/rulesets` and `GET .../rules/branches/main` with 403: "Upgrade to GitHub Pro or make this repository public to enable this feature." Both default branches read `protected: false` today.

    **What the maintainer does** (about 5 minutes):
    1. Make `test1` and `test2` public (Settings → General → Danger zone), or move the `ostra-test` org to GitHub Team. Public is free and enough. The repos hold only demo code.
    2. On `test1`, protect `main` with a **ruleset** rather than classic protection: Settings → Rules → Rulesets → New branch ruleset, target the default branch, enforcement Active, rules "Restrict deletions" and "Block force pushes". With a ruleset, the App can read the rules with `metadata: read` alone (ticket 09). Classic protection's signed-commit flag needs `administration: read`, which the App won't get.
    3. On `test2`, leave `main` unprotected, and add a ruleset named `ostra-demo-signed-commits`: target the default branch, rule "Require signed commits", **enforcement Disabled**. The demo switches it to Active and back.
    4. Create a fine-grained token for the `ostra-test` org: repository `test2` only, permission "Administration: read and write", 90 days. Save it as `GITHUB_TEST_ADMIN_TOKEN` in `~/.config/ostra-dev/github-test.env`. The demo uses it to switch the ruleset (`PUT /repos/ostra-test/test2/rulesets/{id}` with `enforcement: active | disabled`), and nothing else. The product never reads it.
  - **Step 5, the screen targets:** approved for the build by the lead on the delegation (ticket 32), pending the maintainer's own review.
  - **Step 6, spec section 11's choices: confirmed,** each with any note added in spec section 11 itself:
    - Item 2: one app per organization, its webhook on core, polling when the address fails the pre-check. Confirmed. Linear also has `oauthApplicationCreate`, so a later release could create the app with no manifest click. It needs an `oauth:create` key, so it isn't a milestone 2 path.
    - Item 3: the scopes, and `AgentSessionEvent` already in the manifest. Confirmed. The manifest asks for `authorization_code` only. Client credentials would replace the consented installation without warning, and they have no refresh token.
    - Item 4: status ownership. Confirmed. `ostra-test` has no GitHub integration (step 7), so on `OST` ostra moves tickets to done itself (`doneBy: "ostra"`).
    - Item 5: the ticket in the branch, the title and the body. Confirmed.
    - Item 8: the token cap at 10 million for a model with no price. Confirmed.
    - Item 9: ticket images through core, 20 per ticket and 10 MiB each. Confirmed.
    - Item 10: the Inbox's default filter. Confirmed.
    - Item 11: retention unset by default. Confirmed, plus one rule: a saved instance setting wins over `OSTRA_RETENTION_DAYS`, and "keep" counts as a saved setting (`InstanceSetting.retentionSetAt`, ticket 05).
    - Item 12: one active code task per ticket per project. Confirmed. A merged task isn't reopened in milestone 2 (ticket 18), so the index and the reopen agree.
  - **Step 7, Linear's GitHub integration: not installed.** `integrations(first: 50)` on `ostra-test` returns no nodes (checked with the personal key, an admin, 2026-11-19). The demo expects ostra to move `OST` tickets to done, and board `OST`'s draft mapping gets `doneBy: "ostra"`.
  - **Left for the maintainer:** step 1's consent (press Authorize on "Connect Linear" once ticket 33 is in, then save `LINEAR_REFRESH_TOKEN`), step 3's four actions above, and step 5's own review. Switching on "Client credentials" on the Linear app is optional: it allows a 30-day app token for scripted runs. The two grants replace each other, so the token has to be revoked before the consent flow can install the app (the research above).
- 2026-11-19, lead: the record above, the decisions in tickets 02 to 39, spec sections 3, 5 and 11, and the research `context/research/linear-app-token-without-consent.md` are in 62914c0 (`📝 prepare the milestone 2 build`).
