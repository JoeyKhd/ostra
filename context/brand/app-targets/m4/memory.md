# Target: Memory (`/projects/[project-id]/memory`, `/organization/memory`)

> **Committed image:** `memory.webp`, downscaled from a 2048×1360 picture to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Image:** Higgsfield `gpt_image_2_6` (3:2, 2k, high), 1 generation. References: the milestone 2 original `inbox.png` (the screen this one starts from), `app-concepts/html/home-graphite.png` and the Hinge logo (`kit/logo/export/ostra-hinge-single-color-2048.png`). Prompt: `memory.prompt.txt`.
- **Status:** a candidate target for milestone 4, not yet approved (ticket 31).
- **Starts from:** `../m2/inbox`: its sidebar with the open project, top bar, title and lede, the filter row, the 40px hairline list with one selected row, and the 380px properties panel that shows the selected row.
- **State shown:** `calculator`'s Memory, the Project tab: ten notes, two of them "always", three proposals waiting. The note `Check JavaScript with node` (the milestone 4 demo's, step 7 and 9) is selected, at version 2 after a merged proposal.
- **Features:** F-109 (memory notes), F-111 (the proposals' count). ADR 0044 (amended). Data, from ticket 29: `memory.notes({ scope, projectId?, query?, kinds?, status? })` (with the proposals' count), `memory.note(noteId)` (with its versions), `memory.save` and `memory.archive`. Builder: ticket 38.

## Purpose

What a project's agents know before they start. Each note is one fact (a convention, a command, a gotcha), and every new task gets the "always" notes in full and an index of the rest, which it can search (ADR 0044). A member opens this page to see what the agents are told, to find a note by a word, to fix one that's wrong, and to notice that agents have proposed new ones. It's a working list like the Inbox: dense rows, one selected, its detail in the panel. Writing and editing happen in the note's editor (target `memory-note`); deciding proposals in theirs (target `memory-proposals`).

## Layout (CSS px at 1440×960)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 234px, the shared shell | Build it from `components/shell/sidebar.tsx`, never from the picture. **New rows:** `Memory` (`book-open` icon) in the open project, after Boards, selected here; and `Memory` under Organization. Each carries its scope's **proposals count**, mono 12px `--faint`, hidden at 0. It's a plain count, never amber (`app-design.md`) |
| Top bar | 46px, hairline under | Crumbs `calculator › Memory` (organization: `Acme Corp › Memory`). Right, 8px apart: `Proposals` and the page's one primary button `New note` (below) |
| Main column | `1fr`, padding `28px 36px` | Title, lede, scope tabs, the filter row, the list, the index line |
| Properties panel | **380px** (`PageFrame wideProperties`), `border-left: 1px var(--line)`, padding `20px 18px` | The selected note |

### Top bar, right

- **`Proposals`**: `Button variant="outline"`, 30px, a 15px `lightbulb` icon, `Proposals`, then the count of the scope's `proposed` proposals in mono 13px `--faint`. At 0 the count hides and the button stays. It opens the proposals list (target `memory-proposals`, `…/memory/proposals`). It is never amber: proposals wait, but nobody's task is blocked on them (ADR 0044).
- **`New note`**: the page's primary button (Shell fill, `--ink` text, weight 600, `plus` icon), 30px. It opens the editor (target `memory-note`) at `…/memory/new`, with the scope of the tab that's open.

### Main column, top to bottom

1. **Title** `Memory` (`PageHeading`: Manrope 700 26px).
2. **Lede**, 15px `--muted`. Project: `What {project}'s agents get before they start, and can search while they work.` Organization: `What every project's agents get before they start, and can search while they work.`
3. **Scope tabs**, 16px under the lede: the underline tabs of the Needs you page (`../m3/needs-you.md`), 32px, 14px weight 500, 24px apart, a 1px `--line` rule under the row. Each tab ends in its count, mono 12.5px `--faint`. Selected: `--text` with a 2px `--text` underline; others `--muted`. In the URL (`?scope=organization`, `?status=archived`).
   - **On a project's page:** `Project` (its active notes), `Organization` (the organization's active notes, which this project's tasks get too), `Archived` (the project's archived notes).
   - **On the organization's page:** `Notes` and `Archived`.
   - The Organization tab on a project's page is the same list as the organization's page. Editing from it edits the organization's note, for every project; the panel's Scope row says so.
