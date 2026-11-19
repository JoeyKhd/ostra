# Target: the ticket template editor (milestone 2, screen 9)

> **Committed image:** `ticket-template.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel.

- **Prompt:** `ticket-template.prompt.txt`. GPT Image 2.6 through Higgsfield, 1 generation. References: `app-targets/m1/environment.png` (the closest approved screen: a code editor, a section per thing, a top-bar Save), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route (new):** `apps/web/src/app/(panel)/projects/[project-id]/settings/ticket-template/page.tsx` → `components/projects/ticket-template-view.tsx`. `/projects/[project-id]/settings` redirects here while the template is the project's only setting.
- **Features:** F-064 (ticket context). Spec section 12, screen 9. Ticket 31 (`projects.getTicketTemplate`, `saveTicketTemplate`, `previewTicketTemplate`), ticket 37 (this screen), ticket 06 (the renderer and its validator).
- **Status:** a proposed target, waiting on the maintainer's approval (ticket 32's `## Comments`). Ticket 37 builds its data and tests until then, not its UI.

> Build it in real HTML/React (app-design.md, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

A task started from a ticket gets the ticket as its first prompt, rendered through this template. A project admin edits the template here and sees, side by side, exactly what the agent would get for one of the project's Inbox tickets. Two promises are on the page: ticket text always sits in marked blocks (the agent reads it as data), and the preview is rendered for this page only and never logged.

The picture shows the state with the most on it: a custom template, edited and not saved yet, valid, previewed on `CALC-212`.

## Layout (CSS px at 1440 wide)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 232px, `--side`, 1px `--line` on its right | the shared sidebar. The open project `calculator` expands into Tasks, Inbox, Environment and **Settings** (Lucide `settings`, selected, `--sel`). Build it from `components/shell/sidebar.tsx`, not from the picture |
| Top bar | 44px, 1px `--line` below | breadcrumb `calculator › Settings › Ticket template`; on the right a ghost `Reset to built-in` (only on a custom template) and the page's one primary button, `Save template` (admins only) |
| Main | `1fr`, padding `28px 40px`, **no properties panel** | heading, then two equal columns with a 28px gap: Template on the left, Preview on the right |

The picture draws the sidebar at about 246px; build 232px. There is no properties panel: the preview is the page's second half, and a 340px panel would leave each half too narrow for a prompt (app-design.md's "every resource has one" bends here; the template has nothing else to show). Below 1280px the Preview column drops under the Template column.

### Heading

1. **Eyebrow,** Plex Mono 12px `--faint`:
   - built-in: `Built-in template`
   - custom, saved: `Custom · saved 3d ago` (relative time from the save)
   - edited: `Custom · edited, not saved` (the picture) or `Built-in · edited, not saved`
2. **Title** `Ticket template`, Manrope 700 24px, letter-spacing −0.015em.
3. **Lede,** 13.5px `--muted`, one line, max 760px: `The first prompt of a task started from a ticket. Ticket text always goes inside marked blocks, so the agent reads it as data, never as instructions.`

### Left column: Template

1. **Title line** (`Section`, 26px above): `Template` (Plex Sans 600 13px), inline note `placeholders in {{ }}, lists in {{#…}} {{/…}}` (12.5px `--muted`).
2. **Code editor:** `--surface`, 1px `--line-2`, 8px radius, padding `10px 14px`, Plex Mono 12.5px, line height 20px. Gutter of line numbers, `--faint`, right-aligned, about 24px wide, 14px before the text. Literal text in `--muted`; every `{{…}}` tag in `--text`. That two-tone highlight is the only syntax colouring. A line changed since the last save gets a 2px `--line-2` mark at the gutter's left edge. The editor grows with its text from 12 lines up to the viewport, then scrolls inside itself. It's a `textarea` under a highlighted mirror (or CodeMirror if the maintainer approves the dependency; ask first).
3. **Validation line,** 8px under the editor, 12.5px, `role="status"`:
   - valid: Lucide `check` 14px and `Valid · uses 10 placeholders` in `--green` (the count is the distinct placeholders the template uses)
   - invalid: Lucide `circle-x` and the validator's message in `--red`, `role="alert"`, e.g. `Line 12: {{ticket.asignee}} isn't a placeholder.` / `Line 7: {{/ticket.labels}} closes a list that isn't open.` The line's number in the gutter turns `--red`.
