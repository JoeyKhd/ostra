# Target: connecting Trello, step by step

- **Pictures:** `trello-connect-app` and `-light` (step 1, the organization's app), `trello-connect-consent` and `-light` (step 2, the consent hand-off), `trello-connect-token` and `-light` (step 2, the token read back), `trello-connect-polling` and `-light` (no public address); each at 390×844 as `trello-connect-*-phone` and `-phone-light`; the failures, a bot member already connected, a refused token and polling on `trello-states`.
- **Sources:** `html/connection.html?view=app|consent|token|polling`, `html/states.html`, `html/phone.html?scene=app|consent|token`; the parts in `html/tl.js` (`stepApp`, `stepToken`, `tokenPanel`) and `html/tl.css` (`.consent`).
- **Route (new):** `/organization/trackers/<id>` while the connection is `pending`. The same page shows the settings once it's `active` (`connection-trello.md`).
- **Feature:** F-153; ADR 0072; `../../../specs/post-v1-trello/spec.md` §4, §5.2–5.4.
- **Status: design target, 2026-11-23**, awaiting approval (`README.md`).

## Purpose

An admin connects one client's Trello account in two steps: the organization's own Trello app, then a dedicated bot member's token. Trello's consent page is the hand-off, because only a member can grant a token; each step checks itself against Trello before the next opens.

## Layout (CSS px at 1440×956)

| Part | Size and style |
|---|---|
| Top bar | `Acme Corp › Trackers › Acme Trello`; no button while pending |
| Header | Trello's mark 36px, 14px gap; eyebrow mono 13px `--faint` `Trello · connecting`; `h1` the connection's name |
| Lede | 15px `--muted`, max 720px: `ostra signs in as a dedicated bot member the client adds to its boards. Its token never expires, and its app's secret signs each delivery. Neither ever reaches an agent.` |
| Started line | 13px `--faint`: `Started 14:02 by Alex Kim ·` + teal `Start again` (deletes the pending connection, no confirm) |
| Section | `Connect Trello` and `1 of 2` / `2 of 2` (mono `--faint`) |
| A step | hairline rows; grid `22px 1fr`, 12px gap, padding `14px 0 15px`. Circle 22px: done filled `--green` with a check; current 1px `--text` ring and its number; later 1px `--line-2` ring, `--muted` number; failed 1px `--red` ring. Title 14.5px 500; a teal link at the right (`Trello's apps ↗`, `The bot member ↗`, `Change`, `Replace`); body 13.5px `--muted`, max 600px |
| Forms | a 470px column under the step's text: labels 12.5px 500 `--muted`, inputs 32px, mono 13px, `--control-line` |
| Properties panel | 320px: **Mode** (Webhooks or Polling, and why), **The token needs** (the scopes), **It sees** (the boards, once step 2 has read them) |

## Step 1: The app (`trello-connect-app`)

- Body: `Create the organization's own app at trello.com/apps/admin, then paste its key and secret. Trello's consent page proves the key; the secret only signs deliveries.`
- Fields: `API key` (mono; label hint `public: it travels in the consent URL`), `API secret` (password, eye toggle; hint `signs each delivery`), `Name` (prefilled `Acme Trello`; hint `what boards and cards call it`).
- Primary `Save and continue`; help `The key is stored on the connection; the secret goes to the secret store.`
- Done: `The app 4f2c…e91` and `Acme's own Trello app. This connection is called Acme Trello.` with `Change`.
- Errors (red line under the field, `role="alert"`): a blank key or secret is refused (`Paste the app's key and secret from trello.com/apps/admin.`); a key Trello's consent page won't accept is discovered at step 2, not here.

## Step 2: The bot member and its token

### The consent hand-off (`trello-connect-consent`)

- Body: `Add a dedicated member to the boards ostra works, and authorize it as ostra-acme. It is never a person's account, and its token doesn't expire.`
- A 1px `--line-2` box, 8px radius, max 600px: Trello's mark 24px; `Authorize the bot member on Trello`; `The consent page asks for read and write, and a token that never expires.`; `The page returns the token in the URL fragment. ostra reads it there, checks it, and never logs it. A token that's pasted by hand is checked the same way.`
- Primary `Authorize on Trello` (`external-link` first) opens `https://trello.com/1/authorize?key=…&scope=read,write&expiration=never&response_type=token&callback_method=fragment&return_url=…`. Teal `Paste a token instead` reveals the field below; the field is visible anyway as a fallback, labelled `Bot member's token`, hint `or let the consent page return it`, and `Check the token`.
- Help: `ostra reads back the member and the boards it can see. Nothing is saved until you continue.`

### The token read back (`trello-connect-token`)

A 1px `--line-2` box, 8px radius, max 600px, head 12px `--faint` with `just now`; one line per check, a 14px icon, 13.5px:

1. green `check`: `Signs in as ostra-acme · ostra Acme, a bot member, not a person`
2. green `check`: `Sees 5 open boards and 1 closed: Calculations, Retail, Roadmap, Hiring, Ops`
3. green `check`: `The token never expires. It isn't stored until you continue.`

Passed: `Save and continue` (primary), `Check again`, `Saved to the secret store, never shown again.` The panel's **It sees** lists the five open boards and the closed one.

Refused (401): one red line, `Trello refused the token: 401 Unauthorized. Check that the token belongs to ostra-acme and hasn't been revoked.`, and `Check the token` again.
A member another connection holds: red, `ostra-northwind is already connected, as Northwind Trello. A bot member can only have one connection. Open it →` (`trello-states`).
A token that sees no board: red, `Sees no board. Add the bot member to the boards ostra should work.` (`README.md`, open decision 2).

## Polling (`trello-connect-polling`)

With `OSTRA_CORE_PUBLIC_URL` unset, step 2 ends the connection. The read-back stays, and below it: `refresh-cw`, `This server's address isn't public, so Trello gets no webhook. ostra asks each attached board for changes every 60 s instead: a card's change reaches ostra up to a minute late.` (last clause `--text` 500); then `info`, `To receive webhooks, set OSTRA_CORE_PUBLIC_URL to a public https address and restart core. This step then asks for the webhook.` Primary `Finish`, `Connects Acme Trello by polling. Its boards can be attached at once.` The panel's Mode reads `Polling every 60 s`.

## Phone

The top bar: back, the name. The header's mark 30px. Done steps collapse to their title and one line. Step 1's fields stack, 32px inputs; step 2's consent box stacks the button under its text; the read-back wraps and its check lines keep 13.5px; the token field is 40px.

## Keyboard

- `Tab` follows the steps; only the current step's fields and buttons are reachable, a done step offers only `Change`.
- `Authorize on Trello` opens a new tab and returns to the callback page, which reads `#token=`; the panel keeps focus and announces the read-back.
- The read-back is a list (`role="list"`), announced when it arrives; a failed line is `role="alert"`.

## Data

- `trackers.trello.saveApp({ connectionId, apiKey, secret, name })` → stores the name and key, the secret in the secret store, audits `tracker.app-saved`.
- `trackers.trello.authorizeUrl({ connectionId })` → the consent URL, admins only; `OSTRA_TRELLO_AUTHORIZE_URL` replaces the host in tests and the browser suite.
- `trackers.trello.checkToken({ connectionId, token })` → the member and its boards, in memory; nothing stored.
- `trackers.trello.saveToken({ connectionId, token })` → checks again, stores the token, sets the row active (`webhooks` or `polling`), audits `tracker.connected`, resumes paused boards.
- The same `saveToken` sets `webhookMode: "polling"` when `OSTRA_CORE_PUBLIC_URL` is unset; there is no separate polling call.
- No key, secret or token appears in any response; the consent URL is admin-only because it names the key.

## Copy (keys under `trackers.trello.connect.*`)

`title` `Connect Trello` · `step1.title` `The app` · `step1.body` (above) · `step1.key` `API key` · `step1.keyHint` `public: it travels in the consent URL` · `step1.secret` `API secret` · `step1.secretHint` `signs each delivery` · `step1.name` `Name` · `step1.nameHint` `what boards and cards call it` · `step1.save` `Save and continue` · `step1.saved` `The app {key}. {name}'s own Trello app.` · `step2.title` `The bot member and its token` · `step2.body` (above) · `step2.authorize` `Authorize on Trello` · `step2.consent` (above) · `step2.paste` `Paste a token instead` · `step2.token` `Bot member's token` · `step2.check` `Check the token` · `readback.member` (1) · `readback.boards` `Sees {open} open boards and {closed} closed` · `readback.expiry` `The token never expires.` · `readback.refused` (above) · `readback.taken` (above) · `save` `Save and continue` · `saved` `Saved to the secret store, never shown again.` · `polling.mode` `Polling every 60 s` · `polling.body` (above) · `polling.hint` (above) · `finish` `Finish`.

## Tokens

`--green` (the done circle, passing checks), `--red` (a refused token, the taken member, a field's error edge), `--teal` (links, `Paste a token instead`), `--line-2` (the consent and read-back boxes), `--control-line` (fields). **No amber.**
