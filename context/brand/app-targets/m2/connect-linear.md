# Connect Linear: target

> **Committed image:** `connect-linear.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel.

Organization › Linear (F-005, F-042; screen 1 of `../../../specs/m2-tickets-in/spec.md` section 12). The picture shows the **connected** state, by webhooks. The not-connected flow (the manifest link, the three values, Authorize) and every other state are specified below in words.

Prompts: `connect-linear.prompt.txt`. Made with the `ui-taste` skill, image first, on Higgsfield `gpt_image_2_6` (3:2, 2k, high), from the approved milestone 1 GitHub target (`../m1/github.png`, its 2048 original), the graphite Home concept (`../../app-concepts/html/home-graphite.png`) and the Hinge logo. Two generations: the first from the references, the second an edit of the first that fixed the section-title size, the panel's indents, the Mode row's face, the webhook URL's colour and the sidebar icon.

**Status:** a target, not yet approved by the maintainer (ticket 32). The picture is an image-model render: the copy and rules in this file win over the pixels, and the tokens below win over its colours.

## Purpose

An organization admin connects the organization's own Linear app, once, and later checks that it still works. The page answers, in this order:
1. Is Linear connected, and to which workspace? (Connection)
2. Do Linear's events reach ostra, and when did the last one come? (Events)
3. Is the token healthy? (Token)
4. What did the app ask for? (the properties panel: app user, scopes, webhook events)

Route: `/organization/linear` (`apps/web/src/app/(panel)/organization/linear/page.tsx`, ticket 33). The sidebar gets a **Linear** row under Organization, right after GitHub, Lucide `ticket`.

**Who sees what (ticket 33):** admins see everything here. A member sees the same page with no controls: no form, no Copy-to-create, no Disconnect, no Authorize again. See "Differences from the current code", item 2, for the API gap this opens.

## Layout (1440 px wide, the concepts' frame)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 232px, `--side`, right hairline | The shared sidebar (`components/shell/sidebar.tsx`); **Linear** is the selected row |
| Top bar | 44px, bottom hairline | Breadcrumbs `Acme Corp › Linear`. Right: connected, one secondary button `Open in Linear` (`external-link` icon first); otherwise nothing |
| Page | `1fr`, padding `28px 40px` | `h1`, the lede, then sections 26px apart |
| Properties panel | 300px, left hairline, padding `20px 18px` | Connected: App, Scopes, Webhook events. Not connected: what the app will ask for, and the mode |

No cards. A section is a `.shead` title line (13px, 600) and `.rows` split by hairlines. The connect form's inputs are the only boxed things. At `< xl` the properties panel stacks under the page, as `PageFrame` does already. At phone width (F-075) the key/value rows stack: key above value.

### Heading (every state)
- `h1` (Manrope 700, 24px): `Linear`
- Lede (`.lede`, 13.5px, `--muted`, max 720px, two lines): `The organization's own Linear app reads tickets and writes back status, one comment and links. Its tokens stay on this server, in the secret store, and never reach an agent.`
- A callback error (`?error=` on the URL): one line under the lede, `--red`, Lucide `triangle-alert` 14px, no box, at most 300 characters of the server's message (list under "Back from Linear").

## States and copy

### 1. Not connected (no connection, or the last one `revoked`)

