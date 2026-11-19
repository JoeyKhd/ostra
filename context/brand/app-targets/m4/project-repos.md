# Target: a project's repos (milestone 4, screen 17)

> **Committed image:** `project-repos.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel.

- **Prompt:** `project-repos.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation. References: `app-targets/m2/repo-checks.png` (the approved page this one starts from, spec section 12), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route (new):** `apps/web/src/app/(panel)/projects/[project-id]/settings/repos/page.tsx` → `components/projects/project-repos-view.tsx`. It is milestone 2's `repo-checks` page grown, moved under the project's Settings (ticket 39's path): `/projects/[project-id]/repos` redirects here.
- **Features:** F-098 (tasks across several repos: several repos per project, in order, up to 10), with milestone 2's F-060 and F-055 checks kept on each repo. Spec section 12, screen 17; section 3, step 3. Ticket 17 (`addProjectRepo`, `removeProjectRepo`), ticket 30 (`projects.repos`, `.addRepo`, `.removeRepo`, `.reorderRepos`), ticket 39 (this screen). ADR 0027, "Milestone 4: several repos in practice".
- **Status:** a proposed target, waiting on approval (ticket 31's `## Comments`). Ticket 39 builds its data and tests until then, not its UI.

> Build it in real HTML/React (app-design.md, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

A project admin decides which repos a task in this project can change, and in what order the sessions see them. Every session checks out every repo of the project side by side, in this order, and the agent's instructions list them in it (ADR 0027). The page answers, at a glance:

1. Which repos does this project hold, in which order, and how many more can it take (10 at most)?
2. Is anything about a repo worth fixing (milestone 2's two checks, kept on each block)?
3. Can I remove this one, and if not, which tasks are holding it?

Members who aren't project admins see the same page read-only: no handles, no `Add repo`, no row menu, no remove button.

## Layout (CSS px at 1440 wide)

The shared shell, unchanged. Build the sidebar from `components/shell/sidebar.tsx`, never from the picture.

| Region | Size | Contents |
|---|---|---|
| Sidebar | the shell's | the open project expands into `Tasks`, `Inbox`, `Environment`, `Boards`, `Settings` (selected, `--sel`). See "Open points" for milestone 2's `Repos` row |
| Top bar | the shell's (46px), 1px `--line` below | breadcrumb `calculator › Settings › Repos`. Right: outline `Button` `Check again` (`refresh-cw`, milestone 2's), then 8px, the page's one primary `Button` `Add repo` (`plus`, Shell fill, Abyss text). Both hidden from members who aren't project admins, except `Check again`, which only reads |
| Main column | flexible, padding as the shell's pages, content `max-width: 760px` | the settings tabs, title, lede, the repo list, two footnotes |
| Properties panel | 320px (read-only, the scale table's width), 1px `--line` on its left | the selected repo: its facts, the tasks using it, removal, the order's note |

### Main column, top to bottom

1. **Settings tabs.** A row of plain text tabs, 28px tall, the full content width, a 1px `--line` under the row: `Ticket template`, `Repos`, `Access`, `Audit log` (each its own route under `settings/`). Inactive `--muted`, active `--text` with a 2px `--text` underline sitting on the row's hairline. No pills, no amber. A tab a member can't open isn't drawn (a project member sees `Repos` and `Access` only; ticket 33 and 34 own the other two). Focus: 2px `--muted` outline. Keyboard: they're links, so Tab moves through them.
2. **Title** (24px below the tabs): `Repos`, Manrope 700, the title size.
3. **Lede**, two lines:
   - `Every session checks these repos out side by side, in this order.` (lede size, `--muted`).
   - `acme · 3 of 10 repos · checked 2 min ago` (secondary size, `--muted`): the account login in mono `--text`, the count and the limit in mono. The age is the oldest `branchRulesCheckedAt` among the repos (milestone 2's rule). The limit is `OSTRA_PROJECT_MAX_REPOS`.
4. **The repo list** (18px below), an `ol`. No boxes: each repo is a block with a 1px `--line` hairline above it (and below the last), padding `12px 12px`.
   - **Header line** (28px), left to right:
     - the **drag handle**, `grip-vertical` 15px `--faint`, in a 20px hit area (`cursor: grab`; `grabbing` while dragging). A `button` with `aria-label="Move acme/calculator-api"` and `aria-roledescription="sortable"`.
     - the **position**, mono, `--faint`, a 16px column: `1`, `2`, `3`.
     - `git-branch` 15px `--faint`, the repo's `fullName` in mono `--text`, a 13px `lock` in `--faint` for a private repo (`aria-label="Private"`), the default branch in mono `--faint`, 12px after.
     - on the right: the **usage** (`No open tasks` in `--faint`, or `In use by {n} task` / `In use by {n} tasks` in `--text`), 20px, the **verdict** (milestone 2's: `Ready` `--muted`, `1 warning` `--text` 500, `Not supported` `--red` 500, `Couldn't check` `--faint`), 12px, and the **row menu** (`ellipsis` 15px `--faint`, a 24px ghost icon button, `aria-label="More for acme/calculator-api"`).
   - **One check line** under it, indented to the repo name's x, 26px, secondary size. It folds milestone 2's two lines into one when nothing's wrong, and shows only the problem when something is:

| Case | Icon | Text | After a `·`, `--faint` |
|---|---|---|---|
| Both pass | `shield-check` `--green` | `Default branch protected · signed commits not required` | none |
| Not protected | `triangle-alert` `--text` | `Default branch not protected` | `Allowed: the agent holds no token.` |
| Signed commits | `ban` `--red` | `Requires signed commits: ` + `not supported yet` in `--red` | `ostra's pushes aren't signed, so GitHub would refuse them.` |
| Couldn't check | `circle-help` `--faint` | `Couldn't check` | `{reason}` |

     Two problems at once (not protected and signed commits): two lines, the signed-commit one first. The full explanation, "why it's allowed" and "how to fix it", is milestone 2's panel groups, which this page keeps (below). When a repo requires signed commits, milestone 2's blocking notice (`Tasks can't start in this project.`) sits between the lede and the list, as `repo-checks.md` specifies.
   - **The block selects the repo** for the panel: a `button` region (`aria-pressed`), hover `--raise`, selected `--sel` with a 6px radius **inside the list's width**, focus a 2px `--muted` outline, inset. The URL carries it (`?repo=<repoId>`). Default selection: the first repo with a problem (milestone 2's order), else the first repo.
   - **Order:** `position` ascending, as `projects.repos` returns it.
5. **Footnotes** (14px below the list), 12px `--faint`, `info` 13px on the first:
   - `Drag a repo by its handle, or focus the handle and press ↑ or ↓. A repo you add joins each open task at its next session.` For a member who can't edit, only the second sentence.
   - `A project holds up to 10 repos.` (from the setting).

### Reordering

- **Drag:** pointer down on a handle lifts the block (`--raise` fill, a 1px `--line-2` border, no shadow); the other blocks slide to make room (150ms, `ease-out`; none under `prefers-reduced-motion`); a 2px `--text` insertion line shows where it lands. Drop saves at once (`projects.reorderRepos` with the full ordered list of IDs), optimistically; on an error the order snaps back and the error line shows (below). Escape while dragging cancels.
- **Keyboard:** focus a handle, Space or Enter picks the block up (`aria-pressed="true"` on the handle), ↑ and ↓ move it one place, Space or Enter drops and saves, Escape cancels. A live region (`aria-live="polite"`) says `acme/calculator-api moved to position 1 of 3.` after each move and `Order saved.` after the save.
- **No library is added** (`AGENTS.md`: ask before a dependency). Pointer events and the keyboard model above, in one hook `use-sortable-list.ts`. If the builder wants `@dnd-kit`, that's the maintainer's call first.
- The order changes nothing for a running session (ADR 0027); the next session checks out in the new order.

### Properties panel: the selected repo

Group labels and rows as milestone 2's `repo-checks` panel: rows 30px, grid `104px 1fr`, key `--muted`, value `--text`, values in Plex Sans except where marked mono. `Separator`s between groups.

1. **Header:** the repo's `fullName`, mono, `--muted` (the group label's place).

| Key | Value |
|---|---|
| `Position` | `2 of 3` |
| `Folder` | `calculator-api/` (mono): the repo's `checkoutDir` in every task's workspace (ADR 0027: the repo's name, with the owner added when two share one) |
| `Default branch` | `main` (mono) |
| `Visibility` | `Private` / `Public` |
| `Protected` | `Yes` / `No` / `Couldn't check` |
| `Signed commits` | `Not required` / `Required` (in `--red`) / `Couldn't check` |

2. **Milestone 2's explanation and fix groups** (`Why it's allowed` / `Why it's blocked` / `Why ostra couldn't check`, then `Protect main` / `To start tasks here`), exactly as `m2/repo-checks.md` specifies, when the repo has a problem. The picture leaves them out to show the new groups; build them.
3. **In use** — label `In use by 2 tasks` (`In use by 1 task`); for an unused repo the label is `Not in use` and the group holds only the remove button. Each task a row, 34px, a link to the task:
   - the task's mark, the same as the task list's (`TaskMark` from `components/projects/task-row-words.ts` and the `Mark` in `project-view.tsx`, moved to a shared file: a `git-pull-request` for in review, a green `Dot` while working, …), the ticket key in mono `--muted` (or nothing, for a prompt task), the title in `--text` (one line, cut with `…`, the full title in `title`), the state word right-aligned in `--muted` (`Working`, `Needs you`, `In review`, `Queued`, …, the task list's words).
   - At most 5 rows, then `and {n} more` in `--faint` linking to the project's task list filtered by this repo.
   - Under the rows (secondary size, `--muted`): `This repo can't be removed while a task that isn't merged, stopped or done has a branch in it.` Only when the list isn't empty.
4. **Remove:** an outline `Button`, the panel's full width, `trash-2` + `Remove from project`.
   - Disabled while the repo is in use, with the line above as its `aria-describedby`.
   - The only repo of a project: disabled, and the line reads `A project keeps at least one repo.`
   - Otherwise enabled; it opens the confirmation (below). Hidden from members who aren't project admins.
5. **Order:** label `Order`, then a secondary-size `--muted` paragraph: `Sessions check repos out in this order, and the agent's instructions list them in it. The order changes nothing for a running session.`

### The row menu

`DropdownMenu` from the `ellipsis`, project admins only: `Move up`, `Move down` (each disabled at its end), a separator, `Open on GitHub` (`arrow-up-right`, new tab), a separator, `Remove from project…` (`--red` text; disabled with the in-use line as its description while the repo is in use). The menu is the second keyboard way to reorder.

### Add repo

`Add repo` opens a `Sheet` from the right, 380px (the form width), titled `Add a repo`:

- A search field (`Search repos`, 34px) over the list of repos the App's installation grants (`fullName` in mono, a `lock` for private ones, the default branch in mono `--faint`), from `projects.availableRepos` (below). A repo already in this project is listed but disabled, with `in this project` in `--faint`; one in another project stays pickable, with `also in billing-platform` in `--faint` (a repo may sit in two projects, ADR 0027).
- One repo is picked at a time (a radio list); the sheet's primary button `Add repo` adds it at the end (`projects.addRepo`), runs its two checks, closes the sheet and selects the new block. A secondary `Cancel`.
- Under the list, `--faint` secondary size: `The repo goes last. Open tasks check it out at their next session, with no branch until they change it.`
- A repo the App can't reach any more is refused by the server (`addProjectRepo` checks `listRepos`); the sheet shows its message in `--red` under the list.
- **At the limit** (10): the top bar's `Add repo` is disabled, with a `Tooltip` `This project has 10 repos, the most it can hold.` and the second footnote reads `10 of 10 repos. Remove one to add another.` The lede says `10 of 10 repos`.

### Remove: the confirmation

An `AlertDialog`: title `Remove acme/calculator-sdk from calculator?`; body `Tasks in calculator won't check it out any more. Its environment variables and secrets for this project are deleted. The repo, its branches and its PRs on GitHub stay as they are.`; buttons `Cancel` and a destructive `Remove repo` (`--red` fill, Shell text). On success the block goes, the positions close up, and the panel selects the first repo.

**Refused by the server** (a task took a branch in it since the page loaded): the dialog closes, and the error line under the list reads the server's message, `acme/calculator-api is in use by CALC-161 Add history panel and CALC-158 Parse negative exponents.` (ticket 30: the refusal lists the tasks by key or title), and the panel's in-use group refreshes.

## States and copy

| State | What shows |
|---|---|
| **Loading** | the tabs; the title; the lede as a `Skeleton` line; three skeleton blocks (a header line and a check line each); the panel as skeleton rows |
| **One repo** | one block, position `1`, no drag handle (nothing to reorder); `Remove from project` disabled with `A project keeps at least one repo.` |
| **Several repos (the picture)** | as above |
| **A repo in use** | `In use by 2 tasks` on its block; the panel's in-use group; remove disabled |
| **At the limit** | `Add repo` disabled with its tooltip; `10 of 10` in the lede and the footnote |
| **Dragging** | the lifted block, the insertion line; `Order saved.` announced on drop |
| **Saving the order failed** | the order snaps back; the error line: `role="alert"`, `--red` secondary size, `errorText(error)`, under the list |
| **Checking again** | milestone 2's: `Checking…` with the icon spinning (no spin under reduced motion), disabled |
| **A member who isn't a project admin** | the list without handles, menus or `Add repo`; the panel without the remove button; the footnote's second sentence only |
| **Error loading** | `role="alert"`, `--red`, `errorText(error)`, where the list would be |

The demo data in the picture (fixtures, not real): `acme/calculator-web` (protected, ready, unused), `acme/calculator-api` (private, unprotected, used by `CALC-161 Add history panel`, in review, and `CALC-158 Parse negative exponents`, working), `acme/calculator-sdk` (private, protected, unused). The real demo (spec section 3, step 3) adds `ostra-test/test2` to `test1`.

## Components (shadcn/ui names)

- The shell: `Sidebar` and its parts, `Breadcrumb`.
- The settings tabs: links styled as tabs (`nav` with `aria-label="Project settings"`, `aria-current="page"` on the active one); not Radix `Tabs`, since each is a route.
- `Button` (`outline` `Check again`, primary `Add repo`, outline `Remove from project`), `DropdownMenu` (the row menu), `Sheet` (Add repo), `AlertDialog` (remove), `Tooltip` (the limit), `Skeleton`, `Separator`, `Input` (the sheet's search), `RadioGroup` (the sheet's list).
- The repo list: an `ol`, a block per repo with a handle `button` and a select `button`.
- Milestone 2's `repo-check-line.tsx` (one check), grown with the folded "both pass" line; the repo's `PageFrame`, `PropGroup`, `PropRow`; the task list's `Mark`, shared.
- Icons: Lucide 15px, stroke 1.75: `grip-vertical`, `git-branch`, `lock`, `shield-check`, `triangle-alert`, `ban`, `circle-help`, `ellipsis`, `plus`, `refresh-cw`, `info`, `trash-2`, `arrow-up-right`, `settings`.

## Tokens (`app-concepts/html/graphite.css`)

> **Scale.** Build at the approved pictures' scale (`../m1/README.md`, "Scale"): body 14.5px, dense rows 14px, secondary 13px, small 12px, title 26px, `--muted` `#B4B7BB`, `--faint` `#8B8E93`, buttons 30px, a 46px top bar and a 320px properties panel (380px for the sheet's form).

`--bg #0D0E10`, `--side #0A0B0C`, `--raise #17181B` (hover, the lifted block), `--sel #1A1B1E` (selected block, `Settings` row), `--line #1F2023`, `--line-2 #2A2C30` (outline buttons, the lifted block's border), `--text #EDEDEE` (the active tab and its underline, the insertion line), `--muted`, `--faint`, `--green #4FB286` (passing checks only), `--red #E5675C` (signed commits, the destructive actions, errors), `--teal #6FB8AA` (milestone 2's GitHub link).

- **No amber.** Nothing on this page waits on the member. "In use" is a fact, not an alarm: `--text`, no colour.
- **Type:** Plex Sans; repo names, branches, folders, positions, counts, keys and ages in Plex Mono; title Manrope 700.
- **Radii:** 6px the selected and lifted blocks, 7px buttons.

## Data this screen needs beyond milestone 2

From ticket 30:

- `projects.repos({ projectId })` → per repo, in `position` order: `repoId`, `fullName`, `defaultBranch`, `private`, `checkoutDir`, `position`, milestone 2's `checkedAt`, `defaultBranchProtected` and `signedCommitsRequired`, and `inUseBy: [{ taskId, key | null, title, state }]` (the unfinished tasks with a branch in it, ADR 0027's rule), plus `limit` (the setting).
- `projects.addRepo({ projectId, hostRepoId })`, `projects.removeRepo({ projectId, repoId })` (its refusal names the tasks), `projects.reorderRepos({ projectId, repoIds })` (the full list; refused unless it's a permutation of the project's repos). Project admin each.
- **`projects.availableRepos({ projectId })`** (project admin) for the sheet: the installation's repos with `inThisProject` and the names of other projects holding each. Not in ticket 30's list: today `github.repos` is an `adminProcedure` (organization admins), so a project admin who isn't one couldn't fill the sheet. Ticket 30 adds it, or the sheet is organization-admin-only; see "Open points".

## Differences from the current code

Checked against `main` (2026-11-19):

1. **Neither page exists.** There is no `settings/` route under a project and no repos page: milestone 2's `repo-checks` (`/projects/[project-id]/repos`) isn't built yet. Ticket 39 builds this page as the one Repos page, with milestone 2's checks in it.
2. **`Repo` has no `position`** (`packages/db/prisma/schema.prisma`); ticket 05 adds it. It has `checkoutDir` (the `Folder` row), `private`, `branchRules` and `branchRulesCheckedAt` already.
3. **`ProjectNav`** (`components/shell/project-nav.tsx`) has `Tasks` and `Environment` only; `Settings` (`settings` icon) is new, as is milestone 2's `Boards`.
4. **No sortable list** exists in `apps/web`, and no drag-and-drop package is installed; `use-sortable-list.ts` is new (above).
5. **`components/ui/`** has `sheet`, `dropdown-menu`, `alert-dialog`, `tooltip`, `skeleton` and `radio-group` already; no new primitive is needed.
6. **Copy:** every string above is new, under `projectRepos` in `messages/en.json`; milestone 2's `repos` strings are reused for the check lines.

## Wrong in the image

Build from this file, not these:

- **The panel is too wide:** it starts at about x=1047, about 393px. It's 320px.
- **Panel values render in mono:** `2 of 3`, `Private`, `No`, `Not required` are Plex Sans regular. Only `Folder` and `Default branch` are mono.
- **`CALC-161`'s icon is a green `shield-check`.** A task row uses the task list's mark (`git-pull-request` in `--muted` for in review), never a check's shield.
- **`Parse negative exponents` wraps** onto two lines. Titles are one line, cut with `…`.
- **The selected block** extends about 12px past the list's left and right edges. It keeps the list's width; the padding goes inside.
- **The sidebar's `Linear` icon** is drawn as a `ban` sign. Use Linear's real mark, monochrome `--muted` (as `m2/repo-checks.md` says).
- **The settings tabs** sit at the very top of the main column with no gap above; keep the page's top padding above them.
- **The footnote's arrows** `↑` and `↓` render as small glyphs in the sentence; render them as `Kbd` keys (the shared `kbd.tsx`).
- **The panel leaves out** milestone 2's `Why it's allowed` and `Protect main` groups for this unprotected repo. Build them, between the facts and `In use`.
- **The logo** approximates the Hinge mark. Use `kit/logo/export/ostra-hinge-single-color.svg`, 20px.
- **Sidebar sizes and the top bar's buttons** are drawn at the picture's scale; keep the shell's.

All other visible copy is spelled right.

## Open points for the maintainer

**Decided 2026-11-19** by the recommendation, under `## Decided 2026-11-19` in ticket 39.

- **Milestone 2's `Repos` row in the project's sidebar.** `m2/repo-checks` and `app-design.md` give the project both a `Repos` row and a `Settings` row; ticket 39 puts repos under `settings/repos`. Recommended: one page, under Settings (this target), with `/projects/[id]/repos` redirecting to it and the sidebar's `Repos` row dropped, so the project nav doesn't hold two ways to one page. The alternative keeps the `Repos` row pointing at this route and selects `Settings` while it's open.
- **Who adds a repo.** ADR 0027 and ticket 30 say project admins. A repo the App can reach is visible to the organization; a project admin who isn't an organization admin would see every repo the installation grants in the sheet. Recommended: allowed (adding grants nothing the App doesn't already have), with `projects.availableRepos` as above. The alternative is organization admins only.
