# Target: the search palette

> **Committed image:** `search-palette.webp`, downscaled from a 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

The target for the panel's search palette, `apps/web/src/components/search-palette.tsx`: Ctrl+K or ⌘K over any panel page, a query with filter tokens, the top tasks with snippets that say what matched, keyboard hints and "See all results". It grows the existing `components/shell/command-menu.tsx` (the jump-to-a-page menu) into search. The full list is the search page (`search.md`). Where the picture and this file disagree, this file wins.

| Picture | State shown |
|---|---|
| `search-palette.webp` | Alex Kim opened the palette from Home and typed `repo:calculator-web status:in-review by:alex history`. The three tokens became chips; `history` is the text. 23 tasks match; the palette shows the top 5, the first selected, each with the snippets that matched (an agent message, a command, a ticket, a path, a member's message, a prompt) and the matched word marked. |

- **Generated** with Higgsfield `gpt_image_2_6` (3:2, 2k, high), in one generation. References: the approved `../m1/home` original (2048 px), `app-concepts/html/home-graphite.png` and the Hinge logo (`kit/logo/export/ostra-hinge-single-color-2048.png`). Prompt: `search-palette.prompt.txt`.
- **Features:** F-080 search. ADR 0054 ("Search"). Ticket 35 builds it; ticket 26 serves `search.suggest` and `search.tasks`; ticket 11 writes the `SearchEntry` rows. Spec section 12, screen 10; section 3, step 11.

## Purpose

A member finds any task they can open by what was said or run in it, without leaving the page they're on: a word from the agent's reply, a command, a path, the ticket's text, a teammate's message. The palette answers the common case, "take me to that task", in a few keys; the search page holds the full list and the filters as controls.

## Route

No route of its own: a `Dialog` over every panel page, opened by Ctrl+K (⌘K on macOS), by the sidebar's Search box (as today), and by the search field the top bar gains (ticket 35). Enter on a result navigates to `/tasks/[task-id]?event={seq}`, the thread scrolled to the matched event (ticket 35); "See all results" navigates to `/search?q={the whole query, tokens included}`.

## Layout

The page underneath stays as it was, under the overlay (the current `Dialog.Overlay`, `bg-black/50`).

**The palette:** `Dialog.Content`, 680px wide (`min(680px, 100vw - 32px)`), centred on the window, top at `14vh` (as `command-menu.tsx`), `--raise` fill, 1px `--line-2` border, radius 12px, the current menu's shadow. Content height follows the results; the results list scrolls inside at most `min(560px, 70vh)` for the whole palette.

1. **Query row,** 52px, padding 0 16px, a 1px `--line` under it: `search` 16px `--muted`, 12px gap, then one input line holding the token chips and the text (one `input`: the chips are drawn from the parsed query, below), then `esc` as a `Kbd`.
   - **Token chip:** 24px, radius 5px, 1px `--line-2`, `--bg` fill, padding 0 8px, mono 12.5px: the key with its colon `--faint` (`repo:`), the value `--text` (`calculator-web`). 8px apart, and 10px before the text.
   - **The text:** 15px `--text`, the caret off-white. Placeholder with no query: `Search tasks, or type repo: status: by:` `--faint`.
2. **Section label,** 30px, padding 0 16px: `Tasks` 12px weight 500 `--faint`; right-aligned mono 12px `--faint` `{n} matches` (the total from `search.suggest`).
3. **Results,** the top 8 at most (`search.suggest`); a row per task, padding 10px 16px, 1px `--line` between rows. One grid for every row so columns line up:

| Column | Width | Content |
|---|---|---|
| Key | 88px | mono 12.5px `--faint`: the ticket key, or the task's short ID for a prompt task |
| Title, then snippets | `1fr` | the title 14px `--text`, truncated on one line; under it up to two snippet lines |
| Project | 130px | 8px project square + name 13px `--muted`, truncated |
| State | 104px | 7px status dot + the state word 13px `--muted` (the task list's words and tones) |
| Age, or `↵` | 40px, right | mono 12px `--faint` (`58m`, `2d`, `1w`); the selected row shows a `Kbd` `↵` in its place |

   - **Snippet line,** 22px, indented to the title column: what matched 12px `--faint` in a 104px column, then the snippet 13px `--muted`, one line, ellipsis at both ends where the server cut it (`…`). A command, a path or a URL is mono 12.5px.
   - **What matched** (the `SearchEntry.kind`): `title` → no snippet line, the title itself is marked; `prompt` → `Prompt`; `ticket` → `Ticket`; `member_message` → the author's name (`Alex Kim`); `agent_message` → `Agent message`; `tool_input` → `Command` for an `execute`, `Path` for a `read`, `edit` or `search`, `URL` for a `fetch`; `pr` → `Pull request`.
   - **The mark:** each matched range `--text`, weight 500, on a `--line-2` background, radius 3px, padding 0 2px. Never amber, never teal, never yellow. The API returns ranges, not HTML: the panel renders text and `mark` elements, never `dangerouslySetInnerHTML` (ticket 35).
   - **Selected row:** `--sel` fill, radius 8px, inset 6px from the palette's edges (the row's own padding stays). Mouse hover moves the selection, as today.
4. **See all,** 44px, padding 0 16px, a 1px `--line` above: `arrow-right` 15px `--muted`, 10px, `See all {n} results` 14px weight 500 `--text`; right-aligned `Kbd`s `⌘` `↵` (`Ctrl` `↵` off macOS). It's a row of the list: arrows reach it after the last result.
5. **Footer,** 36px, padding 0 16px, a 1px `--line` above, 12px `--faint`: `Kbd` + word pairs, 14px apart: `↑` `↓` `Move`, `↵` `Open`, `⌘↵` `See all`, `esc` `Close`. Right-aligned: `Filters:` + the token keys in mono `repo: project: ticket: status: by: after: before:`; pressing a key name inserts it into the query.

## Every state, with its copy

Copy goes in `apps/web/messages/en.json`. Everything here is **new** unless marked.

### The query

The query is one string; ticket 26's parser turns `repo:`, `project:`, `ticket:`, `status:`, `by:`, `after:` and `before:` into filters, and the rest is text. The panel parses it the same way only to draw chips; the server's parse is the truth.

| Typed | Shows |
|---|---|
| A known key with a value, followed by a space (`repo:calculator-web `) | a chip; Backspace at the start of the text turns the last chip back into text |
| A known key with no value yet (`status:`) | a suggestion list in place of the results, 32px rows: the values that key takes (`status:` → `queued`, `running`, `needs-you`, `in-review`, `merged`, `stopped`; `repo:` → the visible projects' repos; `project:` → visible projects; `by:` → members, by username, `me` first; `after:`/`before:` → `today`, `yesterday`, `7d`, `30d`, or a `YYYY-MM-DD`). Enter or Tab completes it |
| An unknown key (`foo:bar`) | text, no chip (ticket 26: "an unknown token stays text") |
| A value that matches nothing (`repo:nope`) | a chip with its value in `--red`, and under the query 12px `--red` `No repo named nope in your projects.`; the results are empty |

### The results

| Condition | Shows |
|---|---|
| No query | the section label `Recent` and the member's 5 most recently opened tasks, no snippets, no count; then the footer. No "See all" row |
| Typing | the current results stay until the new ones arrive (`search.suggest`, debounced 150 ms); no spinner under 300 ms, then a 2px `--line-2` bar under the query row that slides (still with reduced motion) |
| Results | as the picture: the top 8 and `See all {n} results` |
| Only filters, no text | results are the matching tasks, newest first, with no snippets |
| Nothing found | in place of the list, padding 28px 16px, centred: 14px `--muted` `No tasks match.`; 13px `--faint` `Search looks in titles, prompts, tickets, messages and the commands and paths the agents used. Not in thoughts or tool output.` The "See all" row stays, as `Open the search page` |
| `search.suggest` failed | 13px `--red` `Search didn't answer: {error}` + teal `Try again`; the footer stays |
| One result | the same row; "See all" still shows (`See all 1 result`) |

- **Counts, words:** `{n} matches` / `1 match`; `See all {n} results` / `See all 1 result`.
- A hidden task never appears and is never counted (ADR 0054: access is in the query).

### Pages, as today

The current menu's destinations (Home, New task, each project's Tasks and Environment, Runners, Models, GitHub; `destinations.ts`) stay. When the text (no chips) matches a destination's name, a `Go to` section of at most 3 rows, the current menu's rows, comes **after** the tasks section. With no query it's after `Recent`.

### Keys

| Key | Does |
|---|---|
| Ctrl+K / ⌘K | opens the palette on any panel page; closes it when open (as today) |
| `↑` / `↓` | moves the selection through results, then "See all" (and `Go to`), wrapping |
| Enter | opens the selected task at its matched event; on "See all", the search page |
| Ctrl+Enter / ⌘Enter | the search page with the query, from anywhere in the palette |
| Escape | closes; with a suggestion list open, closes the list first |
| Tab | completes a token suggestion |

The query survives closing and reopening within a page view; navigating clears it.

### Phone width

The palette fills the width (16px margins) and its top sits 12px under the top bar. Each result stacks: key and title on one line, then project and state, then one snippet line. The footer hides its key hints and keeps `Filters:`.

## Tokens and components

Tokens: `app-concepts/html/graphite.css` at the pictures' scale (`../m1/README.md`, "Scale"); nothing new. The mark uses `--line-2` and `--text`. Icons (Lucide): `search`, `arrow-right`, `corner-down-left` (in the `↵` `Kbd`).

| Part | Component |
|---|---|
| The palette | the existing `Dialog` from `radix-ui` in `command-menu.tsx`, grown; `role="combobox"` on the input with `aria-activedescendant` (as today) |
| Results | `role="listbox"` / `role="option"` rows (as today), not `Table` |
| Chips | `.chip` / `Badge variant="outline"` |
| Keys | the existing `Kbd` (`components/ui/kbd.tsx`) |
| Marks | `mark` elements styled as above |
| Skeleton (first open, `Recent` loading) | `Skeleton`, 3 rows |

## Differences from the current code

1. **`command-menu.tsx` is a page jumper** (560px, a list of destinations matched by name). It becomes the search palette: 680px, the tasks section from `search.suggest`, snippets, chips, the "See all" row and the footer; the destinations become the `Go to` section. Rename to `search-palette.tsx` (ticket 35's path) or keep the file and change its name in the shell; one dialog either way.
2. **The input's placeholder** `shell.search` (`Search`) becomes `Search tasks, or type repo: status: by:`.
3. **A top-bar search field** that opens the palette (ticket 35, the spec's sidebar notes): not in the picture. See open point 1.
4. **New message keys:** `search.palette.*` for every line in "Every state".

## Open points for the build

Settle each with the maintainer; don't guess in code.

1. **Search in the top bar and the sidebar.** The spec (section 12) puts search in the top bar; `app-design.md` and every approved picture keep it in the sidebar. The target keeps the sidebar's box; ticket 35's top-bar field is a second way in. Say whether the sidebar box stays.
2. **`status:` values.** The target uses the task-list words hyphenated (`in-review`, `needs-you`). Ticket 26's parser should accept these and the snake case (`in_review`) alike.

## Wrong in the image

| In the image | Build |
|---|---|
| The scrim lighter than `bg-black/50`: the right panel and Recent activity read almost undimmed | the current overlay, `bg-black/50`, over everything but the palette |
| The palette's top at about 150px | `14vh` (about 134px at 956px), as today |
| The palette about 756px wide | 680px |
| The snippets of result 1 start a few px right of the others', and the state column drifts between rows | one grid: every snippet at the same x, every column on its own edge |
| `history` marked in result 1's title | right: the title matched too. A title match marks the title and adds no snippet line |
| The chips' key and value with a space between (`repo: calculator-web`) | no space: `repo:calculator-web`, the key `--faint` |
| The "See all" keys `⌘` and `↵` as two separate caps, and the footer's `⌘↵` as one | the same in both places: one `Kbd` per key, `⌘` `↵` |
| The hinge mark, redrawn | the real `kit/logo/export/ostra-hinge-single-color.svg`, 20px |
| The sidebar's Organization rows (Runner pools, Insights, Members, Spend, Background work) | the shared sidebar, with only what's shipped (`../m1/README.md`, "One sidebar") |
| Task keys, titles, snippets, ages, `23 matches` | demo data, not copy |
