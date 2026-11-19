# Target: one memory note's editor and history (milestone 4, screen 15)

> **Committed image:** `memory-note.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel.

- **Prompt:** `memory-note.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 2 generations. The first had the layout and copy right, but set the Title input in mono, underlined the links, boxed `Archive note` and promised in the refusal that "the agent's tools can use" the token. The second, kept, is a constrained redraw of the first. References: the approved 2048 original of `app-targets/m3/agent-profile` (the screen this one starts from, spec section 12), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`, plus the first generation for the second.
- **Routes (new):** `apps/web/src/app/(panel)/projects/[project-id]/memory/[note-id]/page.tsx` and `.../memory/new/page.tsx`; `apps/web/src/app/(panel)/organization/memory/[note-id]/page.tsx` and `.../memory/new/page.tsx` → `components/memory/memory-note-editor.tsx`.
- **Features:** F-109 (memory notes), and the sources F-111 writes. Spec section 12, screen 15; section 11, item 11; ADR 0044 (amended, "Milestone 4: memory in practice"). Ticket 29 (`memory.note`, `memory.save`, `memory.archive`), ticket 16 (`saveNote`, the secret scan, versions), ticket 38 (this screen).
- **Status:** a proposed target, waiting on approval (ticket 31's `## Comments`). Ticket 38 builds its data and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

One fact a project (or the organization) wants every task to know: its title, body and kind, whether agents get it whole at every session's start ("always"), where it came from, and every version it has had. A member who can open the project edits it and saves; the author, a project admin (an organization admin for an organization note) archives it.

The page has to make two things plain:
- **A note is text agents follow.** The lede says how agents get it (in their index, or whole), and the footnote says each save is scanned.
- **Memory never holds a credential.** A save that holds one is refused, the refusal names the kind it found and never the value, and nothing is stored.

The picture shows `Check JavaScript with node` in `calculator`, at version 2 (merged from Sam Rivera's diff comment, as in the spec's demo, step 9), after Alex Kim added a line with a GitHub token and pressed Save.

## Layout (CSS px at 1440 wide)

The panel's measured scale (`../m1/README.md`, "Scale") holds: body 14.5px (`text-body`), dense rows and fields 14px (`text-ui`), secondary 13px (`text-sm`), small labels 12px (`text-xs`), lede 15px (`text-lede`), title 26px (`text-title`).

| Region | Size | Contents |
|---|---|---|
| Sidebar | 234px, the shared shell | Built from `components/shell/sidebar.tsx`, never from the picture. The open project's **Memory** row selected (Lucide `book-marked`), with the scope's open proposals as a plain `--faint` mono count (never amber). An organization note selects Organization › **Memory** |
| Top bar | 46px, hairline under | Crumbs `Acme Corp › calculator › Memory › Check JavaScript with node` (`Memory` links to the Memory page; the last part `--text` 500). An organization note: `Acme Corp › Memory › {title}`. Right, for a member who may write: a ghost `Discard changes` (shown only while edited) and **Save note**, the page's one primary button, disabled until something changed |
| Main column | `1fr`, padding `28px 36px`, content max 720px | eyebrow, title, lede, the Note section (fields, body, refusal), Versions, footnote |
| Properties panel | **380px** (`wideProperties`: it holds a switch and a button), 1px `--line` on its left, padding `20px 18px` | Note, Always, Source, Archive |

### Heading

1. **Eyebrow,** Plex Mono 12px `--faint`: `Memory note · version 2 · saved 1h ago`. New: `New memory note`. Archived: `Archived 12 Nov`.
2. **Title:** the note's title, Manrope 700 26px, letter-spacing −0.015em; it follows the Title field as it's typed. New and still untitled: `New note`.
3. **Lede,** 15px `--muted`, one line, 8px under the title:
   - always off: `Agents in {scope} get its title in their index, and read the whole note when they need it.`
   - always on: `Every session in {scope} starts with the whole note.`
   - `{scope}` is the project's name, or `this organization` for an organization note.
