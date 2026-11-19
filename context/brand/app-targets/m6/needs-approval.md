# Target: Needs approval (milestone 6, screen 7)

> **Committed image:** `needs-approval.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel.

- **Prompt:** `needs-approval.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 2 generations: the first from the references, the second an edit of the first that fixed the ticket title in the expanded block (a clipped capital and a mono face), the sidebar's icons and one misspelt row. References: `app-targets/m3/needs-you.png` (the approved page this one starts from, spec section 12), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route (new):** `apps/web/src/app/(panel)/projects/[project-id]/needs-approval/page.tsx` → `components/approvals/needs-approval-view.tsx` (ticket 33 names it `src/routes/projects/$projectId/needs-approval.tsx`: the same route in the app router's folder form). Home's rows and the task page's awaiting banner use the same answer component.
- **Features:** F-040 (approval for outside tasks), F-012 (where they come from), F-036 (their needs-you item). Spec section 12, screen 7; section 3, step 10; section 4, "An outside task"; section 11, item 9. Ticket 26 (`tasks.needsApproval`, `tasks.approve`, `tasks.reject`, `projects.setOutsideApproval`), ticket 33 (this screen), ticket 14 (the server). ADR 0031, ADR 0057.
- **Status:** a proposed target, waiting on approval (ticket 30's `## Comments`). Ticket 33 builds its data and tests until then, not its UI.

> Build it in real HTML/React (app-design.md, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

Anyone in the Linear workspace can delegate a ticket to ostra. When ostra can't match that person to a member who can open the project (ADR 0057), the task is an **outside task**: it waits, on the project's default profile and only on a pool, until a member of the project approves it. This page is where they do. It answers, for each waiting task:

1. **Who started it, and why don't they count?** The Linear user's name as Linear gives it, and the reason: not a member of the organization, or a member who can't open this project. Never their address (ticket 26).
2. **What would run?** The ticket, the profile (the project's default for the kind, whatever was asked) and the pool. Never a personal runner.
3. **Approve or reject.** Any member who can open the project; the first answer wins.

And for an organization admin: **should this project ask at all?** The switch, on by default.

The picture shows Alex Kim on `billing-platform`'s list: three tasks waiting, the newest expanded. Casey Moore and Dana Ortiz aren't members of Acme Corp; Jordan Lee is a member who can't open `billing-platform`.

## Layout (CSS px at 1440 wide)

`m3/needs-you`'s frame and row language.

| Region | Size | Contents |
|---|---|---|
| Sidebar | the shell | The project expands with a new row **`Needs approval`** (Lucide `shield-question`) after `Tasks`, selected here, with the amber count pill while tasks wait (hidden at 0). Spec section 12's shell line: the personal section's `Needs you` count includes these items |
| Top bar | 44px, hairline below | crumbs `billing-platform › Needs approval`. Nothing on the right |
| Main column | `1fr`, padding `28px 40px` | title, lede, tabs, the list, the reject note |
| Properties panel | 300px, left hairline, padding `20px 18px` | Outside tasks (the switch), Runs on, From Linear |

### Main column, top to bottom

1. **Title** `Needs approval` (Manrope 700 24px).
2. **Lede,** 13.5px `--muted`: `Tasks started in Linear by people who aren't members of billing-platform. Nothing runs until a member approves.`
3. **Tabs,** `m3/needs-you`'s underline tabs: `Waiting` + mono count, and `Decided`. The tab lives in the URL (`?tab=decided`).
4. **The list.** A header row 28px, 11.5px `--faint`: `Ticket`, `Title`, `Started in Linear by`, `Runs on`, `Age`. Rows 40px, `--line` under each, no boxes, one grid for every row: `14px 84px minmax(0,1fr) 230px 170px 44px 140px`.

| Column | Contents |
|---|---|
| Unread | `m3/needs-you`'s 6px `--text` dot while the member hasn't seen it |
| Ticket | the key, Plex Mono 12.5px `--faint`, a link to the task page (which shows the awaiting banner) |
| Title | the ticket's title, 13px; unread `--text` 500, read `--text` 400 |
| Started in Linear by | the Linear user's name (`trackerActorName`), 13px `--text`, then 12px `--faint` ` · not a member` or ` · member, no access here` |
| Runs on | Plex Mono 12.5px `--muted`: `{profile} · {pool}` |
| Age | Plex Mono 12px `--faint`, since the delegation |
| Action | two 26px buttons, 8px apart: `Reject` (ghost) and `Approve` (outline). An expanded row shows a 15px `chevron-up` ghost button instead |

   - **Order:** oldest first: nothing expires (ADR 0057), so the one waiting longest is first to answer. *The picture sorts newest first; build oldest first.*
   - **One row expanded at a time;** on load, the oldest unread row opens by itself.

5. **The expanded block** (`m3/needs-you`'s `NeedsYou`: a 2px amber rule, 12px padding, no fill), indented to the title column:
   - Title: Lucide `hand` 14px + amber 13px 600 `Needs you · approve an outside task`.
   - One 13px `--text` line, by reason:
     - not a member: `{name} delegated {key} to ostra in Linear. No member of Acme Corp has their Linear address, so they count as outside.`
     - a member without access: `{name} delegated {key} to ostra in Linear. They're a member of Acme Corp, but can't open billing-platform.`
     - no address from Linear: `{name} delegated {key} to ostra in Linear. Linear didn't share their address, so they count as outside.`
   - Three 26px key/value lines, keys 110px `--muted`: `Ticket` teal mono key + the title (sans `--text`) + teal `↗` to Linear · `Profile` the profile's name + `--faint` ` · billing-platform's default for code` · `Pool` mono pool + `--faint` ` · never a personal runner`. When the starter asked for another profile (a Linear label naming one, later), a 12px `--faint` line under Profile: `Asked for {profile}; outside tasks run the default.`
   - Buttons, 28px, 8px apart: `Reject` (outline), `Approve` (amber fill, `--ink` text, 600).
   - Footnote, 12px `--faint`: `Any member of billing-platform can answer. The first answer counts. Linear's session shows the outcome.`
6. **The reject note,** 20px under the list, 12px `--faint` with Lucide `info` 13px: `Rejecting asks for a reason. It's posted to the ticket's agent session in Linear.`

### Properties panel

`PropGroup`s, 11px 500 `--faint` labels; `PropRow`s 30px, 104px key column, 12.5px.

1. **Outside tasks:** a row `Need approval` with a `Switch` at its right (`projects.setOutsideApproval`). Under it 12px `--muted`: `On by default. Only an organization admin turns it off: outside tasks then start at once, still on a pool and on the default profile.` Then `Changed` · `{name}, {date}` (the date mono; `Never changed` `--faint` while it's the default).
2. **Runs on:** `Profile` the project's default for code (and `Refine` for refine, when the kind is ever reachable from Linear; v1 starts code only) · `Pool` mono, the pool admission would pick (`Any of 2 pools` when several) · `Personal runners` `Never`.
3. **From Linear:** `Board` the board with Start from Linear on in this project · `Team` mono · `Agent mode` `On` / `Off` · teal `Connect Linear →` (to `/organization/linear`, organization admins only).

## States and copy

| State | What shows |
|---|---|
| **Waiting** (the picture) | as above |
| **Reject** | `Reject` opens, under the buttons, a one-line `Input` (`maxLength` 300), placeholder `Why, for the person in Linear (optional)`, with `Reject` (outline, `--red` text) and `Cancel` (ghost). Under it 12px `--faint`: `Posted in the ticket's agent session.` |
| **Answering** | the buttons disable and the pressed one shows a 13px spinning `loader-circle`. Success collapses the block to one 12px `--muted` line under the row: `Approved by you. It's queued on default.` / `Rejected by you.`; the action column shows `--faint` `Done`. The row moves to Decided on the next load |
| **Lost the race** | 12.5px `--muted` with `circle-alert`: `Sam Rivera approved this first.` (or `rejected`); buttons gone |
| **Refused** | 12.5px `--red`, `role="alert"`: `errorText(error)` |
| **Decided tab** | the same grid; the Runs on column reads the outcome, 12.5px: `--muted` `Approved by Sam Rivera` / `Rejected by Alex Kim`, the rejection's reason in `--faint` after it (ellipsis, full in `Tooltip`); Age is since the answer; the action column is a teal `Open task` for an approved one. 50 a page, newest first |
| **Nothing waiting** | one 13px `--faint` row under the header: `Nothing waits for approval. Tasks started in Linear by people outside billing-platform show up here.` |
| **Switch off** | the panel's switch off; under the lede a 12.5px `--muted` line with Lucide `shield-off` 13px: `Outside tasks start at once in billing-platform, on a pool and on the default profile. An organization admin turned this off on {date}.` The Waiting tab keeps any task that was waiting when it was turned off (they're not started by the switch) |
| **Turning it off** | an `AlertDialog`: title `Let outside tasks start without approval?`, body `Anyone in the Linear workspace who delegates a ticket on Billing starts a task in billing-platform at once, on its pools and its default profile. It spends Acme Corp's budget.`, buttons `Cancel` and `Turn off approval` (outline, `--red` text). Turning it on needs no dialog |
| **Not an organization admin** | the switch renders disabled, with 12px `--faint` under it: `Only an organization admin changes this.` |
| **Loading** | title, lede and tabs at once; three 40px `Skeleton` rows; the panel's values `–` |
| **Narrow (below 1280px)** | the panel drops under the page. Below 760px each row is two lines: key, title and the buttons on the first; the starter and Runs on on the second. The block's key/value lines stack key above value |

### Home's rows (`m1/home`, `m3/needs-you`)

Each waiting task is a needs-you item (`awaiting_approval`) for the project's members, so it shows on Home's Needs you section and on `/needs-you`, in their grid:
- Reason line (`home-words.ts`, `reasonParts`): `Started in Linear by {name} · approve to run` (12.5px `--muted`, the name `--text`).
- Action (`actionKey`): `Approve` (outline). On `/needs-you` it expands the row with the block above; on Home it opens this page with `?task={id}`, which expands that row.
- Mail (`m3/email-needs-you`'s kinds, `task_approval`): subject `{key} waits for approval in {project}`, line `Started in Linear by {name}, who isn't a member of {project}.`, button `Open in ostra`.
- The task page's awaiting banner (`m1/task` grown): the same block, full width under the header, and `Started in Linear by {name}` in the key line.

## Components (shadcn/ui names)

- The shell, `PageFrame`, `PropGroup`, `PropRow`, `Separator`; `m3/needs-you`'s tabs and row grid.
- `NeedsYou` (`components/ui/needs-you.tsx`) for the block; `Button` (`ghost`, `outline`, the amber variant); `Input` for the reason; `Switch`; `AlertDialog` (turning approval off); `Tooltip`; `Skeleton`.
- Icons: Lucide 15px, stroke 1.75: `hand`, `shield-question`, `shield-off`, `chevron-up`, `info`, `arrow-up-right`, `circle-alert`, `loader-circle`.

## Tokens (`app-concepts/html/graphite.css`)

> **Scale.** The sizes and colours below are `graphite.css`'s. The panel is built at the approved pictures' scale, which wins on size, spacing and contrast: body 14.5px, dense rows 14px, secondary 13px, small 12px, title 26px, `--muted` `#B4B7BB`, `--faint` `#8B8E93`, buttons 30px, a 46px top bar and a 320px properties panel (380px with a form). The measured values are in `../m1/README.md`, "Scale".

| Token | Value | Used for |
|---|---|---|
| `--amber` | `#FFB224` | the block's rule, icon and title, its `Approve` fill, the sidebar pills. One block at a time |
| `--ink` | `#0C1D21` | text on the amber button |
| `--green` | `#4FB286` | the switch when on |
| `--teal` | `#6FB8AA` | the ticket key in the block, `↗`, `Connect Linear →`, `Open task` |
| `--red` | `#E5675C` | errors, the reject confirmation, `Turn off approval` |
| `--text`, `--muted`, `--faint` | `#EDEDEE`, `#9A9DA3`, `#64676D` | as `m3/needs-you` |
| `--surface`, `--line`, `--line-2` | `#131416`, `#1F2023`, `#2A2C30` | input, hairlines, borders |

Type: Manrope 700 24px; IBM Plex Sans 13px rows, 12.5px secondary; IBM Plex Mono for keys, the pool, ages, counts and dates.

## Data this screen needs beyond ticket 26

- `tasks.needsApproval` gives the starter, the ticket, the profile and the pool. Add: **the reason** (`not_member`, `no_project_access`, `no_address`), **read state** for the dot (the needs-you item's), and for the Decided tab **who answered, when and the reason**.
- The panel: the project's **switch, who changed it and when** (`outsideApprovalChangedByMemberId` and the audit entry's time), the **Start from Linear board and team**, and the **pools** the project lists.

## Open points (the build takes the recommendation and records it in ticket 33's `## Comments`)

1. **The order.** Recommended: oldest first (nothing expires, so age is the queue), Decided newest first.
2. **The reason goes to Linear.** Recommended: yes, capped at 300 characters (see `linear-agent-mode`, open point 1). The input's placeholder says who reads it.
3. **The sidebar row.** Spec section 12 puts "the Needs approval count beside Needs you". Recommended: a project row `Needs approval` with its pill (this page is per project), and the items counted in the personal `Needs you` pill too, so one count says "something waits on you".

## Differences from the current code

Checked against `apps/web` on `main` (2026-11-19), which holds milestone 1's panel; `/needs-you` and the `NeedsYou` block are milestone 3's.

1. **New route** `projects/[project-id]/needs-approval/page.tsx` and `components/approvals/needs-approval-view.tsx`.
2. **`ProjectNav`** gains `Needs approval` after `Tasks`, with the amber pill (`projects.list` needs each project's waiting count).
3. **`home-words.ts`** gains the `awaiting_approval` reason and its `Approve` action.
4. **Messages:** a `needsApproval` namespace in `messages/en.json`.

## Wrong in the image

Build the copy and details in this file, not these:

- **The order** is newest first; build oldest first (open point 1).
- **The panel's group labels** are drawn 13px semibold white; they're 11px 500 `--faint`.
- **The row's Runs on** draws `Default` in mono; the profile's name is sans, the pool mono (the block below gets it right after the edit).
- **The unread title** on row 1 and row 2 are 600; unread is 500.
- **The project's sub-rows** in the sidebar are drawn with their own icons; build the sidebar from the shell.
- **The logo** approximates the Hinge mark. Use `kit/logo/export/ostra-hinge-single-color.svg`, 20px.
- The picture has no reject, answering, decided, empty, switch-off, non-admin, loading or narrow states: they're in the tables above.

All visible copy in the image is spelled right.
