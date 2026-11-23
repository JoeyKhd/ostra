# 07: Web: Organization › Slack and the notifications column

Status: ready-for-agent
Builder: web
Features: F-057
Packages: `apps/web` (`app/(panel)/organization/slack/page.tsx` (new), `components/organization/slack-view.tsx`, `slack-settings.tsx`, `slack-words.ts` (new), `components/account/notification-settings*.tsx`, `components/shell/places.ts`, `components/shell/shell-icons.tsx`, `messages/en.json`, the places' test)
Blocked by: 06
Spec: `../spec.md`, section 4.7; `context/brand/app-targets/m3/email-settings.md` and `notification-settings.md`; ADR 0074

## What to build

- **`/organization/slack`**, a `slack` row in `places.ts`'s `OrganizationRow` after `email` (gate `admin`, a rail icon), crumbs Organization › Slack, page frame, properties panel and foot shaped exactly like Organization › Email:
  - **Not set up:** the manifest to copy, the two scopes, the redirect URL, the client ID and secret fields, **Save**, **Add to Slack**; a line saying Slack needs an https public address, with `OSTRA_PUBLIC_URL`'s scheme read from the status;
  - **Pending:** "Waiting for Slack", **Continue in Slack**, **Start again**;
  - **Connected:** the workspace, the bot, the scopes, the token's date and renewal state, **Send me a test message** with its outcome in words, **Check again**, **Disconnect** with a confirmation that says every secret is deleted and messages stop;
  - **Failed:** Slack's refusal in words, **Reconnect**, **Disconnect**;
  - **Locked:** when `OSTRA_SLACK_*` sets the app, the fields are read-only and the settings' names are shown, as Organization › Email does;
  - **Members:** their identity line and a **Check my Slack account** when unmatched.
- **The notifications page:** a fourth 88px column "Slack" in `MomentsTable`, its box disabled with the note when Slack is off, the identity line above the grid when connected, a link to Organization › Slack for admins, the phone's labelled cells, and the header's row widths; the panel's properties gain Slack's state beside mail's.
- **Copy:** `messages/en.json` under `slack.*`, `notificationSettings.slack`, `notificationSettings.slackOff`, `notificationSettings.slackIdentity`, `notificationSettings.noSlack`, `shell.slack`.
- **The places' test** reads `src/app/(panel)` and fails for a page with no place; the new route passes.
- **Visual:** compare at 1440 and 390 px in both themes against the two targets, and record the screenshots under `## Comments`.

## Done when

- [ ] Tests named for `F-057/c1`: the page's four states render (not set up, pending, connected, failed) from the status, a member sees a read-only page, and an admin sees the manifest, both scopes and the redirect URL.
- [ ] Tests named for `F-057/c2`: no value of a secret is ever rendered; the page shows "set"/"not set" and the disconnect dialog names what is deleted.
- [ ] Tests named for `F-057/c3`: the grid has four columns, the Slack box is off by default and disabled with the note when Slack is off, and the panel's box stays checked and disabled.
- [ ] Tests named for `F-057/c5`: a matched member's identity line shows their `@name`; an unmatched one shows "No Slack account" and the check action.
- [ ] Tests named for `F-057/c1` (visual): the two screens at 1440 and 390 px in both themes match the targets, and the screenshots are in the ticket's comments.
- [ ] Typecheck, lint and tests for `apps/web` pass, the places' test passes, and the browser spec this ticket adds runs locally.
- [ ] Committed as `✨ add Organization › Slack`.

## Comments