4. **Filter row**, 16px under the tabs, every control 30px, radius 7px, gap 8px:
   - **Search**, 260px: `Input` with a 15px `search` icon, `--surface`, `--line-2` border, placeholder `Search notes`. Postgres full-text over title and body (`memory.notes({ query })`), debounced 250ms, in the URL (`?q=`). It's the same search an agent's `memory_search` runs, so a member sees what an agent would find.
   - **`Kind`**: outline filter button with a 12px `chevron-down`, opening a `Popover` + `Command` with checkable kinds: `Convention`, `Command`, `Gotcha`, `Decision`, `Preference`, `Term`, each with its icon. The value shows after a colon in `--text`: `Kind: All`, `Kind: Command`, `Kind: 2 kinds`.
   - **`Source`**: the same, with `A member`, `An agent's proposal`, `A diff comment`, `A PR comment` (`MemoryNote.sourceKind`: `member`; `task` and `proposal`; `diff_comment`; `pr_comment`).
   - **`Always only`**: an outline toggle button (`Toggle`, `aria-pressed`) with a 15px `pin` icon. Pressed: `--sel` fill, `--text`.
   - Right (`margin-left: auto`): `{n} notes` in mono 13px `--faint`, the filtered total.
   - Filters live in the URL (`?kind=command,gotcha&source=member&always=1`).
5. **The list**, 14px under the filters. Rows 40px, a 1px `--line` hairline under each, no header, no box. One grid for every row:

| Column | Width | Contents |
|---|---|---|
| Kind | 16px + 14px gap | The kind's icon, 16px, `--muted`, with `aria-label` the kind |
| Title | `minmax(0,1fr)` | 14.5px `--text`, one line, ellipsis. An "always" note ends with the **Always chip**, 10px after the title: 24px tall, 1px `--line-2` border, radius 6px, padding `0 8px`, a 13px `pin` icon and `Always` in 13px `--muted`. The chip never truncates; the title does |
| Kind word | 110px | 14px `--muted`: `Convention` … |
| Source | 170px | `member`: a 22px `Avatar` + the author's name, 14px `--muted`. From a task (`task`, `proposal`, `diff_comment`, `pr_comment`): the source task's key (ticket key or short ID) in mono 13px `--muted`, a link to the task, with a `Tooltip` saying how (`An agent's proposal`, `A diff comment by Sam Rivera`, `An @ostra comment`) |
| Last used | 70px, right | Time since `lastUsedAt`, mono 13px `--faint` (`4m`, `2h`, `1d`), the exact time in a `title`. Never used: `Never` |

   - **Order without a search:** "always" notes first, then by last used, newest first, then never-used notes by creation: the order the index uses (ADR 0044, Q202), so the top of the list is what agents see first. **With a search:** by rank; each row grows to 56px with a second line, the body's best match, 13px `--muted`, one line, the matched words in `--text` weight 500 (`ts_headline`, rendered as text, never HTML).
   - **Selecting:** a click or `Enter` selects the row; `↑`/`↓` move the selection. Selected: `--sel` fill, radius 6px, no border. In the URL (`?note={id}`). On load the first row is selected. Hover `--raise`; focus a 2px `--muted` outline, inset. A source link navigates; it doesn't select.
   - **Paging:** 50 rows, the next 50 as the last row scrolls in, with three `Skeleton` rows.
6. **The index line**, 14px under the list, 13px `--faint`, on the Project and Organization tabs only (unfiltered): `New tasks get the {a} "always" notes in full and the other {b} as an index to search.` When ADR 0044's limits cut the index (100 notes, 8 KiB): `New tasks get the {a} "always" notes in full and {b} of the other {c} as an index. The rest are found only by search.` When the "always" notes pass 8 KiB: `The "always" notes pass 8 KiB, so {n} of them go into the index instead.` in `--muted` with a 13px `info` icon. The numbers come from the domain's index builder (`buildMemoryBlock`), not counted again here.

