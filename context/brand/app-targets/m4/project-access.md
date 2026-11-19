# Target: a project's access (milestone 4, screen 5)

> **Committed image:** `project-access.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel.

- **Prompt:** `project-access.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation, kept as made. References: `app-targets/m2/project-boards.png` (the approved page this one starts from, spec section 12), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route (new):** `apps/web/src/app/(panel)/projects/[project-id]/settings/access/page.tsx` → `components/projects/project-access-view.tsx`. One of the project's settings tabs: `Ticket template`, `Repos`, `Access`, `Audit log` (tickets 33, 34 and 39; milestone 2's ticket template is the first).
- **Features:** F-087 (project access), F-003 (roles). Spec section 12, screen 5; section 3, steps 1 and 2. Ticket 23 (`projects.setAccess`, `projects.setMember`, `projects.removeMember`), ticket 33 (this screen). ADR 0026 (the matrix), ADR 0053.
- **Status:** a proposed target, waiting on approval (ticket 31's `## Comments`). Ticket 33 builds its data and tests until then, not its UI.

> Build it in real HTML/React (app-design.md, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

A project admin decides who can open the project, and what each listed person may change in it. The page answers three questions, in this order:

1. **Who can open it?** Everyone in the organization (open), or only the people listed and the organization's admins (restricted). A restricted project is invisible to everyone else: it isn't in their sidebar, search or Home, and its URL is "not found".
2. **Who is listed, and with which project role?** A project admin changes its repos, boards, environment and access. A project member starts, drives and reopens its tasks.
3. **Who sees it whatever this page says?** The organization's admins, always. The page says so, by name, so nobody restricts a project believing it hides it from them.

Every change applies at once and writes an audit entry (ticket 23). There's no Save button.

The picture shows Alex Kim, an organization admin, on `vault`: restricted, with Sam Rivera listed as its project admin and Jordan's invitation (made on the Members page with `vault` as a restricted project, `member-invite`) waiting. Jun Ota is about to be added.

## Layout (CSS px at 1440 wide)

The shared shell, unchanged. Build the sidebar from `components/shell/sidebar.tsx`, never from the picture.

| Region | Size | Contents |
|---|---|---|
| Sidebar | 232px, `--side`, 1px `--line` on its right | as the shell. The open project expands into its rows, `Settings` (Lucide `settings`) selected (`--sel`). A restricted project shows a 12px Lucide `lock` in `--faint` after its name, in every member's sidebar |
| Top bar | 44px, 1px `--line` below | breadcrumb `vault › Settings › Access`. **No button:** each change applies on its row |
| Main column | flexible, padding `28px 40px`, content `max-width: 760px` | the settings tabs, title, lede, Who can open it, Members, the admins line |
| Properties panel | 300px (no form in it), 1px `--line` on its left, padding `20px 18px` | the project's access, the organization's admins, the last change |

### Main column, top to bottom

1. **Settings tabs.** Underline tabs (`Tabs` with `variant="line"`), 28px tall, 13px, a 1px `--line` under the whole row: `Ticket template`, `Repos`, `Access`, `Audit log`. The active tab is `--text` with a 2px `--text` underline; the others are `--muted`. Each tab is a link (`/settings/ticket-template`, `/settings/repos`, `/settings/access`, `/settings/audit`), so the URL carries it. A project member sees only `Access` (read-only, below); `Repos`, `Ticket template` and `Audit log` are for project admins. `project-repos` draws the same row.
2. **Title** `Access`, Manrope 700 24px, letter-spacing −0.015em, 24px under the tabs.
3. **Lede,** 13.5px `--muted`, one line: `Who can open vault, and what each person may change in it.` (the project's name).
4. **Who can open it** (26px below). `h2` 13px 600. A `RadioGroup` of two hairline rows, 48px, no box. Each row: a 16px radio, the label (13px, 500, `--text`), then its description on the same line (12.5px `--muted`). The chosen row has the `--sel` fill and a 6px radius.

| Option | Label | Description |
|---|---|---|
| `open` | `Open` | `Everyone in Acme Corp can open it and start tasks.` (the organization's name) |
| `restricted` | Lucide `lock` 13px, `Restricted` | `Only the people listed below, and the organization's admins. Nobody else sees that it exists.` |

   Choosing the other option asks first (`AlertDialog`, below), then calls `projects.setAccess`.

5. **Members** (28px below). Section line: `h2` `Members`, the count in faint mono 11.5px (listed people plus pending invitations). Then a `Table`, no box:
   - Header row 30px, 11.5px `--faint`, 500: `Member`, `Project role`, `Added`, and an empty last column.
   - Body rows 44px, 1px `--line` under each. One grid for every row: `1fr 140px 150px 80px`.

| Column | Contents |
|---|---|
| Member | a 24px `Avatar` (initials, `--line-2` fill), the name (13px `--text`) and after it the address in Plex Mono 12.5px `--faint` (organization admins only; open point 3) |
| Project role | a `Select`, 120px × 28px: `Admin` / `Member`. Calls `projects.setMember` on change |
| Added | Plex Mono 12.5px `--faint`: `16 Nov` (`formatDay` of the `ProjectMember` row's `createdAt`) |
| Remove | a ghost `Button`, 24px, `--muted`: `Remove`, right-aligned. Opens the remove dialog |

   - **A pending invitation** that names this project (ADR 0053) is a row too: Lucide `mail` 15px `--faint` in the avatar's place, the address in Plex Mono 13px `--text`, then a `Badge variant="outline"` `invited` (11px, `--faint`). Its role is plain `--muted` text, not a select, and the Added column reads `joins on accepting` in 12.5px `--faint` (sans). No Remove: the invitation is revoked on the Members page (`members`), which this row doesn't link to for a project admin who isn't an organization admin.
   - Rows sort project admins first, then members, then invitations, each by name.
   - **Add member,** one line 12px under the last hairline (as `m2/project-boards`' Attach line): `Add member` (12.5px `--muted`), a `Select` 240px × 28px of the organization's active members who aren't listed and aren't organization admins (each a 16px avatar and the name; for an organization admin, the address in `--faint` mono in the list, never in the trigger), a `Select` 120px of the role (`Member` by default), and an outline `Button` `Add` (28px). With nobody left to add, the first select shows `Everyone is listed` and is disabled, and `Add` too. A project admin adds existing members only: inviting someone new is the Members page's (ADR 0053).
6. **The admins line** (22px below the Add line), no box: Lucide `shield` 13px `--faint`, then 12.5px `--muted`: `Alex Kim and Priya Nair always see vault and can change it: organization admins see every project, listed or not.` The names are the organization's admins (`members.list` with role admin), joined with `and` (three or more: `Alex Kim, Priya Nair and Dana Ortiz`). It shows in both modes; in the open mode it reads `… always see vault and can change it, whoever is listed.`
7. **The roles line,** 10px under it, 12px `--faint`: `A project admin changes its repos, boards, environment and access. A project member starts, drives and reopens its tasks.`

### Properties panel

`PropGroup`s with an 11px 500 `--faint` label, 30px `PropRow`s (key column 104px, 12.5px; key `--muted`, value `--text`). Values are Plex Sans unless the row says mono.

1. **{project name}** (`vault`):
   - `Access` · Lucide `lock` 13px + `Restricted`, or `Open`
   - `Can open` · `3 people` (the number in mono): listed members plus organization admins, counted once each; open: `Everyone (14)`
   - `Project admins` · the names, comma-joined, or `–`
   - `Created` · `16 Nov` (mono) `by Alex Kim`
2. **Organization admins** {count}: one 28px row each, an 18px avatar and the name. Under them, 12px `--faint`: `They see every project. They aren't listed here.`
3. **Last change:** the newest audit entry of an access change for this project (the action names are ticket 10's; `project.access-changed`, `project.member-set` and `project.member-removed` are this file's proposal), as one 12.5px `--muted` sentence (`Alex Kim restricted vault`, `Alex Kim made Sam Rivera an admin`, `Priya Nair removed Jun Ota`) with its age in Plex Mono `--faint` at the right. Under it a teal link `Audit log →` to the `Audit log` tab filtered to those actions (organization admins and project admins only; a project member sees no link).

## States and copy

| State | What shows |
|---|---|
| **Restricted, listed** (the picture) | as above |
| **Open** | the `Open` row chosen. The Members section stays: its count and header read the same, and a 12.5px `--muted` note under the section line says `Everyone in Acme Corp is a member here. List someone to make them a project admin.` Its rows are the people with an explicit role (usually the project admins). Add member's role select defaults to `Admin` in this mode. The panel's `Access` is `Open` without the lock, `Can open` is `Everyone (14)` |
| **Restricted, nobody listed** (spec step 2, `vault` at creation) | the Members count `0`, one 44px row in 13px `--faint`: `Nobody is listed. Only the organization's admins see vault.` and the Add line under it |
| **Make it restricted** | choosing `Restricted` opens an `AlertDialog`: title `Restrict vault?`, body `It disappears at once for the 9 members who aren't listed. Their running tasks here keep running, and they can't open them.` (the count is the organization's active members who aren't listed and aren't admins), buttons `Cancel` and `Restrict` (Shell primary: a restriction loses nothing). The person restricting it is listed by the server as a project admin if they weren't (ticket 23), and the list shows them |
| **Make it open** | `AlertDialog`: title `Open vault to everyone?`, body `Every member of Acme Corp can open it, read its tasks and start new ones.`, buttons `Cancel` and `Open it` |
| **Saving a change** | the changed control is disabled with a 12px `Loader` spinning in it (no skeleton). On success, a 12.5px `--muted` status line under the section, `role="status"`, Lucide `check`: `Saved. vault is restricted.` / `Sam Rivera is an admin here now.` / `Jun Ota is listed.`, gone after 4s |
| **Remove** | `AlertDialog`: title `Remove Jun Ota from vault?`, body (restricted) `vault disappears for them at once, and tasks they drive here lose their driver.` or (open) `They stay a member of vault, without a project role.`; buttons `Cancel` and `Remove` (destructive: `--red` text on `--surface`) |
| **The last project admin** | the server keeps no rule for a last project admin (organization admins always manage the project), so removing or demoting the last one goes through. The dialog adds one line: `vault has no other project admin. Organization admins still manage it.` |
| **You restrict yourself out** | can't happen to an organization admin. A project admin who isn't one removing themselves from a restricted project gets the dialog body `You lose vault at once.` and, on success, lands on Home with the status line `You're no longer listed on vault.` |
| **Error** | under the section that failed, `role="alert"`, 12.5px `--red`: `errorText(error)`. The control returns to its saved value |
| **Loading** | tabs, title and lede at once; the two radio rows render with skeleton descriptions; the table shows two 44px `Skeleton` rows; the panel's values are skeleton bars |
| **A project member** (not a project admin, not an organization admin) | the tabs show only `Access`. The page is read-only: the radio group renders as its chosen label and description only (no radio), the role selects as plain `--muted` text, no `Remove`, no Add line. A 12px `--faint` note under the lede: `Only vault's admins change who can open it.` No `Audit log →` link in the panel |
| **Not allowed at all** | a member who can't open the project gets the panel's `not found` page (ticket 23 answers `NOT_FOUND`); the page never says the project exists |
| **Narrow (below 1280px)** | the panel drops under the page (`PageFrame`). Below 640px the description of each radio row wraps under its label; the table keeps Member and Project role, and puts Added and Remove in a second line under the name |

The demo data in the image (fixtures, not real): the project `vault` (grey square, restricted, created 16 Nov by Alex Kim); `Sam Rivera` (`sam@acme.dev`, project admin); the invitation `jordan@acme.dev` (member); `Jun Ota` in the Add select; the organization's admins `Alex Kim` and `Priya Nair`, the same people as the `members` target. The real demo (spec step 2) uses `test2` with Sam as a project member, and `vault` restricted with nobody listed.

## Components (shadcn/ui names)

- The shell: `Sidebar` and its parts as in `m1/project.md`, `Breadcrumb`.
- `Tabs`, `TabsList`, `TabsTrigger` as links (the settings tabs; shared with `project-repos`)
- `RadioGroup`, `RadioGroupItem` (in `components/ui/radio-group.tsx` already)
- `Table`, `TableHeader`, `TableRow`, `TableHead`, `TableBody`, `TableCell` (already in `components/ui/`)
- `Select` (role, Add member; already in `components/ui/`), `Avatar` / `AvatarFallback` (already), `Badge` (`invited`)
- `Button` (`ghost` for Remove, `outline` for Add), `AlertDialog` (restrict, open, remove; already in `components/ui/`)
- `Skeleton` (loading), `Separator` (panel groups), the repo's `PageFrame`, `PropGroup`, `PropRow`
- Icons: Lucide 15px, stroke 1.75: `settings`, `lock`, `mail`, `shield`, `check`, `chevron-down`, `arrow-right`, `loader`.

## Tokens (`app-concepts/html/graphite.css`)

> **Scale.** The sizes and colours below are `graphite.css`'s. The panel is built at the approved pictures' scale, which wins on size, spacing and contrast: body 14.5px, dense rows 14px, secondary 13px, small 12px, title 26px, `--muted` `#B4B7BB`, `--faint` `#8B8E93`, buttons 30px, a 46px top bar and a 320px properties panel (380px with a form). The measured values are in `../m1/README.md`, "Scale".

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page, panel |
| `--side` | `#0A0B0C` | sidebar |
| `--surface` | `#131416` | selects, the destructive button's fill, skeletons |
| `--sel` | `#1A1B1E` | the chosen radio row, the `Settings` nav row |
| `--line` | `#1F2023` | row hairlines, the tab row's line, panel edge |
| `--line-2` | `#2A2C30` | control borders, avatar fills |
| `--text` | `#EDEDEE` | names, labels, the active tab and its underline |
| `--muted` | `#9A9DA3` | lede, descriptions, the admins line, inactive tabs, keys |
| `--faint` | `#64676D` | addresses, dates, table heads, the roles line, the lock and shield icons |
| `--teal` | `#6FB8AA` | `Audit log →` |
| `--red` | `#E5675C` | errors, `Remove` in its dialog |
| `--amber` | `#FFB224` | only the sidebar's Needs you count. Nothing on this page is amber |

No green on this page: an access change isn't a success to celebrate, it's a fact. Type: Manrope 700 24px (title); IBM Plex Sans 13px body, 12.5px secondary, 11–11.5px labels and heads, 600 for section titles, 500 for labels and buttons; IBM Plex Mono for addresses, dates, counts and ages.

## Data this screen needs beyond ticket 23

- `projects.get` returns `access`; the page also needs **`createdAt` and its creator's name** for the panel.
- `projects.members(projectId)`: the listed members (`ProjectMember` rows with the member's name, address, role, `createdAt`) and the **pending invitations that name this project** (address, role). Ticket 23 lists `setMember` and `removeMember` but no list: add it there, behind `requireProjectAccess`.
- **The organization's admins' names** (for the line and the panel) and **the count of active members** (for `Can open` and the restrict dialog). `members.list` has both for an organization admin; a project admin who isn't one needs them too, so the list procedure returns names and roles (not addresses) to them.
- **The last access change:** the newest of the three audit actions for this project (ticket 25's `audit.list` with a project and action filter, limit 1).

## Open points (the build takes the recommendation and records it in ticket 33's `## Comments`)

**Decided 2026-11-19** by the recommendation, under `## Decided 2026-11-19` in tickets 10 and 33.

1. **Removing someone from a restricted project while they drive a task there.** Ticket 23 doesn't say. Recommended: what ADR 0053 does for a removed member, a `driver.changed` to nobody on each such task, in the same transaction, so nobody drives a task they can no longer open.
2. **The audit actions' names** for access changes. Ticket 10 owns the list; this file's names are a proposal.
3. **What a project admin who isn't an organization admin may read about the organization's members.** Recommended: names and roles, never addresses (the Members page keeps those to organization admins), enough for the admins line and the Add select.

## Differences from the current code

Checked against `apps/web` on `main` (2026-11-19):

1. **New routes.** There's no `/projects/[project-id]/settings` on `main` yet (milestone 2's ticket template lands it). Add `settings/layout.tsx` with the tab row, and `settings/access/page.tsx`. `/projects/[project-id]/settings` redirects to the first tab the viewer may open (`ticket-template` for a project admin, `access` for a member).
2. **`ProjectNav`** expands into Tasks and Environment only. Milestone 2 adds Inbox and Boards; this milestone adds `Settings` (Lucide `settings`) last, for every member who can open the project (a member sees only its Access tab). `m2/project-boards` listed `Repos` as a sidebar row: from milestone 4 it's a settings tab (ticket 39's route), so the row goes.
3. **The lock.** `ProjectNav` and the Home projects table show a 12px `lock` in `--faint` after a restricted project's name. `projects.list` needs `access` in its output.
4. **New UI primitives:** `Tabs` and `Badge`. `radix-ui` (1.8.1) already provides tabs; `Badge` is a styled `span`. No new package.
5. **Messages:** a `projectAccess` namespace in `messages/en.json` for every string above, with plurals for the counts.

## Wrong in the image

Build the copy and details in this file, not these:

- **The panel's group labels** (`vault`, `Organization admins`, `Last change`) are drawn 13px bold white. They're 11px 500 `--faint` `PropGroup` labels, as on every other panel. The count `2` after `Organization admins` is faint mono.
- **Mono where it shouldn't be:** `people` in `3 people`, and `joins on accepting`, render in mono. Only the number `3` and dates are mono; `joins on accepting` is 12.5px sans `--faint`.
- **The panel** starts at about x=1090, about 350px. It's 300px.
- **The sidebar's org rows** show `Members` and `Audit log`; milestone 4's Organization rows come from the shell (`../m1/README.md`, "One sidebar"), not from the picture. The project's own rows also come from the shell.
- **The radio rows** set `Open` and `Restricted` in 600; they're 500.
- **The tabs** start about 6px right of the title's left edge. Align the first tab's text on the title's left edge.
- **The logo** approximates the Hinge mark. Use `kit/logo/export/ostra-hinge-single-color.svg`, 20px.
- The picture has no open, empty, dialog, loading, member or narrow states: they're in the table above.

All visible copy in the image is spelled right.
