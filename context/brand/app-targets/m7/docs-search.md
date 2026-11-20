# Target: the docs site's search dialog (milestone 7, screen 4)

> **Committed images:** `docs-search.webp` (results) and `docs-search-empty.webp` (no results), each 1440×956, so one image pixel is one CSS pixel. Since 2026-11-20 both **are captures of the built site** (`apps/docs`, its static export, at device scale 2, downscaled), no longer generations, so they show the graphite tokens and the build as it is. Both open the dialog over the install guide (`/docs/install/docker-compose`) and type the query. Sizes in this file are CSS px.

- **Prompt:** `docs-search.prompt.txt` keeps the first generation's prompt (GPT Image 2.6 through Higgsfield, 3:2, 2k, high), with a line on the captures that replaced both pictures. References: the approved 2048 original of `app-targets/m4/search-palette` (the start spec section 13 names), `app-concepts/html/home-graphite.png` and the Hinge logo.
- **`docs-search-empty`** was first that generation with its query, results and count erased locally and the empty state composited in; since 2026-11-20 it's a capture too.
- **Where:** a dialog over any docs page, opened by the header's search button, ⌘K or Ctrl+K, or `/` (outside a field, and outside `docs-reference`'s filter). On a phone, the top bar's search icon opens it full screen.
- **Features:** F-058 (ADR 0063: "Search is built in and static: Fumadocs' own index, built with the site and served as a file. No hosted search service"). Ticket 21.
- **Status:** a proposed target, waiting on approval (ticket 12's `## Comments`).
- **The fallback has no search** (ADR 0063): without Fumadocs, the search button, its `⌘K` and this dialog are left out, and this target isn't built.
- **Tokens:** `docs-home.md`. Since 2026-11-20 they're the panel's graphite theme, renamed to its names (`--link` is `--teal`, `--surface-2` `--sel`, `--dialog` `--raise`, `--highlight` `--line-2`): a colour or old name below means its row in `docs-home.md`'s table.

> Build it in real HTML/React, then screenshot both states at 1440×956 and compare each with its picture.

## Purpose

Find the page, or the heading inside it, that answers a question, from the keyboard, without leaving the page or sending the query anywhere: the index is a static file and the search runs in the browser (no telemetry, ADR 0021). Results are grouped by page so a reader sees where an answer lives (`Runners › Pools and join tokens`) before opening it, and a heading result opens the page at that heading.

## Layout (CSS px at 1440×956)

- **Overlay:** the page behind under `rgba(6, 17, 20, .7)` (light: `rgba(12, 29, 33, .4)`), no blur.
- **Dialog:** 736px wide (x 368–1104), top at y 152, `max-height: min(560px, 100vh - 200px)`, `--dialog` fill, 1px `--control` border, radius 12px, no shadow beyond `0 24px 48px rgba(0,0,0,.35)` in dark only. `role="dialog"`, `aria-modal`, `aria-label="Search the docs"`.

### Input row (56px, hairline under it)

- Lucide `search` 18px `--muted` at x 20, then the input, 17px `--text`, placeholder `Search the docs` in `--faint`, `role="combobox"`, `aria-expanded`, `aria-controls` the list, `aria-activedescendant` the selected row. At the right, an `esc` key chip (Plex Mono 12px `--muted`, 1px `--control`, radius 5px, 24px tall) that closes the dialog.

### Results (scrolls inside the dialog)

A `listbox`, padding `8px 10px`. Grouped by page, in the index's rank order of each page's best hit:

- **Page path line**, 34px, Lucide `file-text` 15px `--faint` and 13.5px `--muted`: the section and the page, `Runners › Pools and join tokens`. Not selectable; it labels the group (`role="group"`, `aria-label` the path).
- **Page row** (when the page itself matches), 52px, padding `8px 12px` with a 36px icon column: Lucide `file-text` 16px `--muted`, the page's title 15px weight 500 `--text`, and under it its description, 13.5px `--muted`, one line, ellipsis.
- **Heading row**, 40px (52px with a snippet), indented 12px: a `#` in Plex Mono 15px `--faint` in the icon column, the heading 15px `--text` (a setting name in Plex Mono, as in the reference), and under it, when the match is in the text, a snippet 13.5px `--muted`, one line, ellipsis at both ends (`…an admin makes a join token for the pool…`).
- **Match highlight:** the query's words as `mark`, `--highlight` fill, radius 3px, padding `0 3px`, `--text` weight 600. Never amber.
- **Selected row:** `--surface-2` fill, radius 8px, and a `↵` key chip at its right. The first row is selected when results arrive. Hairlines (`--line`) separate groups, not rows.
- **Choosing** a row (Enter or click) navigates to the page, or to `page#heading`, and closes the dialog. ⌘Enter (Ctrl+Enter) opens it in a new tab.

### Footer (40px, hairline above it)

12.5px `--faint` with key chips (Plex Mono 12px, 1px `--control`, radius 4px, 22px): `↑` `↓` `Move` · `↵` `Open` · `esc` `Close`; on the right Plex Mono 12.5px `--faint`: `6 results · searched in your browser`.

## States

| State | What shows |
|---|---|
| **Results** (`docs-search.webp`) | Query `join token`: three groups, `Runners › Pools and join tokens` (the page row selected, then `Make a join token`, `Revoke a join token`), `Install › Install with Docker Compose` (`Required settings`), `Reference › Configuration` (`OSTRA_JOIN_TOKEN`, `OSTRA_JOIN_TOKEN_FILE`) |
| **No results** (`docs-search-empty.webp`) | Query `jira`. The list replaced by a centred block: the Deep water illustration, 240×150, feathered into `--dialog`, `alt=""`; `No results for “jira”` 15px weight 600 `--text`; `Try a setting's name, a command or a page's title.` 13.5px `--muted`; a teal `Browse the sections →` linking to the docs' root. The footer's count `0 results · searched in your browser`. On a phone the illustration is hidden |
| Before typing | The input's placeholder, and in place of results a short list, 13px weight 500 `--faint` label `Start here`, of four page rows: `Install with Docker Compose`, `Setup in the panel`, `Personal runners`, `Configuration reference`. No recent searches are kept |
| Loading the index (first open) | The rows as three `Skeleton` lines for at most a moment; the index is fetched once per visit, a few hundred KB at most |
| The index failed to load | Lucide `circle-alert` 16px `--red` and 14px `--muted` `Search couldn't load. Check your connection and try again.`, teal `Try again` |
| Light | The light tokens: `--dialog` `#F7F5EF`, the selected row `--surface-2` `#E2DDD0`, the highlight `#D5E5E0` with `--text`; the overlay lighter |
| Phone | Full screen: the input row at the top with a `Cancel` text button in place of `esc`; results fill the screen with 52px rows; the footer's key hints hidden; the empty state without its illustration |

## Behaviour

- Matches page titles, headings and their text, and setting names; a query of one or two characters matches titles and setting names only. Words are matched by prefix (`join tok` finds `join token`).
- Results update as you type, with no button; at most 8 groups, and `See all {n} results` isn't needed on a site this size.
- ↑ and ↓ move the selection across groups (skipping path lines) and wrap; Home and End jump; Tab is trapped in the dialog; Escape closes it and returns focus to what opened it.
- The query stays while the page is open, so reopening the dialog shows the last results.

## Components

- **Fumadocs:** `RootProvider`'s search, set to the static index (`search: { options: { type: "static" } }` or the pinned version's equivalent), with the index built at export by `fumadocs-core`'s search server (`createFromSource`, its static route exported to a file). The dialog is `fumadocs-ui`'s default search dialog restyled to these tokens, or ostra's own dialog on its search hooks if the default can't take the page-group layout above; ticket 21 says which in its `## Comments`. Names are those of Fumadocs' current line, checked against the pinned version.
- **Setting names as headings:** the reference page's rows are indexed as headings (`#OSTRA_JOIN_TOKEN`) by feeding the parser's rows into the index's structured data, so a setting's name finds its row.
- **Icons:** Lucide `search`, `file-text`, `circle-alert`; `#` is text.

