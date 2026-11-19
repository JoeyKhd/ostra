# 13: Web: the palette's actions and the shortcut sheet

Status: ready-for-agent
Builder: web
Blocked by: 05, 12
Features: F-081
Packages: `apps/web` (`src/components/shell/command-menu.tsx`, `src/components/shell/actions/` (new), `src/components/shell/shortcut-sheet.tsx` (new), `messages/en.json`)
Spec: `../spec.md`, sections 4 and 12 (item 11); targets `command-palette`, `shortcut-sheet`

## What to build

- **One registry** of actions, typed by the domain's `PaletteAction`: the list of spec section 12, item 11, each with its message key, shortcut, scope, role and the procedure it calls. The palette, the shortcuts and the sheet all read it.
- **The palette** (milestone 1's menu, milestone 4's search): a group of actions for the current page first, then go-to, then search results; an action that needs a choice (approve which item, reopen with a message) opens its second step inside the palette; an action the member's role can't take isn't listed.
- **The shortcuts:** the two-key `g` sequences with a one-second window, the single keys in their scope, never while focus is in a text field, a select or the composer; `s` asks to confirm.
- **The `?` sheet**, from the registry, by scope, closed with Escape.

## Done when

- [ ] Tests named for `F-081` (Playwright, on the production build): each of "jump to needs you", approve, answer, take over and reopen done from the palette with the keyboard only, end to end on a seeded task; the same five by their shortcuts; no shortcut fires while typing in the composer; every sheet line is a working shortcut and every shortcut has a line (break-it: an action added without a sheet line fails).
- [ ] Built against the approved targets, with their differences listed under `## Comments`.
- [ ] Typecheck, lint and tests of `apps/web` pass.
- [ ] Committed as `✨ add actions to the command palette`.

## Comments
