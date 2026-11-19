# 37: Web: Insights

Status: ready-for-agent
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

- [ ] Playwright, named `it("F-108: ...")`: the figures on the page equal `insights.get`'s for the picked period, and changing the period changes the URL and the figures.
- [ ] Each screen checked by eye against its target, dark and light, at 1440 px and phone width.
- [ ] Committed as `✨ add Insights to the panel`.

## Comments