### Properties panel: the selected note

`PropGroup`/`PropRow` (96px key column, 30px rows, 14px; keys `--muted`, values `--text`), groups split by the `--line` hairline.

1. **Head line:** the kind's icon and word, 13px `--muted`, on the left. On the right a teal `Edit` link, which opens the editor (target `memory-note`, `…/memory/notes/{id}`). Archived notes show `Restore` there instead.
2. **Title:** 17px, weight 600, `--text`, wrapping, 6px under the head line.
3. **Body**, 8px under: 14.5px/1.6 `--text`. Notes are short (4 KiB at most) and shown whole. It's rendered as untrusted text with one markup: backticks become an inline code chip (mono 13px, `--surface`, 1px `--line`, radius 5px, padding `1px 6px`). No links, no HTML, no images. Line breaks kept.
4. **Rows**, after a hairline:
   - `Scope`: `Project · {project}`, or `Organization` with 12px `--faint` under it, `Every project's tasks get it.`
   - `Always`: a `Switch` + `On`/`Off` in `--muted`. Flipping it saves at once (`memory.save`, a new version) for a member who can write the note; it's disabled with a `Tooltip` for one who can't. On failure it flips back with the error under the panel's rows.
   - `Source`: the author's `Avatar` and name for a member's note; for one from a task, the task's key in teal mono, then `--muted` ` · an agent's proposal` / ` · a diff comment` / ` · a PR comment`.
   - `Version`: mono `{n}`, then `--muted` ` · merged from {how} on ` + the task's key in teal mono, when the version came from a proposal (`MemoryNoteVersion.proposalId`). A plain edit: just the number.
   - `Edited`: mono `{age} ago` + `--muted` ` by {member}`. Shown only from version 2.
   - `Last used`: mono `{age} ago` + `--muted` ` in ` + the task's key in teal mono (the latest `MemoryUse`). Never used: `Never` in `--muted`.
   - `Used`: mono `{n}` + `--muted` ` sessions` (`useCount`).
5. **Versions**, after a hairline: group label `Versions`, then up to 3 rows of 30px: `v{n}` mono 13px `--faint` (40px), what happened in 14px `--muted` (`Alex Kim wrote it`, `Sam Rivera edited it`, `Sam Rivera merged a proposal`, `Approved from CALC-171's proposal by Sam Rivera`), the age mono 13px `--faint` on the right. With more: a teal `All {n} versions →` to the editor's history.
6. **`Archive note`**, after a hairline: a teal text button, 14px, no underline. Shown only when `canArchiveNote` allows it (the author, or an admin of the scope). It opens an `AlertDialog`: `Archive "{title}"?`, `New tasks stop getting it. Tasks running now keep what they started with. You can restore it from Archived.`, `Archive` (outline) and `Cancel`. On the Archived tab it's `Restore`, with no dialog.

## States

