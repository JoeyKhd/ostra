# 11: Web: the tracker marks

Status: done
Builder: web
Blocked by: none
Features: F-152, F-008
Packages: `apps/web` (new `src/components/trackers/tracker-mark.tsx`, its test)
Spec: `../spec.md`, sections 9 and 13
Targets: `context/brand/app-targets/m11-trackers/README.md` ("The marks", "Where each treatment goes"), `html/logos/` (`linear.svg`, `jira.svg`, `jira-mono.svg`, `trello.svg`, `trello-mono.svg`, `notion.svg`)

## What to build

- **`TrackerMark({ kind, size, mono, label })`** for `linear`, `jira`, `trello` and `notion`, drawn as inline SVG from the targets' files (copied, not installed: no new package), as `components/github/github-mark.tsx` draws GitHub's. `mono` gives the one-colour version in `currentColor` (Atlassian's cut-outs for Jira and Trello; Linear's and Notion's paths); the brand version keeps the vendors' colours (Linear `#5E6AD2`, Jira's tile `#1868DB`, Trello's `#1558BC`, Notion in `--text` in either theme).
- **A comment above each path** names its source and terms, as the README's table does (Simple Icons 16.30.0, CC0 data, trademarks their owners'; `@atlaskit/logo` 23.3.3, Apache-2.0 code, Atlassian's marks), and that each is used only to name the integration, unaltered.
- **Labels:** `role="img"` with the kind's name when it stands alone; `aria-hidden` when `label` is `false` (beside a word that already names it).
- **The guidelines check:** before this ships, read Linear's (`linear.app/brand`) and Atlassian's (`atlassian.design/foundations/logos/`) guidelines and note under `## Comments` that the use fits (nominative, unaltered, own colours or own one-colour version, no endorsement implied). Notion's page refuses automated reads: ticket 19 asks the maintainer to look.

## Done when

- [x] The targets are approved (2026-11-23, "yes to all"), recorded under `## Comments`.
- [x] Tests named for `F-152/c4`: each kind's mark renders in both treatments and both themes, labelled alone and hidden beside a word.
- [x] Tests named for `F-152/c8`: Trello's and Notion's marks exist for the picker's "Coming soon" row.
- [x] Linear's and Atlassian's guidelines read, and the result under `## Comments`.
- [x] Checks for `apps/web` pass (spec section 10).
- [x] Committed as `✨ draw each tracker's mark`.

## Comments

- 2026-11-23, lead: the maintainer approved the m11 targets ("yes to all"), recorded in `context/brand/app-targets/m11-trackers/README.md`.
- 2026-11-23, web: built as `✨ draw each tracker's mark` (its hash is in the next entry): `apps/web/src/components/trackers/tracker-mark.tsx` and its test. Decisions and readings:
  - **`TrackerMark({ kind, size, mono, label, className })`.** `kind` is `trackerMarkKinds` (`linear`, `jira`, `trello`, `notion`). `size` is required and is one of the sizes the targets name (12, 13, 14, 15, 16, 18, 20, 22, 28, 30, 32, 36), drawn as the SVG's `width` and `height`. `label` defaults to `true`: `role="img"` with `trackerName[kind]`; `false` gives `aria-hidden`. `data-tracker-mark` and `data-treatment` (`brand` or `mono`) are there for the browser specs.
  - **Choice 9 lives in one table, `trackerMarkAt`,** so tickets 12, 15 and 16 don't each pick sizes. Each place has its size and treatment from the build specs. Brand colour: `trackersRow` and `trackersPhoneRow` 20, `trackerPanelHead` 28, `picker` 32, `pickerComingSoon` 22, `connectionHeader` 36, `connectionHeaderPhone` 30, `boardRow` 18, `boardPhoneRow` 20, `attachGroup` 14, `boardSelect` 15, `property` 16, `taskHeader` 14, `newTask` 15, `setupStep` 14. One colour: `inboxRow` 14, `search` 14, `threadMeta` 13, `sidebar` 12. Use it as `<TrackerMark kind={k} {...trackerMarkAt.inboxRow} />`. A one-colour mark is `currentColor`, so its row's `text-faint` gives it the key's colour. The Coming soon row's 60% opacity is the row's own `className`, as `trackers.md` draws it.
  - **The vendors' files, unaltered:** every path is the `html/logos/` file's `d`, checked against the files by the test. Linear is `#5E6AD2` (Simple Icons' value). Jira's tile is `#1868DB` and Trello's `#1558BC`, each with its glyph `#FFFFFF`. Notion's brand version is `fill-text` (the page's `--text`, black on light as Notion's own). The one-colour Jira and Trello are Atlassian's "custom theme" cut-outs. The files' `var(--tile-color, …)`, `var(--icon-color, …)` and `var(--themed-icon-color, …)` hooks are left out, so nothing on a page can recolour a mark; their fallback colours are used as they are. A comment above each path names its source and terms (Simple Icons 16.30.0, CC0 data; `@atlaskit/logo` 23.3.3, Apache-2.0 code; the marks their owners'), and that each is used only to name the integration, unaltered.
  - **The tests** (`tracker-mark.test.tsx`, five): `F-152/c4` renders each kind in both treatments inside `data-theme="dark"` and `"light"`, and checks the vendor's paths, colours or `currentColor`, and that the markup is the same in both themes (it follows the theme only by tokens). It also checks each mark against every surface (`--bg`, `--side`, `--surface`, `--raise`, `--sel`) of both themes in `globals.css` at 3:1 (WCAG 1.4.11): Linear's `#5E6AD2`, Notion's `--text`, a one-colour mark's `--faint`, and white on Jira's and Trello's tiles. Further tests cover the label alone and `aria-hidden` beside a word for every kind and treatment, and each place's size and treatment. `F-152/c8` checks that Trello and Notion exist at the Coming soon row's 22px, labelled, in their own colours.
  - **The guidelines check (read 2026-11-23):**
    - **Linear** (`linear.app/brand`): "Do not alter these files in any way". Don't display the graphics in a way that "implies a relationship, affiliation, or endorsement by Linear". Don't use them as part of your own product's name, and don't "combine these graphics with any other graphics without written consent". The logomark is offered for tight layouts, and monochrome is preferred where possible. The page gives no hex value and no minimum size. **Fits:** the logomark unaltered, beside the word that names the integration, in its colour or in one colour, never merged into another graphic or into ostra's name.
    - **Atlassian** (`atlassian.design/foundations/logos/`): the page covers Atlassian's own logos and attribution logos ("Never compose your own attribution logos or deconstruct the official assets"; the alt text names the product). It says third-party integration logos are in Atlaskit staging, for Atlassians only. Its partner terms are in the Marketplace partners' brand guidelines (`developer.atlassian.com/platform/marketplace/atlassian-brand-guidelines-for-marketplace-partners/`): "Do not modify or recreate Atlassian assets"; no Atlassian logos "on their own or combined with your own branding"; make clear you're a third party. **Fits:** `@atlaskit/logo`'s own icon paths and colours, and its own one-colour version, unaltered. Each only names Jira or Trello beside its name and is labelled with it, never in ostra's logo or as an attribution lockup. `atlassian.com/legal/trademark` didn't render for an automated read, so ticket 19 can have the maintainer glance at it beside Notion's page.
    - **Notion:** unverified here; ticket 19.
  - **Checked by eye:** the side-by-sides are in `C:/Users/santi/ow/_lead/ui-check/m11/11/`. `ticket-chips.png` covers the Inbox, a task's header, What the agent got, Elsewhere, the Ticket group and Not taken. `trackers.png` covers the connection rows, the panel's head and the picker with Coming soon. Each puts the approved target's crop beside the build, dark and light. `marks-detail.png` is the marks enlarged, and `sizes.png` is every kind in both treatments at all twelve sizes in both themes. The raw shots are in `built/`.
    - **How they were made:** a scratch harness outside the repo, since no live screen draws a mark until tickets 12, 15 and 16. esbuild bundled the panel's own `TrackerMark`, Tailwind 4.3.5 compiled the panel's `globals.css`, and the fonts were the panel's. Playwright 1.65.1's Chromium shot it at 2x. The target crops came from the approved pictures, at boxes measured on the targets' own HTML.
    - **Result:** the marks' drawing, colours and sizes match the targets in both themes at every place. The differences are in the harness's own rows around them (Pending's second line, the picker cards' descriptions and chips), not in the marks.
  - **Checks:** typecheck, lint and tests of `@ostra/web` (786 tests in 125 files), and `check:licenses`.
- 2026-11-23, web: pushed to `main` as `41cb95d5` (`✨ draw each tracker's mark`).
