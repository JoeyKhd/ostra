# Target: a docs guide page, the install guide (milestone 7, screen 2)

> **Committed images:** `docs-guide.webp`, downscaled from a 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel; and `docs-guide-phone.webp`, 982×780: both phone screens of one 2048×1360 picture, cropped to them with a margin and downscaled so each screen is **390 CSS px wide**. The left screen sits at x 24–414, the right one at x 568–958, both at y 10–768 (758 tall, cut at the bottom). Sizes in this file are CSS px.

- **Prompts:** `docs-guide.prompt.txt` and `docs-guide-phone.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), one generation each, kept. References for the desktop picture: the approved 2048 original of `app-targets/m1/environment` (the start spec section 13 names: its numbered code block and hairline rows), `app-concepts/html/home-graphite.png` and the Hinge logo. For the phone picture: the desktop picture, the approved 2048 original of `app-targets/m3/phone-approval` (how a phone screen is drawn) and the Hinge logo.
- **Route (new):** `apps/docs/app/docs/[[...slug]]/page.tsx`; this page is `/docs/install/docker-compose`, from `apps/docs/content/install/docker-compose.mdx`.
- **Features:** F-058 (the docs site, the install guide, "every `run` command block checked"), F-076 (the 30-minute measure follows these pages and nothing else; a gap the newcomer hits is a docs bug). ADR 0063, ADR 0029 (what `host` doesn't isolate), F-001 and Q97 (the Docker socket warning). Ticket 21 builds the layout; ticket 22 writes the install, setup and runner pages and the command check.
- **Status:** a proposed target, waiting on approval (ticket 12's `## Comments`).
- **Tokens, header and type:** `docs-home.md` ("Header", "Tokens"). This file doesn't repeat them. Since 2026-11-20 they're the panel's graphite theme, renamed to its names (`--link` is `--teal`, `--surface-2` `--sel`, `--dialog` `--raise`, `--highlight` `--line-2`): a colour or old name below means its row in `docs-home.md`'s table.

> Build it in real HTML/React, then screenshot the build at 1440×956 and at 390×844, and compare each with its picture.

## Purpose

The page a newcomer follows with a terminal open. Every guide page has the same frame, so the install guide stands for all of them:
- where they are (the navigation by section, the breadcrumb, "On this page");
- the steps in order, numbered, each with the commands to paste, copied in one click;
- which commands ostra itself runs on every release (the `run` marker), so they know the page was checked;
- what can hurt them (a warning) and what isn't isolated (the `host` executor), said where it matters, not in a separate security page only;
- where to go next, and how to fix the page.

## Layout (CSS px at 1440×956)

| Region | Size | Contents |
|---|---|---|
| Header | full width, 56px | As `docs-home.md` |
| Navigation | 264px, 1px `--line` on its right, `position: sticky`, scrolls on its own | The sections and their pages |
| Article | `1fr`, content `max-width: 720px` at x 304, padding `24px 40px` | Breadcrumb, title, lede, steps, callouts, previous/next |
| On this page | 248px, 1px `--line` on its left, padding `24px 20px`, sticky | The page's headings; Edit on GitHub |

Below 1180px the right rail goes and "On this page" becomes the collapsible row of the phone layout, above the title. Below 900px the navigation becomes the drawer.

### Navigation

