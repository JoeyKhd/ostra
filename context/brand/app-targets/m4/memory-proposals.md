# Target: memory proposals, the list and one proposal (milestone 4, screen 16)

> **Committed image:** `memory-proposals.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Prompt:** `memory-proposals.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 2 generations. The first had the layout and copy right, but drew robot faces on the agents' rows (the brief rules them out) and specks over `camelCase`. The second, kept, is a constrained redraw of the first. References: the approved 2048 original of `app-targets/m3/needs-you` (the screen this one starts from, spec section 12), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`, plus the first generation for the second.
- **Routes (new):** `apps/web/src/app/(panel)/projects/[project-id]/memory/proposals/page.tsx` and `apps/web/src/app/(panel)/organization/memory/proposals/page.tsx` → `components/memory/proposals-page.tsx`. The selected proposal lives in the URL (`?proposal={id}`); the tab too (`?tab=decided`).
- **Features:** F-111 (memory proposals), F-109 (the notes a decision writes). Spec section 12, screen 16; section 4 ("A proposal's decision"); section 11, items 14 and 15; ADR 0044 (amended). Ticket 29 (`memory.proposals`, `memory.proposal`, `memory.decide`), ticket 16 (`decideProposal`, related notes), ticket 38 (this screen).
- **Status:** a proposed target, waiting on approval (ticket 31's `## Comments`). Ticket 38 builds its data and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

Where a member decides what a project (or the organization) remembers. Agents propose notes while they work, and members propose them with "Remember this" on a diff comment or an `@ostra` comment. **Nothing reaches an agent until a member decides it** (ADR 0044): approve it as a new note, approve it and archive the note it replaces, merge it into a note (editing the merged text), or reject it.

The page has to make the decision easy to get right: the proposal and the notes it may contradict sit **side by side**, and the agent's own claim ("it contradicts Settings keys use camelCase") is shown, but ostra calls no model to judge it (spec section 11, item 14). Proposals are a count, never amber "needs you" (`domain-model.md`).

The picture shows `calculator`'s four open proposals, with the first, from `CALC-171` (the spec's demo, step 8, in Acme's data), selected and "Merge into Settings keys use camelCase" pressed.

## Layout (CSS px at 1440×960)

The panel's measured scale (`../m1/README.md`, "Scale") holds: body 14.5px (`text-body`), dense rows 14px (`text-ui`), secondary 13px (`text-sm`), small labels 12px (`text-xs`), lede 15px (`text-lede`), title 26px (`text-title`).

| Region | Size | Contents |
|---|---|---|
| Sidebar | 234px, the shared shell | Built from `sidebar.tsx`, never from the picture. The project's **Memory** row selected (Lucide `book-marked`), with the open proposals' count as a plain `--faint` mono number (never amber). The organization's page selects Organization › **Memory** |
| Top bar | 46px, hairline under | Crumbs `Acme Corp › calculator › Memory › Proposals` (`Memory` links to the Memory page, target `memory`; `Proposals` `--text` 500). The organization's: `Acme Corp › Memory › Proposals`. Nothing on the right |
| Main column | `1fr`, padding `28px 36px` | Title, lede, tabs, the list, the selected proposal, the decisions, the merge editor |
| Properties panel | 320px, 1px `--line` on its left, padding `20px 18px` | The selected proposal's properties |

### Main column, top to bottom

1. **Title** `Proposals` (`PageHeading`: Manrope 700 26px, −0.015em).
2. **Lede,** 15px `--muted`: `What agents and members asked {scope} to remember. None reaches an agent until someone decides it.` (`{scope}` the project's name, or `this organization`).
3. **Tabs,** 16px under the lede, as Needs you's: underline tabs, 32px, 14px weight 500, 20px apart, a 1px `--line` rule under the row. `Open` + its count in Plex Mono 12px `--faint`; `Decided`, no count.
4. **The list,** 16px under the tabs: 40px rows, a 1px `--line` hairline under each, no boxes, newest first. One grid:

| Column | Width | Contents |
|---|---|---|
| Source icon | 28px | Lucide 15px `--faint`, by `sourceKind`: `git-branch` (an agent, while working, or its closing turn), `message-square` (a diff comment), `git-pull-request` (a PR comment) |
| Title | `minmax(0,1fr)` | 14px `--text` weight 500, one line, ellipsis |
| Source | 270px | 13px `--muted`: `{agent} in {KEY}`, `{agent}, closing turn of {KEY}`, `{member}, a diff comment on {KEY}`, `{member}, a PR comment on {KEY}`; the key Plex Mono `--faint` |
| Relation | 112px | the agent's declared relation, an outline chip, 24px, 12.5px `--text`, 1px `--line-2`, radius 6px: Lucide `not-equal` 13px + `contradicts`, or `arrow-up-right` 13px + `refines`. Empty when none was declared |
| Age | 44px, right | Plex Mono 12px `--faint`: `14m`, `1h`, `1d` |

   - **The selected row** has a `--sel` fill and 6px radius (`aria-selected`). Clicking a row selects it and replaces `?proposal=`; the page doesn't scroll to the top. Hover: `--raise`. Focus: a 2px `--muted` outline, inset.
   - **On load** the first open proposal is selected, unless the URL names one.
   - More than 20 open: the newest 20, then a ghost button `Show {n} more`.

5. **The selected proposal,** 24px under the list: two columns, 24px apart, **no cards**, the left ~44% and the right the rest.
   - **Left: `Proposed`** (label 12px 500 `--faint`):
     1. the title, 15px weight 600 `--text`
     2. 8px down: the kind as an outline chip (`convention`), then 13px `--muted` `for calculator` (`for this organization`)
     3. 12px down: the body, 14px `--text`, line-height 1.6, with backtick spans in Plex Mono (`config/settings.json`, `release`)
     4. 12px down, 13px `--muted`, when the agent declared a relation: `The agent says it contradicts {note}` / `The agent says it refines {note}`, the note's title in `--text` weight 500, a link to the note. A member's proposal from a comment shows instead `From Sam Rivera's comment on {path}:{line}` (diff) or `From Sam Rivera's comment on the PR` with a teal `Open the comment`
   - **Right: `Related notes`** (label 12px 500 `--faint`, then 12.5px `--faint` `ranked by their text`): the declared note first (when there is one), then the scope's three active notes ranking highest against the proposal (ticket 16's `ts_rank`), leaving out the declared one, so at most four rows. Each row two lines, a 1px `--line` hairline above each and under the last, padding 9px 0:
     1. line one: the note's title, 14px `--text` weight 500, a link to the note (`memory-note`); for the declared note, the same relation chip as the list; at the right the kind as an outline chip
     2. line two: the note's first line, 13px `--muted`, one line, ellipsis, Plex Mono for backtick spans
     - **The rows are the target picker** (`RadioGroup`, `role="radio"` per row): the selected row has a `--sel` fill and 6px radius, and names the target in "Approve and archive …" and "Merge into …". The declared note is selected first; with none declared, the top-ranked one
     - No related notes: one row in `--faint`: `No note in calculator is close to this one.`, and the two target buttons are disabled with the `Tooltip` `No note to archive or merge into.`
6. **The decisions,** under a hairline 20px below the columns, one row, 8px apart, wrapping on narrow widths. Outline buttons, 30px, radius 7px, 14px weight 500:
   - `Approve as a new note`
   - `Approve and archive {target}`: makes the note and archives the target. Disabled when the member may not archive the target (`canArchiveNote`), with the `Tooltip` `{author} or a project admin can archive {target}.`
   - `Merge into {target}`, with a 14px `chevron-down` (`chevron-up` while its editor is open, the button `--sel` filled, `aria-expanded`)
   - `Reject`, a ghost button at the row's right end, `--muted`, `--red` text on hover
   - Long target titles truncate at 28 characters inside the buttons, with the full title in `title`.
7. **The merge editor** (open in the picture), 12px under the decisions:
   - label 12px `--muted`: `Version {n+1} of {target}`
   - a `Textarea`, `--surface`, 1px `--line-2`, radius 8px, padding `10px 14px`, Plex Mono 13px / 1.75, at least 3 lines, grows with its text; prefilled with the target's body, a blank line, and the proposal's body, for the member to edit into one fact
   - the byte counter (`214 B of 4 KiB`) right-aligned under it, as the note editor's
   - 8px down: `Merge as version {n+1}`, the page's one primary button (Shell), and `Cancel` (ghost); then 12.5px `--faint`: `Its new version names this proposal as its source.`
   - The merge is scanned like any save; a hit shows the note editor's refusal (`memory-note.md`, "The secret refusal") under the counter, and nothing is stored.

### Properties panel: the selected proposal

`PropGroup`/`PropRow` (84px key column, 30px rows, 14px; keys `--muted`, values `--text`), groups apart by a hairline:

1. **Proposal:** `State` · `Open` (Decided tab: `Approved`, `Merged`, `Rejected`); `Kind` · `convention`; `Scope` · the 8px square and `calculator`, or `Organization`; `Proposed` · `14m ago`.
2. **Source:** `From` · `OpenCode, while working`, `OpenCode, closing turn`, `Sam Rivera, diff comment`, `Sam Rivera, PR comment`; `Task` · the key, a teal Plex Mono link to the task, and under it the task's title in `--text`, wrapping to two lines at most; `Driver` · the task's driver; `Session` · the session's number, Plex Mono.
3. **This task:** `Proposals` · `1 of 20` (`OSTRA_MEMORY_PROPOSALS_PER_TASK`). Hidden for a member's proposal from a comment.
4. 12px `--faint`, 10px under the last group: `An approved note reaches the next session, never a running one.`

## Deciding

- Each decision is one `memory.decide` call, one transaction with its audit entry (ticket 16).
- **While pending,** every decision button disables and the pressed one shows a 14px spinning `loader-circle`.
- **On success** a status line (`role="status"`), 13px `--green` with `check`, replaces the decisions row: `Approved as a new note.`, `Approved. Settings keys use camelCase is archived.`, `Merged into Settings keys use camelCase as version 2.`, `Rejected.`, with a teal `Open the note` after the first three. The row leaves the list on the next load, not under the pointer; it shows `Decided` in `--faint` in its Age column until then. `Next proposal →` (teal) selects the next open one.
- **Lost the race** (`CONFLICT`): `role="alert"`, 13px `--red`: `Sam Rivera decided this first: approved as a new note.` The decisions row hides.
- **Approve as a new note** makes the note from the proposal as it stands (title, body, kind, scope), version 1, source the proposal. A member who wants to change its words edits the note after. An approved note becomes the target `memory-note`.

## States

| State | What shows |
|---|---|
| **Open, with proposals** (`memory-proposals.webp`) | As above |
| Loading | Title at once; the lede and tabs as `Skeleton` lines; four skeleton rows; the two columns as skeleton blocks; the panel's values `–` |
| **Open, empty** | No list or columns. The Deep water illustration centred on the column: `../m2/inbox-empty-illustration.webp` (B-017), a 560×373 box, 40px under the tabs. Under it `No proposals` (15px, 600, `--text`) and `Agents propose notes while they work, and members with Remember this on a comment. They wait here for a decision.` (13px `--muted`, 8px under), then a teal `Back to Memory`. The panel is empty |
| **Decided** | The same list, newest decision first, paged by cursor (50). The relation column becomes the outcome, 13px `--muted`, up to 260px, right-aligned before the age: `Approved by Sam Rivera`, `Approved, archived {note}, by you`, `Merged into {note} by Alex Kim`, `Rejected by Sam Rivera`. Selecting one shows the two columns read-only: no target picker, no decisions; under them the outcome line and a teal `Open the note` |
| Decided, empty | One `--faint` line, 24px under the tabs: `Nothing decided yet.` |
| A proposal decided elsewhere while open here | The change notice refetches; the row shows the outcome in `--muted`, and an open merge editor keeps its text with the `CONFLICT` line above it |
| A proposal from a task the member can't open (the task's project restricted, an organization proposal) | The key shows in `--faint` without a link; the panel's `Task` reads `A task you can't open` |
| An unknown or other-scope `?proposal=` | The first open proposal is selected, and a 13px `--muted` line under the tabs: `That proposal isn't here.` |
| Error loading | `role="alert"`, `--red`, `errorText(error)` where the list would be, with a teal `Retry` |
| Narrow (below 1280px) | The panel drops under the main column; the two columns stay side by side down to 1000px, then stack (Proposed, then Related notes) |
| Phone (F-075) | One column. Rows two lines (title, then source and age; the chip after the title). The selected proposal opens as its own view under a back link `← Proposals`; the decisions stack full width; the merge editor full width |

