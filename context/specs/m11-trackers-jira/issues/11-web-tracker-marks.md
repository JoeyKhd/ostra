# 11: Web: the tracker marks

Status: ready-for-agent
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

- [ ] The targets are approved (2026-11-23, "yes to all"), recorded under `## Comments`.
- [ ] Tests named for `F-152/c4`: each kind's mark renders in both treatments and both themes, labelled alone and hidden beside a word.
- [ ] Tests named for `F-152/c8`: Trello's and Notion's marks exist for the picker's "Coming soon" row.
- [ ] Linear's and Atlassian's guidelines read, and the result under `## Comments`.
- [ ] Checks for `apps/web` pass (spec section 10).
- [ ] Committed as `✨ draw each tracker's mark`.

## Comments

- 2026-11-23, lead: the maintainer approved the m11 targets ("yes to all"), recorded in `context/brand/app-targets/m11-trackers/README.md`.
