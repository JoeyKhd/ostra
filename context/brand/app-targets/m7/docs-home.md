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

It's a brand surface, not the console (`brief.md`: "Abyss is the default background for the docs"): the Deep water palette, dark first, with the console's fonts, logo, density and hairline style. No console sidebar, no organization, no amber.

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
  1. Eyebrow, Plex Mono 13px `--link`: `Documentation · v1.0.0`.
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
- A 4 × 2 grid, `ul`, 1px `--line` hairlines between cells and along the top and bottom, no fills. Each cell is one link, 88px, padding 18px 20px: a 17px Lucide icon `--muted` at the left, then the title 16px weight 600 `--text` and one line of 13.5px `--faint` text (two at most). Hover: `--surface` fill and the title in `--link`.

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

From `brand/files/tokens/tokens.css` (Abyss, Shell, Kelp, Mist, Buoy Amber), with the console's status colours. `apps/docs` defines them as CSS variables on `:root` (dark) and `:root[data-theme="light"]`.

| Token | Dark | Light | Used for |
|---|---|---|---|
| `--bg` | `#0C1D21` Abyss | `#F3F0E8` Shell | Page, header, navigation |
| `--surface` | `#112629` | `#EAE6DC` | Code blocks, fields, callouts, selected nav row, hover |
| `--surface-2` | `#163035` | `#E2DDD0` | The selected search result |
| `--dialog` | `#0F2226` | `#F7F5EF` | The search dialog |
| `--line` | `#1A3034` | `#DDD8CC` | Hairlines (decorative, no contrast need) |
| `--control` | `#5A7A76` | `#7D8B87` | Borders of fields, outline buttons, chips: 3.69:1 and 3.12:1 on `--bg` (WCAG 1.4.11) |
| `--text` | `#F3F0E8` | `#0C1D21` | Titles, body on code, values |
| `--muted` | `#CFD8D4` Mist | `#2F4A47` Kelp | Prose, nav rows |
| `--faint` | `#8FA6A2` | `#53625F` | Labels, numbers, hints |
| `--link` | `#6FB8AA` | `#2B6E63` | Links, the `run` chip, the current TOC row |
| `--green` | `#4FB286` | `#276B4E` | Success, if a page needs it |
| `--red` | `#E5675C` | `#B4382D` | The "Not isolated" callout, errors |
| `--highlight` | `#1F3F44` | `#D5E5E0` | Search match background |
| `--primary` / `--on-primary` | `#F3F0E8` / `#0C1D21` | `#0C1D21` / `#F3F0E8` | The one primary button |

**No amber on the docs site.** Buoy Amber means "this needs you" (`brief.md`), and nothing in the docs waits on the reader.

**Contrast (WCAG AA), measured:** dark `--text` 15.2:1, `--muted` 11.9:1, `--faint` 6.7:1 (6.1:1 on `--surface`), `--link` 7.5:1 (6.8:1 on `--surface`), `--red` 5.3:1 (4.8:1 on `--surface`); light `--text` 15.2:1, `--muted` 8.4:1, `--faint` 5.6:1 (5.1:1 on `--surface`, 4.7:1 on `--surface-2`), `--link` 5.3:1 (4.8:1 on `--surface`), `--red` 4.8:1 on `--surface`, `--green` 5.6:1; the primary button 15.2:1 both ways. Every pair passes 4.5:1 for text; controls pass 3:1 with `--control`.

**Type:** Manrope 800 for the `h1`, 700 for `h2`s; IBM Plex Sans 400 for prose (15 to 16.5px), 500 for nav and links, 600 for small titles; IBM Plex Mono for commands, setting names, paths, versions and numbers.

## Differences from the current code

1. **Everything is new:** there's no `apps/docs` (spec section 1). Ticket 21 creates it, Apache-2.0, private.
2. **The tokens** are the brand's (`files/tokens/`), not the panel's graphite (`apps/web/src/app/globals.css`); the fonts and the logo files are the same.
3. **`OSTRA_DOCS_URL`** (spec section 5) points the panel's help links here; its default is the Pages address.

## Open points (recommendations; ticket 21 records the answer)

1. **"Match my system" on the docs.** Recommended: dark first for a first visit (`brief.md`: dark mode first), and the toggle remembers a choice. The console's own "match my system" (F-082) is a member's setting; the docs have no member.
2. **The repo's address in the copy.** The picture uses `JoeyKhd/ostra`, today's repo. If the repo moves to an organization before launch, the address comes from one constant, never typed in pages.

## Wrong in the image (build from this file)

- **Field and button borders** are drawn in Kelp `#2F4A47` (1.8:1 on Abyss) in dark and a pale line in light: build them with `--control` so they pass 3:1.
- **The illustration in dark** has a soft square edge at its top right: build the radial feather.
- **`Linear is optional`** sits far right on the Before-you-start row: keep it, but as a link to the Linear page, underlined.
- **The grid's text** wraps to two lines in most cells: fine at this width; keep the copy.
- **Wordmark and logo** are the model's drawing: use the real files.
- **The footer** is below the fold and not drawn: build it from this file.

Right as drawn: no sidebar, no amber, one primary button, the hairline grid with no cards, the three numbered columns, the header's search with its key chip, and the Deep water stone as the only picture.