**Keyboard:** `↑`/`↓` move the selection in the list; `Tab` moves into the proposal; in Related notes, arrow keys move the target (the `RadioGroup`); `Esc` closes the merge editor.

## Components (shadcn/ui names)

- **From the repo:** `PageFrame` (with `properties`), `PageHeading`, `PropGroup`, `PropRow`, `Button` (outline for the decisions, the Shell primary for `Merge as version {n}`, ghost for `Reject` and `Cancel`), `RadioGroup` (existing), `Tooltip` (existing), `Skeleton`.
- **From milestone 3** (`m3/needs-you.md`): `Tabs` (underline style), `Textarea`. Ticket 38 adds them from shadcn/ui on `radix-ui` if they aren't on `main` yet.
- **New:** `components/memory/proposals-page.tsx`, `proposal-row.tsx`, `proposal-detail.tsx`, `related-notes.tsx`, `merge-editor.tsx`; the refusal and byte counter shared with `memory-note-editor.tsx`, not copied. `Badge` (outline) for kind and relation chips.
- **Icons:** Lucide 15px, stroke 1.75: `book-marked`, `git-branch`, `message-square`, `git-pull-request`, `not-equal`, `arrow-up-right`, `chevron-down`, `chevron-up`, `loader-circle`, `check`, `circle-alert`.

