# 18: Web: the light theme and Appearance

Status: resolved
Builder: web
Blocked by: 11, 12
Features: F-082
Packages: `apps/web` (`src/app/globals.css`, `src/app/layout.tsx`, Account, the sidebar), `context/brand/files/tokens/` (read)
Spec: `../spec.md`, sections 4 and 12 (item 13); targets `account-appearance`, `light-home`, `light-task`

## What to build

- **The light tokens** under `[data-theme="light"]`, from the brand's token files, and the same set under `@media (prefers-color-scheme: light)` for `system`; nothing outside the token set changes per theme.
- **Before first paint:** the root layout reads the theme cookie on the server and sets `data-theme` (`dark`, `light`, or none for `system`), and `themeColor` and `colorScheme` to match.
- **Account, "Appearance"**, and the sidebar's quick toggle, through `account.setTheme`.
- **Every screen of milestones 1 to 7 in light:** walked by ticket 17; any screen whose light rendering needs a decision `light-home` and `light-task` don't settle gets a target first (spec section 13, last line).

## Done when

- [x] Tests named for `F-082` (Playwright): a new member sees dark; "Light" survives a reload with no dark frame (the first screenshot after navigation is light); "Match my system" follows the emulated scheme both ways; the choice is per member.
- [ ] Ticket 17's contrast check passes in light on every route.
- [x] Typecheck, lint and tests of `apps/web` pass.
- [x] Committed as `✨ add the light theme`.

## Comments

- 2026-11-20, web: built against the approved `light-home` and `light-task` (the maintainer, 2026-11-20) and `account-appearance`.
  - **The tokens.** `globals.css` has `light-home.md`'s table under `[data-theme="light"]`, and the same block under `@media (prefers-color-scheme: light) { :root:not([data-theme]) }` for "match my system"; `[data-theme="dark"]` takes the dark set too, so Appearance's previews show either theme inside the other. `apps/web/src/app/theme-tokens.test.ts` holds both light blocks to the table and checks every text colour on every surface at 4.5:1 in both themes. The raw colours the target listed moved to tokens first: the primary (`--primary`, `--on-primary`), text on amber (`--on-amber`), amber as text (`--amber-text`), the dots' edge (`--dot-amber`, `--dot-green`: dark's 3px halo, light's 1px inner ring on amber), the needs-you rule (`--rule-needs-you`, 2px dark, 3px light), overlay shadows (`--shadow-pop`, and `--shadow-palette` for the palette's larger one), the scrim (`--scrim`), meters (`--meter`), Home's "today" bar (`--chart-now`), row hover (`--hover`), a focused composer's border (`--line-3`), the diff's fills (renamed `--diff-add` and `--diff-del`, the table's names), and the logos (`--logo-mark`, `--logo-lockup`: the Shell exports in dark, the Abyss ones in light, drawn as CSS backgrounds so the right one paints first).
  - **Before first paint.** The root layout sets `data-theme` (none for `system`) and the viewport's `themeColor` and `colorScheme` on the server. Decided here: a signed-in member's account wins over the cookie, so every browser they sign in to follows their choice and a second member in the same browser gets their own; the cookie decides the pages before sign-in. A browser whose cookie doesn't hold the account's theme (a first sign-in) has it set once by the panel through `account.setTheme`, which is ticket 11's "the cookie is set at sign-in" without a change to the API. The cookie stays `HttpOnly` (ticket 11), so the panel repaints itself at once and the server sets the cookie.
  - **Account, Appearance** first, above GitHub, with the panel's Appearance group; the member menu's `Theme` submenu (`moon`, `sun`, `monitor`). Both go through one `ThemeProvider` (`components/shell/theme-provider.tsx`, `useTheme()`), which ticket 13's palette action can call too. A failed save reverts and says so.
  - **The keyboard line** and the panel's `Show all` open ticket 16's shortcut sheet through the shell's `openSheet`. Ticket 13's palette action `toggle-theme`, which landed first and wrote `data-theme` itself, now goes through the same `ThemeProvider` (`useTheme().choose`), so Appearance and the member menu follow it and a failed save reverts there too. The shortcut sheet's and the action toast's raw shadows and scrim moved to the tokens.
  - **Decisions the targets didn't settle** (spec section 13, last line), each a token value, not a new screen: light `--chart-2` (insights' second series) is `#4A4D53`, darker than `--chart`, so both bars pass 3:1 (a lighter grey can't); light `--hover` is `--sel` at 60% (`light-task.md`'s `rgb(232 228 217 / 0.6)` was the old warm paper); the unselected radio ring stays `--faint` (`account-appearance.md` says `--line-2`, under 3:1 for a control); the thread's diff (light-task) now draws line fills with a coloured sign and the code in `--text`, in both themes; `web-storefront`'s ochre square (`#E0A458`) is cyan `#5BB5C9`, since no project square may be amber or orange in either theme. `Skeleton` keeps `--surface`.
  - **Proof:** `context/proof/F-082.md`. `apps/web/e2e/17-theme.spec.ts` (desktop and phone): a new member sees dark; "Light" survives a reload, a new tab and a new browser, with the first animation frame and the first screenshot light; "Match my system" follows the emulated scheme both ways, live and after a reload; the choice is per member; a failed save reverts; Home, a task waiting on an approval and Account pass AA in light, and Appearance in dark. Screenshots compared with the targets: `C:/Users/santi/ow/_lead/ui-check/m7-light-home-final.png`, `m7-light-task-final.png`, `m7-light-account-final.png`, `m7-light-needs-you-final.png`, `m7-account-appearance-final.png`, and the `-phone` ones.
  - **Not ticked:** ticket 17's contrast check on every route doesn't exist yet (ticket 17 is blocked by this one); this ticket's own check covers Home, the task page, Needs you and Account in light.
