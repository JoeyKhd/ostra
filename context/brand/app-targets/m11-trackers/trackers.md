# Target: Organization › Trackers

- **Pictures:** `trackers` and `trackers-light` (the list, Globex Jira selected), `trackers-picker` and `trackers-picker-light` (Connect a tracker), `trackers-empty` and `trackers-empty-light` (no connection), `trackers-states` (every row status, Disconnect, Home's step, a member, a site already connected), `trackers-phone` (390×844). Desktop: a 2880×1912 `.png` and a 1440×956 `.webp`; the phone: 780×1688 and 390×844.
- **Sources:** `html/trackers.html` (`?view=list|picker|empty`), `html/states.html?sheet=trackers`, `html/phone.html?scene=list`; the parts in `html/tr.js` (`connTable`, `connPanel`, `kinds`, `pickerDialog`, `logo`) and `html/tr.css`.
- **Route (new):** `/organization/trackers`, replacing `/organization/linear` (which redirects to its Linear connection's page). The organization panel's Connections group: `GitHub`, then `Trackers` (Lucide `ticket`, the count of connections in mono).
- **Feature:** F-005 (Linear's connection, re-homed), F-008 (Jira), F-042 (polling). ADR 0013, ADR 0047.
- **Status: approved 2026-11-23** ("yes to all", `README.md`).

## Purpose

An organization admin sees every tracker connection at once, whatever its kind, and connects another for the next client. Each connection is one Linear workspace or one Jira site with its own token and webhook. The page answers: which trackers are connected, to what, do their events arrive, and is any broken?

## Layout (CSS px at 1440×956)

The double-sidebar shell; the page column `max-width: 760px`; the properties panel 320px.

| Part | Size and style |
|---|---|
| Top bar | `Acme Corp › Trackers`; right: the page's one primary, `+ Connect a tracker` (hidden in the empty state, whose picker is on the page) |
| Heading | `h1` `Trackers` (Manrope 700, 26px); lede 15px `--muted`, two lines at most |
| Section | `Connections` (15px 600) and the count, mono 13px `--faint` |
| Table | `table.t`, fixed layout. Columns: Connection (rest), Workspace or site 188px, Mode 112px, Last event 92px, Status 118px. Head 30px, 12.5px `--faint`. Rows 46px, hairlines. The selected row `--sel`, 6px radius |
| Connection cell | the kind's mark, **20px, brand colour**, 11px gap; the name (14px 500) over the kind (12.5px `--faint`: `Linear`, `Jira Cloud`) |
| Workspace or site | mono 13px `--muted`, cut with `…` |
| Mode | Lucide `radio-tower` (Webhooks) or `refresh-cw` (Polling), 14px `--faint`, then the word 13.5px `--muted` |
| Last event | mono 13px `--muted`; `–` `--faint` with none yet |
| Status | a 7px dot and the word (13.5px): green `Connected`; a dashed ring and `--muted` `Pending`; red `Failed`. Pending and Failed add a second line, 12.5px `--faint`, the reason (`No delivery yet`, `Token refused`) |
| Under the table | Lucide `lock` 14px + 13px `--faint`: `Each connection keeps its own token and webhook. A client's tickets only ever move through its own connection: Globex's never pass through Acme's.` (the two names are the first two connections of different clients, or the sentence's first half alone) |

### The properties panel (a connection selected)

- Head: the mark 28px, the name (15px 600), and `Jira Cloud · globex.atlassian.net` (13px `--muted`, the site mono).
- **Connection:** `Status` (dot, word, `· since 14 Nov` `--faint`), `Mode`, `Last event` (mono, then `· PROJ-14`), `Signs in as` (`ostra-bot · service account` for Jira, `ostra · app user` for Linear), `Token` (`Expires 14 Sep 2027` for Jira, `Healthy` for Linear).
- **Boards on it** with the count: each a project's square, its name, and on the right the board and key (12.5px `--faint`).
- **What Jira does here** (or **What Linear does here**): the adapter's declared capabilities, one row each: `Moves status` (`By workflow transitions` / `Directly`), `Sub-tasks` / `Sub-issues` (`Yes`), `Rich text` (`ADF, converted` / `Markdown`), `Agent mode` (`– not in Jira` `--faint` / `On` or `Off`).
- `Open Globex Jira →` (teal), to the connection's page (`connection-settings.md`).

## Connect a tracker (`trackers-picker`)

A dialog, 600px, over the scrim, from the top bar's button (and from Home's step through the empty page).

- `Connect a tracker` (16px 600); `Each connection is one Linear workspace or one Jira site, with its own token. Connect one per client.` (14px `--muted`).
- **Two tiles,** a 2-column grid, 12px gap; each 16px padding, `--surface`, 1px `--line-2`, 10px radius; a 16px radio top right. Picked: 1px `--text` border plus a 1px `--text` ring, the radio filled.
  - **Linear:** mark 32px, `Linear` (16px 600), `Linear's own app, per workspace` (12.5px `--faint`); `You create the app in Linear, paste its values and authorize it. Webhooks, or polling without a public address.`; chips `Agent mode`, `Sub-issues`, `Magic words`.
  - **Jira:** mark 32px, `Jira`, `Jira Cloud, by service account`; `A service account's scoped API token, and an admin webhook signed with a secret ostra makes.`; chips `Workflow transitions`, `Sub-tasks`, `JQL filter`.
  - The chips are the adapter's declared capabilities, not marketing.
- **Coming soon** (choice 1, settled): a second 2-column row, 10px under: **Trello** and **Notion**, each one 44px row: the mark 22px at 60% opacity, the name (14px 500 `--faint`), and a `Coming soon` chip (11px 500 `--faint`, 1px `--line-2`) on the right. `aria-disabled="true"`, not focusable, no link, no form.
- Footer: `← →` (kbd) `to pick` 13px `--faint`; `Cancel`; primary `Continue with Jira` (names the picked kind; disabled until one is picked).
- Continue asks nothing more here: it creates a **pending** connection of that kind and opens its page at step 1 (`jira-connect.md`; Linear's steps as today, step 1 gaining the name field).

## No connection yet (`trackers-empty`)

No table and no top-bar button. Under the lede, a hairline, then `Connect a tracker` (15px 600), `Tickets then become tasks, and ostra keeps their status in step. Until then, tasks start from prompts, and nothing else waits on it.`, the same tiles and Coming-soon row, and `Continue` (primary, disabled until a tile is picked) with `Pick one. You can connect more, of either kind, later.` The panel: **How it works**, three numbered lines (Connect, Attach, Start), and **Kept apart**, one line on per-connection tokens.

## States (`trackers-states`)

| State | The row |
|---|---|
| Connected, webhooks | green dot, `Connected`; Mode `Webhooks`; Last event its age |
| Connected, polling | the same; Mode `Polling`; Last event is the last poll |
| Pending | dashed ring, `Pending`, `No delivery yet` (Jira, step 3 open) or `Not authorized yet` (Linear, step 3 open); Last event `–` |
| Failed | red dot, `Failed`, the reason: `Token refused`, `Token expired`, `Site not found` |
| Webhooks silent | red `triangle-alert` 14px, `Silent`: no delivery for 30 min while polling still finds changes |
| Token near its date | red `triangle-alert`, `Token expires`: from 14 days before the date the admin gave; on the day, Failed |
| A member | the same list with no `Connect a tracker`; the panel without actions; a connection's page without Copy, Replace, Rotate or Disconnect, and never its webhook URL or secret. One line above the table: `Only the organization's admins connect, change or disconnect trackers.` |
| Loading | three 46px `Skeleton` rows; the panel's values `–` |
| Disconnect (from a connection's page) | `Disconnect Globex Jira?` / `ostra stops the webhook and polling for globex.atlassian.net and deletes its token from the secret store. Its 2 boards, on calculator and globex-shop, stay attached but paused: their tickets and tasks stay, read-only, and no ticket moves.` / `Connecting the same site again resumes them. Delete the webhook in Jira yourself: ostra can't.` / `Cancel`, `Disconnect` (red text) |
| Site already connected | step 1's field red-edged; `globex.atlassian.net is already connected, as Globex Jira.` + `Open it →` |

Failed and Token-expires open a needs-you item for the organization's admins (as Linear's failed token does today), which carries the amber; this page uses red on the icon only.

## Phone (`trackers-phone`)

The top bar 52px: the menu, `Trackers`, a `+` (44px target) for Connect a tracker. Each connection a card between hairlines: the mark 20px, the name (15px 500), the site (mono 12.5px), then status, mode and last event on one line (13px); a chevron opens its page. The picker is a bottom sheet with the tiles stacked.

## Keyboard

- The table is a list of rows: `↑`/`↓` move the selection (the panel follows), `Enter` opens the connection's page. `c` opens Connect a tracker.
- The picker: `←`/`→` (and `Tab`) move between Linear and Jira, `Space` picks, `Enter` continues, `Esc` closes. The Coming-soon tiles are skipped.
- Each mark is `role="img"` with the kind's name as its label; beside a name that already says it, `aria-hidden`.

## Data

- `trackers.list` → each connection: `id`, `kind` (`linear` | `jira`), `name`, `site` (Linear's URL key or the Jira host), `webhookMode`, `lastEventAt`, `state` (`pending` | `active` | `failed`), `failedReason`, `tokenExpiresAt` (Jira), `silentSince`, `boards` (project, board, key), `capabilities` (from the adapter).
- `trackers.create({ kind, name })` → a pending connection; its page continues.

## Copy (keys under `trackers.*`)

`title` `Trackers` · `lede` `Where the organization's tickets live. Each client can bring its own Linear workspace or Jira site; a project's Boards then attach teams and projects from any of them.` · `connections` `Connections` · `col.*` `Connection`, `Workspace or site`, `Mode`, `Last event`, `Status` · `kind.linear` `Linear` · `kind.jira` `Jira Cloud` · `status.*` `Connected`, `Pending`, `Failed`, `Silent`, `Token expires` · `why.*` `No delivery yet`, `Not authorized yet`, `Token refused`, `Token expired`, `Site not found` · `keptApart` (above) · `connect` `Connect a tracker` · `picker.lede` `Each connection is one Linear workspace or one Jira site, with its own token. Connect one per client.` · `picker.continue` `Continue with {kind}` · `picker.soon` `Coming soon` · `empty.lede` `Tickets then become tasks, and ostra keeps their status in step. Until then, tasks start from prompts, and nothing else waits on it.` · `empty.hint` `Pick one. You can connect more, of either kind, later.` · `panel.open` `Open {name}` · `member` `Only the organization's admins connect, change or disconnect trackers.`

## Tokens

The panel's, both themes: `--sel` (the selected row), `--green` (Connected), `--red` (Failed, the warning icons), `--teal` (links), `--faint` / `--muted`. The marks carry their own colours (`README.md`, "The marks"). **No amber.**
