# 21: Docs: the site, its build and `docs.yml`

Status: ready-for-agent
Builder: web
Blocked by: 12, and ticket 34's yes for Fumadocs (or the fallback)
Features: F-058
Packages: `apps/docs` (new, Apache-2.0), `.github/workflows/docs.yml` (new), `pnpm-workspace.yaml`, `turbo.json`
Spec: `../spec.md`, sections 2 and 4; ADR 0063

## What to build

- **`apps/docs`**, Apache-2.0, private (never published to npm): on Fumadocs (confirmed 2026-11-19, ADR 0007's "Milestone 7" lines), each package pinned exactly. If the maintainer withdraws it, the fallback ADR 0063 names, and this ticket says which under `## Comments`. The brand's tokens and fonts, both themes, the targets' layout.
- **Content loading:** its own pages from `apps/docs/content/`, written as Markdown that both Fumadocs and the fallback render (no MDX component a page can't do without), and `docs/configuration.md`, `docs/development.md` and `docs/agents/*.md` read as files at build time, never copied.
- **The static export** (`output: "export"`), with the repo's Pages base path, and, on Fumadocs, its search index built with it. The fallback has no search (ADR 0007's line), and the `docs-search` target is built only on Fumadocs.
- **`docs.yml`:** started with `gh workflow run Docs` and on `release: published`; builds and deploys to GitHub Pages; actions pinned by SHA; no secret but the workflow's own token. `ci.yml` only typechecks and lints `apps/docs` with the rest.
- **`OSTRA_DOCS_URL`'s default** is the Pages address.

## Done when

- [x] Tests named for `F-058`: the configuration reference page lists every setting `packages/domain`'s settings test knows, with its default (break-it: a setting removed from `docs/configuration.md` fails both tests); the export builds with no server route.
- [ ] `docs.yml` ran once by hand and deployed, its run linked under `## Comments`, if Pages is enabled (ticket 34); otherwise its dry run (build only) is linked.
- [x] `pnpm check:licenses` passes: `apps/docs` imports no Sustainable Use package.
- [x] Committed as `✨ add the docs site`.

## Comments

- 2026-11-19: Built on Fumadocs (`fumadocs-core` 16.19.4, `fumadocs-ui` 16.19.4, `fumadocs-mdx` 15.6.3, pinned exactly), not the fallback. `apps/docs` is Apache-2.0 and private; `pnpm check:licenses` holds it (break-it: `@ostra/domain` added to its dependencies failed the check). The content tree is `content/meta.json` and one folder per section, every page the navigation shows in place as a skeleton for tickets 22 and 23; `docs/development.md` and `docs/agents/*.md` are a second collection read from `docs/` at build time and shown under Contributing. Pages are plain Markdown with GitHub alerts (`> [!NOTE]`, `> [!WARNING]`, `> [!CAUTION]` for Not isolated) and numbered steps (`## 1. Title`), so they read the same on GitHub. Code blocks keep their ` ```sh run ` meta as `data-run` for ticket 22's command check.
- 2026-11-19: Tests: `packages/domain/src/settings-docs-reference.test.ts` (every setting the settings test knows is on the page, with its default, under the right process), `apps/docs/src/lib/configuration-reference.test.ts` (the shared parser), and the checked build `apps/docs/scripts/export.check.test.ts` (`pnpm --filter @ostra/docs check:export` after `next build`, run by `docs.yml`, not by `ci.yml`): every route is a file in `out/` and the dynamic route has no fallback, the search index is in the export, and the reference page lists every setting with its default. Break-its are in `context/proof/F-058.md`.
- 2026-11-19: The search dialog is ostra's own, on Fumadocs' static search (`useStaticSearch`, the index from `createFromSource(...).staticGET` at `api/search`) inside `fumadocs-ui`'s `RootProvider`: the default dialog can't take the page-group layout. The configuration reference's rows are indexed as headings, so `OSTRA_JOIN_TOKEN` finds its row. The layout, nav, TOC and callouts are ostra's own components on Fumadocs' page tree and TOC hooks, styled with plain CSS on the target's tokens (no Tailwind added); next-themes is off, and the theme is the small inline script plus toggle the target names.
- 2026-11-19: Open points, as recommended: dark first, with the toggle remembered in `localStorage`; the repo's address from one constant (`src/lib/site.ts`); "Last changed in" left out until a release tags a build; steps as plain `h2`s; development settings kept, labelled `dev`; the "Start here" list fixed in `src/lib/site.ts`; the version chip reads the release tag (`OSTRA_DOCS_VERSION` in `docs.yml`, else the newest tag, else `dev`). The install guide downloads the compose file from `releases/latest/download/compose.yaml`, so no page has to type a version. `OSTRA_DOCS_URL` itself is ticket 36's setting; its default is `https://joeykhd.github.io/ostra/` (`siteUrl` here).
- 2026-11-19: Screenshot-compared against `docs-home`, `docs-home-light`, `docs-guide`, `docs-guide-phone`, `docs-reference`, `docs-search` and `docs-search-empty` at 1440×956 and 390×844, dark and light.
- 2026-11-19: `docs.yml` hasn't run yet. GitHub Pages isn't enabled on the repo (its Pages address answers 404; ticket 34), and this session had no way to start a workflow. Its dry run is `gh workflow run Docs -f deploy=false` (build and the export check, no deploy); once Pages is on, `gh workflow run Docs` publishes, and the run's link goes here.
