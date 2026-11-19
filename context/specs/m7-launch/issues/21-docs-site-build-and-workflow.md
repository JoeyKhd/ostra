# 21: Docs: the site, its build and `docs.yml`

Status: ready-for-agent
Builder: web
Blocked by: 12, and ticket 34's yes for Fumadocs (or the fallback)
Features: F-058
Packages: `apps/docs` (new, Apache-2.0), `.github/workflows/docs.yml` (new), `pnpm-workspace.yaml`, `turbo.json`
Spec: `../spec.md`, sections 2 and 4; ADR 0063

## What to build

- **`apps/docs`**, Apache-2.0, private (never published to npm): on Fumadocs once the maintainer says yes (ADR 0007's "Waiting for the maintainer's yes"), each package pinned exactly; until then, the fallback ADR 0063 names, and this ticket says which under `## Comments`. The brand's tokens and fonts, both themes, the targets' layout.
- **Content loading:** its own pages from `apps/docs/content/`, written as Markdown that both Fumadocs and the fallback render (no MDX component a page can't do without), and `docs/configuration.md`, `docs/development.md` and `docs/agents/*.md` read as files at build time, never copied.
- **The static export** (`output: "export"`), with the repo's Pages base path, and, on Fumadocs, its search index built with it. The fallback has no search (ADR 0007's line), and the `docs-search` target is built only on Fumadocs.
- **`docs.yml`:** started with `gh workflow run Docs` and on `release: published`; builds and deploys to GitHub Pages; actions pinned by SHA; no secret but the workflow's own token. `ci.yml` only typechecks and lints `apps/docs` with the rest.
- **`OSTRA_DOCS_URL`'s default** is the Pages address.

## Done when

- [ ] Tests named for `F-058`: the configuration reference page lists every setting `packages/domain`'s settings test knows, with its default (break-it: a setting removed from `docs/configuration.md` fails both tests); the export builds with no server route.
- [ ] `docs.yml` ran once by hand and deployed, its run linked under `## Comments`, if Pages is enabled (ticket 34); otherwise its dry run (build only) is linked.
- [ ] `pnpm check:licenses` passes: `apps/docs` imports no Sustainable Use package.
- [ ] Committed as `✨ add the docs site`.

## Comments
