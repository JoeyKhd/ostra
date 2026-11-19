# 17: Web: the keyboard walk and the contrast check on every screen

Status: ready-for-agent
Builder: web
Blocked by: 16, 18
Features: F-081
Packages: `apps/web/e2e/a11y/` (new)
Spec: `../spec.md`, sections 9 and 10.1; Q261

## What to build

Two checks, ostra's own code on Playwright (no new dependency), over **every route** of the panel, listed from the app's route tree so a new route can't be missed, in both themes, at 1440 px and 390 px, on seeded data that puts each screen in its fullest state:
- **The keyboard walk:** Tab from the top reaches every visible interactive element once, in an order that follows the layout, each with a visible focus indicator (a computed outline or ring of at least 2 px and 3:1 against its background), with no trap; Escape closes any open dialog or menu.
- **The contrast check:** for every visible text node, the computed color against the composited background behind it: 4.5:1 for normal text, 3:1 for large text (24 px, or 18.66 px bold) and for the borders of inputs and buttons. Placeholders count. Disabled controls are listed, not failed.

Each failure names the route, the element's role and text, and the ratio. Every failure found is fixed in this ticket, or in the ticket that owns the screen, before this one is done.

## Done when

- [ ] Tests named for `F-081`: the walk and the contrast check pass on every route in both themes at both widths; the route list matches the app's route tree (break-it: a route left out fails the list check; a token lowered below 4.5:1 fails the contrast check).
- [ ] Typecheck, lint and tests of `apps/web` pass.
- [ ] Committed as `✅ check every screen by keyboard and contrast`.

## Comments