| State | What shows |
|---|---|
| **Notes, one selected** (`memory.webp`) | As above |
| Loading | Title at once; lede, tabs and filters as `Skeleton` lines (filters drawn, disabled); 8 skeleton rows (title and source widths). The panel: 2 skeleton lines and 5 skeleton rows |
| **No notes yet** (the scope has none, no filter) | No filter row, no panel (`.content.full`), no index line. The Deep water illustration (`../m2/inbox-empty-illustration.webp`, B-017) centred in a 560×373 box, 40px under the tabs. Then `No notes yet` (15px, 600) and, 8px under, 13px `--muted`: `A note is one thing every new task in {project} should know: a convention, a command, a gotcha. Write one, or approve one an agent proposed.` (organization: `…every new task in Acme Corp…`). The top bar's `New note` is the action; no second button. With proposals waiting, a teal `{n} proposals waiting →` line under the text |
| **No match** (a search or filter narrows to nothing) | No illustration. One 14px `--muted` line 24px under the filters, `No note matches "{q}".` (or `No note matches these filters.`), then a teal `Clear filters`. The panel shows nothing |
| Archived tab | The same list, titles in `--muted`, no Always chips, last used kept. The panel's head shows `Restore`; no `Always` switch. No index line |
| Archived, empty | One 14px `--faint` line, 24px under the filters: `Nothing archived.` |
| A note changed elsewhere while selected | The live change notice refetches the list and the selected note; the panel shows the new version without a jump. If it was archived, the selection moves to the next row and a 13px `--muted` line in the panel says `{member} archived this note.` for 5 seconds |
| `Always` switch refused | The switch flips back; a 13px `--red` line with `circle-alert`, `role="alert"`, `errorText(error)`, under the rows |
| Error loading | `role="alert"`, `--red`, `errorText(error)` where the list would be, with a teal `Retry`. Filters stay usable |
| A restricted project the member can't open | The route is not found (ticket 29's `NOT_FOUND`), as every project page |
| Phone width (F-075) | The panel opens as a full-screen `Sheet` on a row's tap. Rows keep the kind icon, the title and the Always chip on line one, and kind · source · last used on line two in 13px `--faint`. Filters scroll sideways in one row; the search goes full width above them |