Section **Connect your Linear app** (`.shead`). Under it, three numbered steps as rows, 52px minimum, hairlines between, the same 22px step circles as Home's checklist (`SetupChecklist`'s `Tick`): a done step is a filled `--green` circle with a check, the current step a 1px `--text` ring with its number, a later step a 1px `--line-2` ring with a `--muted` number. The forms sit in a 460px column under their step's text, aligned to the text's left edge (34px in from the circle's).

**Step 1: `Create the app in Linear`**
- Body (12.5px `--muted`): `ostra fills in the app's name, its callback and its webhook. You press Create in Linear, as a workspace admin.`
- The mode line, one line, Lucide `info` 15px `--muted`, 12.5px `--muted`, no box, no colour. It shows **before** the click: the server says which mode the connection will run in (see differences, item 3).
  - Webhooks: `Linear will send events to` + the webhook URL in mono `--text` (`https://ostra.acme.dev/webhooks/linear/<connectionId>`; before `linear.start` there's no ID yet, so the line reads `Linear will send events to this server, at /webhooks/linear/…` with the path in mono).
  - Polling: `This server's address isn't public (<reason>), so the app gets no webhook and ostra asks Linear for changes every 60 s. Set OSTRA_CORE_PUBLIC_URL to a public https address to receive events.` (`OSTRA_CORE_PUBLIC_URL` in mono). `<reason>` is the pre-check's words from ticket 08, ported from `spikes/linear-agent-mode/src/manifest.ts`: `a loopback host cannot be reached from Linear`, `a private-network host cannot be reached from Linear`, `a host with no dot is a local name, not a public one`, `Linear only delivers webhooks to https:// URLs`.
- Button (the page's one primary while this is the current step, `.btn.primary`, Shell): `↗ Create the app in Linear`, icon first. On click: `linear.start`, then the manifest link opens in a new tab (`target="_blank" rel="noopener"`). While `start` runs: disabled, `Preparing…` with a spinning `loader-circle`.
- Done (the connection is `pending`): the circle ticks, the button gives way to a teal link `Open in Linear again ↗`.

**Step 2: `Paste the app's values`**
- Body: `From the app's page in Linear. They go to the secret store and are never shown again.`
- Fields (`.field`, label 12px/500 `--muted`, inputs 32px mono, `type="password"` for the two secrets, `autocomplete="off"`):
  - `Client ID`
  - `Client secret`
  - `Webhook signing secret`: only in webhooks mode. In polling mode the field isn't there, and the step's body adds ` Polling needs no signing secret.`
- Button: `Save`. Primary when this is the current step, disabled until every shown field is filled. While saving: `Saving…`. An error shows above it: `--red`, `triangle-alert` 14px, the server's message, `role="alert"`.
- Done: the fields are cleared and replaced by one `--muted` line with a `lock` 13px: `Saved in the secret store.` and a teal `Replace` link that brings the empty fields back. The saved values never come back from the server.

**Step 3: `Authorize`**
- Body: `Linear asks you to install the app on the workspace, then sends you back here.`
- Button: `↗ Authorize in Linear`, primary when current, outline and disabled before step 2 is done. It navigates in the same tab to `linear.authorizeUrl`'s answer (`actor=app`, PKCE). While the URL is fetched: `Opening Linear…`.

**Properties panel (not connected)**
- Label `Mode`. One `.row2`: `Webhooks` or `Polling`, and under it `.help` with the reason, the same words as the mode line.
- `.sep`, label `The app asks for` with a faint count `4`. Rows, mono `--muted`, one left edge: `read`, `write`, `issues:create`, `comments:create`.
- `.sep`, label `Webhook events` with a faint count `6` (webhooks mode only). Rows, mono `--muted`: `Issue`, `Comment`, `Attachment`, `IssueLabel`, `OAuthAuthorization`, `AgentSessionEvent`. Under them `.help`: `AgentSessionEvent is asked for now, so agent mode later needs no new app.`
- Polling mode: instead of the events list, one row `Webhook` · `Off: polling every 60 s`.

**A member, not connected:** no steps. One `--muted` row: `Linear isn't connected. An admin connects it from this page.`

### 2. Pending (`state: pending`)

The same three steps, with step 1 (and step 2, once saved) ticked. Above them, one faint line: `Started <date, time> by <admin name>.` and a teal `Start again` link, which calls `linear.disconnect` on the pending row and goes back to state 1 (confirmation not needed: nothing is connected yet).

### 3. Back from Linear

The callback (ticket 27) returns to `/organization/linear?connected=1` or `?error=…`.
- Connected: state 4, with a `--green` `check` 14px and faint `Just connected` at the end of the Connection row.
- Error: state 2 (pending), with the red line under the lede. Server messages it can carry: `Linear didn't send the app back. Start again.`, `This sign-in with Linear is not valid any more: start again`, `This sign-in with Linear was started in another session`, `This sign-in with Linear was already used: start again`, `Linear signed in as a person, not as the app. Authorize again.`, `Linear refused the authorization: <Linear's error>`.

### 4. Connected, webhooks (`connect-linear.webp`)

**Connection**: one 40px row between hairlines:
- `.dot.green` + `Connected` in `--green`, then the workspace's URL key in mono `--text` (`acme`), then its name in `--muted` (`Acme`)
- right: faint mono `since 12 Nov` (the connection's activation date, `en-GB` day and month; with the year when it isn't this year). After the callback: `✓ Just connected` instead.

**Events**: key/value rows, 40px, hairlines between, key column 160px `--muted`, value `--text`:

| Key | Value |
|---|---|
| `Mode` | Lucide `radio-tower` 15px `--muted`, then `Webhooks: receiving` (sans) |
| `Webhook URL` | the URL in mono `--faint`, truncated in the middle; at the right a teal `Copy` (`Copied` for 2 s) |
| `Last event` | mono `--text` event type (`Issue`), then `--muted` `CALC-161 updated`; right, faint mono `2 min ago`. With no event yet: faint `None yet` |
| `Backstop` | `--muted`: `Every board is also polled every 5 min, so a missed delivery is found.` (`OSTRA_RECONCILE_MINUTES`, from the server, not typed in the panel) |

**Token**: the same key/value rows:

| Key | Value |
|---|---|
| `Access token` | `.dot.green` + `Healthy` in `--green`, then `--muted` ` · expires in 21 h, refreshed an hour before` |
| `Refresh token` | `lock` 13px + `--muted` `In the secret store` |

**Disconnect** (admins only): one row: `--muted` `Revokes the token at Linear and stops every board. Boards and their tickets stay, read-only.` and, right, an outline button `Disconnect`. It opens an `AlertDialog`:
- Title `Disconnect Linear?`
- Body: `ostra revokes its token at Linear and stops polling and webhooks for every board. Boards, tickets and tasks stay, read-only. To connect again, you authorize the app again.`
- Buttons: `Cancel` (outline) and `Disconnect` (outline, `--red` text and border). While it runs: `Disconnecting…`. Then state 1, with the revoked row's workspace named in one faint line: `Disconnected from acme on <date>. Its boards and tickets stay, read-only.`

**Properties panel (connected)**
- Label `App`. Rows (`PropRow`: its 96px key column, 30px): `App user` mono (`ostra`, the app user's display name) · `Secrets` with a `lock` 13px and `--muted` `In the secret store`.
- `.sep`, label `Scopes` with a faint count `4`. Rows, mono `--muted`, on the label's left edge: `read`, `write`, `issues:create`, `comments:create`.
- `.sep`, label `Webhook events` with a faint count `6`, rows as in the not-connected panel, and the `.help` line under them.

### 5. Connected, polling

As state 4, with these rows changed:
- `Mode`: Lucide `refresh-cw` 15px `--muted`, `Polling every 60 s` (`OSTRA_TRACKER_POLL_SECONDS`, from the server).
- `Webhook URL` becomes `Webhook`: `--muted` `None: this server's address isn't public (<reason>).`
- `Backstop` row: gone (polling is the source).
- `Last event` becomes `Last poll`: faint mono time, `--muted` `<n> tickets changed` when there were any.
- Panel: `Webhook events` group replaced by the `Webhook` · `Off: polling every 60 s` row.

### 6. Webhooks silent

Linear's webhooks stopped arriving while polling still finds changes (ticket 14). ostra never switches the mode on its own.
- `Mode` value: Lucide `triangle-alert` 15px `--red`, then `--text` `Webhooks: silent since 14:02`, then `--muted` ` · polling still finds changes`.
- Under the Events rows, one `.help` line: `Check the app's webhook in Linear: it may be disabled, or its URL may have changed. Tickets still arrive every 5 min.`
- Colour: red is the error colour, used on the icon only. No amber: no needs-you item opens for this.

### 7. Token failed (`state: failed`)

A refused refresh (ticket 14) marks the connection `failed`, stops polling and writes for it, and opens a needs-you item for the admins.
- Connection row: `.dot` `--red` + `Failed` in `--red`, the workspace as usual; right, faint mono `since 14:02`.
- `Access token` row: `triangle-alert` 14px `--red` + `--text` `Linear refused the refresh. Polling and writes have stopped.`
- One primary button under the Token section, on the page's left edge: `↗ Authorize again` (same flow as step 3, against the same app). It's the page's one Shell button. The needs-you item, not this page, carries the amber (in the sidebar and on Home).
- A member sees the rows and, instead of the button, `--muted` `An admin authorizes the app again.`

### 8. Loading

While `linear.status` is pending: the heading at once, and three `Skeleton` rows (40px, `--surface`) where the first section goes. Never a blank page. The panel's values show `–`.

**Colour use on this page:** green only on the Connected and Healthy dots and words, and the Just-connected check. Teal only on links (`Copy`, `Replace`, `Start again`, `Open in Linear again`). Red only on errors, the silent-webhooks icon and the Failed state. **No amber on this page.**

## Components (shadcn/ui names)

| Where | Component |
|---|---|
| Frame | the app's `PageFrame` (sidebar, top bar, properties panel) |
| Breadcrumbs | as on the GitHub page (`PageFrame`'s `crumbs`) |
| Open in Linear, Disconnect, later steps' buttons | `Button variant="outline" size="sm"` (`.btn`) |
| The current step's button, Authorize again | `Button variant="default"` (`.btn.primary`, Shell) |
| Copy, Replace, Start again, Open in Linear again | `Button variant="link"` in `--teal`, or a plain `<a>` |
| Step circles | `SetupChecklist`'s `Tick`, moved to `components/ui/step-tick.tsx` so both use one |
| Form | `Field` + `Label` + `Input` (`type="password"` for secrets) + `FieldDescription` (`.help`) |
| Errors | inline text with `triangle-alert`, `role="alert"`; no `Alert` box |
| Status | the app's `Status` (`tone="green"` / `"red"` / `"grey"`; its red dot has no halo today: add `rgba(229,103,92,0.15)`) |
| Key/value rows | `ul.rows` of `grid grid-cols-[160px_1fr_auto]` rows |
| Properties | the app's `PropGroup`, `PropRow`, and `Separator` (`.sep`) |
| Disconnect confirmation | `AlertDialog` (new: shadcn CLI, built on `radix-ui`, already a dependency) |
| Loading | `Skeleton` |
| Spinner | Lucide `loader-circle` with `animate-spin` |

## Tokens (from `../../app-concepts/html/graphite.css`)

```css
--bg: #0D0E10; --side: #0A0B0C; --surface: #131416; --raise: #17181B;
--line: #1F2023; --line-2: #2A2C30;
--text: #EDEDEE; --muted: #9A9DA3; --faint: #64676D;
--sel: #1A1B1E; --teal: #6FB8AA; --green: #4FB286; --red: #E5675C;
--amber: #FFB224; --shell: #F3F0E8; --ink: #0C1D21;
```

- Body: IBM Plex Sans 400 13px/1.5. Nav, buttons 500. Section titles 600 13px. Field labels 500 12px `--muted`.
- `h1`: Manrope 700 24px/1.25, letter-spacing -0.015em. Lede 13.5px `--muted`.
- Mono (IBM Plex Mono): the workspace key, the app user, the webhook URL, event types, ticket keys, scopes, event names, counts (11–11.5px 500 `--faint` beside titles), times, env names.
- Icons: Lucide 15px, stroke 1.75 (13px in `.row2`).
- Rows: 40px; key column 160px. Inputs: 32px, `--surface`, 1px `--line-2`, radius 7px. Buttons: 28px, radius 7px, padding 0 11px, 12.5px.
- Properties: `PropRow` (96px key column in the code), 30px rows, 12.5px; group labels 500 11px `--faint`; `.sep` 1px `--line`, 14px margins.
- Status dot: 7px, with its 3px halo (`rgba(79,178,134,0.15)` for green, `rgba(229,103,92,0.15)` for red).

## Differences from the current code

There is no Linear page today. What it needs beyond ticket 33's list:

1. **New files:** `app/(panel)/organization/linear/page.tsx` and `components/linear/linear-view.tsx`, built like `components/github/github-view.tsx` (same `PageFrame`, `Section`, `PropGroup`, error line and `?connected=1` handling).
2. **Members see the page, read-only (ticket 33),** but ticket 27 makes every `linear.*` procedure admin-only, `linear.status` included. Either `linear.status` becomes a member procedure that returns no secrets and no webhook URL to members, or members get `AdminOnly` like the GitHub page. This needs a decision before ticket 33 builds; until then build the admin view and `AdminOnly`.
3. **The mode before the click.** Step 1's mode line needs the server's mode and reason before `linear.start` creates the row: a small query (for example `linear.mode` → `{ mode, reason }` from the address pre-check), or `linear.status` answering it when there's no connection. Not in ticket 27 yet.
4. **`linear.status` fields the page reads:** state, mode, workspace key and name, app user's name, activation date, the last event's time, type and ticket key (the type and key from the newest `WebhookDelivery`; with only `Connection.lastEventAt`, the row shows the time alone), the access token's expiry, "silent since", the poll interval and the reconcile interval (from `OSTRA_TRACKER_POLL_SECONDS` and `OSTRA_RECONCILE_MINUTES`, never typed in the panel), the started-at time and admin of a pending row. Ticket 27 lists most of these; the names, dates, intervals and delivery fields are additions.
5. **Sidebar:** add `Linear` (Lucide `ticket`) after GitHub. GitHub is admin-only in the sidebar today; Linear follows item 2's decision. Record the row in `../../app-design.md`'s Organization list (it has no GitHub row either).
6. **Step circles:** move `Tick` out of `setup-checklist.tsx` into a shared component.
7. **`AlertDialog`, `Skeleton`:** added with the shadcn CLI (`AlertDialog` is the first confirmation dialog in the panel).
8. **Messages:** every string above under a new `linear.*` group in `messages/en.json`.

## Wrong in the image

The build uses the copy in this file, not the pixels.

1. **`Client ID` and `Workspace` in the properties panel:** drop both. The client ID was pasted into a secret field and never comes back (ticket 33), and the workspace is already on the Connection row. The App group is `App user` and `Secrets` only.
2. **Rows are drawn about 35px tall:** they're 40px.
3. **The properties panel** comes out about 355px wide: build it at 300px.
4. **The logo mark** (top-left) is drawn as a circle with a slash: use the real Hinge file (`../../kit/logo/export/ostra-hinge-single-color.svg`, 20px).
5. **The Linear sidebar icon** is drawn as a panel: use Lucide `ticket`.
6. **`Issue CALC-161 updated`** is drawn all in mono: only `Issue` and `CALC-161` are mono, `updated` is sans `--muted`.
7. **The `·` in the Access token row** sits apart from its words: it's ` · ` inline in the `--muted` text.
8. **The sidebar** shows the full later concept sidebar (Runner pools with counts, Agent profiles, Insights, Memory, Members, Audit log, Background work). Build it from the shared shell, as milestone 1's README says.
9. No misspellings.
