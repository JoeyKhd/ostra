# 16: Web: keyboard paths for the core actions

Status: ready-for-agent
Builder: web
Blocked by: 13
Features: F-081
Packages: `apps/web`
Spec: `../spec.md`, section 10.1

## What to build

Every core action reachable and usable by keyboard without the palette too, on its own screen: the needs-you list (arrow keys between items, Enter opens, the item's shortcuts), the approval card (focus lands on it when it appears in the thread, its buttons in order), a question's form, the take-over bar, the reopen sheet, the composer (Enter sends, Shift+Enter a new line, Escape leaves it). Focus is visible everywhere (the brand's focus ring), dialogs trap focus and give it back on close, and a live region announces a new needs-you item.

## Done when

- [ ] Tests named for `F-081` (Playwright): approve, answer, take over and reopen done with Tab, arrows and Enter alone on their screens; focus returns to its trigger after every dialog; the live region announces a new item.
- [ ] Typecheck, lint and tests of `apps/web` pass.
- [ ] Committed as `✨ make the core actions keyboard-first`.

## Comments
