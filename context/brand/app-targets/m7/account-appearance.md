# Target: Account, Appearance (milestone 7, screen 10)

> **Committed image:** `account-appearance.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Prompt:** `account-appearance.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation, kept. References: the approved 2048 original of `app-targets/m3/account` (the screen this one starts from, spec section 13), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route:** unchanged, `apps/web/src/app/(panel)/account/page.tsx` → `components/account/account-view.tsx` (`../m3/account.md`). This target adds the **Appearance** section above GitHub and an Appearance group to the panel.
- **Features:** F-082 (the theme: dark, light, match my system, per member, before first paint), F-081 (the link to the shortcut sheet). Spec section 4 ("The theme"), section 12 item 13 (Q262), section 13 row 10. Ticket 11 (`account.setTheme`), ticket 18 (the light theme and this section), ticket 13 (the `?` sheet it links to).
- **Status:** a proposed target, waiting on approval (ticket 12's `## Comments`). Ticket 18 builds its data and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

Each member chooses how the panel looks: **Dark** (the default for everyone), **Light**, or **Match my system** (follows the operating system's setting, live). The choice is saved on their account and in a cookie, so it follows them to every browser they sign in to and paints before the first frame (no dark flash on a light choice).

The section answers three things at a glance: what the choices look like (a preview each), which one is on, and, for "match my system", what that resolves to right now. The keyboard line under it points to the shortcut sheet, because Account is where people look for personal settings.

The picture shows Alex with **Match my system** selected while the system is dark.

## Layout (CSS px at 1440×960)

`../m3/account.md`'s layout at the panel's measured scale (`../m1/README.md`, "Scale"): sidebar 234px, top bar 46px, page padding `28px 36px`, content max 760px, properties panel 320px.

### Heading

- Title `Account`; the lede changes to: `Your theme, your GitHub account, and the machines where you ran ostra login. Only you see this page.`

### Appearance (new, the first section)

1. **Title line** (`Section`): `Appearance` + inline note 13px `--muted`: `saved to your account, so every browser you sign in to follows it`.
2. **Three choices,** a `RadioGroup` laid out as one row of three cards, each 236px wide with 18px between (the 760px column holds three with room to spare):
   - **The preview,** 236 × 148px, radius 8px, 1px `--line-2` border, `overflow: hidden`: a **schematic** of the panel drawn in real HTML/CSS with the theme's own tokens (not an image, not a screenshot): a 64px sidebar strip with three 6px bars and one 5px `--amber` dot, an 18px top bar with a hairline under it, two text bars (title and lede) and three hairline rows. No words inside.
     - `Dark`: the dark token set (`--bg` page, `--side` strip, `--muted`/`--faint` bars).
     - `Light`: the light set from `light-home.md` (`#FBFAF6` page, `#F3F0E8` strip, Abyss and Kelp bars).
     - `Match my system`: both, split by one diagonal from the top-right corner to the bottom-left corner, dark above, light below (two stacked schematics with a `clip-path: polygon(…)` on the light one).
     - The previews render their own token values, scoped (`data-theme` on the preview's root), so each looks right whichever theme the page is in.
   - **The label row,** 10px under the preview: a 14px `RadioGroupItem` and the label 14px. Unselected: `--line-2` ring, `--muted` label. **Selected:** `--text` ring with a 6px `--text` centre, `--text` label weight 500, and the preview gets a 2px `--text` outline at 3px offset.
   - The whole card (preview and label) is the radio's hit area (`label`), and the group is keyboard-operable as one radio group (arrows move and select, Tab leaves).
   - **Under `Match my system`,** 12px `--faint`, only when it's selected: `Your system is dark now.` / `Your system is light now.` (from `matchMedia('(prefers-color-scheme: dark)')`, live).
3. **Saving:** choosing applies at once (the page repaints; no Save button), then calls `account.setTheme`. While the call runs nothing changes visually; on failure the choice reverts and a `role="alert"` line in 12.5px `--red` under the row says `Your theme couldn't be saved: {error}. It's back to {previous}.`
4. **The keyboard line,** 14px under the row, 12px `--faint`: Lucide `keyboard` 13px, `Press` + a `Kbd` `?` (mono 11.5px, `--surface`, 1px `--line-2`, radius 4px, 18px tall) + `anywhere to see every keyboard shortcut.` + 10px + teal `Keyboard shortcuts`, which opens the `?` sheet (ticket 13). The same registry drives the sheet, so this link never lists anything itself.
5. A 1px `--line` hairline 20px below closes the section.

### GitHub and CLI sessions

Unchanged from `../m3/account.md`, below Appearance.

### Properties panel

`../m3/account.md`'s groups, with **Appearance** (new) after You:
- `Theme` · `Dark` / `Light` / `Match my system`
- `Now` · `Dark` / `Light` (only for `Match my system`: what it resolves to)
- `Shortcuts` · teal `Show all` (opens the `?` sheet)

## States

| State | What shows |
|---|---|
| **Match my system, the system dark** (`account-appearance.webp`) | As above |
| Dark (the default for a new member) | `Dark` selected; no "Your system is…" line; the panel has no `Now` row |
| Light | `Light` selected; the whole page is in light (`light-home.md`'s tokens) |
| Match my system, the system switches | The page and `Your system is … now.` follow at once (the CSS media query does the page; the line listens to `matchMedia`) |
| Saving failed | The alert line above; the choice reverts |
| Signed out of other browsers | Nothing to show: the cookie is set at sign-in from the account's `theme` (ticket 18), so a new browser paints the member's choice first time |
| Loading | The three cards render at size with their previews (they need no data); the radio reflects the cookie's value, so nothing jumps when the account loads |
| Narrow (below 1280px) | The panel drops under the page; the three cards stay in one row and shrink to fit (min 180px each) |
| Phone | The cards stack as three 56px rows: a 72 × 46px preview at the left, the radio and label beside it; the keyboard line is hidden (no `?` on a phone) |

## The sidebar's quick toggle (spec section 13, "screens that only grow")

The member menu (`components/shell/user-menu.tsx`) gains a `Theme` submenu with the same three choices as `DropdownMenuRadioItem`s (Lucide `moon`, `sun`, `monitor`), above `Account`. It calls the same `account.setTheme`. The palette's `Toggle theme` action (ticket 13) switches between dark and light, and sets the choice explicitly (it never toggles into "match my system").

## Components (shadcn/ui names)

`PageFrame`, `PageHeading`, `Section`, `RadioGroup` / `RadioGroupItem` (Radix, through `radix-ui`), `Kbd` (new, `components/ui/kbd.tsx`, shared with the shortcut sheet and the palette), `PropGroup` / `PropRow`, `DropdownMenuRadioGroup` in the user menu. New: `components/account/theme-choice.tsx` and `components/account/theme-preview.tsx` (the schematic; its variant an exhaustive `switch` over `ThemePreference`, `satisfies never`). Icons: `keyboard`, `moon`, `sun`, `monitor`.

## Tokens

The measured tokens (`apps/web/src/app/globals.css`), as `../m3/account.md`. The previews use both sets (`light-home.md`). Amber only on: the sidebar's count, and the 5px dot inside each preview (it's a picture of the panel, where that dot is the needs-you).

## Data this screen needs beyond ticket 11

- **`account.get`** returns `theme` (`ThemePreference`: `dark`, `light`, `system`; default `dark`).
- **`account.setTheme({ theme })`**, which saves it, writes the audit event `account.theme_changed`, and sets the `ostra-theme` cookie (path `/`, a year, `SameSite=Lax`, not `HttpOnly` so the client can update it before the server answers).

## Differences from the current code

1. **No Appearance.** `account-view.tsx` (milestone 3's ticket 47) has GitHub and CLI sessions only; add the section first, and the panel group.
2. **The theme is fixed.** `layout.tsx` sets `data-theme="dark"`; it reads the cookie on the server instead (ticket 18). `system` renders no `data-theme`, and `globals.css`'s media query decides.
3. **The user menu** has no theme submenu.
4. **`Kbd`** doesn't exist in `components/ui/`; the shortcut sheet (ticket 13) and this page share one.
5. **Messages:** new keys under `account.appearance.*` and `userMenu.theme.*`.

## WCAG AA check (F-081)

Dark: label `--muted` 9.6:1, selected `--text` 17.4:1, the note and keyboard line `--faint` 5.9:1, `Keyboard shortcuts` `--teal` 8.4:1. The selected state is never colour alone: the filled radio and the outline both mark it. The previews are decorative for assistive tech (`aria-hidden`); each radio's accessible name is its label. Light: `light-home.md`'s values, the selected outline `--text` (Abyss).

## Open points (recommendations; ticket 18 records the answer)

1. **Appearance first, above GitHub.** Recommended, as drawn: everyone uses it, while GitHub and CLI sessions matter to some.
2. **Apply at once, no Save.** Recommended: the preview *is* the page.
3. **A theme per device.** Not offered: "match my system" covers a member whose machines differ.

## Wrong in the image (build from this file)

- **The preview cards** are about 252px wide with 22px gaps. Build 236px and 18px.
- **The selected outline** is 3px off-white with rounded corners and a 4px offset. Build 2px at a 3px offset, radius 11px (the card's 8px plus the offset).
- **The light preview's** bars are grey; build Abyss and Kelp bars from the light tokens, so it reads warm.
- **The keyboard line's `?` key** is a 26px box. Build the shared `Kbd`, 18px.
- **The `GitHub` title** sits directly under a hairline at the end of Appearance. Keep the section's 20px hairline and `Section`'s normal top margin above GitHub.
- **The `Linear` icon** is a half-filled circle. Use the icon milestone 2's Linear screen settled on.
- **The panel's values** (`Alex Kim`, `Admin of Acme Corp`, `Match my system`, `Dark`, `30 days`) are drawn in sans, rightly; `Email`, `Login`, `Linked` and `Active` are mono, as drawn.

Right as drawn: the three schematic previews with no words inside, the diagonal split on `Match my system`, the selected outline and filled radio, `Your system is dark now.` under it, the keyboard line with the `?` key and teal `Keyboard shortcuts`, the Appearance group in the panel with `Theme`, `Now` and `Show all`, and GitHub and CLI sessions unchanged below.
