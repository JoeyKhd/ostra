# Target: members (milestone 4, screen 1)

> **Committed image:** `members.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel.

- **Prompt:** `members.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 2 generations: the first drew the page, the second (kept) edits it to line the invitation rows up with the members table and set the panel's values in sans. References: `app-targets/m1/runners.png` (the screen this one starts from, spec section 12), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route (new):** `apps/web/src/app/(panel)/organization/members/page.tsx` → `components/members/members-view.tsx`. The invite sheet is the next target, `member-invite.md`.
- **Features:** F-002 (invitations, removal), F-003 (organization roles). Spec section 12, screen 1. Ticket 22 (`members.invite`, `.revokeInvitation`, `.invitations`), ticket 23 (`members.list`, `.setRole`, `.remove`), ticket 32 (this screen).
- **Status:** a proposed target, waiting on approval (ticket 31's `## Comments`). Ticket 32 builds its data and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

Who belongs to the organization, and who is about to. An organization admin sees every active member with their role, the projects they can open and when they were last active; changes a role or removes someone from the row's menu; sees the invitations still waiting, copies a link just made or revokes one; and finds the people who were removed, folded away. A member who isn't an admin sees who else is here, and nothing they could act on.

The picture shows an admin, Alex Kim, with five members (two admins), Sam Rivera selected with the row menu open, two pending invitations (one made a moment ago, so its link can still be copied) and one removed member, folded.

## Layout (CSS px at 1440 wide)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 234px, `--side`, 1px `--line` on its right | the shared sidebar (`components/shell/sidebar.tsx`). Organization gains **Members** (Lucide `users`), selected (`--sel`, `--text`), shown to **every member** (ticket 32). Build it from the shell, not the picture |
| Top bar | 46px, 1px `--line` below | breadcrumb `Acme Corp › Members` (`Members` in `--text` 500). Right, admins only: **Invite** with a `plus` icon, the page's one primary button (Shell fill, Abyss text). It opens the invite sheet (`member-invite.md`) |
| Page | `1fr`, padding `28px 36px` | title, lede, then the sections **Members**, **Invitations** and **Removed**, 26px apart |
| Properties panel | **320px**, 1px `--line` on its left, padding `20px 18px` | the selected member. Admins only; a member's page is `content.full` |

### Heading

- Title **Members**, Manrope 700 26px, letter-spacing −0.015em.
- Lede, 15px `--muted`, one line:
  - admin: `Who belongs to {organization}. {n} members, {admins} of them admins, and {pending} invitations waiting.` Picture: `Who belongs to Acme Corp. 5 members, 2 of them admins, and 2 invitations waiting.` With no pending invitation the tail goes: `…, 2 of them admins.` One of each: `1 member`, `1 of them an admin`, `1 invitation waiting`.
  - member: `Who belongs to {organization}.`

### Members section

- Section head: **Members** (Plex Sans 600) and the count `5` (Plex Mono `--faint`): the active members, and those waiting on their address check.
- A `Table` with no box, as Runners' and Agent profiles' tables. Header row 30px, labels Plex Sans 500 12.5px `--faint`. Body rows **44px** (the picture's; a row holds an avatar), a 1px `--line` hairline under each.
- Order: admins first, then by name.

| Column | Width | Contents |
|---|---|---|
| Member | ~290px | a 26px round avatar (initials, Plex Sans 600 11px, `--raise` fill), 10px gap, the name in `--text`, then for the viewer's own row an outline chip `you` (12px `--muted`, 22px tall, 1px `--line-2`, radius 6px), then 12px later the address in Plex Mono 13px `--faint`, truncated. **Admins only see addresses**; a member's view has none (as `organization.members` does today) |
| Role | 86px | `Admin` or `Member`, `--text` |
| Projects | flex | admins: `All projects` in `--muted`. Members: the projects they can open, by name, comma-separated, one line, truncated, then `+N` in `--faint`; the full list in a `Tooltip`. **Only projects the viewer can open are named**: a restricted project the viewer isn't listed on is never shown, not even as a count |
| Last active | 110px | `now` (under 2 minutes), `14m ago`, `2h ago`, `3d ago`, then the date `12 Nov`; Plex Mono 13px `--faint`. A membership waiting on its address check reads `Waiting on the address check` in Plex Sans `--faint` |
| (menu) | 40px | admins only: a 28px ghost icon button, Lucide `ellipsis` 15px `--faint`, `aria-label` `Actions for {name}`. Pressed or open: `--surface` fill and a 1px `--line-2` border |

- The whole row is the click target for the selection (`aria-pressed`, `--sel` fill; hover `--raise`). The selection is in the URL (`?member=<id>`). With nothing picked, the viewer's own row is selected.
- **The row menu** (`DropdownMenu`, `align="end"`, 220px, `--surface`, 1px `--line-2`, radius 8px, the popover's soft shadow): a label `Role` (12px `--faint`), the items `Admin` and `Member` as a `DropdownMenuRadioGroup` with a check on the current one, a separator, then `Remove from {organization}` in `--red` with Lucide `user-minus`.
  - Picking the other role calls `members.setRole` at once (no dialog: it's undone the same way). While it runs the row's Role cell shows the new value at 60% opacity.
  - **The last admin:** on the only admin's row, `Member` and `Remove from {organization}` are disabled, with a `Tooltip`: `{organization} needs at least one admin.` A `CONFLICT` from the server (two admins demoted at once) shows the same sentence as the error line.
  - **The viewer's own row:** the menu offers the role only (an admin can make themselves a member while another admin exists). Removing yourself, or leaving, isn't on this page (open point below).
  - A membership waiting on its address check: the menu has only `Remove from {organization}`; its role shows, and changes once it's active.
- **Removing** asks first: an `AlertDialog`.
  - Title: `Remove {name} from {organization}?`
  - Body, `--muted`: `Their account stays, and the history keeps their name with "(removed)". At once:` then a list, each line only when its count isn't zero (ADR 0053's transaction):
    - `They lose access to {organization} and its projects.`
    - `{n} personal runner(s) revoked.`
    - `{n} CLI session(s) signed out.`
    - `They stop driving {n} task(s). Their needs-you items go to each project's members.`
    - `Their draft diff comments are deleted.`
    - `{n} invitation(s) they sent revoked.`
  - Buttons `Cancel` and `Remove {name}` (destructive: `--red` text on `--surface`, 1px `--line-2`). While it runs: `Removing…`, both disabled. On success the row leaves the list and the Removed count grows; the panel selects the viewer's own row.

### Invitations section (admins)

- Section head **Invitations** and the count of pending ones (`2`). Hidden for members. With none pending and none past: the section shows one `--faint` line, `No invitation is waiting. Invite someone with Invite.`
- Pending invitations as 44px hairline rows on **the same column grid as the table above**:
  - Member column: Lucide `mail` 15px `--faint` in the avatar's place, then the address in Plex Mono 13px `--text`.
  - Role: `Member` / `Admin`.
  - Projects: the restricted projects it grants, by name (`vault`), or `All projects` for an admin; an invitation that grants none reads `Open projects` in `--muted`.
  - Last active column: `expires in 7 days`, `expires in 2 days`, `expires today`, in Plex Sans `--faint`.
  - At the right: `Copy link` (teal link button) and `Revoke` (`--muted` ghost).
- **`Copy link` shows only while the page still holds the link.** `members.invite` returns the link once and no later read returns it (ticket 22, ADR 0053). So the row of an invitation made in this tab, before a reload, has `Copy link` (`Copied` for 1.5s); every other pending row has only `Revoke`. In the picture, `jordan@acme.dev` was invited a moment ago and `mira@acme.dev` two days ago. To give someone a fresh link: revoke, then invite again.
- **Revoke** asks first: `AlertDialog`, title `Revoke the invitation for {address}?`, body `The link stops working at once. You can invite them again.`, buttons `Cancel` and `Revoke` (destructive). The row leaves the pending list.
- **Past invitations:** under the rows, a ghost toggle (24px, `--muted` 13px, `chevron-right`, `chevron-down` open): `Show 3 past invitations` / `Hide past invitations`. Open, the last 20 accepted, revoked and expired invitations follow on the same grid, all in `--muted`, with no actions; the last column reads `accepted 18 Nov by Sam Rivera`, `revoked 16 Nov`, `expired 10 Nov`. Hidden when there are none.

### Removed (admins)

- A collapsed fold: `chevron-right` 15px `--faint`, the section head **Removed** in `--muted` 600, the count in Plex Mono `--faint`. The whole line is the toggle (`aria-expanded`). Hidden when nobody was removed.
- Open: rows on the same grid. The avatar at 50% opacity, the name in `--muted` with ` (removed)`, the address in `--faint`; Role and Projects empty; the last column `removed 14 Nov by Alex Kim` in `--faint`. No menu: someone removed comes back through a new invitation (ADR 0053), and the old membership stays removed.

### Properties panel: the selected member (admins)

`PropGroup`s with a 12px 500 `--faint` label, 30px `PropRow`s with a **96px** key column, 14px; a 1px `--line` between groups.

1. Eyebrow `Member` (12px 500 `--faint`); title row: a 36px avatar, then the name (Plex Sans 600 17px) and under it the address in Plex Mono 13px `--muted`.
2. **Organization:** `Role` · `Member`; `Joined` · `12 Nov`; `Invited by` · `Alex Kim` (`—` for the first admin); `Last active` · `14m ago` (Plex Mono). A membership waiting on its check adds `Address` · `Not checked yet` in `--faint`.
3. **Projects** with the count in Plex Mono `--faint`: one 30px row per project they can open (only projects the viewer can open, too): the 8px colour square, the name in `--text`, Lucide `lock` 12px `--faint` after a restricted one, and the project role at the right in `--muted` (`Member`, `Project admin`). An admin: one line, `Admins open every project.` in `--muted`. Under the rows, 12px `--faint`: `Open projects need no grant. A restricted project shows its lock.` Project roles are changed on the project's Access page (`project-access`), not here.
4. **On their behalf:** `Personal runners` · `1`; `CLI sessions` · `2`; `Tasks they drive` · `1` (Plex Mono). These are what removal ends, so the admin sees them before the menu's `Remove`.

## States and copy

| State | What changes |
|---|---|
| Loading | five 44px rows of `Skeleton` bars (a round one for the avatar); the panel shows its group labels with skeleton values; Invitations and Removed wait |
| Loaded (the picture) | as above |
| Only the first admin | the one row; the Invitations section reads `No invitation is waiting. Invite someone with Invite.`, with `Invite` as a teal link that opens the sheet. No illustration: the list is never empty |
| Row menu open (the picture) | as above |
| Role change failed | one `--red` 13px line under the section head, `role="alert"`, from `errorText()`; the cell returns to its old value |
| Remove dialog | as above. Failed: the error line inside the dialog, the dialog stays |
| An invitation just made | its row heads the pending list with `Copy link`, and the lede's count grows; the sheet shows the link (`member-invite.md`) |
| A member (not an admin) | no `Invite`, no addresses, no menus, no Invitations, no Removed, no panel (`content.full`); the lede's member form. Projects name only what the viewer can open |
| Load failed | under the lede, `role="alert"`, 13px `--red`: the error text, in place of the sections |
| Narrow (below 1280px) | the panel drops under the page (`PageFrame`). Below 900px the address leaves the Member column for a second line under the name, and Projects becomes `3 projects` in `--muted` |
| Phone (F-075) | one column: each member a 56px two-line row (name and role; `calculator, web-storefront · 14m ago` in `--faint`), the menu button at the right; invitations the same, with `Copy link` and `Revoke` in the row's menu. `Invite` stays in the top bar as an icon button with an `aria-label` |

## Components (shadcn/ui names)

`Sidebar` (existing, plus Members), `PageFrame` with `Breadcrumb` and `properties`, `PageHeading`, `Section`, `Table` / `TableHeader` / `TableRow` / `TableHead` / `TableCell` (existing `ui/table.tsx`), `Avatar` (existing), `Badge` outline for `you` (today `Chip` in `ui/status.tsx`), `DropdownMenu` with `DropdownMenuLabel`, `DropdownMenuRadioGroup`, `DropdownMenuSeparator`, `DropdownMenuItem` (existing `ui/dropdown-menu.tsx`), `AlertDialog` (existing), `Tooltip` (existing), `Button` (default = the Shell primary; ghost for the toggles and `Revoke`; link for `Copy link`), `PropGroup` / `PropRow`, `Skeleton` (existing). Lucide 15px, stroke 1.75: `users`, `plus`, `ellipsis`, `user-minus`, `mail`, `lock`, `check`, `chevron-right`, `chevron-down`.

## Tokens

At the approved pictures' scale (`../m1/README.md`, "Scale"; the colours `app-design.md` lists).

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page, panel |
| `--side` | `#0A0B0C` | sidebar |
| `--surface` | `#131416` | the open menu, the pressed menu button, skeletons |
| `--raise` | `#17181B` | row hover, avatar fill |
| `--sel` | `#1A1B1E` | the selected row and sidebar item |
| `--line` | `#1F2023` | row hairlines, panel edge, group lines |
| `--line-2` | `#2A2C30` | the menu's border, the `you` chip, secondary buttons |
| `--text` | `#F2F3F4` | names, roles, values |
| `--muted` | `#B4B7BB` | lede, `All projects`, project names, keys, `Revoke`, the Removed head |
| `--faint` | `#8B8E93` | header labels, addresses, times, expiries, counts, icons, the panel's labels |
| `--red` | `#E5675C` | `Remove from {organization}`, the destructive buttons, errors |
| `--teal` | `#6FB8AA` | `Copy link`, `Invite` as an inline link |
| `--amber` | `#FFB224` | only the sidebar's Needs you count. Nothing on this page is amber |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | `Invite` |

Type: Manrope 700 26px (title); IBM Plex Sans 14.5px body, 14px rows, 13px secondary, 12–12.5px labels, 600 for section heads and the panel title, 500 for buttons; IBM Plex Mono for addresses, counts and times. Project squares use the project's own colour.

## Data this screen needs beyond tickets 22 and 23

- `members.list` per member: `lastActiveAt` (ticket 23 names it: the latest of the account's session activity in this organization and its last audit entry), the membership `state` (`active`, `pending_verification`), `invitedBy` (from the accepted invitation), the projects the member can open **filtered to the ones the viewer can open**, each with its project role and `access`, and the counts `personalRunners`, `cliSessions`, `drivingTasks` (admins only).
- `members.list({ removed: true })`: `removedAt` and the remover's name.
- `members.invitations`: pending and the last 20 past, each with its address, role, granted project names (filtered as above), `expiresAt`, `acceptedAt` and the acceptor's name, `revokedAt`. Never the link.
- The remove dialog's counts come from the selected member's panel data; the server's transaction is what counts.

## Differences from the current code

Checked against `apps/web` and `packages/api` on `main` (2026-11-19):

1. **New route and view.** Nothing exists under `organization/members/`, nor `components/members/` (ticket 32 names both).
2. **Sidebar.** `sidebar.tsx` lists Runners for everyone, then Models and GitHub for admins. Add **Members** (`users`) for every member (ticket 32), in `app-design.md`'s order.
3. **`organization.members`** (`packages/api/src/routers/organization.ts`) returns `memberId`, `userId`, `name`, `username`, `email` (admins only), `role` and `joinedAt`, with no state, projects, last activity or counts, and lists every membership. Ticket 23's `members.list` replaces or wraps it and filters removed ones. `components/tasks/task-view.tsx` reads it today (line 182) for names; it keeps working through whichever ticket 23 picks.
4. **`organization.setMemberRole`** has the last-admin lock, and no screen calls it. Ticket 23 moves it to `members.setRole`, and this page is its first caller.
5. **No invitation or removal procedure** exists (tickets 22 and 23).
6. **Messages.** New keys under `members.*` in `messages/en.json`, and `shell.members`.

## Open points for the lead

**Decided 2026-11-19** by the recommendation, under `## Decided 2026-11-19` in ticket 32.

- **`Copy link` on older invitations.** Spec section 12 lists "Copy link" on pending invitations; ticket 22 and ADR 0053 show the link once and never return it again. This target keeps the link once: `Copy link` lives only on an invitation made in this tab. If the maintainer wants it on every pending row, the API must store a readable link, which ADR 0053 would need to say.
- **Leaving an organization.** ADR 0053 says the last admin can't leave, but no ticket builds a "Leave" action. This page offers none; if one comes, it goes in the profile menu, not on this list.

## Wrong in the image

Build the copy and details in this file, not these:

- The panel's values `Member`, `12 Nov` and `Alex Kim` under Organization are drawn in mono. They're Plex Sans; only `14m ago` and the three counts are mono.
- The **On their behalf** values sit on a wider key column than Organization's. Every group uses the same 96px key column.
- The invitations' expiry sits about 80px left of the Last active column. It's on the same grid as the members table.
- The open menu hides Lena Brandt's Last active cell (`Waiting on the address check`). Nothing is wrong there; it's under the menu.
- The panel's title is drawn at about 22px. It's Plex Sans 600 17px.
- The sidebar has no Insights, Memory or project items, and draws Spend and Audit log as it pleases: the sidebar is built from the shell, whatever the picture shows.
- The picture has no loading, empty, member, error, removed-open, past-invitations, dialog or narrow states: they're in the sections above.

All visible copy in the image is spelled right.
