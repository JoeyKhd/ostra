# Target: a refine task's draft (milestone 6, screen 8)

> **Committed images:** `refine-draft.webp` and `refine-draft-applied.webp`, each downscaled from a 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel.

| Picture | State shown |
|---|---|
| `refine-draft.webp` | Alex Kim's refine task on `CALC-180` "Users want to see the version somewhere". The agent handed in two drafts (turns 1 and 2); Alex edited the second, so version 3 is his. He changed one acceptance criterion (the agent's words show under it) and uploaded `version-mock.png`. The task needs him: `Needs you · draft ready`. |
| `refine-draft-applied.webp` | Two minutes later. Alex pressed `Update ticket`, then `Mark ready`: version 3 is on Linear, the two sub-tickets are sub-issues `CALC-181` and `CALC-182`, the image is attached, the ticket is in `Todo`, and the task is done. |

- **Prompts:** `refine-draft.prompt.txt`, `refine-draft-applied.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), one generation each, kept as made. `refine-draft`: references `app-targets/m3/task-plan-edit.png` (the approved page this one starts from, spec section 12), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`. `refine-draft-applied`: an edit of the `refine-draft` generation, with the approved `m2/task-ticket` original and the logo.
- **Route:** the task page, `apps/web/src/app/(panel)/tasks/[task-id]/page.tsx`, with a new tab: `?tab=draft` (`components/tasks/draft/draft-view.tsx`). A refine task opens on it while a draft exists.
- **Features:** F-099 (refine tasks), F-036 (the draft's owner, `draft_ready`), F-097 (`Create ticket` for a prompt). Spec section 12, screen 8; section 3, step 2; section 4, "A refine task"; section 11, item 12. Ticket 27 (`drafts.*`), ticket 34 (this screen), ticket 15 (the server). ADR 0028 (amended).
- **Status:** proposed targets, waiting on approval (ticket 30's `## Comments`). Ticket 34 builds its data and tests until then, not its UI.

> Build it in real HTML/React (app-design.md, rule 5), then screenshot the build at 1440×956 and compare it with the pictures.

## Purpose

A refine task's agent reads the code, never pushes, and hands in a typed draft of the ticket with `submit_draft`. A member reads it, edits it, and writes it to the tracker. Nothing of a draft reaches Linear before a member presses a button (ADR 0011). The tab answers:

1. **What does the draft say?** Five typed fields, each editable: the description, acceptance criteria, edge cases, open questions and sub-tickets, plus images.
2. **Whose words are these?** The versions: each agent turn's draft and each member's edit, and, on a field a member changed, the agent's words beside it.
3. **What will Linear show?** `Preview` renders the description exactly as `Update ticket` writes it (sections for the fields Linear has no field for).
4. **Write it back:** `Update ticket` (description, images as attachments, sub-tickets as sub-issues), `Mark ready` (the board's "ready" status), or `Create ticket` for a refine task started from a prompt. After that, the applied state: what was written, with links.

## Layout (CSS px at 1440 wide)

`m2/task-ticket`'s page with milestone 3's tabs (`m3/task-plan`, `m3/task-changes`). The sidebar comes from the shell, the top bar keeps the copy-link button (no `Stop` while no turn runs; `Stop` shows during a turn, as on every task).

### Header

- **Key line:** `CALC-180 · from Linear` + a `.chip` `refine` (22px, mono 12px `--muted`, the kind's badge: `m1/task`'s growth for every refine and review task).
- **Title, status line, ticket strip:** as `m2/task-ticket`. The status line adds, after the state, `--muted` `Read-only: this task never pushes` (`never pushed` once done).
- **No context row** on the Draft tab; it stays on Activity.
- **Tabs:** `Activity`, `Draft` + mono `--faint` `v{n}` (the shown version). A refine task has no Changes or Checks tab (it changes nothing).

### The Draft tab, top to bottom

1. **Version line,** 14px under the tabs, 26px tall: `Version` 12.5px `--muted`, then one `.chip` per version, 24px: `v1 · agent`, `v2 · agent`, `v3 · your edit` (`v3 · Sam Rivera` for another member's). The shown one has the `--sel` fill and `--text`; the others `--muted` with a 1px `--line-2` border. More than 5: the newest 4 and a `+{n}` dropdown. Then 12px `--faint` `Saved {age} ago` (or `Saving…`). At the far right, a two-option segmented toggle, 26px: `Edit` | `Preview`.
   - An older version is read-only: its fields render as text, and a 12.5px `--muted` line replaces the buttons: `An earlier version. Editing it saves a new version from it.` with a teal `Edit from v1`.
2. **The draft block,** 12px under the version line. While the task needs someone, a 2px amber rule at its left (`NeedsYou` without its title row: the status line carries `Needs you · draft ready`); otherwise a 2px `--line-2` rule. 12px left padding. Each field has a 12px `--faint` label and, for lists, a mono `--faint` count; fields are 18px apart.
   - **Description:** a `Textarea`, `--surface`, 1px `--line-2`, radius 8px, auto-growing from 3 to 12 lines, 13px/1.5 `--text`. Markdown as text (the preview renders it).
   - **Acceptance criteria**, **Edge cases**, **Open questions:** lists, each item a 30px row: a `grip-vertical` 14px `--faint` (drag to reorder, and `Alt`+arrow keys), the mono number, a single-line `Input` (26px, radius 6px), an `x` 14px `--faint` (remove). Under each list a teal 12.5px `+ Add a criterion` / `+ Add an edge case` / `+ Add a question`. Empty lists show only the add link.
   - **An edited item** shows, under its row, indented to the input, 11.5px `--faint`: `edited by you · the agent's: {the agent's text}` (`edited by Sam Rivera` for another member). It compares with the newest agent version; a new item says `added by you`; a removed agent item leaves a line `removed by you: {text}` with a teal `Restore`.
   - **Sub-tickets:** rows of 30px: a `chevron-right` (expands), the title in an `Input`, at its right 12px `--faint` `{n} lines`. Expanded, a `Textarea` for its description under the title. `+ Add a sub-ticket`. At most 20.
   - **Images** + mono `{n} of 10`: one 52px row per image: a 64×40 thumbnail (`object-fit: cover`, radius 4px, `--surface`), the file name mono 12.5px, the size mono 12px `--faint`, an `x`. Then an outline `Upload` button (Lucide `upload`), 26px, which also accepts a drop and a paste anywhere on the tab. PNG, JPEG, GIF, WebP, at most 10 MiB each (milestone 2's cap).
   - **Buttons,** 28px, 8px apart: `Update ticket` (amber while the task needs someone, else Shell primary), `Mark ready` (outline), `Discard my edits` (ghost `--muted`, only on a member's version, back to the newest agent version after an `AlertDialog`).
   - **Footnote,** 12px `--faint`: `Update ticket writes version {n} to {key} on Linear and creates {k} sub-issues. Mark ready moves it to {ready status}.` (`creates {k} linked tickets` where the tracker has no sub-issues; no sub-issue clause with none).
3. **No composer on the Draft tab.** To ask the agent for another draft, the member uses Activity's composer (a new turn: the agent hands in the next version). The Activity tab's composer hint on a refine task: `Ask for changes to the draft. The agent hands in a new version.`

### Preview

`Preview` replaces the fields (not the version line or the buttons) with the description as Linear will show it, rendered as Markdown in a `--surface` block (radius 8px, 1px `--line`, padding 16px, max-height none): the member's description, then `## Acceptance criteria` as a checklist, `## Edge cases`, `## Open questions` as lists, and the images as `![name](attachment)` placeholders with their thumbnails. Under the block, 12px `--faint`: `Linear has no field for acceptance criteria, so they go in the description.` Then a `Sub-issues` list: each sub-ticket's title and its text, as cards would read in Linear, without boxes (title 13px 600, text 13px `--muted`). The preview is `drafts.get`'s `preview`, so it equals what `updateTicket` writes (ticket 27's test).

### Properties panel

`m2/task-ticket`'s groups, with:
- **Properties:** `Status`, `Driver`, `Kind` `Refine`, `Profile` `Refine` + `.chip` `built-in`, `Agent`, `Model`, `Runner`, **`Pushes`** `--muted` `None: read-only`, `Spend`. No `Box` row once the session is idle and released, as usual.
- **Draft** (new): `Versions` mono · `Latest` `Your edit, {age} ago` / `Agent, turn {n}` · `From agent` `v{n}, turn {t}`. Applied: `Applied` `v{n}, {time} by {name}` · `Ready` mono time.
- **Ticket:** `Key`, `Status`, `Board`.
- **On Linear:** before applying, 12px `--faint` `Nothing written yet. A draft reaches Linear only when someone presses Update ticket.` After: the sync list (`m2/task-ticket`'s), one row per write: `Updated the description`, `Attached {n} image(s)`, `Created {n} sub-issues`, `Moved to {status}`, each `--green` `done`, `pending` or `--red` `failed` with `Retry sync`.

## States and copy

| State | What shows |
|---|---|
| **Draft ready, edited** (`refine-draft.webp`) | as above |
| **Draft ready, untouched** | version chips `v1 · agent` …; no `edited by` lines; no `Discard my edits` |
| **The agent is drafting** (a turn running) | the version line shows `Drafting v{n+1}…` with a spinning `loader-circle` at its end; the fields stay editable, and a 12.5px `--muted` line above the buttons: `The agent is working on a new version. Your edits are saved as their own version.` `Update ticket` stays available for the shown version |
| **No draft yet** (the first turn) | the Draft tab shows one 13px `--faint` line: `No draft yet. The agent hands one in at the end of its turn.` |
| **Saving** | edits save as a member's version 1 s after typing stops (`drafts.save`): `Saving…`, then `Saved just now`. The first edit on an agent version creates the member's version and selects it. A failed save: `--red` `Not saved: {error}` with a teal `Try again`; the fields keep the text |
| **Uploading** | the new row shows a 2px `--muted` progress bar under the name and `Uploading…`; over the size cap: `--red` `{name} is over 10 MiB.`; at 10 images the `Upload` button disables with the `title` `10 images at most.` |
| **Updating** | `Update ticket` → `Updating…` (spinner), all fields read-only. Done: the On Linear rows fill in; the status line under the block, `role="status"`: `CALC-180 is updated on Linear. 2 sub-issues created.` The task moves to done; `Mark ready` stays available |
| **Mark ready** | moves the ticket to the board's ready status (`Todo` in the demo); `Mark ready` → `Marking ready…`, then `Moved to Todo`. A board whose ready status isn't confirmed yet: an `AlertDialog`, `Move CALC-180 to Todo?`, body `Calculator's mapping drafted Todo as its ready status. A project admin can change it on the Boards page.`, buttons `Cancel`, `Move to Todo` |
| **Applied** (`refine-draft-applied.webp`) | status `Done`; the block's rule `--line-2`; one 13px line at the block's top: `check` `--green` + `Version 3 applied to CALC-180 by Alex Kim` + mono `--faint` ` · 14:52` + `--muted` ` · moved to Todo`; the fields as read-only text (no inputs, grips, `x`, add links or upload); each sub-ticket as teal mono key + title + teal `sub-issue ↗`; each image with `check` `--green` `attached`; the buttons give way to 12px `--muted` `Edits now happen in Linear. To refine again, start a new refine task from the ticket.` (`start a new refine task` teal, opening New task with kind `refine` and the ticket). The version chip reads `v3 · applied`; `Saved` reads `Applied 2 min ago`. The Edit/Preview toggle stays, defaulting to the fields |
| **Partly applied** | a failed write leaves its On Linear row `failed`; the block's top line reads `triangle-alert` `--red` + `Version 3 is partly on CALC-180: the image wasn't attached.` and `Retry sync`. Writes are idempotent by version (ticket 15), so a retry creates nothing twice |
| **A prompt refine task** (`Create ticket`) | no ticket strip; `Update ticket` is `Create ticket`, and with several boards it opens a `DropdownMenu` of the project's boards (`Create on Calculator`). The footnote: `Create ticket makes a new ticket on {board} from version {n}, with {k} sub-issues.` After: the header gains the ticket strip, the key line the new key, and `Mark ready` applies to it |
| **Done without applying** | a member stopped the task, or it ended: the fields read-only, the line `This draft was never applied.` and `Create ticket` / `Update ticket` still available to any member who can open the project, until the task is reopened |
| **Loading** | the version line with two chip skeletons; five label + field `Skeleton`s |
| **Narrow (below 1280px)** | the panel drops under the page; the version line wraps the toggle under the chips; grips hide below 760px (reorder by the row's menu) |

## Components (shadcn/ui names)

- The task page's frame, tabs, header and properties (`PropGroup`, `PropRow`, `Separator`).
- `Textarea`, `Input`, `Button` (amber, Shell primary, `outline`, `ghost`, `link`), `ToggleGroup` (`Edit` | `Preview`), `Badge variant="outline"` (version chips, `refine`, `built-in`), `Collapsible` (sub-tickets), `DropdownMenu` (boards, older versions), `AlertDialog`, `Skeleton`.
- Drag to reorder: `@dnd-kit/sortable` is a new dependency; **ask first** (AGENTS.md). Without it, reorder by `Alt`+arrow keys and a row menu (`Move up`, `Move down`).
- The Markdown preview: the panel's `.agent-md` renderer (no raw HTML).
- Icons: Lucide 15px, stroke 1.75: `grip-vertical`, `x`, `plus`, `upload`, `chevron-right`, `check`, `triangle-alert`, `loader-circle`, `arrow-up-right`.

## Tokens (`app-concepts/html/graphite.css`)

> **Scale.** The sizes and colours below are `graphite.css`'s. The panel is built at the approved pictures' scale, which wins on size, spacing and contrast: body 14.5px, dense rows 14px, secondary 13px, small 12px, title 26px, `--muted` `#B4B7BB`, `--faint` `#8B8E93`, buttons 30px, a 46px top bar and a 320px properties panel (380px with a form). The measured values are in `../m1/README.md`, "Scale".

| Token | Value | Used for |
|---|---|---|
| `--amber`, `--ink` | `#FFB224`, `#0C1D21` | the status while the draft waits, the block's rule, `Update ticket` while it waits |
| `--surface` | `#131416` | fields, the image tile, the preview block |
| `--sel` | `#1A1B1E` | the shown version chip |
| `--line`, `--line-2` | `#1F2023`, `#2A2C30` | hairlines; field borders, the applied block's rule |
| `--text`, `--muted`, `--faint` | `#EDEDEE`, `#9A9DA3`, `#64676D` | field text; labels and lines; counts, `edited by`, sizes |
| `--teal` | `#6FB8AA` | add links, `Restore`, keys and `sub-issue ↗` once applied |
| `--green` | `#4FB286` | applied checks, `done`, `attached` |
| `--red` | `#E5675C` | failed saves, uploads and writes |
| `--shell` | `#F3F0E8` | `Update ticket` when nothing waits (Shell primary) |

Type: Manrope 700 24px; IBM Plex Sans 13px fields and rows, 12px labels; IBM Plex Mono for keys, version numbers, counts, file names, sizes and times.

## Data this screen needs beyond ticket 27

- `drafts.get` returns the fields, the versions, the images and the preview. Add: **per item, the newest agent version's text** (or a field-level diff), so `edited by` and `removed by` can show without a second call; **who made each member version**; the **board's ready status** and whether the mapping is confirmed; and **whether the tracker has `subIssues`** (the footnote's wording).
- The applied state reads the task's **ticket writes** (the sync list) and `RefineDraft.appliedAt`, `appliedByMemberId`, `readyAt`, and the **created sub-issues' keys** (`draft.applied`'s `subTickets`).

## Open points (the build takes the recommendation and records it in ticket 34's `## Comments`)

1. **Autosave or a Save button.** Recommended: autosave after 1 s as one member version per editing session (a new version only after another source wrote one in between), so versions don't pile up per keystroke.
2. **May `Update ticket` run twice?** Ticket 27 refuses each once the task is done. Recommended: once per version; to change it again, a new refine task (the applied state says so).
3. **Drag to reorder** needs `@dnd-kit/sortable` (a new dependency). Recommended: ask the maintainer; build keyboard reorder first either way.

## Differences from the current code

Checked against `apps/web` on `main` (2026-11-19), which holds milestone 1's task page; the tabs are milestone 3's.

1. **New tab** `?tab=draft` and `components/tasks/draft/` (`draft-view.tsx`, `draft-field-list.tsx`, `draft-images.tsx`, `draft-preview.tsx`, `draft-applied.tsx`).
2. **The task page** gains the kind's chip in the key line, `Pushes` in the panel for read-only kinds, and the Draft group. Refine tasks hide Changes and Checks.
3. **New UI primitives:** `Textarea`, `ToggleGroup`, `Badge`, `Collapsible` through the shadcn CLI (on `radix-ui`, already a dependency).
4. **Messages:** a `draft` namespace in `messages/en.json`, with plurals (`1 sub-issue`, `2 sub-issues`, `1 of 10`).

## Wrong in the images

Build the copy and details in this file, not these:

- **The version chips** are drawn about 28px; they're 24px. The selected chip has the `--sel` fill, not only a brighter border.
- **The `edited by you` line** draws `GET /version returns the version` in mono and `the agent's:` in sans; the whole line is 11.5px sans `--faint`, with only inline code in mono.
- **The panel's `Board` value** `Calculator` is drawn in mono; it's sans. Only the runner, keys, counts, times and spend are mono. The panel's group labels are 11px 500 `--faint`.
- **The applied picture** selects `Preview` but shows the fields: in the applied state the toggle defaults to the fields (`Edit` reads `Fields` there, since nothing is editable). Its status dot is drawn as a ring; it's the `--muted` done dot.
- **The applied block's top line** sets `14:52` in mono, which is right, and `moved to Todo` in mono, which is sans `--muted`.
- **The sidebar's rows** come from the shell, not the pictures.
- **The logo** approximates the Hinge mark. Use `kit/logo/export/ostra-hinge-single-color.svg`, 20px.
- The pictures have no drafting, empty, saving, uploading, updating, partly-applied, prompt-task, loading or narrow states: they're in the table above.

All visible copy in the images is spelled right.
