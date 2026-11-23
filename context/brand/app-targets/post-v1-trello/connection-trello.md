# Target: a Trello connection's settings

- **Pictures:** `connection-trello` and `connection-trello-light` (Acme Trello, connected by webhooks), and `connection-trello-phone` and `-phone-light`. The failing states (a revoked token, polling, silent webhooks) are on `trello-states`.
- **Sources:** `html/connection.html?view=connected`, `html/phone.html?scene=settings`; the parts in `html/tl.js` (`trelloSettings`, `trelloSettingsPanel`).
- **Route (new):** `/organization/trackers/<id>`, once the connection is `active` or `failed`.
- **Feature:** F-153. ADR 0072.
- **Status: design target, 2026-11-23**, awaiting approval (`README.md`).

## Purpose

One Trello connection's page: is it healthy, do its deliveries arrive, and the few things an admin changes (copy the webhook URL, replace the token, replace the app secret, re-register the webhooks, check again, rename, disconnect). It is milestone 11's settings page with Trello's own sections in the same order.

## Layout (CSS px at 1440×956)

| Part | Size and style |
|---|---|
| Top bar | `Acme Corp › Trackers › Acme Trello`; right: `Open in Trello` (secondary, `external-link` first). No primary |
| Header | Trello's mark 36px; eyebrow mono 13px `--faint` `Trello · bot member ostra-acme`; `h1` the name + a 15px `pencil` (`--faint`, 10px gap) that renames it in place (admins) |
| Lede | 15px `--muted`, two lines: the connect page's line |
| Sections | 24px apart; `.shead` 15px 600; key/value rows: 160px key column `--muted`, 40px rows between hairlines, an end column for the faint mono time or a teal action |
| Properties panel | 320px: **App**, **Scopes**, **Boards on it**, **What Trello does here** |

## Connection

One 42px row: green dot, `Connected` (green 500), the bot member's username mono (`ostra-acme`), `ostra Acme · bot member` `--muted`; right, `since 14 Nov` faint mono.

## Events

| Key | Value | End |
|---|---|---|
| `Mode` | `radio-tower` 15px + `Webhooks: receiving` | |
| `Webhooks` | `1 on Calculations` (the board 500) + `· one per attached board` `--muted` | teal `Re-register webhooks` |
| `Webhook URL` | the URL, mono 13px `--faint`, cut in the middle | teal `Copy` |
| `App secret` | `lock` 13px + `In the secret store` `--muted` | teal `Replace the app secret` |
| `Last event` | mono `updateCard` + `TR-12 moved to Doing` `--muted` | `3 min ago` |
| `Backstop` | `--muted` `Every board is also polled every 5 min, so a missed delivery is found.` | |

Polling: `Mode` `refresh-cw` `Polling every 60 s`; `Webhooks` becomes `Webhook` `None: this server's address isn't public (<reason>).` The `App secret` row stays, because a later webhook needs it, with `Replace the app secret`; the `Backstop` row stays too, since the 5-minute drift check still runs. Silent: `Mode` red `triangle-alert`, `Webhooks: silent since 14:02 · polling still finds changes`, and under the rows `Check the webhook in Trello: Trello disables one after 30 days of failures over 1,000. Tickets still arrive every 5 min.`

The URL is one per connection and the registration is one per board. With several boards the row reads `2 on Calculations and Retail`; the per-board list lives in the panel, not here. `Copy` copies the callback URL ostra derives from `OSTRA_CORE_PUBLIC_URL`, never a secret.

## Bot member

| Key | Value | End |
|---|---|---|
| `Signs in as` | the username mono, then `· ostra Acme` `--muted` | |
| `Token` | green dot, `Healthy`, `· never expires` | teal `Replace` |
| `Reaches` | `5 open boards` + `· 1 closed` `--muted` | faint `checked 2h ago` + teal `Check again` |

`Replace` opens step 2's consent/paste fields in place and saves a new token after its read-back. `Check again` runs the same read-back with the saved token. A 401 from the saved token fails the connection (`token-refused`), pauses its boards and makes `Replace the token` the page's one primary (`trello-states`).

## Disconnect

`Deletes the webhook on Calculations, revokes the token at Trello and deletes the app secret. Boards, cards and tasks stay, read-only.` + `Disconnect` (outline, red text on hover). The dialog:

`Disconnect Acme Trello?` / `ostra deletes the webhook it made on Calculations, revokes the token at Trello, and deletes the app secret and the connection. Its boards, on calculator and globex-shop, stay attached but paused: their cards and tasks stay, read-only, and nothing moves on Trello.` / `Connecting the same bot member again resumes them.` / `Cancel`, `Disconnect` (red text).

## Panel

- **App:** `App key` (mono, the public key), `Workspace` (`Acme · Trello`), `Secrets` (`lock`, `In the secret store`).
- **Scopes** with the count 2: `read`, `write`, each with a faint check or a red `x` when the last read-back found it missing.
- **Boards on it** with the count: project square, project, board and key (`calculator`, `Calculations · TR`; `globex-shop`, `Retail · RT`).
- **What Trello does here:** `Moves status` `Directly, by list`; `Rich text` `Markdown`; `Files` `Attachments`. No sub-tasks, mentions, transitions or agent mode, because the adapter doesn't declare them.

## Phone

The top bar: back, the name, `external-link`. The header's mark 30px. The rows stack as key above value where the value is long; `Re-register webhooks`, `Copy`, `Replace` and `Check again` stay reachable as 44px targets under their rows. The disconnect row wraps its button.

## Keyboard

- `Tab` reaches the header's rename, then each row's action in order. Rename: `Enter` saves, `Esc` cancels; an empty name is refused.
- `Copy` announces `Copied`. `Re-register webhooks` announces `Re-registering…` and then its result line. `Check again` announces its result.

## Data

- `trackers.get({ id })` → the connection (as `trackers.list`), plus Trello's `apiKey`, `botName`, `botUserName`, `boardsCount`, `scopes` and `lastCheckAt`. Never the app secret or the token.
- `trackers.rename({ id, name })`, `trackers.trello.checkToken`, `.replaceToken`, `.replaceAppSecret`, `.reregisterWebhooks`, `trackers.disconnect({ id })`. Every change is audited.

## Copy (keys under `trackers.trello.settings.*`)

`title` `Acme Trello` · `open` `Open in Trello` · `connection` `Connection` · `events` `Events` · `mode.webhooks` `Webhooks: receiving` · `mode.polling` `Polling every 60 s` · `webhooks` `Webhooks` · `webhooks.one` `{n} on {board}` · `webhooks.help` `one per attached board` · `reregister` `Re-register webhooks` · `url` `Webhook URL` · `copy` `Copy` · `secret` `App secret` · `secret.inStore` `In the secret store` · `replaceSecret` `Replace the app secret` · `lastEvent` `Last event` · `backstop` `Backstop` · `backstop.body` (above) · `silent` `Webhooks: silent since {time} · polling still finds changes` · `bot.title` `Bot member` · `signsInAs` `Signs in as` · `bot.fullName` `{full} · bot member` · `token` `Token` · `healthy` `Healthy` · `neverExpires` `never expires` · `replace` `Replace` · `reaches` `Reaches` · `reaches.body` `{open} open boards · {closed} closed` · `checkAgain` `Check again` · `disconnect` `Disconnect` · `disconnect.body` (above) · `confirm.title` `Disconnect {name}?` · `confirm.body` (above) · `confirm.again` (above).

## Tokens

`--green` (Connected, Healthy), `--red` (failed, revoked, silent; the disconnect confirm), `--teal` (the row actions), `--faint` (times, the pencil). **No amber.**
