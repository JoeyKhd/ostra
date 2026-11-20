# Target: the configuration reference (milestone 7, screen 3)

> **Committed image:** `docs-reference.webp`, 1440×956, so one image pixel is one CSS pixel. Since 2026-11-20 it **is a capture of the built site** (`apps/docs`, its static export, at device scale 2, downscaled), no longer a generation, so it shows the graphite tokens and the build as it is. The capture hovers `OSTRA_PUBLIC_URL` and has just copied its link. Sizes in this file are CSS px.

- **Prompt:** `docs-reference.prompt.txt` keeps the first generation's prompt (GPT Image 2.6 through Higgsfield, 3:2, 2k, high), with a line on the capture that replaced its picture. References: the approved 2048 original of `app-targets/m4/audit-log` (the start spec section 13 names: its filter row, its group bands with counts and its mono table cells), `app-concepts/html/home-graphite.png` and the Hinge logo.
- **Route (new):** `/docs/reference/configuration`, rendered at build time from **`docs/configuration.md`**, read as a file, never copied (ADR 0063: "one source for the reference"; `apps/docs` imports nothing from `packages/domain`, which is Sustainable Use).
- **Features:** F-058 ("the configuration reference rendered from `docs/configuration.md` holds every setting the settings test knows"). The self-hosting rule in `AGENTS.md` (a new setting ships with its line in the reference). Ticket 21 (the page and its test), ticket 23 (the Reference section's other pages).
- **Status:** a proposed target, waiting on approval (ticket 12's `## Comments`).
- **Frame, header, tokens:** `docs-guide.md` and `docs-home.md`. This file covers the main column. Since 2026-11-20 they're the panel's graphite theme, renamed to its names (`--link` is `--teal`, `--surface-2` `--sel`, `--dialog` `--raise`, `--highlight` `--line-2`): a colour or old name below means its row in `docs-home.md`'s table.

> Build it in real HTML/React, then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

The one page an admin keeps open while writing a compose file or a Helm values file: every setting ostra reads, its default, what it does and **which process reads it**, so a runner setting never ends up on the server or the other way round. It must be findable (a filter, anchors to share), and it must be exactly the tested file: a setting added in code without its line already fails `packages/domain/src/settings.test.ts`, and ticket 21's test fails when this page lists a different set.

## Layout (CSS px at 1440×956)

| Region | Size | Contents |
|---|---|---|
| Header | 56px | As `docs-home.md` |
| Navigation | 264px | As `docs-guide.md`, with Reference open: `Configuration` (current), `CLI commands`, `Runner protocol`, `Ports` |
| Main | x 304 to 1176, content `max-width: 872px` (wider than a guide: it's a table) | Breadcrumb, title, lede, source line, filter row, groups |
| On this page | 248px | The groups; Edit on GitHub |

### Main column

1. **Breadcrumb** `Reference › Configuration`, 13px `--faint`, the current page `--text` weight 500.
2. **Title** `h1` Manrope 800 32px: `Configuration reference`.
3. **Lede**, 16px `--muted`: `Every setting ostra reads, its default, and where it's read. A fresh install needs none of them.` (the file's own first lines, shortened; the file's second paragraph, on the settings test, is what the source line below says).
4. **Source line**, 13.5px `--faint`, Lucide `file-text` 15px: `Rendered from docs/configuration.md, which a test checks against the code.` The path is inline code and links to the file on GitHub.
5. **Filter row**, 20px under, 36px:
   - **Field**, 340px × 36px, `--surface`, 1px `--control`, radius 7px: Lucide `filter` 15px `--faint`, placeholder `Filter by name or words` 14px. `type="search"`, `aria-label="Filter settings"`. It filters as you type (no button), matching the name, the flag, the default and the words, case-insensitive; `/` focuses it when no field has focus (the site's `/` opens search otherwise; on this page the filter wins, and ⌘K still opens search).
   - **Read by**, a segmented control (`role="radiogroup"`, `aria-label="Read by"`), 32px, 1px `--control`, radius 7px, segments 14px weight 500 with a Plex Mono 13px count: `All 59`, `Server 39`, `Runner 13`, `Development 7`. Selected: `--surface-2` fill, `--text`. The counts are the file's, computed at build time.
   - **Count**, right-aligned Plex Mono 13px `--faint`: `59 settings`; while filtering `{n} of 59 settings`.
   - The filter and the segment are kept in the URL (`?q=port&read=server`), so a filtered view can be shared.
6. **Groups**, in the file's order and with its headings: `The server`, `Code hosts and Git LFS` (prose and its small table, no settings rows), `The runner`, `Development and tests only`. Each group:
   - **Band**, 44px, `--surface` fill, radius 6px, padding `0 14px`: the heading as an `h2`, 17px weight 700 `--text`, a Plex Mono 14px `--faint` count, and on the right 13.5px `--faint` the process that reads it: `Read by core and the panel` (server), `Read by ostra runner · each is also a flag` (runner), `Read only in development and tests` (development).
   - **The file's paragraph under its heading** (such as "Read by `apps/core` and `apps/web` through `parseServerSettings`…") renders under the band in 14px `--muted`, collapsed to its first sentence with a teal `More` when it runs past two lines.
   - **Table** (a real `table`, with `caption` the group's name, visually hidden): head row 36px, 12.5px weight 500 `--faint`: `Setting`, `Default`, `What it does`. Rows at least 46px, 1px `--line` between, padding `10px 12px`, top-aligned:

| Column | Width | Contents |
|---|---|---|
| Setting | 316px | The name, Plex Mono 14px `--text`, then a 20px outline chip, Plex Mono 11.5px `--faint`, 1px `--control`, radius 4px: `server`, `runner` or `dev`. A runner setting's flag under the name, Plex Mono 12.5px `--faint` (`--executor`) |
| Default | 200px | Plex Mono 13.5px `--muted`. Prose defaults (`generated on first start, kept in OSTRA_DATA_DIR`) in 13.5px sans `--muted` with their names in mono. `(required)` as italic `required` in `--faint`; `(none)` as `none` in `--faint` |
| What it does | rest | 14px `--muted`, line-height 1.5, the file's cell rendered as Markdown: inline code, bold ("**Back it up**"), links to other settings' anchors |

   The rows in the picture (copy from `docs/configuration.md`, shortened in the picture; the page shows the file's full text):

| Setting | Read by | Default |
|---|---|---|
| `OSTRA_WEB_PORT` | server | `3000` |
| `OSTRA_CORE_PORT` | server | `8787` |
| `OSTRA_PUBLIC_URL` | server | `http://localhost:3000` |
| `OSTRA_DATA_DIR` | server | `.ostra-dev/server` (development), `/var/lib/ostra` (production) |
| `OSTRA_TASK_SPEND_CAP_USD` | server | `25` |
| `OSTRA_SERVER_URL`, `--server` | runner | required |
| `OSTRA_RUNNER_EXECUTOR`, `--executor` | runner | `host` |
| `OSTRA_RUNNER_CAPACITY`, `--capacity` | runner | `1` |

   The picture shows `OSTRA_DATA_DIR`'s production default only; build the file's text. The file's own order is kept (it is not sorted alphabetically).

7. **Anchors.** Each row has `id` = the setting's name (`#OSTRA_PUBLIC_URL`), and each group its heading's slug. On row hover or keyboard focus, a 24px icon button with Lucide `link` 15px `--link` appears in the 24px gutter left of the name (`aria-label="Copy link to OSTRA_PUBLIC_URL"`); the row gets `--surface` at 60%. A click copies the full URL with the anchor and shows a `Tooltip` `Link copied` above it for 1.5 s (`aria-live="polite"`). Opening the page at an anchor scrolls the row under the header (`scroll-margin-top: 72px`) and gives it a `--highlight` fill that fades over 2 s.
8. **Filtering.** Rows that don't match hide; a group with none left hides with its band; matched words get `--highlight`. **No match:** under the filter row, Lucide `search-x` 16px `--faint` and 14px `--muted` `No setting matches “{q}”.` then a teal `Clear the filter`. The prose sections (the paragraphs between tables in the file, such as "The first admin." and "Several server processes.") show when the filter is empty, and hide while filtering.

### On this page

The file's `##` headings: `The server` (current in the picture), `Code hosts and Git LFS`, `The runner`, `Development and tests only`. Then `Edit on GitHub`, pointing at `docs/configuration.md` on `main`, not at an `apps/docs` file.

## States

| State | What shows |
|---|---|
| **All, the server group in view, a row hovered** (`docs-reference.webp`) | As above, `OSTRA_PUBLIC_URL`'s link button with `Link copied` |
| Filtered (`?q=port`) | `{n} of 59 settings`; `OSTRA_WEB_PORT`, `OSTRA_CORE_PORT`, `OSTRA_DEV_PG_PORT` and every row whose words match, the words highlighted; empty groups hidden |
| Read by: Runner | Only `The runner`'s band and rows |
| No match | The no-match line and `Clear the filter` |
| Opened at `#OSTRA_SECRETS_KEY` | That row scrolled under the header and highlighted |
| Light | `docs-home`'s light tokens; bands `--surface` `#EAE6DC`, chips' border `--control` `#7D8B87` |
| No JavaScript | Every group and row shows; the filter row is hidden; anchors work as plain links |
| Under 1024px | The rail goes; the table becomes one block per setting: the name and chip, then `Default` and its value as a key/value line, then the text, hairlines between |
| Phone | As under 1024px; the filter field full width, the segmented control scrolls sideways under it |

## Components

- **Fumadocs:** the docs layout and page as `docs-guide`. The file is loaded at build time from `../../docs/configuration.md` (a `fs.readFile` in the page's loader or a `fumadocs-mdx` collection pointed at the file, ticket 21's choice), parsed with remark into groups and rows, and rendered by ostra's own `SettingsReference` client component (the filter, the segment and the anchors are ostra's, not Fumadocs'). The prose between tables renders through the site's Markdown pipeline.
- **The fallback:** the same `SettingsReference` component, the file parsed with the same remark step; nothing on this page depends on Fumadocs.
- **Shared parser:** the parser that turns the file into rows is one module, used by the page and by ticket 21's test (`F-058: the configuration reference page lists every setting the settings test knows, with its default`), so they can't disagree.
- **Icons:** Lucide `file-text`, `filter`, `link`, `search-x`, `github`.

## Accessibility (WCAG AA)

- Contrast: names `--text` 15.2:1; defaults and text `--muted` 11.9:1 dark, 8.4:1 light; chips and the count `--faint` 6.1:1 on `--surface` dark, 5.1:1 light; the chip and field borders `--control` above 3:1.
- The table has a `caption` and `th scope="col"`; each row's name is its `th scope="row"`. The filter announces the count through `aria-live="polite"` (`{n} of 59 settings`).
- The link button is reachable by Tab on the row's name (the name itself is the anchor link; the button copies).

## Differences from the current code

1. **New:** the page, `SettingsReference`, the shared parser and ticket 21's test.
2. **`docs/configuration.md`** keeps its format; the parser relies on its four tables' headers (`Setting | Default | What it does`, and the runner's `Setting | Flag | Default | What it does`). A change to a header changes the parser in the same commit.
3. **The `Read by` chip** is derived from the group (`The server` → server, `The runner` → runner, `Development and tests only` → dev), not a new column in the file.

## Open points (recommendations; ticket 21 records the answer)

1. **The Helm values** (F-118) are settings too. Recommended: a fifth group, `Helm values`, when the charts land, from the same file.
2. **Development settings on the public site.** Recommended: keep them, last and labelled `dev`, since contributors read the same page; the segmented control hides them in one click.

## Wrong in the image (build from this file)

Nothing since 2026-11-20: the picture is a capture of the build. Its counts are `docs/configuration.md`'s on that day (`All 112`, `Server 69`, `Runner 29`, `Development 14`); the 59 in this file is the count when it was written, and the page always shows the file's. The generated picture it replaced drew Abyss colours, Kelp borders, chevrons on the navigation's pages and the `Link copied` tooltip over the previous row's name; the build has none of these.

**Fixed with the capture (2026-11-20):** at 1440 the `Read by` segments shrank to fit the row and cut off the last one (`Development 7`). They no longer shrink; the filter field gives way (200 to 320px), and where even that doesn't fit, the count wraps to its own line (`apps/docs/src/components/settings-reference-layout.test.ts`).

Right as drawn: the filter row with its segmented `Read by` and counts, the group bands with their counts and the process that reads them, mono names with `server` and `runner` chips, flags under runner names, the hovered row with its link button and tooltip, and "On this page" with the file's headings.
