# 13: Web: the palette's actions and the shortcut sheet

Status: resolved
Builder: web
Blocked by: 12, 36
Features: F-081
Packages: `apps/web` (`src/components/shell/command-menu.tsx`, `src/components/shell/actions/` (new), `src/components/shell/shortcut-sheet.tsx` (new), `messages/en.json`)
Spec: `../spec.md`, sections 4 and 12 (item 11); targets `command-palette`, `shortcut-sheet`

## What to build

- **One registry** of actions, typed by the domain's `PaletteAction`: the list of spec section 12, item 11, each with its message key, shortcut, scope, role and the procedure it calls. The palette, the shortcuts and the sheet all read it.
- **The palette** (milestone 1's menu, milestone 4's search): a group of actions for the current page first, then go-to, then search results; an action that needs a choice (approve which item, reopen with a message) opens its second step inside the palette; an action the member's role can't take isn't listed.
- **The shortcuts:** the two-key `g` sequences with a one-second window, the single keys in their scope, never while focus is in a text field, a select or the composer; `s` asks to confirm.
- **The `?` sheet**, from the registry, by scope, closed with Escape.

## Done when

- [x] Tests named for `F-081` (Playwright, on the production build): each of "jump to needs you", approve, answer, take over and reopen done from the palette with the keyboard only, end to end on a seeded task; the same five by their shortcuts; no shortcut fires while typing in the composer; every sheet line is a working shortcut and every shortcut has a line (break-it: an action added without a sheet line fails).
- [x] Built against the approved targets, with their differences listed under `## Comments`.
- [x] Typecheck, lint and tests of `apps/web` pass.
- [x] Committed as `✨ add actions to the command palette`.

## Comments

- 2026-11-20, web: built in `apps/web` (commit named below). The one registry is the domain's `paletteActions` (ticket 36, now also exported as `@ostra/domain/palette` for the client) with the panel's words in `src/components/shell/actions/registry.ts`; `use-scope.tsx` holds the task page and the focused needs-you item in scope; `use-shortcuts.ts` is the one key listener (the `g` sequences wait 1 second, a `t` within 1 second of a dropped `g` is ignored, nothing fires in a field, a select, the composer or under an open dialog or menu, `s` asks to confirm); `palette-actions.ts` and `palette-step.tsx` are the palette's groups and second steps; `kbd-sequence.tsx` draws keys for the palette and the sheet; `shell-actions.tsx` runs every action and holds the palette, the sheet, Stop's confirmation and the toast. `src/components/shell/shortcut-sheet.tsx` is the `?` sheet. Tests: `e2e/17-keys.spec.ts` (Playwright, production build) and `src/components/shell/actions/registry.test.ts`; proofs in `context/proof/F-081.md`, with the break-its.
- 2026-11-20, web: differences from the approved targets (`command-palette`, `shortcut-sheet`):
  - The palette stays in `src/components/search-palette.tsx`, milestone 4's file (no `command-menu.tsx` exists); one dialog, as both specs say.
  - At phone width the palette is milestone 4's centred dialog, not the bottom sheet of `command-palette-phone`; the keys' hints hide below 640px. Ticket 19 (the phone sweep) owns the phone.
  - No `Recent tasks` group with nothing typed: the panel keeps no record of tasks opened. With text typed, the matching destinations follow the task results under `Pages`.
  - `Deny…`'s reason is typed in the palette's own field, behind the step's chip (`Deny CALC-142`), not in a second field under the row.
  - The reopen message step has one line under the field (`It resumes from its own session, with your message.`), not the three resume routes, and an empty message isn't sent: `tasks.reopen` takes no message only for a reopen after a limit or a crash.
  - `a`, `d` and `r` act on a focused row of the Needs you list and on a task page's open approval or question. Home's needs-you rows and a project's Tasks list carry no approval or question IDs yet, so the keys do nothing there; the palette's `Approve…`, `Deny…` and `Answer…` work on every page.
  - `g` then `t` opens the current project's Tasks, and the search page (every task) elsewhere: the panel has no organization-wide Tasks page.
  - The theme row sets `data-theme` and saves through `account.setTheme` (ticket 11); the light tokens are ticket 18's.
  - The toast is new (the panel had none): one polite live region in the shell, bottom right, which ticket 16 also uses.
  - The counts' hints are left out while they load, instead of a skeleton.
  - The sheet's phone variant (from Account, Appearance) waits for ticket 18's Appearance screen.
  - Open points as recommended: `Actions` between the page's group and `Go to`; `Approve…` approves once; `Stop` from the palette runs without a second confirmation; the sheet lists every shortcut for every role.