## Accessibility (WCAG AA)

- Contrast on `--dialog`: `--text` 14.4:1, `--muted` 11.3:1, `--faint` 6.4:1 (5.4:1 on the selected row) in dark; light `--faint` 5.9:1 on `--dialog`, 4.7:1 on the selected row; `--text` on the highlight 9.9:1 dark, 13.3:1 light.
- The combobox pattern (above); the count is announced through a visually hidden `aria-live="polite"` region (`6 results`); the empty state's sentence is announced the same way.

## Differences from the current code

1. **New**, with `apps/docs`. The panel's own ⌘K (`apps/web/src/components/shell/command-menu.tsx`, `../m4/search-palette`) is a separate component on a separate site; they share the look, not code (`apps/docs` is Apache-2.0 and imports nothing from `apps/web`).

## Open points (recommendations; ticket 21 records the answer)

1. **The "Before typing" list.** Recommended: the four pages of the 30-minute path and the reference, fixed in the site's config, not computed.
2. **Search across versions.** v1 keeps the current release only (ADR 0063), so the index is this build's; nothing to choose yet.

## Wrong in the image (build from this file)

The pictures are captures of the build since 2026-11-20, so they show what the build does. Two things in the capture differ from this file, and are the build's to fix (ticket 21):
- **Snippets carry raw Markdown:** `**New token**` and backticks show as typed. Build the snippet as plain text.
- **Some heading rows lose their text's form:** the setup page's `6. Connect a runner` shows as `connect a runner`. Build the heading as written.

The results' order and count (24 for `join token`) are the index's, as this file says; the generated picture showed six. Its other faults (an invented page behind, Kelp borders, smaller empty-state text, the model's wordmark) are gone with it.

Right as drawn: the dialog shape with the `esc` chip, results grouped under page paths, page and `#` heading rows with snippets, the selected row with its `↵` chip, the footer's key hints and "searched in your browser", the empty state with the Deep water stone and `Browse the sections →`, and no amber.