4. **Status line** after a save (`role="status"`), 13px: a `check` icon and `Saved as version 3.` in `--green`.

Sections are `Section`s, 26px apart: a title line (Plex Sans 600 14.5px), an optional count (Plex Mono 12px `--faint`), an optional inline note (13px `--muted`), then the content 10px down.

### Note

- **Three labelled fields in one row,** 12px apart; labels 12px 500 `--muted`, 6px above; controls 34px, `--surface`, 1px `--line-2`, radius 7px, 14px Plex Sans:

| Field | Width | Contents |
|---|---|---|
| Title | flex (~310px) | `Input`, Plex Sans. Required, at most 120 characters (the protocol's limit); over it, `{n} characters over the limit.` in `--red` under the field |
| Kind | ~194px | `Select` of `MemoryKind`, each with its Lucide icon 15px `--faint`: `Convention` (`ruler`), `Command` (`square-terminal`), `Gotcha` (`triangle-alert`), `Decision` (`signpost`), `Preference` (`heart`), `Term` (`book-a`) |
| Scope | ~194px | The project's 8px colour square and name, or `building-2` and `Organization`. **Editable only on a new note** (a `Select` of the organization and the projects the member can open, defaulting to the page's scope). On a saved note it's read-only, the same box with no chevron and a `Tooltip` `A note keeps its scope. Write a new one in the other scope.` (see "Open points") |

- **Body:** label `Body`, then a `Textarea`: `--surface`, 1px `--line-2`, radius 8px, padding `10px 14px`, **Plex Mono 13px / line-height 1.75**, at least 3 lines, grows with its text. Placeholder: `One fact, in a sentence or two. Commands and paths as you'd type them.`
  - Under it, right-aligned, Plex Mono 12px `--faint`: the body's UTF-8 size against the limit, `214 B of 4 KiB` (`1.2 KiB of 4 KiB` past 1 KiB). Over the limit it turns `--red` and `Save note` is disabled.
