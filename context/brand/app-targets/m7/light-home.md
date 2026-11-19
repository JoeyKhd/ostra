# Target: Home in the light theme (milestone 7, screen 11)

> **Committed image:** `light-home.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Prompt:** `light-home.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation, kept. References: the approved 2048 original of `app-targets/m1/home` (the screen this one starts from, spec section 13), `app-concepts/html/home-graphite.png` and the Abyss Hinge logo `kit/logo/export/ostra-hinge-2048.png` (the light-background export).
- **Route:** unchanged, `apps/web/src/app/(panel)/page.tsx` → Home's Overview (`../m1/home.md`, with milestone 3's `Overview` / `Board` toggle from `../m3/home-board.md`). Nothing on the page changes but its colours.
- **Features:** F-082 (the theme). Spec section 4 ("The theme"), section 12 item 13 (Q262), section 13 row 11. Ticket 18 (the light theme and Appearance), ticket 17 (the contrast check in both themes).
- **Status:** a proposed target, waiting on approval (ticket 12's `## Comments`). Ticket 18 builds its tokens and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 with `data-theme="light"` and compare it with the picture.

## Purpose

This target, with `light-task`, **settles the light theme for every screen**. No other screen of milestones 1 to 7 gets a light picture: each is the dark build with the token values below swapped in (spec section 13, last line). So this file is mostly a token table and its rules, and the picture is the proof that they make a calm, legible page.

What it has to get right:
1. **The surfaces:** page, sidebar, raised surfaces, selected rows and lines as distinct, quiet steps of warm paper, the way the dark theme's graphite steps are.
2. **The needs-you amber** where amber can't be text: Buoy Amber stays the one signal, as fills only, and a darker amber carries it where it has to be text or an icon.
3. **The sidebar:** the same rows, counts and project markers on Shell.

The picture is milestone 1's Home (`../m1/home.webp`) with milestone 3's view toggle, in light: the five needs-you rows, the projects table, recent activity and the side panel's PRs chart, spend and runner pools.

## The light tokens (`[data-theme="light"]`)

The same variable names as the dark set in `apps/web/src/app/globals.css`; only the values change. Every contrast is WCAG 2.2, computed against the token it sits on (`#FBFAF6` page unless noted).

| Token | Dark (today) | **Light** | Used for | Contrast in light |
|---|---|---|---|---|
| `--bg` | `#0D0E10` | `#FBFAF6` (Shell, lifted) | page, properties panel | — |
| `--side` | `#0A0B0C` | `#F3F0E8` (Shell) | sidebar | — |
| `--surface` | `#131416` | `#F3F0E8` (Shell) | inputs, code blocks, the composer, outline buttons, the search field, group bands | — |
| `--raise` | `#17181B` | `#FFFFFF` | menus, popovers, dialogs, tooltips (they sit above the page, so they're the lightest step) | — |
| `--sel` | `#1A1B1E` | `#E8E4D9` | the selected row and nav item, the view toggle's selected half, avatars' fill | — |
| `--line` | `#1F2023` | `#E4E1D8` | hairlines: rows, panel edges, group separators | 1.24:1 (a hairline, never the only cue) |
| `--line-2` | `#2A2C30` | `#CFD8D4` (Mist) | control borders: buttons, inputs, chips, the composer | 1.39:1 (the label carries the control, as in dark) |
| `--text` | `#F2F3F4` | `#0C1D21` (Abyss) | titles, values, row titles | 16.6:1 |
| `--text-2` | `#D6D8DB` | `#1E3135` | sidebar rows | 11.9:1 on `--side` |
| `--muted` | `#B4B7BB` | `#2F4A47` (Kelp) | lede, secondary text, keys, project names in rows | 9.2:1 |
| `--faint` | `#8B8E93` | `#5A6664` | labels, ages, counts, table heads, icons | 5.7:1; 5.2:1 on `--side`; 4.7:1 on `--sel` |
| `--teal` | `#6FB8AA` | `#1F6B5E` | links and inline actions (`Open all →`, `Take over`), the focus ring | 6.1:1 |
| `--green` | `#4FB286` | `#25734F` | success, additions, merged | 5.5:1; 5.0:1 on the diff's add fill |
| `--red` | `#E5675C` | `#B4382D` | errors, failures, deletions | 5.7:1; 5.1:1 on the diff's delete fill |
| `--amber` | `#FFB224` | `#FFB224` (unchanged) | **fills only** in light: the Needs you count pill, status and project dots, the approval's rule, `Approve` buttons | `--ink` on it 9.6:1 |
| `--amber-text` (**new**) | `#FFB224` | `#8A5300` | amber that has to be text or a line icon: the approval title and its `hand`, the Needs you column's numbers | 6.1:1 |
| `--primary` (**new**) | `#F3F0E8` (`--shell`) | `#0C1D21` (`--ink`) | the one primary button's fill (`New task`, `Send`), the sidebar's `+` | — |
| `--on-primary` (**new**) | `#0C1D21` | `#F3F0E8` | text and icon on the primary fill | 15.2:1 |
| `--chart` (**new**) | `#CFD8D4` (Mist) | `#748A85` | single-series bars and lines; "now" bars at 45% | 3.5:1 (graphics need 3:1) |
| `--track` (**new**) | `--line` | `#E4E1D8` | meter tracks (spend, pools, context) | — |
| `--meter` (**new**) | `--mist` | `#2F4A47` (Kelp) | meter fills | 9.2:1 |
| `--diff-add` (**new**) | `rgba(79,178,134,0.10)` | `#E6F2EA` | added lines' fill | `--text` on it 15.0:1 |
| `--diff-del` (**new**) | `rgba(229,103,92,0.10)` | `#FBE9E6` | removed lines' fill | `--text` on it 14.8:1 |
| `--shadow-pop` (**new**) | `0 8px 24px rgba(0,0,0,0.45)` | `0 8px 24px rgba(12,29,33,0.12)` | overlays only (menus, dialogs, the palette); no page element has a shadow | — |
| `--ink`, `--shell`, `--mist` | brand constants | unchanged | brand colours by name, never by role | — |

`color-scheme: light`, `<meta name="theme-color">` `#FBFAF6` (dark `#0D0E10`), and the Abyss Hinge (`ostra-hinge.svg`) in the sidebar instead of the Shell one.

### Where the light set comes from

`context/brand/files/tokens/tokens.css`'s light theme is `background: Shell`, `surface: Mist`, `text: Abyss`, `text-muted: Kelp`, `line: Mist`, `signal: Buoy Amber`. The panel keeps its text, muted, line-2 and signal exactly. It moves two, for the same reason the dark panel moved off Abyss (`app-design.md`, rule 1): a Mist surface under a Shell page reads green-grey and muddy at panel density, and a page that *is* Shell leaves no lighter step for the page against the sidebar. So the page is Shell lifted halfway to white (`#FBFAF6`), and Shell itself becomes the sidebar and the raised surfaces. Open point 1 asks the maintainer to confirm it.

## Rules every light screen follows

1. **Swap values, never structure.** A light screen is its dark build with the token values above. No component gets a `light:` variant of its own layout, border or weight. If a dark screen used a raw hex or `rgba` (`sidebar.tsx`'s `hover:bg-[#e6e2d8]`, `status.tsx`'s halos, `button.tsx`'s primary), it moves to a token first (ticket 18).
2. **Amber is a fill.** Buoy Amber on Shell or paper is 1.7:1, unreadable (`brief.md`: "never use it as text on Shell"). In light:
   - Fills stay `--amber` with `--ink` text: the sidebar's count pill, `Approve`, `Approve once`, `Keep working`.
   - **Dots** (the status dot, a project's waiting dot, the Needs you section dot) are `--amber` with a 1px inner ring of `--amber-text` at 55% (`box-shadow: inset 0 0 0 1px rgb(138 83 0 / 0.55)`) in place of the dark theme's 3px halo, so a 7px dot holds its edge on paper. A dot never stands alone: its label says the same.
   - **Text and line icons** that mean needs-you use `--amber-text`: the approval's `Needs you · approval` and its `hand`, the projects table's Needs you numbers (weight 600). Everything else that's amber in dark is a fill in light.
   - Still one meaning: nothing that isn't needs-you is amber or orange in either theme (project squares included).
3. **Project squares** keep their hues; on paper they're drawn at the same 8px with no border.
4. **The sidebar** is `--side` (Shell) with a 1px `--line` on its right; the selected row `--sel` with `--text` weight 500; counts `--faint`; the org switcher's mark is the Abyss Hinge.
5. **Rows and tables** are hairlines on the page, no boxes, as in dark. Table heads 12px `--faint`; mono numbers `--text`.
6. **Buttons:** the one primary is `--primary` (Abyss) with `--on-primary` (Shell) text; outline buttons are `--surface` with a 1px `--line-2` border and `--text`; ghost buttons `--muted`, `--text` on hover with `--sel` behind. Hover on a primary: `--primary` at 88%.
7. **Charts and meters:** bars `--chart`, the "now" bar `--chart` at 45%, labels `--faint` with the peak and today in `--text`; meters a 4px `--track` with a `--meter` fill. A meter at its limit doesn't change colour (the status carries the need).
8. **Focus:** a 2px `--teal` outline at 2px offset, in both themes (6.1:1 on paper).
9. **Overlays** (menus, the palette, dialogs, tooltips) are `--raise` (white) with a 1px `--line-2` border and `--shadow-pop`. They're the only things with a shadow.
10. **Images and illustrations:** the Deep water illustration (`files/web/sign-in-illustration.webp`) stays as it is on the sign-in page in both themes; it's dark art in its own column, never recoloured.

## Layout (CSS px at 1440×960)

Unchanged from `../m1/home.md` and `../m3/home-board.md` (the toggle). The picture matches the dark one region for region: sidebar 234px, top bar 46px, main padding `28px 36px`, side panel 320px (the picture draws it about 350px: build 320px).

## States

| State | What shows in light |
|---|---|
| **The overview with five needs-you items** (`light-home.webp`) | As above |
| No needs-you items | `../m1/home.md`'s empty line, `--faint`; the sidebar has no pill, and nothing on the page is amber |
| First run (`../m2/home-first-run.md`) | The checklist's ticks: a done tick is a `--green` fill with a white check in light (5.8:1; dark keeps `--ink`), so `step-tick.tsx`'s `text-ink` becomes a token. Pending rings `--line-2`; the current step's ring `--text` |
| The default-password banner (`../m1/home-banner`) | `--surface` band with a 1px `--line` under it; its text `--text`; its link `--teal`. It's not needs-you, so never amber |
| Board view (`../m3/home-board.md`) | Column headers are `--surface` bands; cards are rows on `--bg` with a 1px `--line` border (the board's one allowed box, as in dark); the Needs you column's header dot follows rule 2 |
| Loading | `Skeleton` bars `--sel` |
| Errors | `--red` text, `triangle-alert` `--red` |
| Narrow / phone | As dark (`../m2/phone-inbox.md` and `../m3/phone-approval.md`), with these tokens |

## Components (shadcn/ui names)

No new component. `Sidebar`, `PageFrame`, `PageHeading`, `Section`, `Table`, `Button` (`primary`, `amber`, `outline`, `ghost`), the `Status` dot (`ui/status.tsx`), `Skeleton`, the chart (`dataviz` skill rules). The work is in `globals.css` and in moving raw colours to tokens.

## Data this screen needs

None beyond milestone 3's Home. The theme itself comes from the member's account (`theme`, ticket 11) and the cookie (ticket 18).

## Differences from the current code

1. **No light set.** `globals.css` defines only `:root` (dark) and says the light theme "is left for later". Add `[data-theme="light"]` with the table's values, and the same block under `@media (prefers-color-scheme: light) { :root:not([data-theme]) { … } }` for "match my system".
2. **`layout.tsx` hard-codes `data-theme="dark"`.** It reads the theme cookie on the server and sets `dark`, `light` or nothing (`system`), plus `themeColor` and `colorScheme` (ticket 18).
3. **Raw colours outside the tokens** that must move to tokens first: `button.tsx` (`primary`: `bg-shell text-ink hover:bg-[#e6e2d8]`), `sidebar.tsx` (the `+` button, the same), `status.tsx` and `runner-rows.tsx` (halos as `rgba`), every overlay's `shadow-[0_8px_24px_rgba(0,0,0,0.45)]` (`dropdown-menu`, `popover`, `select`, `tooltip`, `alert-dialog`, `storage-view`, `new-task-view`, `command-menu`), and `step-tick.tsx`'s `text-ink`. New tokens: `--amber-text`, `--primary`, `--on-primary`, `--chart`, `--track`, `--meter`, `--diff-add`, `--diff-del`, `--shadow-pop`.
4. **The logo** in the sidebar is the Shell Hinge only; light needs the Abyss export (`ostra-hinge.svg`), swapped by the theme (two `<img>`s with `data-theme` CSS, so nothing flashes before hydration).

## WCAG AA check (F-081)

Every text pair above passes 4.5:1, the smallest being `--faint` on `--sel` at 4.7:1; large text and graphics pass 3:1 (`--chart` 3.5:1). Ticket 17's contrast walk checks the built pages in both themes; this table is what it should find. Amber text never appears in light (rule 2), which is the one pair that would fail.

## Open points (recommendations; ticket 18 records the answer)

1. **Page = Shell lifted, not Shell.** Recommended as drawn: `#FBFAF6` page, Shell sidebar and surfaces, Mist only as control borders. The alternative, the brand file's exact light set (Shell page, Mist surfaces), was not drawn; it makes fields and code blocks green-grey.
2. **`--amber-text`.** Recommended: one token, `#FFB224` in dark and `#8A5300` in light, so components say "amber text" once. It's needs-you's colour darkened to pass on paper, not a second signal.
3. **Charts in light.** Recommended `#748A85` (Mist darkened to 3.5:1). The picture draws `#95AFA9`, which fails 3:1.

## Wrong in the image (build from this file)

- **The side panel** is about 350px. Build 320px.
- **The chart's bars** are `#95AFA9` (2.2:1). Build `--chart` `#748A85`, today's bar at 45%.
- **The Needs you dot** in the section title has an amber halo ring; the sidebar's project dots have none. Build rule 2's 1px inner ring on every amber dot, no halo.
- **The view toggle** sits 12px closer to the lede than in `../m3/home-board`. Build milestone 3's spacing.
- **The outline buttons in the needs-you rows** have weight 600 text. Build weight 500, as dark.
- **The sidebar's org mark** is a filled circle with a slash. Build the Abyss Hinge from `kit/logo/export/ostra-hinge.svg`.
- **The Needs you column's numbers** are drawn in a reddish amber close to `--red`. Build `--amber-text` `#8A5300` weight 600.

Right as drawn: the warm paper page and the darker Shell sidebar, the selected `Home` row, the amber count pill with dark text, the amber `Approve` fill as the page's one amber button, the Abyss `New task` primary and the dark `+`, hairline rows with no boxes, teal links, the green merge and red stopped icons, and the Kelp meter fills on pale tracks.
