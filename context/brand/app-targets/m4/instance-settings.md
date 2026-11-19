# Target: the instance's pages (milestone 4, screen 7)

> **Committed images:** `instance-settings.webp` (Organizations) and `instance-settings-accounts.webp` (Accounts), each downscaled from its 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel.

- **Prompts:** `instance-settings.prompt.txt` (Organizations, generation 1 of 1) and `instance-settings-accounts.prompt.txt` (Accounts: generation 1 from it, then generation 2, an edit of the first that adds the Instance admins section; its prompt follows the first in the file). GPT Image 2.6 through Higgsfield, 3:2, 2k, high. References: the 2048 original of `app-targets/m2/storage-settings` (the screen the spec starts this one from), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`; the Accounts generations also took the Organizations picture first, so the two pages match.
- **Routes (new):** `apps/web/src/app/(panel)/instance/organizations/page.tsx` → `components/instance/organizations-view.tsx`, and `apps/web/src/app/(panel)/instance/accounts/page.tsx` → `components/instance/accounts-view.tsx` (ticket 33 names `src/app/(panel)/instance/`).
- **Features:** F-049 (several organizations: the instance admin creates them, open organization sign-up), F-002 (the instance admin's reset link), F-003 (the last instance admin). Spec section 12, screen 7. ADR 0053 (members, invitations and several organizations), ADR 0026 (open sign-up), ADR 0003 (the reset link's sink). Ticket 24 (`instance.organizations`, `instance.accounts.search`, `instance.grantAdmin`, `instance.revokeAdmin`, the two switches), ticket 22 (`accounts.createResetLink`), ticket 33 (these pages).
- **Status:** a proposed target, waiting on approval (ticket 31's `## Comments`). Ticket 33 builds its data and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with each picture.

## Purpose

The instance admin runs the install: it creates organizations, sets email and storage, and makes reset links when mail is off. These two pages are where it sees the install as a whole:

- **Organizations:** every organization on the install, with its size and nothing of its content, "New organization", and whether any account may create one.
- **Accounts:** every account, found by username or address; a one-time reset link for one; who the instance admins are, with the last one kept; and whether anyone may create an account.

The role grants nothing inside an organization the account isn't in (ADR 0053, Q194), and both pages say so where it matters: an organization the admin isn't in shows its counts and says how to get in, never a link into it.

The pictures show Alex Kim, an instance admin and a member of Acme Corp and Second, with Northwind Labs selected on Organizations, and Sam's reset link just made on Accounts, with mail off on the install.

## The sidebar's Instance group

A new group, `Instance`, under Organization, for the instance admin alone (ticket 33: "The sidebar shows them under 'Instance' to the instance admin alone"). Its rows: `Organizations` (Lucide `building-2`), `Accounts` (Lucide `circle-user-round`), `Storage` (`hard-drive`) and `Email` (`mail`).

**Storage and Email move into it.** Milestones 2 and 3 put them under Organization, but both are the install's settings, for the instance admin (ADR 0050: "Email is set per install"; storage's target: "for instance admins"), and an organization admin who isn't the instance admin otherwise sees two rows under their organization that aren't theirs. Their routes stay (`/organization/storage`, `/organization/email`); only the group changes. An organization admin who isn't the instance admin sees the email page read-only (email-settings' "Read-only, organization admin" state), so Email keeps a row under Organization for them, and only them. The lead confirms this move when approving; if it's refused, Organizations and Accounts alone make the group.

Build the sidebar from `components/shell/sidebar.tsx`, never from the pictures. The pictures' Organization rows (Runners, Models, GitHub, Linear, Agent profiles, Members, Audit log) show milestone 4's sidebar; Spend, Insights and Memory are left out of these two pictures for room.

## Page 1: Organizations (`instance-settings.webp`)

### Layout (CSS px at 1440 wide)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 234px, `--side`, 1px `--line` on its right | the shared sidebar, `Organizations` selected (`--sel`) under `Instance` |
| Top bar | 46px, 1px `--line` below | breadcrumb `Instance › Organizations`; on the right the page's one primary button, `New organization` with Lucide `plus` |
| Page | `1fr`, padding `28px 36px`, content max 760px | title, lede, Organizations, Creating organizations |
| Properties panel | 320px, 1px `--line` on its left, padding `20px 18px` | the selected organization |