**Keyboard:** `/` focuses the search; `↑`/`↓` move the selection; `Enter` on the selected row opens the editor; `n` opens New note (when focus isn't in a field).

## Kind icons

Lucide, 16px in the list and 15px in the panel, always `--muted`, always beside the kind's word (in the list, the Kind word column; in the panel, its head line):

| Kind | Icon |
|---|---|
| `convention` | `ruler` |
| `command` | `terminal` |
| `gotcha` | `triangle-alert` (grey, never amber or red: it's a pitfall, not an error) |
| `decision` | `gavel` |
| `preference` | `thumbs-up` |
| `term` | `book-a` |

## Components (shadcn/ui names)

- **From the repo:** `PageFrame` (with `wideProperties`), `PageHeading`, `PropGroup`, `PropRow`, `Button`, `Input`, `Switch`, `Avatar`, `Tooltip`, `Skeleton`, `AlertDialog`, `Sheet`; from milestone 2 and 3, the Inbox's filter `Popover` + `Command` and the Needs you page's `Tabs`.
- **New in `components/ui/`:** `Toggle` (on `radix-ui`), if milestone 3 hasn't added it.
- **New:** `src/app/(panel)/projects/[project-id]/memory/page.tsx`, `src/app/(panel)/organization/memory/page.tsx`, and `components/memory/` (`note-list`, `note-row`, `note-panel`, `kind-icon`, `note-body`, `index-line`). `note-body` (the backtick-only renderer) and `kind-icon` are shared with `memory-note` and `memory-proposals`.
- **Icons:** Lucide 15px stroke 1.75: `book-open`, `lightbulb`, `plus`, `search`, `chevron-down`, `pin`, `info`, `circle-alert`, and the kind icons above.

## Tokens (`app-concepts/html/graphite.css`, at the pictures' scale)

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page, panel |
| `--side` | `#0A0B0C` | sidebar |
| `--surface` | `#131416` | search, outline buttons, inline code |
| `--raise` | `#17181B` | row hover |
| `--sel` | `#1A1B1E` | the selected row, a pressed `Always only`, the selected sidebar row |
| `--line` | `#1F2023` | hairlines, the tabs' rule, the panel border, the code chip's border |
| `--line-2` | `#2A2C30` | control borders, the Always chip, the switch's track |
| `--text` | `#F2F3F4` | titles, the body, values |
| `--muted` | `#B4B7BB` | lede, kind words, sources, icons, panel keys |
| `--faint` | `#8B8E93` | counts, ages, `v{n}`, the index line |
| `--teal` | `#6FB8AA` | `Edit`, task keys in the panel, `All versions →`, `Archive note`, `Clear filters`, `Retry` |
| `--red` | `#E5675C` | refusals, load errors |
| `--amber` | `#FFB224` | **not on this page.** Only the sidebar's project dot. Proposals are a plain count |

- **Type:** Manrope 700 26px title; IBM Plex Sans 14.5px rows and body, 17px/600 the panel's title; IBM Plex Mono for task keys, counts, ages, versions and inline code.
- **Heights:** rows 40px (56px with a search line), tabs 32px, filters and top-bar buttons 30px, the Always chip 24px, panel rows 30px. **Radii:** 6px rows and chips, 7px controls, 5px inline code.

## Differences from the current code

1. **There's no Memory page.** No routes, no `components/memory/`, no `memory` router (ticket 29), no `MemoryNote`, `MemoryNoteVersion`, `MemoryProposal` or `MemoryUse` (ticket 05). Everything is new.
2. **The sidebar** (`sidebar.tsx`) has neither Memory row, and the open project's items stop at Environment. Add `Memory` after Boards in the project, and under Organization, each with its proposals count from `memory.notes`'s count (live through the change notices).
3. **The index line** needs the domain's index builder to report what it would include (`buildMemoryBlock`'s `indexNoteIds`, `alwaysNoteIds` and `omitted`), without rendering the block. Ticket 29 should return those counts with `memory.notes` for an unfiltered scope; say so in its `## Comments`.
4. **`Tabs`, `Popover`, `Command`** come from milestones 2 and 3's tickets; reuse them. `Switch`, `AlertDialog`, `Sheet` and `Avatar` exist.
5. **New message keys** (`apps/web/messages/en.json`): `shell.memory`; `memory.title`, `.ledeProject`, `.ledeOrganization`, `.tabProject`, `.tabOrganization`, `.tabNotes`, `.tabArchived`, `.proposals`, `.newNote`, `.search`, `.kind`, `.kindAll`, `.kinds`, `.source`, `.sourceMember`, `.sourceProposal`, `.sourceDiffComment`, `.sourcePrComment`, `.alwaysOnly`, `.notes`, `.always`, `.never`, `.indexLine`, `.indexCut`, `.alwaysOver`, `.empty`, `.emptyBody`, `.proposalsWaiting`, `.noMatch`, `.noMatchFilters`, `.clearFilters`, `.archivedEmpty`, `.edit`, `.restore`, `.scope`, `.scopeOrganizationNote`, `.version`, `.mergedFrom`, `.edited`, `.lastUsed`, `.used`, `.sessions`, `.versions`, `.allVersions`, `.archive`, `.archiveTitle`, `.archiveBody`, `.archivedBy`, the version lines, and one per kind (`memory.kind.convention` …).

## Wrong in the image (build from this file)

The image's copy is spelled right everywhere. These details differ from what to build:

- **The ages** (`4m`, `12m` … `Never`) render in the sans face. Build mono 13px `--faint`.
- **The task keys in the Source column** (`CALC-142`) are `--text`. Build mono `--muted`, as links.
- **`Archive note`** is underlined, word by word. Build a teal text button with no underline.
- **The panel's ages** (`3h ago`, `2h ago`) set `ago` in mono too. Build the number and unit in mono and `ago` in sans, as the rows say.
- **The `Always` switch** sits a little low against its key. Align it to the row's centre.
- **The index line** under the list is missing. Build it (the main column's item 6): here it reads `New tasks get the 2 "always" notes in full and the other 8 as an index to search.`
- **The sidebar** is drawn from the image's own shell, with Organization rows from other milestone 4 screens. Build it from `sidebar.tsx`. Its `Memory 3` is right: the count is proposals, not notes.
- **The panel** starts at x 1055 (385px). Build 380px, `wideProperties`.
- **The notes, people, keys and counts** are demo data (the demo's own note, `Check JavaScript with node`, at version 2 after step 9's merge). Build from `memory.notes` and `memory.note`.

Right as drawn: the kind icons, the Always chips after the title, one selected row, the plain `Proposals 3` button beside the one primary `New note`, the scope tabs with counts, and the panel's order (kind, title, body with its code chip, rows, versions, archive).