4. **Placeholders** (`Section`, count in mono `--faint`): rows 30px, hairlines between them, no box. Left column 220px: the placeholder in Plex Mono 12.5px `--text`; right: a short description in 12.5px `--muted`. Clicking a row inserts the placeholder at the caret (a list inserts both its open and close tags). The list, from ticket 06's validator (names are the proposal here; the renderer owns the final list):

| Placeholder | Description |
|---|---|
| `{{ticket.key}}` | The ticket's key, CALC-212 |
| `{{ticket.title}}` | Its title |
| `{{ticket.url}}` | Its link on the tracker |
| `{{ticket.description}}` | Its description, in a marked block |
| `{{#ticket.labels}}` | Each label: `{{name}}` |
| `{{#ticket.comments}}` | Each comment, oldest first: `{{author}}`, `{{body}}` |
| `{{#ticket.images}}` | Each image copied into the workspace: `{{path}}` |
| `{{#ticket.parent}}` | The parent ticket, if any: `{{key}}`, `{{title}}` |
| `{{#ticket.links}}` | Each linked ticket: `{{key}}`, `{{title}}` |
| `{{profile.instructions}}` | The agent profile's instructions |

### Right column: Preview

1. **Title line:** `Preview` (600 13px), the inline note `on` (`--muted`), then a `Select` 28px tall (`--surface`, 1px `--line-2`, 7px radius, `chevron-down`): the ticket key in Plex Mono, then its title, truncated (`CALC-212  Division by 3 rounds the wrong way`). The options are the project's Inbox tickets, newest first; the first one is chosen on load. At the far right of the line, Plex Mono 11.5px `--faint`: `1,184 characters`.
2. **Preview box:** `--surface`, 1px `--line-2`, 8px radius, padding `14px 18px`, Plex Mono 12.5px, line height 20px, `--text`, read-only, no line numbers, `white-space: pre-wrap`. It scrolls inside itself past the viewport. The marked blocks' marker lines (`┌ ticket text: description`, `└ end of ticket text`) are `--faint`; their exact text is the renderer's (ticket 06), shown verbatim, never restyled into a box.
3. **Note,** 10px under the box, 12px `--faint`, Lucide `eye-off` 13px: `Rendered on the server for this page only. Never logged.`

The preview re-renders 400ms after typing stops, through `previewTicketTemplate`. It renders the editor's text, saved or not. While the template is invalid, the last good preview stays, dimmed to 50% opacity, with nothing new rendered.

## States and copy

| State | What changes |
|---|---|
| Loading | eyebrow, editor and preview are `Skeleton` blocks (the editor 12 lines tall); the title, lede and top bar stay |
| Built-in, untouched | eyebrow `Built-in template`; no `Reset to built-in`; `Save template` disabled (nothing to save) |
| Custom, saved | eyebrow `Custom · saved 3d ago`; `Reset to built-in` shown; `Save template` disabled |
| Edited | eyebrow `… · edited, not saved`; changed lines marked in the gutter; `Save template` enabled (the picture) |
| Invalid | the red validation line and red gutter number; `Save template` disabled; preview dimmed |
| Saving | `Saving…`, disabled |
| Saved just now | the validation line becomes `Saved.` with `check` in `--green` for 4 s, then returns to the valid line; eyebrow `Custom · saved just now` |
| Save failed | under the lede, `role="alert"`, 12.5px `--red`: the error text (`errorText`) |
| Reset to built-in | an `AlertDialog`: title `Go back to the built-in template?`, body `Your custom template is replaced. Tasks already started keep the prompt they got.`, buttons `Cancel` and `Reset` (primary). Reset saves at once |
| Previewing | the box keeps its last render; a 2px-high `--line-2` bar runs along its top edge while the render is in flight. No spinner |
| No ticket to preview | the select is disabled and reads `No ticket yet`; the box holds one line in `--muted`, sans: `The Inbox has no ticket to preview on. Attach a board to the project first.` (`Attach a board` links to the boards page, teal) |
| Preview failed | the box holds `circle-x` and the error in `--red`, `role="alert"` |
| Leaving with unsaved edits | the browser's own leave prompt (`beforeunload`); in-app navigation asks `Leave without saving the template?` in an `AlertDialog` |
| Not a project admin | the editor is read-only (no gutter marks, no caret); no top-bar buttons; the placeholder rows don't insert; the lede gains a second sentence: `Only a project admin can change it.` The preview still works |
| Narrow (below 1280px) | Preview drops under Template; the placeholders list follows the preview |

