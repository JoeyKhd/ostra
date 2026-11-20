# 17: Web: the keyboard walk and the contrast check on every screen

Status: resolved
Builder: web
Blocked by: 16, 18
Features: F-081
Packages: `apps/web/e2e/a11y/` (new)
Spec: `../spec.md`, sections 9 and 10.1; Q261

## What to build

Two checks, ostra's own code on Playwright (no new dependency), over **every route** of the panel, listed from the app's route tree so a new route can't be missed, and over every dialog, sheet, menu and palette step a route opens (the approval card, the reopen sheet, ⌘K, the `?` sheet), listed beside the route, in both themes, at 1440 px and 390 px, on seeded data that puts each screen in its fullest state:
- **The keyboard walk:** Tab from the top reaches every visible interactive element once, in an order that follows the layout, each with a visible focus indicator (a computed outline or ring of at least 2 px and 3:1 against its background), with no trap; Escape closes any open dialog or menu.
- **The contrast check:** for every visible text node, the computed color against the composited background behind it: 4.5:1 for normal text, 3:1 for large text (24 px, or 18.66 px bold) and for the borders of inputs and buttons. Placeholders count. Disabled controls are listed, not failed.

Each failure names the route, the element's role and text, and the ratio. Every failure found is fixed in this ticket, or in the ticket that owns the screen, before this one is done.

## Done when

- [x] Tests named for `F-081`: the walk and the contrast check pass on every route in both themes at both widths; the route list matches the app's route tree (break-it: a route left out fails the list check; a token lowered below 4.5:1 fails the contrast check).
- [x] Typecheck, lint and tests of `apps/web` pass.
- [x] Committed as `✅ check every screen by keyboard and contrast`.

## Comments

- 2026-11-20, web: built in `apps/web/e2e/a11y/`, commit `11083ac9` (`✅ check every screen by keyboard and contrast`): `page-lib.ts` is the code that runs in the page (the tabbable elements in document order, the focused element's outline or ring and its contrast, every visible text node's colour over its composited background, placeholders, the edges of fields and buttons), `checks.ts` the walk by Tab, the walk by arrows for menus and selects, and the overlay helpers, `a11y.spec.ts` the tests; `playwright.config.ts` adds the `a11y-desktop` (1440 × 900) and `a11y-phone` (390 × 844) projects, run by hand (`--project a11y-desktop --project a11y-phone`, 11 minutes), never in `ci.yml`. The route list is `e2e/routes.ts` (ticket 19's), checked against the `page.tsx` files of `src/app`; the task page is also opened waiting on an approval, a question and a spend cap. The overlays are found, not listed by hand: every trigger a route draws that says it opens one (`aria-haspopup`, a select's combobox) is pressed with Enter, plus the keyed ones beside their routes (⌘K and `?` on Home, ⌘K and its Approve… step on Needs you, ⌘K on a task). Proofs and break-its in `context/proof/F-081.md`. Ticket 18 landed first; the light run uses its tokens.
- 2026-11-20, web: what the checks found, and fixed here (both themes):
  - **No focus ring on most fields and menus.** Tailwind 4's `outline-none` also sets `--tw-outline-style: none`, so `outline-none focus-visible:outline-2` drew nothing: fields, selects, menu and select items, checkboxes, radios, the segmented control, the Needs you, inbox and search rows, and the chart. The `outline-none`s are gone where a ring follows (the global 2px `:focus-visible` outline shows), and menu and select items draw it inset (`-outline-offset-2`). The composers and the code editor show it on their box (`.focus-box`, in `globals.css`); a date field shows it on `:focus`, since its parts take the focus.
  - **Field and button edges under 3:1.** A new token, `--control-line` (`#686b71` dark, `#80838a` light, 3.3:1 or more on the page, the sidebar, the surface and a dialog), draws the edge of every field, select, switch, segmented control, outline button and the search boxes; `--line-2` stays the hairline of rows, cards and overlays. The project page's profile selects lose their hidden-until-hover edge.
  - **The auth pages' `--faint`** was 3.4:1 (`#64676d`): now `#7c7f85`, 4.8:1. The Email column's `off` lost its 60% fade (2.8:1).
  - **The palette's input** draws its 3:1 edge as the header's bottom line, and its own focus ring.
- 2026-11-20, web: what the checks count, where the ticket left it open:
  - A button's edge is checked when it draws a box all round in a colour other than its fill; a filled button (primary, amber) and a text button are identified by their words, which the text check covers (WCAG 1.4.11). Amber stays a fill in light, as light-home.md's rule 2 says.
  - A roving group (a radio group, a segmented control) is one Tab stop, and a date field's parts one control.
  - Menus and selects are walked by their arrows (Tab leaves a menu by design); each item shows the same ring.
  - The palette's Approve… step closes on the second Escape: the first goes back a step (ticket 13).
  - Text over a picture (the sign-in illustration's tagline) can't be computed and is listed with the disabled controls in the test's attachment, not failed; it is Shell at 70% on the dark illustration in both themes.
  - Differences from the approved targets: the brighter `--control-line` edges and the focus rings above, which AA asks for.