The picture draws the panel at about 395px, as every target before it. Build 320px.

### Heading

- Title `Organizations`, Manrope 700, `text-title`. No eyebrow.
- Lede, `text-lede` `--muted`, one line: `Every organization on this install. You see their names and sizes, never their projects or tasks.`

### Organizations

1. **Title line** (`Section`): `Organizations` and the count in Plex Mono `--faint` (`3`).
2. **`Table`,** borderless, 38px rows with `--line` hairlines, header in 12.5px `--faint`. Columns:

| Column | The picture | Rule |
|---|---|---|
| Organization | `Acme Corp` | the name, `--text`. Never a link: the instance admin opens an organization through the switcher, as a member |
| Members | `12` | Plex Mono. Active memberships only (`Member.state = active`) |
| Projects | `4` | Plex Mono |
| Created | `3 Nov` | sans (`formatDay`); a year when it isn't this one (`3 Nov 2025`) |
| Your role | `Admin`, `Member`, or `Not a member` in `--faint` | the signed-in account's role in it |

   Sorted by name. The row is a button: clicking it (or Enter) selects it for the panel, with the `--sel` fill and `aria-selected`, as runners' pools. With nothing picked, the active organization is selected.
3. **Help,** 10px under the rows, 13px `--faint`: `Members count active members. Pending invitations are in each organization's own Members page.`

### Creating organizations

1. **Title** `Creating organizations` (600, `text-ui`), 32px above.
2. **One switch row:** a `Switch` (off in the picture), 10px, the label `Any account can create an organization` (`text-ui` `--text`, a real `<label>`), 10px, the state's hint in `--faint`: off `off: only instance admins can`, on `on: any signed-in account can`.
3. **The setting line,** 10px down, 13px `--faint`: `OSTRA_OPEN_SIGNUP_ORGANIZATIONS sets this for the install and locks the switch. It's unset here.` with the setting name in Plex Mono.

The switch saves at once (no Save button): it's one boolean, and turning it on asks first (below). It's stored as an instance setting; when `OSTRA_OPEN_SIGNUP_ORGANIZATIONS` is set, the setting wins and the switch is locked.

### Properties panel: the selected organization

`PropGroup` with the organization's name as its 12px `--faint` label, then 30px `PropRow`s, key column 130px:

| Key | The picture | Rule |
|---|---|---|
| Created | `12 Nov 2026` | sans, the full date |
| Created by | `Priya Shah` | the account's name; `the first admin's seed` for the first organization; `(removed account)` never happens: accounts aren't deleted |
| Admins | `1` | Plex Mono |
| Members | `5` | Plex Mono, active |
| Invitations | `2 pending` | Plex Mono number; `none` in `--faint` |
| Projects | `2` | Plex Mono |
| Runner pools | `1` | Plex Mono |

Then a `Separator` and a group `Your access`, one paragraph in 13px `--muted`:
- **Not a member** (the picture): `You're not a member of Northwind Labs. The instance admin role opens nothing inside it. Ask one of its admins to invite you.`
- **A member:** `You're an admin of Acme Corp.` (or `a member of`), then, when it isn't the active organization, a teal text button `Switch to Acme Corp`, which runs `organizations.switch` and goes to Home.

Counts only: no project names, no member names other than the creator, no runner names (ticket 24: "no content of any").

### New organization

`New organization` opens the create sheet that `org-switcher` (screen 6) defines, the same component: a `Sheet` from the right (380px, a form), one field `Name` (required, at most 64 characters, unique on the install: `An organization with that name exists.`), buttons `Cancel` and primary `Create organization`. On success it calls `organizations.create`, which makes the creator its admin with a default pool and the built-in agent profile, and switches to it, as the switcher does, with the "Switched to <name>" notice. The new organization's row appears here on the way back.

## Page 2: Accounts (`instance-settings-accounts.webp`)

### Layout

