# Target: Account (milestone 3, screen 13)

> **Committed image:** `account.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel.

- **Prompt:** `account.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation. References: `app-targets/m1/runners.png` (the approved page this one starts from, spec section 12), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route (new):** `apps/web/src/app/(panel)/account/page.tsx` → `components/account/account-view.tsx`. Reached from the member menu at the foot of the sidebar (`components/shell/user-menu.tsx`), never from a nav row.
- **Features:** F-119 (the verified GitHub link), F-103 (`ostra login`: CLI sessions, listed and revocable). Spec section 12, screen 13. Ticket 39 (`account.github.get` / `.unlink`, `/api/github/link/start` and `/callback`, `account.cliSessions.list` / `.revoke`), ticket 47 (this screen), ticket 33 (the CLI). ADR 0051 (a CLI session), ADR 0052 (the verified link).
- **Status:** a proposed target, waiting on approval (ticket 41's `## Comments`). Ticket 47 builds its data and tests until then, not its UI.

> Build it in real HTML/React (app-design.md, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

A member's own page: what ostra knows about them and which credentials of theirs exist. It answers two questions, in this order:

1. **Is my GitHub account linked, and as whom?** The link is what lets `@ostra` on a pull request reach the agent (ADR 0041) and what credits the member as co-author (ADR 0052). Link, see the login, unlink.
2. **Which machines can run `ostra checkout` as me?** Each `ostra login` is a CLI session: listed with its machine, when it was made, when it was last used and when it expires, and revocable.

Every member sees the same page, about themselves only. There's no admin view of another member's account here.

The picture shows Alex, linked to GitHub as `@alexkim`, with two CLI sessions.

## Layout (CSS px at 1440 wide)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 232px, `--side`, 1px `--line` on its right | the shared sidebar, built from `components/shell/sidebar.tsx`, never from the picture. No nav row is selected; the member row at the foot (the `UserMenu` trigger) has the `--sel` fill while this page is open |
| Top bar | 44px, 1px `--line` below | breadcrumb with one item, `Account`. No button: every action on this page sits on its row |
| Page | `1fr`, padding `28px 40px`, content max 760px | title, lede, GitHub, CLI sessions |
| Properties panel | **300px** (the default: no form in it), 1px `--line` on its left, padding `20px 18px` | You, GitHub link, CLI sessions |

The picture draws the sidebar at about 238px and the panel at about 340px. Build 232px and 300px.

### Heading

- Title `Account`, Manrope 700 24px, letter-spacing −0.015em. No eyebrow.
- Lede, 13.5px `--muted`, one line: `Your GitHub account, and the machines where you ran ostra login. Only you see this page.`

### GitHub

1. **Title line** (`Section`): `GitHub`, inline note `for co-author credit, and for @ostra on a pull request` (12.5px `--muted`).
2. **One row,** 48px, a 1px `--line` hairline above and below, no box:
   - Lucide `github` 15px `--text` (the brand mark from the GitHub page's own icon, the same one the sidebar uses).
   - `@alexkim`: Plex Mono 13px `--text`, 16px after the icon, in a 180px slot.
   - The state: a 7px dot with its halo and a word, 13px. Linked: `--green` dot, `Linked` in `--muted`.
   - Plex Mono 12.5px `--faint`: `ID 5829104 · 12 Nov`: the GitHub user ID and the day it was linked (`githubLinkedAt`, `formatDay`).
   - At the right: a ghost `Button` (24px, `--muted` text, no border, `--text` on hover): `Unlink`.
3. **Help,** 10px under the row, 12.5px `--faint`, max 720px, two lines:
   - `ostra kept your GitHub login and ID, and revoked the sign-in token at once.`
   - `Commits from your tasks credit 5829104+alexkim@users.noreply.github.com.` The address in Plex Mono, `--muted`. It's built as `<id>+<login>@users.noreply.github.com` (ADR 0052).

### CLI sessions

1. **Title line,** 30px above: `CLI sessions`, the count in Plex Mono 12px `--faint` (`2`), inline note `made by ostra login, valid for 30 days`. The number is `OSTRA_CLI_SESSION_DAYS` (default 30), never a constant in the copy.
2. **Table** (`Table`), no box. Header row 30px, 11.5px `--faint`, weight 500, 1px `--line` under it. Body rows 40px, 1px `--line` under each.

| Column | Width | Contents |
|---|---|---|
| Machine | flex | Lucide `terminal` 15px `--faint`, then the machine's name in Plex Mono 13px `--text` (`alex-mbp`, `alex-wsl`): the name the CLI sent (`CliSession.name`), truncated with an ellipsis and a `title` |
| Created | 130px | Plex Mono 12.5px `--muted`: `12 Nov` |
| Last used | 130px | 13px `--muted`, relative (`formatAge`): `4 min ago`, `2d ago`; `never` in `--faint` |
| Expires | 130px | Plex Mono 12.5px `--muted`: `12 Dec`. Within 3 days: `in 2 days` in `--text` (never amber or red: nothing is wrong yet) |
| Revoke | 80px, right | ghost `Button`, 24px, `--muted`: `Revoke` |

   Revoked and expired sessions aren't listed.
3. **Sign in another machine,** 12px under the table, 12.5px `--muted`: `Sign in another machine: run this, then approve the code it prints.`
4. **The command:** a one-line code box (`.code`: `--surface`, 1px `--line-2`, 7px radius, 40px tall, padding `0 16px`), Plex Mono 13px: the CLI's login line with the panel's address (`OSTRA_PUBLIC_URL`). At its right end a teal `Copy` text button (`Copied` for 1.5s). The invocation is the same helper the Runners page uses for its connect command (see "Differences from the current code").
5. **Footnote,** 10px down, Lucide `shield` 13px `--faint`, then 12px `--faint`: `A CLI session reads only a task's branches and clone URLs. Git uses your own access: ostra hands out no token.` (ADR 0051.)

### Properties panel

`PropGroup`s with an 11px 500 `--faint` label, 30px `PropRow`s (key column 96px, 12.5px; key `--muted`, value `--text`). Values are Plex Sans unless the row says mono.

1. **You** (always):
   - `Name` · `Alex Kim`
   - `Email` · `alex@acme.dev` (Plex Mono)
   - `Role` · `Admin of Acme Corp` (`Member of Acme Corp`): the role in the organization the panel has open
   - `Password` · a teal `Change` link, no underline, to `/change-password`. This is the page's permanent way to a new password: the member menu shows its item only while the default password stands.
2. **GitHub link** (only while linked):
   - `Login` · `@alexkim` (mono)
   - `Linked` · `12 Nov` (mono)
   - `Token` · `Revoked at link time`
3. **CLI sessions:**
   - `Active` · `2` (mono)
   - `Valid for` · `30 days` (from `OSTRA_CLI_SESSION_DAYS`)
   - `Can read` · `Branches and clone URLs`

## States and copy

### GitHub

| State | What it shows |
|---|---|
| Linked (the picture) | as above |
| Not linked | the row: Lucide `github` 15px `--faint`, `Not linked` in 13px `--muted`, and at the right a secondary `Button` (26px, 1px `--line-2`, `--text`) `Link GitHub account`, which navigates to `/api/github/link/start`. The help reads: `Link the GitHub account you work with. ostra keeps only your login and ID, and revokes the sign-in token at once. Until then, commits from your tasks credit your ostra name and email, and @ostra from your GitHub account isn't answered.` The panel has no GitHub link group |
| Back from GitHub, linked | under the help, `role="status"`, 12.5px `--green` with Lucide `check`: `Linked as @alexkim.` (from `?github=linked`; the query is cleared from the URL after it's read) |
| Back from GitHub, taken | `role="alert"`, 12.5px `--red`: `That GitHub account is linked to another ostra account. Unlink it there first.` (`?github=taken`) |
| Back from GitHub, revoke failed | `role="alert"`, `--red`: `GitHub didn't confirm the token was revoked, so ostra stored nothing. Try again.` (ADR 0052: a failed revocation stores nothing and says so; `?github=revoke-failed`) |
| Back from GitHub, cancelled or expired | `role="alert"`, `--red`: `The link didn't finish. Nothing was stored.` (`?github=failed`: a denied consent, a `state` older than 10 minutes or bound to another session) |
| GitHub not connected to the install | the row shows `GitHub isn't connected to this install yet.` in `--muted`, no button. An organization admin gets a teal link at the right, `Connect GitHub`, to `/organization/github`; a member gets the help `Ask an admin to connect GitHub.` |
| Unlink | `Unlink` opens an `AlertDialog`: title `Unlink @alexkim?`, body `@ostra from this GitHub account stops reaching the agent, and new commits credit your ostra name and email. You can link again at any time.`, buttons `Cancel` and `Unlink` (destructive: `--red` text on `--surface`). While it runs the button reads `Unlinking…`, disabled. On success the dialog closes and the row shows the not-linked state with the status line `Unlinked.` (`--muted`, `check`) |
| Unlink failed | in the dialog, above its buttons, `role="alert"`, 12.5px `--red`: the error text (`errorText`) |

### CLI sessions

| State | What it shows |
|---|---|
| Sessions (the picture) | the table |
| None | no table: one 40px row with hairlines, 13px `--faint`: `No CLI sessions. Run the line below on a machine to start one.` The line above the code box reads `Sign in a machine: run this, then approve the code it prints.` The section count is `0` |
| A new session | the list polls every 15s while the page is open, so a code just approved on the device page appears without a reload. No toast |
| Revoke | `Revoke` opens an `AlertDialog`: title `Revoke the CLI session on alex-mbp?`, body `ostra checkout on that machine stops working until it runs ostra login again.`, buttons `Cancel` and `Revoke` (destructive). On success the row leaves, and under the table `role="status"`, 12.5px `--muted` with `check`: `Revoked.` |
| Revoke failed | in the dialog, `role="alert"`, `--red`: the error text |
| A machine with no name | the CLI didn't send one: `Unnamed machine` in `--faint` (sans) |

### The page

| State | What changes |
|---|---|
| Loading | the GitHub row and two table rows render at their heights with `Skeleton` bars (120px, 80px) where values go; the panel's values are skeletons |
| Load failed | one `role="alert"` line in `--red` (`errorText`) in place of both sections |
| Narrow (below 1280px) | the panel drops under the page (`PageFrame`). Below 640px the GitHub row wraps: login and state on the first line, `ID … · …` under it, `Unlink` stays at the right of the first line; the table keeps Machine, Last used and Revoke, and moves Created and Expires into a faint second line under the machine name |

## Components (shadcn/ui names)

`Sidebar` (existing; `UserMenu` gains an `Account` item, Lucide `user-round`, above `Change password`), `PageFrame` with `Breadcrumb` and `properties`, `PageHeading`, `Section`, `PropGroup` / `PropRow`, `Table` / `TableHeader` / `TableRow` / `TableHead` / `TableCell`, `Button` (`ghost` for Unlink and Revoke, `outline`/secondary for Link GitHub account, `link` for Copy and Change), `AlertDialog` (from milestone 2), `Skeleton`, the `Status` dot (`ui/status.tsx`). Lucide 15px, stroke 1.75: `github`, `terminal`, `shield`, `check`, `user-round`.

## Tokens (`app-concepts/html/graphite.css`)

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page, panel |
| `--side` | `#0A0B0C` | sidebar |
| `--surface` | `#131416` | the code box, skeletons, destructive button fill |
| `--line` | `#1F2023` | row hairlines, panel edge, group lines |
| `--line-2` | `#2A2C30` | the code box's border, the secondary button's border |
| `--text` | `#EDEDEE` | login, machine names, values, titles |
| `--muted` | `#9A9DA3` | lede, notes, keys, dates, ghost buttons |
| `--faint` | `#64676D` | help, footnote, table headers, icons, the ID line |
| `--sel` | `#1A1B1E` | the member row at the sidebar's foot |
| `--green` | `#4FB286` | the `Linked` dot (halo `rgba(79,178,134,0.15)`), `Linked as …` |
| `--red` | `#E5675C` | errors, the destructive dialog buttons |
| `--teal` | `#6FB8AA` | `Copy`, `Change`, `Connect GitHub` |
| `--amber` | `#FFB224` | only the sidebar's Needs you count. Nothing on this page is amber |

Type: Manrope 700 24px (title); IBM Plex Sans 13px body, 12.5px secondary, 11–11.5px labels and headers, 600 for section titles, 500 for buttons; IBM Plex Mono for the login, the ID line, the no-reply address, machine names, dates in the table, the command and the email.

## Data this screen needs beyond ticket 39

- `account.cliSessions.list` returns machine name, created and last used (ticket 39). The table also needs **`expiresAt`**, and the panel and the section note need the **session length** (`OSTRA_CLI_SESSION_DAYS`). Add both to the list's output.
- `account.github.get` returns the login; the row also shows the **GitHub user ID** and **`githubLinkedAt`**, both stored by ticket 39.
- The command needs the panel's **public URL** (`OSTRA_PUBLIC_URL`, already read by the device flow).
- Whether **GitHub is connected to the install** (milestone 1's `github` status query) decides the not-connected row.

## Differences from the current code

Checked against `apps/web` on `main` (2026-11-19):

1. **New route and view.** No `/account` exists: add `src/app/(panel)/account/page.tsx` and `components/account/account-view.tsx` (ticket 47).
2. **Member menu.** `components/shell/user-menu.tsx` has only `Change password` (while the default password stands) and `Sign out`. Add `Account` first, and give the trigger the `--sel` fill on `/account`.
3. **The login line.** The CLI isn't on npm before milestone 7 (ADR 0046), so the Runners page tells a member to run `pnpm ostra runner --server …` in a clone of ostra. The picture prints `ostra login --server https://ostra.acme.dev`. Build the line with the same helper and the same prefix the Runners page uses, so the two always agree; when the package ships, both drop the prefix together. If the prefix stays, the line above the box reads `Sign in another machine: run this in a clone of ostra, then approve the code it prints.`
4. **The device page** names a CLI session's purpose (`m1/device` grows, ticket 47): `Sign in the ostra CLI on alex-mbp`. Not on this screen, but the two are tested together (ticket 47's Playwright run).
5. **Messages.** New keys under `account.*` in `messages/en.json`.
6. **`AlertDialog`** isn't in `components/ui/` yet. Milestone 2's storage screen adds it (`m2/storage-settings.md`); reuse that one, or add it if it hasn't landed (`radix-ui` is already a dependency).
7. **Sidebar flavour.** The picture shows `My tasks` and `Agent profiles`. `Agent profiles` comes with ticket 42; `My tasks` is in the sidebar only if the shell has it when this is built.

## Wrong in the image

Build the copy and details in this file, not these:

- The sidebar is about 238px and the panel about 340px. Build 232px and 300px.
- The panel's values (`Alex Kim`, `Admin of Acme Corp`, `Revoked at link time`, `Branches and clone URLs`, `30 days`) are drawn in mono. They're Plex Sans; only `Email`, `Login`, `Linked` and `Active` are mono.
- `Last used` values are drawn in mono. They're sans (`formatAge`), as on the Runners page.
- The `Linear` icon is a half-filled circle. Use the icon milestone 2's Linear screen settled on.
- The no-reply address mixes a muted ID with a bright `+alexkim@…`. It's one run of Plex Mono in `--muted`.
- The `shield` in the footnote is drawn with a mark inside. Use plain Lucide `shield`.
- The command reads `ostra login`: see "Differences from the current code", item 3.
- The picture has no not-linked, error, empty, dialog, loading or narrow states: they're in the tables above.

All visible copy in the image is spelled right.
