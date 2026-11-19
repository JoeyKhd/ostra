# 18: Web: the light theme and Appearance

Status: ready-for-agent
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

- [ ] Tests named for `F-082` (Playwright): a new member sees dark; "Light" survives a reload with no dark frame (the first screenshot after navigation is light); "Match my system" follows the emulated scheme both ways; the choice is per member.
- [ ] Ticket 17's contrast check passes in light on every route.
- [ ] Typecheck, lint and tests of `apps/web` pass.
- [ ] Committed as `✨ add the light theme`.

## Comments
