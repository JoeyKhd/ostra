# Target: connecting Jira, step by step

- **Pictures:** `jira-connect` and `-light` (step 2, the token checked and read back), `jira-connect-webhook` and `-light` (step 3, waiting for the first delivery), `jira-connect-polling` and `-light` (no public address), `jira-connect-states` (each step's failure, connected, a token near its date, Rotate), `jira-connect-phone` (step 3 at 390×844).
- **Sources:** `html/connection.html?kind=jira&view=token|webhook|polling`, `html/states.html?sheet=jira`, `html/phone.html?scene=jira`; the parts in `html/tr.js` (`stepSite`, `stepToken`, `readback`, `stepWebhook`, `jiraNewPanel`).
- **Route (new):** `/organization/trackers/<id>` while the connection is `pending`. The same page shows the settings once it's `active` (`connection-settings.md`).
- **Feature:** F-008; ADR 0047; `../../../research/trackers.md` §2.1–2.4.
- **Status: a proposal** (`README.md`).

## Purpose

An organization admin connects one client's Jira Cloud site in three steps, in the house style of `../m2/connect-linear.md`'s numbered steps: the site, the service account's scoped token, then the admin webhook. Each step checks itself against Jira before the next opens, so the admin learns at once what's wrong and where to fix it.

## Layout (CSS px at 1440×956)

| Part | Size and style |
|---|---|
| Top bar | `Acme Corp › Trackers › Globex Jira`; no button while pending |
| Header | the Jira mark 36px, 14px gap; eyebrow mono 13px `--faint` `Jira Cloud · connecting`; `h1` the connection's name |
| Lede | 15px `--muted`, max 700px: `ostra signs in as a service account the client owns, with a scoped API token. It hears of changes through one admin webhook, or by polling when this server isn't public. The token never reaches an agent.` |
| Started line | 13px `--faint`: `Started 14:02 by Alex Kim ·` + teal `Start again` (deletes the pending connection, no confirm) |
| Section | `Connect Jira` and `1 of 3` (done steps, mono `--faint`) |
| A step | hairline rows; grid `22px 1fr`, 12px gap, padding `14px 0 15px`. Circle 22px: done filled `--green` with a check; current 1px `--text` ring and its number; later 1px `--line-2` ring, `--muted` number; failed 1px `--red` ring. Title 14.5px 500; a teal link at the right (`Service accounts ↗`, `WebHooks in Jira ↗`, `Change`, `Replace`); body 13.5px `--muted`, max 600px |
| Forms | a 470px column under the step's text: labels 12.5px 500 `--muted`, inputs 32px, mono 13px, `--control-line` |
| Properties panel | 320px: **Mode** (Webhooks or Polling, and why), **The token needs** (the scopes, each with what it's for), **Webhook events** (the six), **It sees** (the projects, once step 2 has read them) |

## Step 1: The site

- Body: `The Jira Cloud site this client works in. ostra finds its cloud ID from it.`
- `Site`: `https://` `[globex]` `.atlassian.net` (the prefix and suffix `--faint`; a pasted full URL is trimmed to the name).
- `Name` (`what boards and tickets call it`): prefilled `Globex Jira` from the site, editable (choice 2).
- Primary `Find the site`: reads the site's tenant info for its cloud ID. While it runs: `Finding…`.
- Done: `The site globex.atlassian.net` and `Jira Cloud. This connection is called Globex Jira.`, with `Change` (reopens it; steps 2 and 3 keep their values only if the site is the same).
- Errors (red line under the field, `role="alert"`): `No Jira Cloud site answers at globex-shop.atlassian.net. Check the name in the browser's address bar when you're in Jira.` · `globex.atlassian.net is already connected, as Globex Jira.` + `Open it →` · `That's a Jira Data Center address. ostra connects to Jira Cloud only.`

## Step 2: The service account and its token (`jira-connect`)

- Body: `In admin.atlassian.com › Directory › Service accounts, create one for ostra and give it the Jira projects it should see. Then create a scoped API token for it, with these scopes:` and the scopes as mono chips (`read:jira-work`, `write:jira-work`, `read:jira-user`, `read:workflow:jira`; choice 5). Link `Service accounts ↗` (admin.atlassian.com).
- Fields: `Service account email` (`ostra-bot@serviceaccount.atlassian.com`); `Scoped API token` (password, an eye toggle) beside `Expires` (a date, 150px; choice 6).
- Primary `Check the token` and `ostra reads back who it is and what it reaches. Nothing is saved until you continue.`
- **What ostra read back,** a 1px `--line-2` box, 8px radius, max 600px, head 12px `--faint` with `just now`; one line per check, a 14px icon (green `check`, red `triangle-alert` or `circle-x`), 13.5px:
  1. `Signs in as ostra-bot · a service account, not a person` (`/myself`; `accountType` `app`). A person's account: red, `This is a person's account. Use a service account, so ostra writes as a bot and never holds a member's token.`
  2. `Sees 3 projects: PROJ, SHOP, OPS` (project search). None: red, `It sees no project. Give the service account access to the projects ostra should see.`
  3. `Can browse, create, edit, transition and comment in all 3` (`/mypermissions` per project). Short: red icon, `Can't transition or comment in OPS. Grant Transition issues and Add comments in its permission scheme, or leave OPS unattached.`
  4. `Reads their workflows, so the status mapping can check each transition`. Without the scope: red icon, `Can't read workflows: without read:workflow:jira, the status mapping can't warn about a missing transition.`
- Passed: `Save and continue` (primary) and `Check again`; `Saved to the secret store, never shown again.` Warnings only (3, 4): `Save anyway`. Refused (401/403): one red line, `Jira refused the token: 401 Unauthorized. Check the email is the service account's, and that the token isn't expired or revoked.`, and `Check the token` again.
- Done: `ostra-bot sees 3 projects. The token is in the secret store and expires on 14 Sep 2027.` + `Replace`.

## Step 3: The admin webhook (`jira-connect-webhook`)

- Body: `In Jira, open Settings › System › WebHooks and press Create a WebHook. A Jira admin fills it in with these:` Link `WebHooks in Jira ↗` (`https://<site>/plugins/servlet/webhooks`).
- Rows, a 116px label column, max 640px: `URL` and `Secret` as copy fields (mono 12.5px, 32px, a 32px copy button that turns into a green check for 2 s); `Events`: six chips with a green check (`Issue created`, `Issue updated`, `Issue deleted`, `Comment created`, `Comment updated`, `Comment deleted`) and `Leave Exclude body unticked.`; `JQL optional`: a copy field with `project in (PROJ, SHOP, OPS)` (the projects step 2 saw).
- `lock` line: `The secret signs each delivery. ostra keeps it in the secret store and shows it until the first delivery arrives; after that you can only rotate it. The JQL only narrows what Jira sends: each board's rules still decide.`
- The wait row (1px `--line-2`, 8px radius): a spinner, `Waiting for the first delivery…` + `--faint` `Change any ticket in PROJ to send one.`, and teal `Use polling instead` (connects by polling, as below, and drops the secret).
- The first signed delivery connects it: the page becomes the settings with `✓ Just connected` (`jira-connect-states`).
- A wrong signature: the wait row red-edged, `A delivery came at 14:06 with a signature that doesn't match. Paste the secret in Jira again.` + `Make a new secret`.

## No public address (`jira-connect-polling`)

Step 3 becomes **Events: polling**: Lucide `refresh-cw`, `This server's address isn't public (a private-network address can't be reached from Jira), so Jira gets no webhook. ostra asks Jira for changes every 60 s instead: a ticket's change reaches ostra up to a minute late.` (the last clause `--text` 500); then `info`, `To receive webhooks, set OSTRA_CORE_PUBLIC_URL to a public https address and restart core. This step then asks for the webhook.` Primary `Finish`, `Connects Globex Jira by polling. Its boards can be attached at once.` The reasons are Linear's (`linear.addressProblem.*`), with Jira for Linear. The panel's Mode reads `Polling every 60 s`, and it has no Webhook events group.

## Phone (`jira-connect-phone`)

The top bar: back, the name. The header's mark 30px. Done steps collapse to their title and one line. Step 3's rows stack label over field; copy fields 40px with 40px buttons; the event chips wrap; the wait row wraps `Use polling instead` under its text.

## Keyboard

- `Tab` order follows the steps; only the current step's fields and buttons are reachable, done steps offer only their `Change`/`Replace`.
- Each copy button is labelled (`Copy the webhook URL`, `Copy the webhook secret`, `Copy the JQL`) and announces `Copied` politely.
- The read-back is a list (`role="list"`), announced when it arrives; a failed check line is `role="alert"`.

## Data

- `trackers.jira.findSite({ connectionId, site, name })` → cloud ID or the errors above.
- `trackers.jira.checkToken({ connectionId, email, token, expiresOn })` → the four checks, each `ok | warn | fail` with its words and IDs. `trackers.jira.saveToken` stores it (secret store) only after a pass or warnings.
- `trackers.jira.webhook({ connectionId })` → URL, a new secret while pending, the event list, the suggested JQL; `lastDeliveryAt` / `badSignatureAt` by polling the page every 3 s.
- `trackers.jira.finishPolling({ connectionId })`.
- Audit: `tracker.connection-created`, `tracker.token-saved`, `tracker.connected` (no values).

## Copy (keys under `trackers.jira.connect.*`)

The strings above, as written: `title` `Connect Jira`, `step1.*`, `step2.*` (with `readback.*` for each check's three outcomes), `step3.*`, `polling.*`. Errors keep Jira's status code in mono and never its body.

## Tokens

`--green` (done circles, passing checks, the copied check), `--red` (failed checks, a wrong signature's edge, the warning icons), `--teal` (links), `--line-2` (the read-back and wait boxes), `--control-line` (fields). **No amber.**
