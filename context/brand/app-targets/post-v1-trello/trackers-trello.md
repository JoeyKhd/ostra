# Target: Organization › Trackers with Trello

- **Pictures:** `trackers-trello` and `trackers-trello-light` (five connections, Acme Trello selected), `trello-picker` and `trello-picker-light` (Connect a tracker, Trello picked, only Notion `Coming soon`), and both at 390×844: `trackers-trello-phone`, `trackers-trello-phone-light`, `trello-picker-phone`, `trello-picker-phone-light`.
- **Sources:** `html/trackers.html` (`?view=list|picker`), `html/phone.html?scene=list|picker`; the parts in `html/tl.js` (`connTable`, `connPanel`, `kinds`, `pickerDialog`) and `html/tl.css`.
- **Route (built by milestone 11):** `/organization/trackers`, replacing `/organization/linear`. The organization panel's Connections group: `GitHub`, then `Trackers` (Lucide `ticket`, the count of connections in mono).
- **Feature:** F-153 (Trello), F-152 (Trackers). ADR 0071, ADR 0072.
- **Status: design target, 2026-11-23**, awaiting the maintainer's approval (`README.md`).

## Purpose

The same page milestone 11 draws for Linear and Jira, with a third kind: an admin sees every tracker connection at once, including the client's Trello account, and connects another from a picker where Trello is now a real choice.

## Layout (CSS px at 1440×956)

The double-sidebar shell; the page column `max-width: 760px`; the properties panel 320px. Milestone 11's table (`../m11-trackers/trackers.md`) with one column renamed.

| Part | Size and style |
|---|---|
| Top bar | `Acme Corp › Trackers`; right: the page's one primary, `+ Connect a tracker` |
| Heading | `h1` `Trackers` (Manrope 700, 26px); lede 15px `--muted`: `Where the organization's tickets live. Each client can bring its own Linear workspace, Jira site or Trello account; a project's Boards then attach teams, projects and boards from any of them.` |
| Section | `Connections` (15px 600) and the count, mono 13px `--faint` |
| Table | `table.t.conns`, fixed layout. Columns: Connection (rest), `Workspace, site or bot` 178px, Mode 108px, Last event 88px, Status 118px. Head 30px, 12.5px `--faint`; rows 46px, hairlines; the selected row `--sel`, 6px radius |
| Connection cell | the kind's mark, 20px, brand colour, 11px gap; the name (14px 500) over the kind (12.5px `--faint`): `Linear`, `Jira Cloud`, `Trello · bot member` |
| Workspace, site or bot | mono 13px `--muted`, cut with `…`. A Trello row shows the bot member's username (`ostra-acme`) |
| Mode | `radio-tower` (Webhooks) or `refresh-cw` (Polling), 14px `--faint`, then the word 13.5px `--muted` |
| Last event | mono 13px `--muted`; `–` `--faint` with none yet |
| Status | a 7px dot and the word (13.5px): green `Connected`; a dashed ring and `--muted` `Pending`, with a second line 12.5px `--faint` (`No delivery yet`); red `Failed` (`Token refused`, `Token revoked`) |
| Under the table | Lucide `lock` 14px + 13px `--faint`: `Each connection keeps its own token and webhook. A client's tickets only ever move through its own connection: Globex's never pass through Acme's.` |

### The properties panel (Acme Trello selected)

- Head: Trello's mark 28px, `Acme Trello` (15px 600), and `Trello · bot member ostra-acme` (13px `--muted`, the username mono).
- **Connection:** `Status` (green dot, `Connected · since 14 Nov`), `Mode` (`Webhooks`), `Last event` (mono `updateCard`, faint `· TR-12`), `Signs in as` (mono `ostra-acme`, faint `· bot member`), `Token` (`Never expires`). There is no token date for Trello.
- **Boards on it** with the count: each a project's square, its name, and on the right the board and key (`Calculations · TR`, `Retail · RT`).
- **What Trello does here:** `Moves status` (`Directly, by list`), `Sub-tasks` (`– not in Trello`, faint), `Rich text` (`Markdown`), `Files` (`Attachments`), `Agent mode` (`– not in Trello`, faint). These are the adapter's declared capabilities; no capability it doesn't declare is drawn as a control.
- `Open Acme Trello →` (teal) to the connection's page (`connection-trello.md`).

## Connect a tracker (`trello-picker`)