- Padding `20px 12px`. Sections from the content tree (`meta.json`), in ADR 0063's order: Start, Install, Runners, Agents and models, Using ostra, Security, Reference, Contributing.
- **The open section** (the current page's) shows a 12px weight 500 `--faint` label and its pages as 32px rows, 14px weight 500 `--muted`, padding-left 12px, radius 6px. The current page: `--surface` fill, `--text`, `aria-current="page"`. Hover: `--surface`.
- Start stays open too (it's short and first). **The other sections** are 38px rows, 14.5px weight 500 `--muted`, with Lucide `chevron-right` 15px `--faint` at the right, hairlines between them; a click opens the section in place (`chevron-down`) without navigating.
- Install's pages, in the checklist's order (ticket 22, F-076): `Install with Docker Compose`, `First sign-in`, `Setup in the panel`, `Linear (optional)`, `Kubernetes with Helm`, `Upgrading`.

### Article

1. **Breadcrumb**, 13px `--faint`, `›` separators: `Install › Install with Docker Compose`; the section links to its first page.
2. **Title** `h1`, Manrope 800 32px `--text`: `Install with Docker Compose`.
3. **Lede**, 16px `--muted`: `From a Linux machine with Docker to the panel's sign-in page, in about ten minutes.`
4. **Steps.** Each step is an `h2`, 21px Manrope 700 `--text`, with its number in Plex Mono 18px `--faint` in a 36px column before it (the number is part of the layout, not the heading's text, so the anchor is `#get-the-compose-file`). 28px above, 8px below. Then its paragraph, 15px `--muted`, line-height 1.6.

| Step | Heading | Paragraph | Code (`sh`, marked `run`) |
|---|---|---|---|
| 1 | `Get the compose file` | `Download this release's compose file into an empty folder.` | `mkdir ostra && cd ostra` / `curl -fsSLO https://github.com/JoeyKhd/ostra/releases/download/v1.0.0/compose.yaml` |
| 2 | `Start it` | (none) | `docker compose up -d` / `docker compose ps` |
| 3 | `Open the panel` | `Open http://localhost:3000 and sign in as demo.` (address and username in inline code) | (none) |

   The version in the URL comes from the release line at build time. The headings after these (`Required settings`, `Next steps`) are below the fold.

5. **Code block.** `--surface`, 1px `--line`, radius 8px, margin 12px 0:
   - **Strip**, 34px, hairline under it, padding `0 10px 0 16px`: the language, Plex Mono 12.5px `--faint` (`sh`); on the right the **run marker** and the copy button.
   - **The run marker:** a 24px chip, 1px `--link` border, radius 5px, Lucide `play` 12px + `run`, Plex Mono 12.5px `--link`. It's a `button`-less label with a `Tooltip` (and `aria-describedby` text): `ostra runs this block on a fresh machine before each release.` It shows only on blocks marked `run` in the source (` ```sh run `, ticket 22's extractor reads the same meta), never on blocks that need the reader's own values.
   - **Copy:** a 28px icon button (Lucide `copy` 15px `--muted`), `aria-label="Copy"`; after a copy, `check` in `--green` and an `aria-live="polite"` `Copied` for 2 s. It copies the block's text exactly, without prompts or the strip.
   - **Body:** padding `14px 16px`, Plex Mono 14px `--text`, line-height 1.5, no line numbers for `sh` (a file block, such as YAML, has them, as `../m1/environment`). A long line scrolls sideways inside the block; it never wraps, so a copied command is what's shown.
6. **Callouts.** `aside` with `role="note"`, `--surface` fill, radius 0 8px 8px 0, a 2px left rule, padding `14px 18px 14px 20px`, 16px margin. A title line, a 16px Lucide icon and 15px weight 600, then 15px `--muted` text. No other border, never a box inside a box.

| Kind | Rule and icon | Title | Text in this page |
|---|---|---|---|
| Note | `--link`, `info` in `--link` | `Note` (`--text`) | `The first start creates the admin demo@demo.com with the password demo. The panel asks for a new password at the first sign-in.` (F-001) |
| Warning | `--text`, `triangle-alert` in `--text` | `Warning` (`--text`) | `The pool runner mounts the Docker socket, which is root on this machine. Run pools on machines that do nothing else.` (F-001, Q97) |
| Not isolated | `--red`, `shield-off` in `--red` | `Not isolated` (`--red`) | `A runner on the host executor runs agents in a worktree on its own machine. Its agent can reach whatever that account can.` (ADR 0029, ADR 0031) |

   "Not isolated" is its own kind, not a warning with a title, so every page that mentions the `host` executor says it the same way, and a test can find each one. Amber is never used for a callout: nothing here waits on the reader.

7. **Previous and next.** A hairline, 24px above, then two links side by side, 16px apart, each 1fr, 66px, 1px `--line` border, radius 8px, padding `12px 16px`: 12.5px `--faint` `Previous` / `Next` over 15.5px weight 500 `--text` with an arrow (`← Before you start`, `First sign-in →`, the next right-aligned). Hover: `--surface` fill, border `--control`. The order is the navigation's.

### On this page (right rail)

- 12.5px weight 500 `--faint` `On this page`, then the page's `h2`s as 30px rows, 13.5px `--muted`, padding-left 14px, a 1px `--line` rule along their left. The heading in view: `--text`, with a 2px `--link` bar over the rule (scroll-spy, `aria-current="location"`). Steps are listed without their numbers.
- A hairline, then `Edit on GitHub` (Lucide `github` 15px + 13.5px weight 500 `--muted`) linking to the page's file on `main` (`https://github.com/JoeyKhd/ostra/edit/main/apps/docs/content/install/docker-compose.mdx`; for a page read from `docs/`, that file), then 12.5px `--faint` `Last changed in v1.0.0` (the release whose build last changed the file, from git at build time).

## Phone (under 640px, `docs-guide-phone.webp`)

- **Top bar**, 52px, `--bg`, hairline under it: Lucide `menu` 20px (opens the drawer, `aria-label="Open navigation"`), the Hinge mark and wordmark, and at the right two 38px icon buttons with 1px `--control` border: `search` (opens `docs-search` full screen) and the theme toggle.
- **On this page**, a 44px row under the bar, hairline under it, 15px `--muted` and `chevron-down`: it opens the headings as a list under it, closed again by choosing one.
- **Article:** padding `0 16px`; title 28px on two lines; lede 16px; steps' headings 19px with the number in a 28px column; code blocks full width, their long lines scrolling sideways with a 24px fade at the right edge (a `mask-image` gradient, shown only while the line overflows); callouts full width. Previous/next stack, next first.
- **The drawer** (right screen): from the left, 320px (or 85vw), full height, `--bg`, 1px `--control` line on its right; the page behind dims with `rgba(6,17,20,.7)` (light: `rgba(12,29,33,.4)`). At its top a 52px row with the mark, the wordmark and an `x` close button; a 40px search field `Search the docs`; then the navigation as on desktop, rows 44px (touch targets), the current page's section open. At its foot, a hairline, `GitHub` with its icon, and the version chip. Escape, the close button, a tap outside or choosing a page closes it; focus is trapped while it's open and returns to the menu button.
- Targets are at least 44px tall on a phone; inputs are 16px so iOS doesn't zoom.

## States

| State | What shows |
|---|---|
| **Desktop, dark** (`docs-guide.webp`) | As above |
| **Phone, dark** (`docs-guide-phone.webp`) | Left: the page; right: the drawer open |
| Light | `docs-home`'s light tokens. Code blocks stay `--surface` (`#EAE6DC`) with `--text`; the `run` chip `--link` `#2B6E63`; the Not-isolated rule and title `#B4382D` |
| Copied | The copy button's `check` in `--green` and `Copied` for 2 s |
| A heading's anchor | On hover or focus, a 14px Lucide `link` in `--faint` after the heading; a click copies the URL with its `#anchor` and shows `Link copied` (as `docs-reference`) |
| A Markdown page from `docs/` | The same frame; its GitHub alerts (`> [!NOTE]`, `> [!WARNING]`, `> [!CAUTION]`) render as Note, Warning and Not isolated callouts; "Edit on GitHub" points at the file in `docs/` |
| Fallback (no Fumadocs) | The same frame, from ostra's own nav, TOC and markdown rendering; no search button |
| Print | Header, navigation, rail and previous/next hidden; code blocks wrap; links print their address |

## Components

- **Fumadocs:** the docs layout (`DocsLayout`, with the content tree from `source.pageTree` and the shared `baseOptions`), the page (`DocsPage` with `toc`, `editOnGithub` and its previous/next footer, `DocsTitle`, `DocsDescription`, `DocsBody`), `Callout` (`type` info, warn, and a third type for "Not isolated", or ostra's own `NotIsolated` wrapping it), `Steps`/`Step` or the numbered `h2` above, the code block with its copy button (`CodeBlock`/`Pre`) plus a small Shiki transformer that reads the `run` meta and renders the chip, and the mobile TOC popover. Names are those of Fumadocs' current line; ticket 21 checks them against the pinned version and restyles each to these tokens.
- **The fallback** (ADR 0063): `app/docs/[...slug]/page.tsx` renders MDX or Markdown with the panel's renderer (`@assistant-ui/react-markdown`), ostra's own `DocsNav` from the same `meta.json`, a TOC from the headings collected at build time, previous/next from the nav order, and the same code block and callout components.
- **Icons:** Lucide `menu`, `x`, `chevron-right`, `chevron-down`, `play`, `copy`, `check`, `info`, `triangle-alert`, `shield-off`, `link`, `github`, `arrow-left`, `arrow-right`.

## Accessibility (WCAG AA)

- Contrast as `docs-home.md` ("Tokens"): prose `--muted` 11.9:1 dark and 8.4:1 light; the `run` chip `--link` 6.8:1 on `--surface` dark, 4.8:1 light; the Not-isolated title `--red` 4.8:1 on `--surface` both themes.
- Landmarks: `header`, `nav` (aria-label `Docs`), `main`, `aside` (aria-label `On this page`). Headings in order, one `h1`. The callout's meaning is in its title word, never in its colour alone.
- Keyboard: Tab reaches the skip link, header, navigation, article links, each code block's copy button, previous/next and the rail; `/` or ⌘K opens search.

## Differences from the current code

1. **Everything is new** (`apps/docs`).
2. **The guide's commands** must match `deploy/compose.yaml` and the release's assets: the compose file is a release asset from ticket 33's workflow, at the URL shown.
3. **The `run` meta** is new syntax in the site's MDX; ticket 22's `scripts/check-docs-commands.ts` reads the same meta.

## Open points (recommendations; tickets 21 and 22 record the answer)

1. **Where "Last changed in" comes from.** Recommended: the git history at build time, mapped to the release tag; omitted for a page no release has changed yet.
2. **Steps as `h2`s or Fumadocs' `Steps`.** Recommended: plain `h2`s with the number as layout, so the headings land in "On this page" and in search (`docs-search` lists them).

## Wrong in the image (build from this file)

- **Field and button borders** are Kelp `#2F4A47` (1.8:1): build `--control`.
- **The rail's other headings** have no rule along their left; only the current one has its bar. Build the 1px `--line` rule with the 2px `--link` bar over it.
- **The navigation is about 280px wide** in the picture, so the article starts at x 322: build 264px, the article at x 304.
- **The phone's code lines** are cut with a ghosted glyph rather than a clean fade: build the mask.
- **Previous and next** are drawn at the fold; on the real page they follow the last section (`Next steps`).
- **Wordmark and logo** are the model's drawing: use the real files.

Right as drawn: the hairline navigation with one selected page and collapsed sections, the numbered steps, the code blocks' `sh` strip with the teal `run` chip and copy icon, the three callouts with left rules (teal, off-white, red) and no amber, "On this page" with its current row, "Edit on GitHub", and previous/next.
