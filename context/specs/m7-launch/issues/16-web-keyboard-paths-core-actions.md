# 16: Web: keyboard paths for the core actions

Status: resolved
Builder: web
Blocked by: 13
Features: F-081
Packages: `apps/web`
Spec: `../spec.md`, section 10.1

## What to build

Every core action reachable and usable by keyboard without the palette too, on its own screen: the needs-you list (arrow keys between items, Enter opens, the item's shortcuts), the approval card (focus lands on it when it appears in the thread, its buttons in order), a question's form, the take-over bar, the reopen sheet, the composer (Enter sends, Shift+Enter a new line, Escape leaves it). Focus is visible everywhere (the brand's focus ring), dialogs trap focus and give it back on close, and a live region announces a new needs-you item.

## Done when

- [x] Tests named for `F-081` (Playwright): approve, answer, take over and reopen done with Tab, arrows and Enter alone on their screens; focus returns to its trigger after every dialog; the live region announces a new item.
- [x] Typecheck, lint and tests of `apps/web` pass.
- [x] Committed as `✨ make the core actions keyboard-first`: landed in ticket 13's commit, which both share (see `## Comments`).

## Comments

- 2026-11-20, web: built in `apps/web`, in the same commit as ticket 13 (`bda6b821`), since both change the shell's actions, the palette's dialog and the same e2e file: the approval card (`NeedsYou` with `focusOnAppear`, `src/components/ui/needs-you.tsx`) and the question's card take the focus when they appear, unless the member is typing, and Tab goes on to their controls in order; the Needs you list is one Tab stop (a roving `tabindex`), the arrows move between rows, Enter opens a row, and the focused row's item is in the shortcuts' scope; the composer leaves on Escape (Enter sends, Shift+Enter is a new line, as before); a dialog opened without a trigger (the palette, the sheet, Stop's confirmation) gives the focus back to what had it (`onCloseAutoFocus`, and an optional prop of the same name on `AlertDialogContent`), and Radix's own dialogs and menus trap the focus and give it back to their trigger; the shell's polite live region announces a new needs-you item (the sidebar's count, rising). The focus ring is the panel's existing 2px `:focus-visible` outline. Tests in `e2e/17-keys.spec.ts`; proofs and break-its in `context/proof/F-081.md` (the second condition stays partial until ticket 17's walk and contrast check).