A dialog, 640px, over the scrim.

- `Connect a tracker` (16px 600); `Each connection is one workspace, site or bot member, with its own token. Connect one per client.` (14px `--muted`).
- Four tiles, a 2×2 grid, 12px gap: each 16px padding, `--surface`, 1px `--line-2`, 10px radius; a 16px radio top right. Picked: 1px `--text` border plus a 1px `--text` ring, the radio filled.
  - **Linear:** mark 32px, `Linear`, `Linear's own app, per workspace`; chips `Agent mode`, `Sub-issues`, `Magic words`.
  - **Jira:** mark 32px, `Jira`, `Jira Cloud, by service account`; chips `Workflow transitions`, `Sub-tasks`, `JQL filter`.
  - **Trello:** mark 32px, `Trello`, `Trello, by bot member`; `The organization's own app, and a bot member whose token never expires. Webhooks, or polling without a public address.`; chips `Lists as statuses`, `Cards`, `Attachments`.
  - **Notion (disabled):** dashed border, no radio, mark at 60% opacity, `Coming soon` chip top right; `Notion`, `Later, after Trello`; `Notion's properties and webhook verification need a spike before ostra can map its pages.` `aria-disabled="true"`, not focusable, no form.
- Footer: `← →` (kbd) `to pick` 13px `--faint`; `Cancel`; primary `Continue with Trello` (names the picked kind; disabled until one is picked).

Continue creates a **pending** Trello connection and opens its page at step 1 (`trello-connect.md`).

## Phone

The top bar 52px: the menu, `Trackers`, a `+` (44px target) for Connect a tracker. Each connection a card between hairlines: the mark 20px, the name (15px 500), the site or bot member (mono 12.5px), then status, mode and last event on one line (13px); a chevron opens its page. The picker is a bottom sheet (`min(100vw − 32px, 390px)`), the tiles stacked two by two, descriptions and no capability chips; `Cancel` and `Continue with Trello` at the foot.

## Keyboard

- The table is a list of rows: `↑`/`↓` move the selection (the panel follows), `Enter` opens the connection's page. `c` opens Connect a tracker.
- The picker: `←`/`→` (and `Tab`) move between Linear, Jira and Trello, `Space` picks, `Enter` continues, `Esc` closes. Notion is skipped.
- Each mark is `role="img"` with the kind's name as its label; beside a name that already says it, `aria-hidden`.

## Data

- `trackers.list` → each connection: `id`, `kind` (`linear` | `jira` | `trello`), `name`, `site` (Linear's URL key, the Jira host, or Trello's bot username), `webhookMode`, `lastEventAt`, `state`, `failedReason`, `tokenExpiresAt` (Jira only), `silentSince`, `boards` (project, board, key), `capabilities` (from the adapter).
- For Trello the view adds `botName`, `botUserName`, `boardsCount`; it never draws a token date (`spec §5.4`).
- `trackers.create({ kind: "trello", name })` → a pending connection with `appId` `pending:<id>`; its page continues.

## Copy (keys under `trackers.*`)

`title` `Trackers` · `lede` (above) · `connections` `Connections` · `col.connection` `Connection` · `col.site` `Workspace, site or bot` · `col.mode` `Mode` · `col.lastEvent` `Last event` · `col.status` `Status` · `kind.trello` `Trello · bot member` · `mode.webhooks` `Webhooks` · `mode.polling` `Polling` · `status.connected` `Connected` · `status.pending` `Pending` · `why.noDelivery` `No delivery yet` · `why.tokenRefused` `Token refused` · `why.tokenRevoked` `Token revoked` · `keptApart` (above) · `connect` `Connect a tracker` · `picker.lede` (above) · `picker.continue` `Continue with {kind}` · `picker.soon` `Coming soon` · `trello.sub` `Trello, by bot member` · `trello.body` (above) · `trello.caps` `Lists as statuses`, `Cards`, `Attachments` · `notion.sub` `Later, after Trello` · `notion.body` (above) · panel `moves` `Directly, by list` · `noSubTasks` `– not in Trello` · `richText.markdown` `Markdown` · `files.attachments` `Attachments` · `noAgentMode` `– not in Trello`.

## Tokens

The panel's, both themes: `--sel`, `--green`, `--red`, `--teal`, `--faint`/`--muted`. Trello's mark carries its own `#1558BC` and white glyph. **No amber.**
