# Target: notification choices (milestone 3, screen 10)

> **Committed image:** `notification-settings.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel.

- **Prompt:** `notification-settings.prompt.txt`. GPT Image 2.6 through Higgsfield, 2 generations: the first from the full spec, the second an edit of the first that narrowed the panel, made its group labels quiet and set its keys and values in sans. References: `app-targets/m1/models.png` (the closest approved settings page with a properties panel), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route (new):** `/account/notifications` → `apps/web/src/app/(panel)/account/notifications/page.tsx` → `components/account/notification-settings-view.tsx`.
- **Features:** F-036 (notifications: each member chooses per moment and channel), F-115 (email: "Without email the panel says mail is off"). Spec section 12, screen 10; ADR 0050. Ticket 37 (`notifications.preferences.get` / `.save`, `email.status`), ticket 45 (this screen).
- **Status:** a proposed target, waiting on the maintainer's approval (ticket 41's `## Comments`). Ticket 45 builds its data and tests until then, not its UI.

> Build it in real HTML/React (app-design.md, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

Any member decides which "needs you" moments reach them on which channel: the panel (the Needs you page and the sidebar's count), the ticket (a comment on the task's ticket that mentions them) and email. The panel can't be turned off. The page also says, without alarm, where mail goes, what a mail may carry, and when mail is off on this install, so a member never waits for a mail that can't come.

The picture shows Alex Kim on an install **without mail**, having just unchecked `Plans` for email (the defaults have it on), before pressing `Save choices`.

## Layout (CSS px at 1440 wide)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 232px, `--side`, 1px `--line` on its right | the shared sidebar. No row of Projects or Organization is selected: on an Account page the **member row at the bottom** is `--sel` with `--text`. Build it from `components/shell/sidebar.tsx`, not from the picture |
| Top bar | 44px, 1px `--line` below | breadcrumb `Account › Notifications` (`Account` links to `/account`, target `account`); on the right the page's one primary button, `Save choices`, disabled until the choices differ from the saved ones |
| Page | `1fr`, padding `28px 40px`, content max 760px | title, lede, the mail notice, Moments |
| Properties panel | **300px** (no form in it), 1px `--line` on its left, padding `20px 18px` | Your address, Channels, Mail, Last change |

The picture draws the panel at about 355px. Build 300px.

### Heading

- Title `Notifications`, Manrope 700 24px, letter-spacing −0.015em. No eyebrow.
- Lede, 13.5px `--muted`, one line: `When a task needs you, ostra tells you here, on the ticket and by mail. Choose which moments reach you where.`

### The mail notice (only while mail is off)

16px under the lede. Not a card and not amber (nothing waits on the member): a 2px `--line-2` left rule, 12px left padding, 20px line height, 13px:
- Lucide `mail-x` 15px `--muted`, 8px, then `Mail is off on this install.` in 500 `--text`, then ` Your email choices are kept, and apply once an instance admin sets up mail.` in `--muted`.
- For the instance admin only, after it, a teal link (no underline): `Set up email` → `/organization/email` (target `email-settings`).

From `email.status` (ticket 37). With mail on, the notice isn't rendered and nothing takes its place.

### Moments

1. **Title line** (`Section`, 26px above): `Moments`, 600 13px. No count.
2. **A table** (`Table`, no box), as wide as the content (max 760px). Header row 30px, labels 500 11.5px `--faint`: `Moment` on the left, then three **88px** columns at the right, centred: `Panel`, `Ticket`, `Email`. While mail is off the email head reads `Email` then ` off` in `--faint` at 60% (`aria-hidden`; the notice says it in words).
3. **Rows,** 44px, a 1px `--line` hairline under each and above the first. The first cell holds two lines: the moment's name, 13px 500 `--text`; under it its description, 12px `--muted`. The three channel cells each hold one centred 16px `Checkbox` (4px radius; checked: `--text` fill with a `--bg` check; unchecked: `--surface` with 1px `--line-2`).
   - **Panel:** checked and `disabled` (40% opacity) in every row, with a `Tooltip`: `The panel always shows it.`
   - **Ticket** and **Email:** enabled, one per row, each with an `aria-label` such as `Email for Plans`. Email stays enabled while mail is off: the choice is kept and applies once mail is on.
   - A whole row is never clickable; only the boxes are.

The rows, in this order (the needs-you reasons a member meets most first). The defaults are ADR 0050's: every moment on for the panel and the ticket; email on for the first six.

| Moment (`kind`) | Name | Description | Email default |
|---|---|---|---|
| `approval` | `Approvals` | `The agent wants to do something its rules hold back` | on |
| `question` | `Questions` | `The agent asks the driver something` | on |
| `plan` | `Plans` | `A plan is ready to approve` | on (unchecked in the picture: the member's unsaved change) |
| `pr_ready` | `Pull requests ready` | `A draft pull request waits for review` | on |
| `crashed` | `Crashed` | `The agent stopped with an error` | on |
| `spend_cap` | `Spend cap reached` | `The task used its whole spend cap` | on |
| `stalled` | `Stalled` | `No progress for a while` | off |
| `no_changes` | `Finished without changes` | `The agent ended and changed nothing` | off |
| `setup_failed` | `Setup failed` | `A setup command failed on the box` | off |
| `ticket_closed` | `Ticket closed` | `The ticket closed while the task ran` | off |

The `test` kind (the instance admin's test mail) has no row.

4. **Under the table,** 10px down, 12px `--faint`: `The panel always shows every moment. Ticket comments go only to tasks with a ticket.` Then on its own line, 6px down, a teal link, 12.5px: `Reset to defaults`. It sets the boxes to the defaults without saving (so `Save choices` turns on when that differs); hidden when the boxes already equal the defaults.

### Properties panel

`PropGroup`s with an 11px 500 `--faint` label, 30px `PropRow`s (96px key column, the default), 12.5px, keys `--muted`, values `--text`, all sans except where noted. `.sep` hairlines between groups.

1. **Your address:** the member's sign-in address on its own line, Plex Mono 13px `--text` (`alex.kim@acme.dev`, from `me.email`), and under it 12px `--muted`: `Your sign-in address. {tracker} mentions use it too.` with the connected tracker's name (`Linear`); with no tracker connected the second sentence is left out. The address isn't edited here.
2. **Channels:**
   - `Panel` · `Always on`
   - `Ticket` · the organization's connected tracker by name (`Linear`; Jira later), or `No tracker connected` in `--faint`
   - `Email` · a 7px `--grey` dot then `Off on this install`; with mail on, a `--green` dot (with its halo) then `On`. The member never sees the provider.
3. **Mail:**
   - `Delay` · `2 min` in Plex Mono (the install's delay: `OSTRA_EMAIL_DELAY_SECONDS` or the instance setting; `0` reads `none`, under a minute `30 s`)
   - `Skipped when` · `read in the panel`
   - then 12px `--muted`, line height 18px: `A mail carries the task's title and key, the moment, one line about it and a link. Never ticket text, agent output or code.` (ADR 0050, "What a mail may carry".)
4. **Last change:** one line, 12.5px `--muted`: `Never changed. These are the defaults.`, or once saved `Changed 12 Nov`.

## States and copy

| State | What changes |
|---|---|
| Loading | the table's boxes and the panel's values are `Skeleton`s (16px squares, 80–120px bars); the notice isn't shown until `email.status` returns |
| Defaults, mail on | no notice; the Email head without `off`; Email shows `On`; `Save choices` disabled; `Reset to defaults` hidden |
| Mail off (the picture) | the notice; the Email head with `off`; Email shows `Off on this install`. The boxes keep working |
| Edited (the picture) | a box differs from the saved choice; `Save choices` enabled. Leaving the page with unsaved changes asks the browser's own "leave page?" (`beforeunload`), nothing more |
| Saving | `Save choices` reads `Saving…`, disabled; the boxes are disabled |
| Saved | `Save choices` disabled again; under the table's footnote, `role="status"`, 12.5px `--green` with `check`: `Saved.`; Last change reads `Changed` and today's date |
| Save failed | under the table, `role="alert"`, 12.5px `--red`: the error text (`errorText`); the boxes keep the member's edits |
| No tracker connected | the Ticket column stays (choices are kept for when one is); `Ticket` reads `No tracker connected`; the footnote's second sentence stays |
| Load failed | the error alert in place of the table, with `Retry` as a teal link |
| Narrow (below 1280px) | the panel drops under the page (`PageFrame`) |
| Phone (below 640px, F-075) | each row becomes a block: the name and description, then a line of three labelled checkboxes (`Panel`, `Ticket`, `Email`) with their labels beside them; the header row is hidden. `Save choices` stays in the top bar |

## Components (shadcn/ui names)

`Sidebar` (existing; the member row gains a selected state), `UserMenu` (existing; gains `Account` with `user-round` and `Notifications` with `bell`), `PageFrame` with `Breadcrumb` and `properties`, `PageHeading`, `Section`, `Table` (existing), `Checkbox` (existing), `Tooltip` (new, `radix-ui`), `PropGroup` / `PropRow`, `Button` (default = the Shell primary), `Skeleton` (existing), the `Status` dot (`ui/status.tsx`). Lucide 15px, stroke 1.75: `mail-x`, `check`, `bell`, `user-round`.

## Tokens (`app-concepts/html/graphite.css`)

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page, panel, the check mark |
| `--side` | `#0A0B0C` | sidebar |
| `--surface` | `#131416` | unchecked boxes, skeletons |
| `--line` | `#1F2023` | row hairlines, panel edge, group lines |
| `--line-2` | `#2A2C30` | box borders, the notice's left rule |
| `--text` | `#EDEDEE` | names, values, checked boxes, the address |
| `--muted` | `#9A9DA3` | lede, descriptions, keys, the notice's second sentence |
| `--faint` | `#64676D` | column heads, the footnote, `off`, panel labels |
| `--sel` | `#1A1B1E` | the selected member row |
| `--green` | `#4FB286` | the `On` dot, `Saved.` |
| `--red` | `#E5675C` | save and load errors |
| `--teal` | `#6FB8AA` | `Reset to defaults`, `Set up email`, `Retry` |
| `--amber` | `#FFB224` | only the sidebar's Needs you count. Nothing on this page is amber |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | `Save choices` |

The grey dot is the `Status` tone `grey` (`--faint`).

Type: Manrope 700 24px (title); IBM Plex Sans 13px body, 500 for moment names and buttons, 600 for the section title, 12px descriptions and footnotes, 11–11.5px labels and heads; IBM Plex Mono for the address and the delay.

## Data this screen needs beyond ticket 37

Ticket 37's `notifications.preferences.get` returns the member's choices per kind and channel with the defaults filled in, and whether mail is on. The picture also shows these; add them to that query or drop the row:

- **The connected tracker's name** (or none), for the Ticket row and the address hint. `organization` already knows its connections (milestone 2).
- **The email delay** in seconds, from the instance setting or `OSTRA_EMAIL_DELAY_SECONDS`.
- **Whether the member's choices were ever saved** and when (the latest `NotificationPreference.updatedAt`), for Last change.
- **Whether the viewer is the instance admin**, for the `Set up email` link (`me` may already carry it).

## Differences from the current code

Checked against `apps/web` on `main` (2026-11-19):

1. **New route and view.** No `account` folder exists under `src/app/(panel)/`. Add `account/notifications/page.tsx` and its view (ticket 45 names the folder).
2. **Member menu.** `components/shell/user-menu.tsx` holds the address, `Change password` and `Sign out`. Add `Account` and `Notifications` above `Change password`, and give the trigger a selected state (`--sel`) on `/account` routes.
3. **New UI piece:** `Tooltip` isn't in `components/ui/` yet. `Checkbox`, `Table` and `Skeleton` exist.
4. **Messages.** New keys under `notifications.*` (the lede, the notice, the moments' names and descriptions, the heads, the footnote, the panel's rows, the states) in `messages/en.json`. The moments' names and descriptions are shared with the `needs-you` page and the mails (ticket 21's templates), so define them once per `kind`.

## Wrong in the image

Build the copy and details in this file, not these:

- The panel is about 355px. Build 300px.
- The panel's group labels (`Your address`, `Channels`, `Mail`, `Last change`) are drawn in `--muted` at about 13px. They're 11px 500 `--faint`, like every panel label.
- The `Mail` group's values sit in a wider key column than `Channels`. One 96px key column for every group.
- `Moments` renders at about 15px and the moment names in 600. The title is 600 13px; the names are 500 13px.
- The table's channel columns are about 113px apart. Build 88px columns.
- The `off` after `Email` is drawn as plain `--faint`. It's `--faint` at 60%, `aria-hidden`.
- The notice's left rule runs a little long and its icon is drawn as a plain envelope with a small mark. Use Lucide `mail-x`.
- The sidebar is drawn, not built: `+ New project` shows only to admins, and `My tasks` isn't a milestone 3 row. Build it from the shared shell for the viewer's role.
- The logo mark is approximate. Use the real Hinge SVG.
- The picture has no loading, saved, failed, mail-on, no-tracker or phone states: they're in the table above.

All visible copy in the image is spelled right.
