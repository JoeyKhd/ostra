# Target: a connection's settings (Jira and Linear)

- **Pictures:** `connection-jira` and `connection-jira-light` (Globex Jira, connected by webhooks), `connection-linear` and `connection-linear-light` (Acme Linear, today's Linear page re-homed). The connected states (just connected, a token near its date, expired, silent webhooks) and the Rotate and Disconnect dialogs are on `jira-connect-states` and `trackers-states`.
- **Sources:** `html/connection.html?kind=jira&view=connected`, `?kind=linear&view=connected`; `html/tr.js` (`jiraSettings`, `jiraSettingsPanel`, `linearSettings`, `linearSettingsPanel`).
- **Route (new):** `/organization/trackers/<id>`, once the connection is `active` or `failed`. `/organization/linear` redirects here for the organization's first Linear connection.
- **Feature:** F-005, F-008, F-012 (agent mode), F-042. ADR 0013, ADR 0047.
- **Status: a proposal** (`README.md`).

## Purpose

One connection's page: is it healthy, do its events arrive, and the few things an admin changes (copy the webhook URL, replace the token, rotate the secret, check again, disconnect). Linear's content is today's `linear-view.tsx`, moved under its connection; Jira's has the same sections in the same order, with Jira's own rows.

## Layout (CSS px at 1440×956)

| Part | Size and style |
|---|---|
| Top bar | `Acme Corp › Trackers › Globex Jira`; right: `Open in Jira` / `Open in Linear` (secondary, `external-link` first). No primary |
| Header | the mark 36px; eyebrow mono 13px `--faint` (`Jira Cloud · globex.atlassian.net`, `Linear · workspace acme`); `h1` the name + a 15px `pencil` (`--faint`, 10px gap) that renames it in place (admins) |
| Lede | 15px `--muted`, two lines |
| Sections | 24px apart; `.shead` 15px 600; key/value rows: 160px key column `--muted`, 40px rows between hairlines, an end column for the faint mono time or a teal action |
| Properties panel | 320px, groups as below |

## Jira (`connection-jira`)

**Connection:** one 42px row: green dot, `Connected` (green 500), the site mono, the client's name `--muted`; right, `since 14 Nov` faint mono.

**Events**

| Key | Value | End |
|---|---|---|
| `Mode` | `radio-tower` 15px + `Webhooks: receiving` | |
| `Webhook URL` | the URL, mono 13px `--faint`, cut in the middle | teal `Copy` |
| `Webhook secret` | `lock` 13px + `--muted` `In the secret store` | teal `Rotate the secret` (confirm: `jira-connect-states`) |
| `Last event` | mono `issue_updated` + `--muted` `PROJ-14 updated` | `6 min ago` |
| `Backstop` | `--muted` `Every board is also polled every 5 min, so a missed delivery is found.` | |

Polling: `Mode` `refresh-cw` `Polling every 60 s`; `Webhook URL` becomes `Webhook` `None: this server's address isn't public (<reason>).`; no secret or backstop row; `Last event` becomes `Last poll`. Silent: `Mode` red `triangle-alert`, `Webhooks: silent since 14:02 · polling still finds changes`, and under the rows `Check the webhook in Jira's Settings › System › WebHooks: it may be disabled, or its URL may have changed. Tickets still arrive every 5 min.`

**Service account**

| Key | Value | End |
|---|---|---|
| `Signs in as` | the service account's email, mono | |
| `Token` | green dot, `Healthy` (green), `· expires 14 Sep 2027, in 295 days` | teal `Replace` (step 2's fields and read-back, in place) |
| `Reaches` | `3 projects` + `--muted` `· browse, create, edit, transition, comment` | faint mono `checked 2h ago` + teal `Check again` (runs step 2's read-back with the saved token) |

From 14 days before the date: `Token` red `triangle-alert`, `Expires in 9 days, on 2 Dec · paste a new one`. On the day, the connection fails: `Jira refused the token on 2 Dec. Polling and writes have stopped.`, and `Replace` becomes the page's one primary, under the section.

**Disconnect** (admins): `Stops the webhook and polling for its 2 boards and deletes the token from the secret store. Boards, tickets and tasks stay, read-only.` + `Disconnect` (outline). Dialog: `trackers.md`, "States".

**Panel:** **Site** (`Site`, `Cloud ID` cut in the middle, `Product` `Jira Cloud`, `Workflows` `Readable` or `Not readable`); **Scopes** with the count, each with a check (`--faint`), or a red `x` when the last read-back found it missing; **Webhook events** with the count; **Boards on it** (project square, project, key). ostra can't read the admin webhook's JQL (that needs an admin's credentials), so it isn't shown.

## Linear (`connection-linear`)

Today's page, moved: **Connection**, **Events** (`Mode`, `Webhook URL`, `Last event`, `Backstop`), **Token** (`Access token`, `Refresh token`), then **Agent mode** with a faint `Linear only` beside the title (`State` `On · turned on 12 Nov by Alex Kim`; `Start from Linear` `Calculator · takes the Calculator team's delegations` + teal `Boards`), then **Disconnect** (`Revokes the token at Linear and stops its 4 boards. Boards and their tickets stay, read-only.`). Every copy key is today's `linear.*` and `agentMode.*`, moved under `trackers.linear.*`; the not-connected, pending, failed and polling states are `../m2/connect-linear.md`'s, unchanged. The panel: **App**, **Scopes** (six, with `app:assignable` and `app:mentionable` once agent mode is on), **Webhook events**, and **Boards on it**, new.

Agent mode stays wherever `linear-view.tsx` draws it today (`AgentModeSections`); this page only gives it the `Linear only` note. It appears only because the Linear adapter declares `agentSessions` (choice 11).

## Keyboard

- `Tab` reaches the header's rename, then each row's action in order. Rename: `Enter` saves, `Esc` cancels; an empty name is refused.
- `Copy` announces `Copied`. `Check again` announces its result line.

## Data

- `trackers.get({ id })` → the connection (as `trackers.list`), plus for Jira `cloudId`, `email`, `reach` (projects, permissions, `checkedAt`), `workflowsReadable`, `scopes`; for Linear, today's `linear.status`.
- `trackers.rename({ id, name })`, `trackers.jira.checkToken`, `trackers.jira.replaceToken`, `trackers.jira.rotateSecret` (returns the new secret once), `trackers.disconnect({ id })`. Every change is audited.

## Tokens

`--green` (Connected, Healthy, Just connected), `--red` (failed, expiring, silent icons; Disconnect's confirm), `--teal` (the row actions), `--faint` (times, the pencil). **No amber.**