The same frame as Organizations: breadcrumb `Instance › Accounts`, **no primary button** (accounts come by invitation, or by sign-up when it's open; the instance admin never makes one here), the page column, the 320px panel holding the selected account.

### Heading

- Title `Accounts`.
- Lede, one line: `Every account on this install, in any organization. Make a reset link, or choose who runs the install.`

### Search

An `Input` 320px wide, 34px, Lucide `search` 14px inside its left edge, placeholder `Search by username or address`, `type="search"`, 20px under the lede. It filters as the admin types (debounced 200ms) through `instance.accounts.search`, which matches a prefix of the username, the address or the name, case-insensitive. The query lives in the URL (`?q=`). Escape clears it.

### Accounts

1. **Title line:** `Accounts` and the count in Plex Mono `--faint`: every account with no query, the matches with one.
2. **`Table`,** 38px rows. Columns:

| Column | The picture | Rule |
|---|---|---|
| Name | `Alex Kim` and a `Chip` `instance admin` | the account's name in `--text`; the chip (grey, outlined, never amber) for an instance admin |
| Username | `alex` | Plex Mono `--muted` |
| Address | `alex@acme.dev` | `--muted`. An address not verified yet gets a `--faint` ` · not verified` after it |
| Organizations | `Acme Corp, Second` | `--muted`, the active memberships' names, joined; past two, `Acme Corp, +2`; none: `none` in `--faint` |
| Last signed in | `now`, `2h ago`, `never` in `--faint` | `--muted`, relative (`formatAge`) |

   Sorted by name, paged by 50 with keyset pagination (`Show more` under the table, a ghost button) when there are more. The row is a button that selects the account for the panel, as on Organizations. With nothing picked, nothing is selected and the panel reads `Select an account to see it, make a reset link or make it an instance admin.` in 13px `--muted`.

### Instance admins

1. **Title line,** 32px above: `Instance admins` and the count.
2. **Rows,** 38px, at the Accounts table's column positions: the name (`Alex Kim` and ` (you)` in `--faint`), the address in `--muted`, `since 3 Nov` in `--muted` (from the grant's audit entry; the first admin's is the install's creation), and at the right a ghost `Remove` in `--muted` on every row but the signed-in admin's own when they're the last one.
3. **Help,** 10px down, 13px `--faint`: `Instance admins create organizations and set email and storage. The role opens nothing inside an organization they're not in, and the last one can't give it up.`

`Remove` asks first: an `AlertDialog`, title `Remove Priya Shah as an instance admin?`, body `Priya keeps every organization membership. Only the instance's pages and settings close.`, buttons `Cancel` and `Remove` (destructive, `--red` text on `--surface`). It calls `instance.revokeAdmin`. Removing yourself is allowed while another admin exists: the dialog's body adds `You'll lose these pages at once.`, and on success the panel goes to Home.

### Sign-up

1. **Title** `Sign-up`, 32px above.
2. **One switch row:** `Switch` (off in the picture), the label `Anyone can create an account`, the hint off `off: accounts come by invitation`, on `on: the sign-in page offers sign-up`.
3. **The setting line:** `OSTRA_OPEN_SIGNUP_ACCOUNTS sets this for the install and locks the switch. It's unset here.`

### Properties panel: the selected account

`PropGroup` with the account's name as its label, 30px rows, key column 130px:

| Key | The picture | Rule |
|---|---|---|
| Username | `sam` | Plex Mono |
| Address | `sam@acme.dev` | sans (the picture draws it in mono) |
| Verified | `Yes` | `Yes`, or `Not yet` in `--muted` |
| Organizations | `Acme Corp` | sans, one per line when there are several |
| Created | `18 Nov` | sans |
| Last signed in | `2h ago` | sans |

Then `Separator` and the **Reset link** group:

