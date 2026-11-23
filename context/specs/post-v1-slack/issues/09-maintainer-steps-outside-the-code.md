# 09: The maintainer's steps outside the code

Status: ready-for-human
Builder: maintainer
Features: F-057
Packages: none in the repository: a Slack test workspace, an app, and `~/.config/ostra-dev/slack.env`, all outside it
Blocked by: none for the workspace and app; 10 for the review of the run
Spec: `../spec.md`, sections 2, 3, 9 and 10; ADR 0074

## What to do

1. **Say when F-057 starts.** It is `later` and this spec is written before v1; nothing is built until you say so. The spec and these tickets wait.
2. **Agree the ledger's row and the build-order line.** The proposed F-057 "done when" is in the lead's report, with its nine conditions (c1 to c9) and the proposed line in `build-order.md`'s "After v1, in this order". Say what to change.
3. **Answer the spec's five open questions** (section 9): a drawn target for Organization › Slack; whether a public Slack app for every install might ever exist; Sign in with Slack as the identity fallback; shared-channel notifications; a bot-token paste for installs without HTTPS. The defaults, if you say nothing: no new target, each install makes its own app, email matching, no shared channel, OAuth only.
4. **Make the test workspace and app,** for the manual run only; nothing on disk in the repo:
   1. **The workspace:** a Slack workspace you own for testing, `ostra-test` (a free plan is enough), with the address you sign in with.
   2. **The app:** at `api.slack.com/apps`, **Create New App** › **From a manifest**, with the manifest ostra shows on Organization › Slack (or by hand: bot scopes `chat:write` and `users:read.email`; redirect URL `https://<your public address>/api/slack/callback`; no Events API, no interactivity, no slash command, no incoming webhook). Turn **token rotation** on or off, and say which on the build's page.
   3. **The install:** **Install to Workspace** and authorize; the app's bot user is `ostra` (or the name you give).
   4. **A second member:** invite `Sam` with the address Sam's ostra account uses, so the demo's per-member DM and the "No Slack account" case both run (a third member with an address Slack doesn't know is enough for the latter).
   5. **The client credentials:** the app's **Client ID** and **Client Secret** from **Basic Information**.
   6. **The secrets file:** `~/.config/ostra-dev/slack.env` (never in the repo, never printed) with `OSTRA_SLACK_LIVE_CLIENT_ID=<client id>`, `OSTRA_SLACK_LIVE_CLIENT_SECRET=<client secret>`, `OSTRA_SLACK_LIVE_WORKSPACE=ostra-test` and `OSTRA_SLACK_LIVE_SAM_EMAIL=<Sam's address>`, exported with `set -a; . ~/.config/ostra-dev/slack.env; set +a`.
   7. **The public address:** the install must be served over HTTPS, because Slack's OAuth redirect URL must be; use your reverse proxy or the tunnel milestone 2 uses for Linear, and confirm `<public>/api/slack/callback` is the redirect URL in the app.
5. **Look at the build** once tickets 07 and 08 land: Organization › Slack in its four states and the notifications grid's fourth column at 1440 and 390 px in both themes, against `app-targets/m3/email-settings.md` and `notification-settings.md`, or say what to change.
6. **Review the manual run** (ticket 10): the real install, a real DM to you and to Sam, an answer's edit, the rate-limit case against the fake, and the disconnect that leaves no secret.

## Done when

- [ ] Said when F-057 starts.
- [ ] Agreed the F-057 row's conditions and the build-order line.
- [ ] Answered the five open questions, or left them to the defaults.
- [ ] The workspace, the app (with its scopes and redirect URL), the second member and the client credentials exist.
- [ ] `~/.config/ostra-dev/slack.env` exists outside the repo.
- [ ] The build looked at.
- [ ] The manual run reviewed.

## Comments
