# Target: the docs site's landing page (milestone 7, screen 1)

> **Committed images:** `docs-home.webp` (dark) and `docs-home-light.webp` (light), each downscaled from a 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Prompts:** `docs-home.prompt.txt` and `docs-home-light.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), one generation each, kept. References for the dark one: the approved 2048 original of `app-targets/m1/home` (the start spec section 13 names), `app-concepts/html/home-graphite.png`, the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png` and the Deep water illustration `files/web/sign-in-illustration.webp` (B-017). The light one was made from the dark one, with the Abyss Hinge export `ostra-hinge-2048.png`.
- **Route (new):** `apps/docs/app/(home)/page.tsx`, at the site's root (`https://joeykhd.github.io/ostra/` until a domain is registered; ADR 0063).
- **Features:** F-058 (the docs site), and F-076's "following only the docs": this page is where the 30-minute path starts. ADR 0063 ("What the site holds", section 1, Start), ADR 0048 (the word is "source-available"). Ticket 21 builds it; ticket 22 writes the words of the pages it links to.
- **Status:** a proposed target, waiting on approval (ticket 12's `## Comments`). Ticket 21 builds its data and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 in both themes and compare each with its picture.

## Purpose

The first page a team new to ostra reads, before it has a panel. In one screen it says:
- what ostra is, in the brief's words: source-available, self-hosted, a control plane for coding agents, with the tracker as the source of truth;
- what they need before they start (ADR 0063: a Linux machine with Docker, a GitHub organization, a model provider's base URL and token);
- the 30-minute path as three steps, each linking to the page that walks it;
- where everything else is: the eight sections of ADR 0063 as a grid.

It's a public page, not the console: no console sidebar, no organization, no amber. It wears the console's graphite theme, dark first, with its fonts, logo, density and hairline style, so the docs and the panel read as one product (the maintainer, 2026-11-20; the Deep water palette it was first drawn in is superseded, below).

## Layout (CSS px at 1440×956)

| Region | Size | Contents |
|---|---|---|
| Header | full width, 56px, 1px `--line` under it | Logo, `Docs`, version chip; search, GitHub, theme toggle |
| Content | `max-width: 1212px`, centred (x 114–1326), padding `0 24px` | Hero, Before you start, The 30-minute path, Sections |
| Footer | below the fold | License line, links (below) |

### Header (shared by every docs page)

- **Left, x 24:** the Hinge mark 22px (`files/logo/`, Shell on dark, Abyss on light; never typed or redrawn), the wordmark `ostra` (the outlined wordmark file, never live text), a 1px × 20px `--line` divider, `Docs` 15px weight 500 `--muted`, then the version chip: Plex Mono 12.5px `--muted`, 1px `--control` border, radius 5px, 22px tall, `v1.0.0`. The version comes from the release line at build time (ADR 0045, ADR 0063: "the docs carry the version they describe"), never typed.
- **Right:** the search button, 264px × 34px, `--surface`, 1px `--control` border, radius 7px: Lucide `search` 15px `--faint`, `Search the docs` 14px `--faint`, and a `⌘K` key chip (Plex Mono 11.5px `--faint`, 1px `--line` border, radius 4px; `Ctrl K` off macOS). It opens `docs-search`. Then Lucide `github` 16px + `GitHub` 14px weight 500 `--muted`, linking to `https://github.com/JoeyKhd/ostra`. Then the theme toggle, a 34px square icon button with 1px `--control` border, radius 7px: Lucide `moon` on dark, `sun` on light (the theme it switches to is its `aria-label`: `Switch to light theme`).
- The whole header is the `nav` landmark; a skip link `Skip to content` is its first focusable element.

### Hero (y 96–370)

- **Left column, 600px:**
  1. Eyebrow, Plex Mono 13px `--teal`: `Documentation · v1.0.0`.
  2. `h1` in Manrope 800, 44px, line-height 1.05, `--text`, two lines: `Self-hosted cloud agents` / `for your team.` (the tagline, `brief.md`).
  3. Lede, 16.5px, line-height 1.4, `--muted`, max 580px: `ostra is the source-available, self-hosted control plane for coding agents. A Linear ticket or a prompt becomes a task, an agent works it on its own branch on your runners, and it opens a pull request on GitHub.`
  4. Buttons, 38px, radius 7px, 14.5px weight 600, 16px apart: primary `Install ostra` + Lucide `arrow-right` (`--primary` fill, `--on-primary` text), linking to the install guide (`docs-guide`); outline `Configuration reference` (1px `--control`, `--text`), linking to `docs-reference`.
  5. 13px `--faint`, 16px under the buttons: `Your agents, your machines, your tracker, your keys.` (the brief's proof points).
- **Right, 424 × 272px at x 834:** the Deep water illustration (B-017), decorative (`alt=""`, `aria-hidden`), never a mock of the product.
  - **Dark:** cropped to the hinge stone and feathered into `--bg` with a radial mask (the way `../m4/search-empty` composites it), no frame.
  - **Light:** the same crop inside a rounded rectangle, radius 12px, no border, no shadow: a window into the water. The illustration isn't recoloured for light.
  - Under 1024px it's hidden.

### Before you start (y 398–446)

One row between two 1px `--line` hairlines, 48px:
- `Before you start` 16px weight 600 `--text`, as an `h2`.
- Three items, 32px apart, each Lucide `circle-check` 15px `--faint` and 14px `--muted`: `A Linux machine with Docker` · `A GitHub organization you administer` · `A model provider's base URL and token`. Each links to its paragraph on the Start section's "Before you start" page, with no link colour (underline on hover).
- At the right end, teal 14px underlined `Linear is optional`, linking to the install section's Linear page.
- Under 1024px the items stack, one per line, under the title.

### The 30-minute path (y 456–668)

- `h2` `The 30-minute path`, Manrope 700 22px `--text`; on its right, baseline-aligned, 14px `--muted`: `From docker compose up to your first agent-made pull request.` (`build-order.md`, F-076).
- Three equal columns, 40px gutters, each with a 1px `--line` hairline on top and 16px padding top. An `ol`; each `li`:
  1. Plex Mono 13px `--faint` number: `01`, `02`, `03`.
  2. 17px weight 700 `--text` title (Manrope 700).
  3. 14px `--muted` text, max 3 lines.
  4. A teal 14px weight 500 link with Lucide `arrow-right` 14px.

| # | Title | Text | Link |
|---|---|---|---|
| 01 | `Start ostra` | `One compose file brings up the server, Postgres and a pool runner.` Then a one-line code block (below) | `Install with Docker Compose` → the install guide |
| 02 | `Set it up in the panel` | `Sign in as demo, choose a password, then add a model provider and the GitHub App, in the checklist's order.` | `Setup in the panel` → Install › Setup in the panel |
| 03 | `Start a task` | `Create a project, type a prompt or pick a Linear ticket, and review the pull request the agent opens.` | `Your first task` → Using ostra › Tasks |

- **The code line** in column 01: 34px, `--surface`, 1px `--line`, radius 6px, Plex Mono 13.5px `--text` `docker compose up -d`, and a 26px copy button at its right (Lucide `copy`, then `check` and `Copied` as its `aria-live` label for 2 s). It's the same block as the guide's, without its `sh` strip.
- The column texts are the guide pages' own first sentences, written once in ticket 22 and imported here, so the landing can't contradict them.

### Sections (y 692–920)

- `h2` `Sections`, Manrope 700 22px.
- A 4 × 2 grid, `ul`, 1px `--line` hairlines between cells and along the top and bottom, no fills. Each cell is one link, 88px, padding 18px 20px: a 17px Lucide icon `--muted` at the left, then the title 16px weight 600 `--text` and one line of 13.5px `--faint` text (two at most). Hover: `--surface` fill and the title in `--teal`.

| Section (ADR 0063) | Icon | Text |
|---|---|---|
| `Start` | `book-open` | `What ostra is, what you need, the 30-minute path.` |
| `Install` | `download` | `Docker Compose, the first sign-in, setup, Helm, upgrading.` |
| `Runners` | `server` | `Pools, join tokens, docker, host and kubernetes.` |
| `Agents and models` | `cpu` | `Providers, OpenCode, Claude Code, agent profiles.` |
| `Using ostra` | `list-checks` | `Tasks, steering, approvals, reopening, automations.` |
| `Security` | `shield` | `What the box isolates, the proxies, reporting a flaw.` |
| `Reference` | `sliders-horizontal` | `Every setting, the CLI's commands, the ports.` |
| `Contributing` | `puzzle` | `The adapter guide, the contract suites, the CLA.` |

- The order and titles come from the navigation's own tree (`meta.json` under `apps/docs/content/`), never a second list.

### Footer (below the fold)

A 1px `--line` hairline, then one 13px `--faint` row: `ostra is source-available under the Sustainable Use License. These docs are Apache-2.0.` and on the right `GitHub` · `Security` (the Security section's "Report a vulnerability") · `v1.0.0`. No newsletter, no social icons, no telemetry (ADR 0021): the site loads no analytics.

## States

| State | What shows |
|---|---|
| **Dark** (`docs-home.webp`) | As above. The default for a first visit |
| **Light** (`docs-home-light.webp`) | The same layout with the light tokens; the illustration in its rounded window; the toggle shows `sun` |
| Theme chosen | Kept in `localStorage` (`theme`) and applied before first paint by the theme provider's inline script, so a reload never flashes the other theme. The docs have no accounts |
| Fallback (no Fumadocs) | The same page and header without the search button and its `⌘K` (ADR 0063: the fallback has no search) |
| Under 1024px | The illustration hides; Before you start stacks; the path's columns stay three down to 860px, then stack |
| Phone (under 640px) | The header becomes `docs-guide`'s phone bar (menu, logo, search icon, theme icon); hero heading 34px; the grid two columns, then one under 420px; buttons full width, stacked |
| No JavaScript | Everything reads and every link works; search and the copy button need JavaScript and are hidden by `noscript` CSS |

## Components

- **Fumadocs** (ticket 21, once the maintainer says yes; ADR 0007): the page sits in `fumadocs-ui`'s home layout (`HomeLayout`) with the shared `baseOptions` (the logo as `nav.title`, the GitHub link, the theme toggle and the search trigger) that the docs layout reuses, so the header is written once. `RootProvider` holds the theme and the search. The section grid is `Cards`/`Card` restyled to the hairline grid. Names are those of Fumadocs' current line; ticket 21 checks them against the pinned version.
- **The fallback** (ADR 0063: Next.js alone): `app/page.tsx` with its own `SiteHeader` (the same markup, no search). The theme toggle is then ostra's own small inline script, setting `data-theme` on `html` before first paint; no theme package is added.
- **Icons:** Lucide 15 to 17px, stroke 1.75: `search`, `github`, `moon`, `sun`, `arrow-right`, `circle-check`, `copy`, `check`, and the eight section icons.
- **Fonts:** Manrope, IBM Plex Sans and IBM Plex Mono from `context/brand/fonts/`, self-hosted with the site (no Google Fonts request).

## Tokens (the docs site's, shared by `docs-guide`, `docs-reference` and `docs-search`)

**The panel's graphite theme, since 2026-11-20** (the maintainer: the docs looked like an older product). The pictures were drawn on the brief's Abyss palette; build from this table, not their colours. `apps/docs/src/app/globals.css` defines the tokens on `:root` (dark) and `:root[data-theme="light"]`:
- **Shared names hold the panel's values:** dark from `apps/web/src/app/globals.css`, light from `light-home.md`'s table (the panel's own `[data-theme="light"]` block once ticket 18 builds it).
- **Copied, with a drift test:** sharing one file would need a new package, so the values are copied, and `apps/docs/src/app/theme-tokens.test.ts` fails when a shared token's value differs from the panel's, or a contrast pair below drops under AA.
- **Renamed to the panel's names:** `--link` is `--teal`, `--surface-2` is `--sel`, `--dialog` is `--raise`, and `--highlight` is `--line-2`. `docs-guide`, `docs-reference` and `docs-search` still use the old names: read them through this table.

| Token | Dark | Light | Used for |
|---|---|---|---|
| `--bg` | `#0D0E10` | `#FAFAFB` | Page, header, navigation, the phone drawer |
| `--surface` | `#131416` | `#F3F3F5` | Code blocks, fields, callouts, outline buttons and chips, group bands, hover |
| `--raise` | `#17181B` | `#FFFFFF` | The search dialog, tooltips |
| `--sel` | `#1A1B1E` | `#E8E9EC` | The selected nav row, search result and segment; button hover; skeleton bars |
| `--line` | `#1F2023` | `#E3E4E7` | Hairlines (decorative, no contrast need) |
| `--line-2` | `#2A2C30` | `#D0D2D6` | Dialog, drawer and tooltip edges; the search match and the reference's target row (as the panel's `mark`) |
| `--control` (docs only) | `#62656B` | `#7F8288` | Borders of fields, outline buttons, chips: 3.30:1 and 3.69:1 on `--bg` (WCAG 1.4.11). The panel draws these in `--line-2`; the docs keep 3:1 (decided 2026-11-19, README). Dark is the panel's own quiet grey (`--chart-2`), light its light `--chart` |
| `--text` | `#F2F3F4` | `#141518` | Titles, values, code |
| `--text-2` | `#D6D8DB` | `#2B2D32` | Prose, callout text, nav rows (as the panel's sidebar rows) |
| `--muted` | `#B4B7BB` | `#4A4D53` | Ledes, secondary text, the reference's descriptions, search snippets |
| `--faint` | `#8B8E93` | `#62656B` | Labels, numbers, hints |
| `--teal` | `#6FB8AA` | `#1F6B5E` | Links, the `run` chip, the current TOC row, the focus ring |
| `--green` | `#4FB286` | `#25734F` | Success (the copy button's tick) |
| `--red` | `#E5675C` | `#B4382D` | The "Not isolated" callout, errors |
| `--primary` / `--on-primary` | `#F3F0E8` / `#0C1D21` | `#141518` / `#FAFAFB` | The one primary button (the panel's Shell and Ink in dark; graphite on the page's white in light) |
| `--overlay` (docs only) | `rgba(0,0,0,0.5)` | `rgba(13,14,16,0.4)` | The scrim behind the search and the drawer (dark as the panel's palette) |
| `--dialog-shadow` (docs only) | `0 16px 48px rgba(0,0,0,0.5)` | `0 8px 24px rgba(13,14,16,0.12)` | The search dialog (the panel's palette in dark, its `--shadow-pop` in light) |

**No amber on the docs site.** Buoy Amber means "this needs you" (`brief.md`), and nothing in the docs waits on the reader.

**Contrast (WCAG AA), measured** for every text token on every background (`--bg`, `--surface`, `--raise`, `--sel`), lowest first:
- **Dark:** `--faint` 5.24:1 on `--sel` (5.87:1 on `--bg`), `--red` 5.27:1, `--green` 6.60:1, `--teal` 7.47:1, `--muted` 8.55:1, `--text-2` 12.06:1, `--text` 15.50:1.
- **Light** (the graphite set of 2026-11-20): `--green` 4.75:1 on `--sel` (5.52:1 on `--bg`), `--faint` 4.81:1, `--red` 4.88:1, `--teal` 5.21:1, `--muted` 6.98:1, `--text-2` 11.35:1, `--text` 15.04:1.
- **Both:** `--text` on the search match (`--line-2`) 12.59:1 dark and 12.06:1 light; the primary button 15.2:1 dark and 17.5:1 light. `--control` passes 3:1 on `--bg`, `--surface` and `--raise` (lowest 3.04:1, dark on `--raise`).

**The illustration** keeps its own colours in both themes: in dark it's feathered into graphite with the radial mask (its water reads as a soft glow); in light it's a rounded window, on the home page and in the search's empty state alike.

**Type:** Manrope 800 for the `h1`, 700 for `h2`s; IBM Plex Sans 400 for prose (15 to 16.5px), 500 for nav and links, 600 for small titles; IBM Plex Mono for commands, setting names, paths, versions and numbers.

## Differences from the current code

1. **Everything is new:** there's no `apps/docs` (spec section 1). Ticket 21 creates it, Apache-2.0, private.
2. **The tokens** are the panel's graphite (`apps/web/src/app/globals.css`), as the table above says; the fonts and the logo files are the same. (First built on the brand's Abyss tokens, `files/tokens/`; superseded 2026-11-20.)
3. **`OSTRA_DOCS_URL`** (spec section 5) points the panel's help links here; its default is the Pages address.

## Open points (recommendations; ticket 21 records the answer)

1. **"Match my system" on the docs.** Recommended: dark first for a first visit (`brief.md`: dark mode first), and the toggle remembers a choice. The console's own "match my system" (F-082) is a member's setting; the docs have no member.
2. **The repo's address in the copy.** The picture uses `JoeyKhd/ostra`, today's repo. If the repo moves to an organization before launch, the address comes from one constant, never typed in pages.

## Wrong in the image (build from this file)

- **The colours:** the picture is drawn on Abyss; build the graphite tokens above.
- **Field and button borders** are drawn in Kelp `#2F4A47` (1.8:1 on Abyss) in dark and a pale line in light: build them with `--control` so they pass 3:1.
- **The illustration in dark** has a soft square edge at its top right: build the radial feather.
- **`Linear is optional`** sits far right on the Before-you-start row: keep it, but as a link to the Linear page, underlined.
- **The grid's text** wraps to two lines in most cells: fine at this width; keep the copy.
- **Wordmark and logo** are the model's drawing: use the real files.
- **The footer** is below the fold and not drawn: build it from this file.

Right as drawn: no sidebar, no amber, one primary button, the hairline grid with no cards, the three numbered columns, the header's search with its key chip, and the Deep water stone as the only picture.