## Tokens (`apps/web/src/app/globals.css`, the measured values)

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page, panel |
| `--side` | `#0A0B0C` | sidebar |
| `--surface` | `#131416` | outline buttons, the merge editor, chips |
| `--raise` | `#17181B` | row hover |
| `--sel` | `#1A1B1E` | the selected list row, the selected related note, the pressed `Merge into`, the sidebar item |
| `--line` | `#1F2023` | hairlines, the tabs' rule, the panel border |
| `--line-2` | `#2A2C30` | button and chip borders, the merge editor's border |
| `--text` | `#F2F3F4` | titles, the proposal's body, values |
| `--muted` | `#B4B7BB` | lede, sources, excerpts, panel keys, outcomes |
| `--faint` | `#8B8E93` | icons, keys in the list, ages, counts, labels, the panel's note |
| `--teal` | `#6FB8AA` | task keys in the panel, `Open the note`, `Next proposal →`, `Retry` |
| `--green` | `#4FB286` | the success line |
| `--red` | `#E5675C` | refusals, lost races, load errors, `Reject` on hover |
| `--amber` | `#FFB224` | **only** the sidebar's Needs you count. A proposal is never amber (`domain-model.md`) |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | `Merge as version {n}` |

- **`contradicts` is not red.** Red means errors and deletions (`app-design.md`); a contradiction is a question for the member, so its chip is neutral with the `not-equal` icon carrying the meaning beside the word.
- **Type:** Manrope 700 26px title; IBM Plex Sans 14px rows, 13px sources and excerpts, 15px/600 the proposal's title, 12px labels; IBM Plex Mono for keys, ages, counts, backtick spans and the merge editor.
- **Heights:** rows 40px, tabs 32px, decision buttons 30px, chips 24px. **Radii:** 6px selected rows and chips, 7px buttons, 8px the merge editor.