- **Before one is made:** a secondary `Button size="sm"` with Lucide `key-round`: `Create reset link`, and under it 12px `--faint`: `A link that sets a new password. It works once, for 24 hours, and signs Sam out everywhere else.` (the hours from `OSTRA_RESET_LINK_HOURS`).
- **Just made** (the picture): a `Code` box the panel's width holding the link in Plex Mono, one line, truncated in the middle with `…` (the full link is what `Copy` copies and what a screen reader reads), and a teal `Copy` at its right (`Copied` for 1.5s). Under it, 12px `--muted`: `Shown once. Works once, for 24 hours.` The link is held in the component's state only: never fetched again, never in the URL, gone when another account is selected or the page reloads. Making another revokes the earlier one (ticket 22's grant), so the button comes back as `Create another link` with the line `The link made earlier stops working.`
- **The mail line,** 12px `--faint`, under either: with mail off (the picture) `Mail is off on this install, so Sam can't reset by mail.`; with mail on and a verified address, `Sam can also reset by mail from the sign-in page.`; with mail on and no verified address, `Sam's address isn't verified, so a reset by mail can't reach it.`
- The instance admin's own account: no reset link (`Change your password from your account.` with a teal link to `/account`), since a link for oneself is the account page's job.

Then `Separator` and the **Instance admin** group:
- Not one (the picture): 13px `--muted` `Sam isn't an instance admin.`, then a secondary `Button size="sm"` with Lucide `shield`: `Make instance admin`. It asks first: `AlertDialog`, title `Make Sam Rivera an instance admin?`, body `Sam will create organizations, set email and storage, and make reset links for any account. It opens nothing inside an organization Sam isn't in.`, buttons `Cancel` and `Make instance admin` (primary). It calls `instance.grantAdmin`.
- One already: `Instance admin since 12 Nov.` and the `Remove` of the list above, with the same dialog.

## States and copy

| State | What changes |
|---|---|
| Loading | the table rows are 38px hairline rows with `Skeleton` bars where values go; the switches disabled; the panel's values `Skeleton` bars |
| One organization (a fresh install) | one row; its panel reads `You're an admin of <name>.` |
| Turning a switch on | an `AlertDialog` first. Organizations: title `Let any account create an organization?`, body `Anyone with an account can make their own organization and invite people to it. You can turn this off again; organizations made meanwhile stay.`, buttons `Cancel` and `Turn on`. Accounts: title `Let anyone create an account?`, body `The sign-in page offers sign-up to anyone who can reach this install. An account sees nothing until it's in an organization.`, buttons `Cancel` and `Turn on`. Turning off asks nothing |
| Switch saved | the switch moves; under the setting line, `role="status"`, 13px `--green` with `check`: `Saved.` for 3 seconds |
| Locked by the setting | `OSTRA_OPEN_SIGNUP_ORGANIZATIONS` (or `_ACCOUNTS`) is set: the switch shows its value, disabled, with Lucide `lock` 13px before the setting line, which reads `Set by OSTRA_OPEN_SIGNUP_ORGANIZATIONS on this install. Change it there and restart ostra.` |
| No match | the search finds nothing: one row in `--muted`, `No account matches "sam r".` The count reads `0` |
| Reset link failed | under the button, `role="alert"`, 13px `--red`: the error text (`errorText`) |
| The last instance admin | the signed-in admin is the only one: no `Remove` on their row, and the help line ends `…and the last one can't give it up.` as drawn. A refused revoke (a race) shows the API's error under the list, `role="alert"` |
| Not the instance admin | the `Instance` group isn't in the sidebar; a direct URL shows `AdminOnly` with the instance wording: `Only the instance admin can open this.` |
| Load failed | the error alert in place of the table |
| Narrow (below 1280px) | the panel drops under the page (`PageFrame`); below 640px the table scrolls sideways inside its section with the first column fixed, and the search input takes the full width |

The two pages hold no decorative area, so no illustration: an empty list is never possible here (the instance admin's own organization and account always exist).

## Components (shadcn/ui names)

`Sidebar` (existing, plus the Instance group), `PageFrame` with `Breadcrumb` and `properties`, `PageHeading`, `Section`, `Table` (selectable rows, as runners' pools), `PropGroup` / `PropRow` (with storage's `labelWidth`), `Button` (default = the Shell primary; `variant="secondary"` `size="sm"` in the panel; `variant="ghost"` for `Remove` and `Show more`), `Input`, `Switch`, `Label`, `Chip`, `Code` (the shown-once box, as runners' join token), `AlertDialog`, `Sheet` (the create sheet, shared with `org-switcher`), `Separator`, `Skeleton`. Lucide 15px, stroke 1.75: `building-2`, `circle-user-round`, `plus`, `search`, `key-round`, `shield`, `lock`, `check`.

## Tokens

> **Scale.** The panel is built at the approved pictures' scale, which wins on size, spacing and contrast: body 14.5px, dense rows 14px, secondary 13px, small 12px, title 26px, buttons 30px, a 46px top bar and a 320px properties panel (380px with a form). The measured values are in `../m1/README.md`, "Scale".

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page, panel |
| `--side` | `#0A0B0C` | sidebar |
| `--surface` | `#131416` | the search input, the code box, the switch's off track, skeletons |
| `--sel` | `#1A1B1E` | the selected row, the selected nav row |
| `--line` | `#1F2023` | row hairlines, panel edge, group lines |
| `--line-2` | `#2A2C30` | input, button and chip borders, the switch's track border |
| `--text` | `#F2F3F4` | names, values, switch labels |
| `--muted` | `#B4B7BB` | keys, the lede, table values, the access paragraph |
| `--faint` | `#8B8E93` | counts, headers, hints, help, `Not a member`, `never` |
| `--green` | `#4FB286` | `Saved.` only |
| `--red` | `#E5675C` | errors, the destructive `Remove` in its dialog |
| `--teal` | `#6FB8AA` | `Copy`, `Switch to …` |
| `--amber` | `#FFB224` | only the sidebar's Needs you count. Nothing on these pages is amber |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | `New organization`, the dialogs' confirm buttons, the switch's on track |

Type: Manrope 700 for the titles; IBM Plex Sans for everything else (600 for section titles, 500 for buttons); IBM Plex Mono for counts, usernames, the reset link and setting names.

## Data these pages need beyond tickets 22 and 24

Ticket 24's `instance.organizations` returns each organization's name and its counts of members and projects; `instance.accounts.search` finds accounts. The pictures also show these; add them to those queries or drop the row:

- **Per organization:** its creation time and creator's name (`Organization.createdByUserId`, spec 5.3), the admin count, pending invitations, pools, and the caller's own role in it.
- **Per account:** its name, verified flag, active organizations' names, creation time, last sign-in (the latest session's `createdAt`), and whether it's an instance admin with the grant's time.
- **The switches' state:** each switch's saved value, and whether its setting is set (and so locks it). Ticket 24 names "the two open sign-up switches"; this target reads them as instance settings overridden by the env settings, as email's are.
- **Mail on or off,** for the reset link's mail line (`email.status`, milestone 3).

## Differences from the current code

Checked against `apps/web` on `main` (2026-11-19):

1. **New routes and views.** Nothing exists under `app/(panel)/instance/`: add both pages, `components/instance/`, and `messages/en.json` keys under `instance.*`.
2. **Sidebar.** `components/shell/sidebar.tsx` has Home, Projects and Organization (Runners, Models, GitHub). Add the `Instance` group for the instance admin, after Organization; move Storage and Email into it when milestones 2 and 3's rows land (above).
3. **`AdminOnly`** needs an instance wording (`Only the instance admin can open this.`), as storage's and email's targets also ask.
4. **The shown-once `Code` box** exists for runners' join tokens; reuse it for the reset link, with middle truncation.
5. **`Switch`, `Table`, `AlertDialog`, `Sheet`, `Skeleton`** exist in `components/ui/`. `PropRow`'s `labelWidth` comes with storage's target; reuse it.

## Wrong in the image

Build the copy and details in this file, not these:

- The sidebar is about 235px and the panel about 395px. Build 234px and 320px.
- Organizations: the panel's label `Northwind Labs` has `Labs` underlined. It's plain `--faint` text. The panel's keys drift right down the column; they share one left edge.
- Organizations: the panel's `Created`, `Admins` and other values are drawn in mono, `12 Nov 2026` included. Dates are sans; only the numbers are mono.
- Accounts: the panel's `Address`, `Organizations`, `Created` and `Last signed in` are drawn in mono. They're sans; only `Username` is mono.
- Accounts: the table's Organizations column is drawn in `--text`. It's `--muted`, like Address.
- Accounts: the search input is about 360×34px. Build 320×34px.
- The section titles (`Organizations`, `Creating organizations`, `Accounts`, `Instance admins`, `Sign-up`) are drawn a step bolder and larger than the rows. They're 600 at `text-ui`, as on every page.
- Neither picture has the loading, locked, saved, no-match, dialog or narrow states: they're in the table above.

All visible copy in the images is spelled right.