- **The secret refusal** (the picture). When `memory.save` answers `BAD_REQUEST` with `found`:
  - the body's border turns `--red`, and the body gets `aria-invalid="true"` and `aria-describedby` the refusal
  - under the counter, `role="alert"`, 13px: a `circle-alert` 15px and `This note holds {found}. Memory never holds credentials.` in `--red`; on the next line, 13px `--muted`, aligned with the text after the icon: `Nothing was saved. A token belongs in {project}'s environment secrets.` with `{project}'s environment secrets` a teal link to the project's environment (`/projects/{id}/environment#secrets`). An organization note: `Nothing was saved.` alone
  - `{found}` comes from the scan's kind: `a GitHub token`, `a GitLab token`, `a Slack token`, `an AWS access key`, `a Google Cloud key`, `an Azure key`, `a private key`, `an Authorization header with a value`, `a URL with a password in it`, `the value of one of the organization's secrets`. The value is never shown or logged, and the page doesn't mark where in the body it is (the API doesn't say)
  - the refusal stays until the body changes, then clears
- The title is scanned too (ticket 16 scans the whole note); a hit there shows the same alert with the Title input's border `--red`.

### Versions

- Title `Versions`, count `2`, note `every save keeps the one before it`.
- Rows, 40px, a 1px `--line` hairline above each and under the last, newest first. One grid:

| Column | Width | Contents |
|---|---|---|
| Version | 48px | Plex Mono 13px `--faint`: `v2` |
| What | 180px | 14px `--text`: `Written by hand` (v1 from a member), `Edited` (a member's later save), `Approved from a proposal` (v1 from "Approve as a new note"), `Merged from a proposal` ("Merge into …") |
| Who | 120px | 14px `--muted`: the member who saved or decided it (`editedByMemberId`) |
| Source | `minmax(0,1fr)` | 13px `--muted`, for a version with a `proposalId`: `proposed by {agent} in {KEY}`, `{member}'s diff comment on {KEY}`, `{member}'s PR comment on {KEY}`, `the closing turn of {KEY}`, the key a teal Plex Mono link to the task (no underline; underline on hover). Empty for a member's own save |
| When | 64px, right | Plex Mono 12px `--faint`: `1h ago`, `3 Nov` past a week |
| View | 40px, right | a teal `View` link, no underline |

- **`View`** expands the row in place: a block with a 2px `--line-2` left rule (never a card) and 12px left padding, holding that version's title (14px `--text`), its kind and `always` as outline chips, and its body in Plex Mono 13px `--muted`; then a teal `Use this text`, which fills the editor with it (saving makes a new version; nothing is rolled back), and `View` reads `Hide`. One row open at a time.
- Under the rows, 8px down, 13px `--faint`, only while edited: `Unsaved changes would become version {n+1}.`
- More than 10 versions: the newest 10, then a ghost button `Show all {n} versions`.

### Footnote

22px under the last section: Lucide `shield-check` 14px `--faint`, then 13px `--muted`: `A note is text every agent in {scope} follows. Each save is scanned for credentials, and a note that holds one is refused.`

### Properties panel

`PropGroup`s with a 12px 500 `--faint` label, 30px `PropRow`s with a 96px key column, 14px; keys `--muted`, values `--text`; a 1px `--line` between groups. Help text 12px `--faint`, 6px under its control.

1. **Note:** `Status` · a 7px dot and the word: `--green` with its halo, `Active`; `--faint`, `Archived`; `--faint`, `Not saved yet` on a new note. `Version` · `2`. `Last used` · `2h ago in CALC-161` (the key in Plex Mono, a teal link to the task), or `Not used yet` in `--faint`. `Used` · `9 times in 6 tasks` (`useCount`, and the distinct tasks in `MemoryUse`).
2. **Always:** the row `Always give it whole` (14px `--text`) with a `Switch` at the right, which it labels (`aria-labelledby`) (on: `--teal` track, `--ink` knob; off: `--line-2` track). Help: `Every session starts with the whole note, not only its title. {scope}'s always notes use {used} of 8 KiB.` Turning it on counts as an edit (Save note enables). When this note would push the scope past 8 KiB, the help ends `Past 8 KiB, project notes and the most recently used come first, and the rest are left out.` (ADR 0044's order) in `--muted`.
3. **Source** (`sourceKind`, `sourceTaskId`, `sourceRef`):
   - `From` · `Written by Sam Rivera` (member), `OpenCode's proposal` (an agent's proposal), `Sam Rivera's diff comment`, `Sam Rivera's PR comment`, `A closing turn`
   - `Task` (when there is one) · the key, a teal Plex Mono link, then the task's title in `--text`, truncated with the full title in `title`
   - `Comment` (diff and PR comments) · the comment's first line in `--muted`, in quotes, truncated, linking to the comment on the task's Changes tab or thread
   - `Approved` (a note from a proposal) · `3 Nov by Sam Rivera`
4. **Archive** (only for whoever `canArchiveNote` allows): a ghost button, 30px, Lucide `archive` 15px, `--muted` text, `--red` text on hover: `Archive note`. Help: `Archived, it leaves the index and search. Its versions stay.` A member who may write but not archive sees, in place of the button, 12px `--faint`: `{author} or a project admin can archive it.` (`an organization admin` for an organization note).

## States and copy

| State | What changes |
|---|---|
| Loading | the title as a 220px `Skeleton`; the fields and body as skeleton boxes; two skeleton version rows; the panel's values as skeleton bars |
| Saved, unchanged | `Save note` disabled; no `Discard changes` |
| Edited | `Save note` enabled; `Discard changes` shown; `Unsaved changes would become version {n+1}.` Leaving with changes opens an `AlertDialog`: `Leave without saving?` / `Your changes to {title} are lost.` / `Stay` and `Leave` |
| Saving | `Save note` reads `Saving…`, disabled |
| Saved | the status line `Saved as version {n}.`; the eyebrow `Memory note · version {n} · saved just now`; the new version tops the list |
| **Refused: a credential** (the picture) | as "The secret refusal" above. Nothing stored, no version, no audit entry |
| Refused: someone saved first | `role="alert"` under the lede, 13px `--red`: `Sam Rivera saved version 3 while you were editing. Your text is still in the editor: copy what you need, then reload.` with a teal `Reload` (see "Data") |
| Other save errors | under the lede, `role="alert"`, 13px `--red`, `errorText(error)`: `Give the note a title.`, `The body is over 4 KiB.` |
| New note (`/memory/new`) | eyebrow `New memory note`, title `New note` until titled; Kind `Convention`; Scope the page's scope, editable; empty body; always off; no Versions section; the panel's Note group reads `Status` · `Not saved yet`, with no Source or Archive group. `Save note` is enabled once Title and Body are set; on success the page moves to the note's route with `Saved as version 1.` |
| Archive confirm | `AlertDialog`: `Archive {title}?` / `Agents stop getting it, and search no longer finds it. Its versions and sources stay.` / `Cancel` and `Archive note` (primary). `Archiving…` while pending; on success, back to the Memory page with the note under its Archived filter |
| Archived | eyebrow `Archived 12 Nov`; every field read-only; no `Save note`; versions still viewable, without `Use this text`; the Archive group reads `Archived 12 Nov by Sam Rivera.` in `--muted` |
| A member who can open the project but may not write | (none in milestone 4: every member who can open the project writes its notes, ADR 0044 amended.) Kept for later roles: read-only, as Archived without its eyebrow |
| A note in a project the member can't open, or an unknown ID | `NotFound`-style body: `No such note.` and a teal `All of {scope}'s memory` (the API answers `NOT_FOUND`, never saying it exists) |
| A link to another organization's note | the panel switches organization and says so (spec section 3, step 12; `org-switcher`'s notice), then shows the note |
| Load failed | the error alert in place of the sections, with a teal `Retry` |
| Narrow (below 1280px) | the panel drops under the main column (`PageFrame`); the three fields wrap to one per line below 900px; the version rows lose the Who column (it moves under What in 12px `--faint`) |
| Phone (F-075) | one column; version rows two lines (`v2 · Merged from a proposal`, then who, source and when); `View` blocks full width |

**Keyboard:** `Ctrl+S` / `⌘S` saves when `Save note` is enabled. `Esc` closes an open version block.

## Components (shadcn/ui names)

`Sidebar`, `PageFrame` with `Breadcrumb` and `properties` (`wideProperties`), `PageHeading`, `Section`, `Input`, `Textarea`, `Select` (existing `ui/select.tsx`), `Button` (default = the Shell primary; ghost for `Discard changes`, `Archive note`, `Show all`), `Badge` (outline: kind, `always` in the version block), `Switch` (existing), `AlertDialog` (existing), `Tooltip` (existing), `Skeleton`, `PropGroup` / `PropRow`, `Status`. Lucide 15px, stroke 1.75: `book-marked`, `ruler`, `square-terminal`, `triangle-alert`, `signpost`, `heart`, `book-a`, `building-2`, `circle-alert`, `check`, `shield-check`, `archive`, `chevron-down`.

## Tokens (`apps/web/src/app/globals.css`, the measured values)

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page, panel |
| `--side` | `#0A0B0C` | sidebar |
| `--surface` | `#131416` | inputs, selects, the body |
| `--raise` | `#17181B` | version row hover |
| `--line` | `#1F2023` | row hairlines, panel edge, group lines |
| `--line-2` | `#2A2C30` | control borders, the open version's left rule, the switch's off track |
| `--text` | `#F2F3F4` | values, version descriptions |
| `--muted` | `#B4B7BB` | lede, labels, notes, Who and Source columns, the refusal's second line |
| `--faint` | `#8B8E93` | eyebrow, counts, version numbers, times, help, the byte counter |
| `--sel` | `#1A1B1E` | the sidebar item |
| `--teal` | `#6FB8AA` | task keys, `View`, `Use this text`, the environment link, the switch's on track |
| `--green` | `#4FB286` | the `Active` dot (halo `rgba(79,178,134,0.15)`), `Saved as version 3.` |
| `--red` | `#E5675C` | the refusal and its icon, the refused field's border, other save errors, archive on hover |
| `--amber` | `#FFB224` | only the sidebar's Needs you count. Nothing here is amber: a note waits on nobody |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | `Save note`, the archive dialog's confirm |

Type: Manrope 700 26px (title); IBM Plex Sans 14.5px body, 14px fields and panel rows, 13px notes and secondary, 12px labels and help, 600 for section titles, 500 for buttons; IBM Plex Mono for the eyebrow, the body, the byte counter, version numbers, times and task keys. Radii: 7px controls, 8px the body, 6px chips.

## Data this screen needs beyond ticket 29

- **`memory.save` takes the version the member started from** (`expectedVersion`) and answers `CONFLICT` with who saved and which version, so two members editing at once don't overwrite each other silently. Ticket 16 already takes the note's lock for gap-free versions; this is the check under that lock.
- **The refusal's kinds as words.** `found` is a closed union in `packages/domain`'s scan; `messages/en.json` holds one phrase per kind (`memory.found.*`), with `satisfies never` over the union.
- **Last used and Used:** `lastUsedAt` and `useCount` are on the note; the task of the last use and the count of distinct tasks come from `MemoryUse` (`memory.note` returns `lastUsedTaskId` and `usedInTasks`).
- **The always budget:** the size of the scope's active always notes, for the switch's help (`memory.note` returns `alwaysUsedBytes`; the limit is `OSTRA_MEMORY_ALWAYS_MAX_KIB`).
- **The source's comment text** for diff and PR comments, from `sourceRef`, so the Source group can quote its first line.
- **`canArchiveNote`** in `memory.note`'s answer, so the page shows the button or the line about who can.

## Differences from the current code

Checked against `apps/web`, `packages/api` and `packages/db` on `main` (2026-11-19):

1. **Everything is new.** No `memory` router, no `MemoryNote` tables (ticket 05), no `components/memory/`, no Memory rows in `sidebar.tsx`.
2. **UI pieces:** `Select`, `Switch`, `AlertDialog`, `Tooltip`, `Skeleton` and `Status` exist in `components/ui/`. `Textarea` and `Badge` don't yet; milestone 3's tickets add them, and if they aren't on `main` when ticket 38 starts, it adds them from shadcn/ui on `radix-ui` (no new dependency).
3. **Messages.** New keys under `memory.note.*` in `messages/en.json`, including every refusal phrase and error above.

## Open points (recommendations; ticket 38 records the answer)

1. **Changing a saved note's scope.** Recommended: not allowed; a member writes a new note in the other scope and archives this one. `MemoryNoteVersion` has no scope column, so a moved note's history couldn't say where it was, and moving a project note to the organization widens who sees it.
2. **Delete as well as archive.** F-109 says members "delete" notes; ADR 0044 (amended) says "archiving or deleting". Recommended: archive only in milestone 4, since an archived note keeps the sources and versions the audit log points at.
3. **Restoring an archived note.** Recommended: none in milestone 4 (`memory.archive` has no reverse); a member writes it again.

## Wrong in the image

Build the copy and details in this file, not these:

- **The token in the body** (`GITHUB_TOKEN=ghp_EXAMPLE…`) is a fake drawn for the picture, and one character in it is garbled. The page shows whatever the member typed; nothing on the page marks it.
- The Scope field is drawn as an editable select with a chevron. On a saved note it's read-only with no chevron (open point 1).
- The `View` links and the panel's `CALC-118` are underlined. Teal, no underline (underline on hover only).
- The Kind icon is drawn as `>_`. Build Lucide `square-terminal`.
- The sidebar shows Organization rows from later milestones and a project list from demo data. Build it from `sidebar.tsx`.
- The panel is drawn about 396px wide. Build 380px.
- `Last used` draws `CALC-161` in white mono; it's a teal link.
- The `Source` group has no `Comment` row: this note's source is an agent's proposal, which has none.
- The picture has no loading, saved, new, archived, conflict, version-open or dialog states: they're in the tables above.

All visible copy in the image is spelled right.