## Data this screen needs beyond ticket 29

- **The declared note plus three:** `memory.proposal` returns `relatesTo` (the declared note, with its relation) apart from `related` (the top three by `ts_rank`, the declared one left out), so the page can put the declared note first without a duplicate.
- **Each related note's first line, kind, author and `canArchiveNote`,** for its row and for disabling "Approve and archive …".
- **The task's driver, the session's number and the task's proposal count** for the panel (`memory.proposal`'s `source`).
- **The comment's path and line** for a diff-comment proposal (`sourceRef`), and the comment's anchor for `Open the comment`.
- **The merged text's prefill** is built on the client from the two bodies; `memory.decide({ kind: "merge", noteId, body })` takes the member's text.
- **The sidebar's count** is `memory.notes`' proposals count for the scope (ticket 29).

## Differences from the current code

Checked against `apps/web`, `packages/api` and `packages/db` on `main` (2026-11-19):

1. **Everything is new.** No `memory` router, no `MemoryProposal` table (ticket 05), no `components/memory/`, no proposals route.
2. **The sidebar** (`sidebar.tsx`) has no Memory row for a project or the organization. Ticket 38 adds both, each with its plain proposals count, never amber.
3. **UI pieces:** `RadioGroup`, `Tooltip`, `AlertDialog` and `Skeleton` exist; `Tabs`, `Textarea` and `Badge` don't on `main` yet (see Components).
4. **Messages.** New keys under `memory.proposals.*` in `messages/en.json`: the lede, the tabs, every source line, both relations, the four decisions and their success lines, the outcomes, the empty states, the conflict line.

## Open points (recommendations; ticket 38 records the answer)

**Decided 2026-11-19** by the recommendation, under `## Decided 2026-11-19` in ticket 38.

1. **Which notes rank as related for a project proposal.** Ticket 16 says "the scope's active notes". Recommended: the project's notes and the organization's, since a project note can contradict an organization note (and wins over it, ADR 0044), and the member should see both. An organization proposal ranks only organization notes.
2. **Editing a proposal before approving it as a new note.** Recommended: no; approve as it stands and edit the note (one version more, with the member as its editor). It keeps the proposal's text as the agent or member wrote it, for the audit.
3. **A reason on Reject.** `MemoryProposal` has no field for one. Recommended: none in milestone 4; the agent never sees the decision anyway.

## Wrong in the image (build from this file)

The image's copy is spelled right everywhere. These details differ from what to build:

- **No target is marked** among the related notes. The selected target (here `Settings keys use camelCase`) has a `--sel` fill.
- **Both relation chips use `not-equal`.** `refines` uses `arrow-up-right`.
- The task keys in the source column render in the sans face in places. Build Plex Mono `--faint`.
- **The merge editor has no byte counter.** Build it, as in the note editor.
- The `Merge into` button's chevron sits on its left. Put it after the label, pointing up while the editor is open.
- **The sidebar** shows demo projects and Organization rows from other milestones. Build it from `sidebar.tsx`; the Memory row's count comes from the API.
- The right panel starts at x 1122 (318px). Build 320px.

Right as drawn: one selected row in `--sel`, the neutral `contradicts` chip, the two columns without cards, three outline decisions and a ghost `Reject`, the one primary button in the merge editor, and no amber anywhere but the sidebar's count.
