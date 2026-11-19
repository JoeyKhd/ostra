# 37: Web: Insights

Status: resolved
Builder: web
Blocked by: 28, 31
Features: F-108
Packages: `apps/web` (`src/app/(panel)/organization/insights/`, `src/app/(panel)/projects/[project-id]/insights/`)
Spec: `../spec.md`, sections 3 (step 13) and 12; target `insights`

## What to build

- **Insights** for the organization and for each project to the `insights` target: the period picker (7, 30, 90 days, two dates) in the URL, the six figures with the count each median is over, PRs opened and merged by day, waiting by reason, tokens and spend by project and model, "Other projects" for what the member can't open, and "Computed N minutes ago".
- Charts follow the `dataviz` guidance, with a table view of each for screen readers.
- The sidebar gains Insights under Organization and under each project.

## Done when

- [x] Playwright, named `it("F-108: ...")`: the figures on the page equal `insights.get`'s for the picked period, and changing the period changes the URL and the figures.
- [x] Each screen checked by eye against its target, dark and light, at 1440 px and phone width.
- [x] Committed as `✨ add Insights to the panel`.

## Comments

- 2026-11-19, web builder: `/organization/insights` and `/projects/[id]/insights` read `insights.get` for the period in the URL (`?period=7d|30d|90d` or `?from=…&to=…`), with the six figures, their sparklines, PRs by day with a table view, waiting by reason, and the spend rail (by project with "Other projects", by model, the unpriced note). `insights.get` grew per-day sparkline figures, `repoCount` and `intervalMinutes` (additive). The sidebar gains Insights under Organization and under each project. Proof: `apps/web/e2e/09-insights.spec.ts` (desktop and phone) and two new `insights.test.ts` cases, with break-its in `context/proof/F-108.md`; F-108 is `done`. Checked by eye at 1440 px and phone width in the dark theme; the panel has no light theme yet (`globals.css` leaves it for later), so there is none to check. Commit: see the git log for `✨ add Insights to the panel`.