## Components (shadcn/ui names)

`Sidebar` (existing `components/shell/sidebar.tsx`, with the new project rows Inbox and Settings), `PageFrame` with `Breadcrumb` (no `properties`), `PageHeading`, `Section`, `Button` (default = the Shell primary for `Save template`; `ghost` for `Reset to built-in`), `Textarea` under a highlighted mirror (or CodeMirror, if approved), `Select` / `SelectTrigger` / `SelectContent` / `SelectItem` (new), `AlertDialog` (new), `Skeleton` (new). Lucide 15px, stroke 1.75: `settings`, `check`, `circle-x`, `eye-off`, `chevron-down`.

## Tokens (`app-concepts/html/graphite.css`)

> **Scale.** The sizes and colours below are `graphite.css`'s. The panel is built at the approved pictures' scale, which wins on size, spacing and contrast: body 14.5px, dense rows 14px, secondary 13px, small 12px, title 26px, `--muted` `#B4B7BB`, `--faint` `#8B8E93`, buttons 30px, a 46px top bar and a 320px properties panel (380px with a form). The measured values are in `../m1/README.md`, "Scale".

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page |
| `--side` | `#0A0B0C` | sidebar |
| `--surface` | `#131416` | editor, preview box, select |
| `--line` | `#1F2023` | hairlines, the placeholder rows |
| `--line-2` | `#2A2C30` | editor, preview and select borders, the edited-line mark, the preview's progress bar |
| `--text` | `#EDEDEE` | `{{…}}` tags, the rendered preview, placeholder names |
| `--muted` | `#9A9DA3` | literal template text, lede, notes, descriptions |
| `--faint` | `#64676D` | eyebrow, line numbers, marker lines, character count, the never-logged note |
| `--sel` | `#1A1B1E` | the selected Settings row |
| `--green` | `#4FB286` | `Valid …`, `Saved.` |
| `--red` | `#E5675C` | validation errors, preview and save errors |
| `--teal` | `#6FB8AA` | `Attach a board` link |
| `--amber` | `#FFB224` | only the sidebar's Needs you count. Nothing on this page is amber |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | `Save template` |

Type: Manrope 700 24px (title); IBM Plex Sans 13px body, 12.5px notes and descriptions, 600 for section titles, 500 for buttons; IBM Plex Mono 12.5px for the template, the preview and placeholder names, 12px for the eyebrow, 11.5px for counts.

## Differences from the current code

Checked against `apps/web` on `main` (2026-11-19):

1. **New route and view.** Nothing exists yet: no `/projects/[project-id]/settings` route and no template view. Add `settings/page.tsx` (a redirect) and `settings/ticket-template/page.tsx`.
2. **Sidebar.** `components/shell/project-nav.tsx` expands a project into Tasks and Environment only. Milestone 2 adds Inbox (screen 4) and Settings (`settings` icon, `/projects/[id]/settings`, project admins only, since the template is all it holds).
3. **New UI pieces:** `Select`, `AlertDialog` and `Skeleton` aren't in `components/ui/` yet (it has button, field, input, label, sheet, status, switch). `radix-ui` is already a dependency, so they need no new package.
4. **Code editor.** The environment's setup script is still a plain `Textarea`, and its target (`m1/environment.md`) asks for the same gutter editor. Build one `CodeEditor` for both, with this screen's two-tone placeholder highlight as an option.
5. **Messages.** New keys under `ticketTemplate.*` in `messages/en.json` for every string above.

## Wrong in the image

Build the copy and details in this file, not these:

- The sidebar is about 246px. Build 232px.
- The edited-line mark on line 20 is a small dot, outside the gutter. It's a 2px `--line-2` bar at the gutter's left edge, the line's full height.
- The Placeholders list has a vertical rule between its columns and a ragged left inset (its rows start about 8px right of the section title). No vertical rule; rows start at the section title's left edge.
- The picture shows six placeholder rows and cuts the list off at the screen's edge. All ten are listed (the table above); the page scrolls.
- The comment's marker line is drawn in italics. Marker lines are upright Plex Mono, `--faint`.
- `Reset to built-in` sits close to the primary button. Give it an 8px gap, like every top bar.
- The picture has no loading, invalid, saving, reset, empty-Inbox or read-only states: they're in the table above.

All visible copy in the image is spelled right, and the preview matches the template line for line.
