# The docs site: Fumadocs on Next.js, built static, on GitHub Pages

**Status:** accepted (2026-11-19, on the maintainer's delegation for milestone 7's spec), **with its three new dependencies waiting for the maintainer's yes** (ADR 0007). Settles Q254 and Q255. Covers F-058, and the "following only the docs" of F-076. Builds on ADR 0007 (the panel's stack), 0045 (`apps/docs`, "in the same stack as the panel"; its license declared when it's created), 0048 (the word is "source-available") and 0061 (heavy jobs by hand, never in `ci.yml`).

## The generator

- **Fumadocs** (`fumadocs-core`, `fumadocs-ui`, `fumadocs-mdx`, MIT), on Next.js 16 and React 19, the panel's own versions. ADR 0045 asked for the panel's stack, and Fumadocs is a Next.js App Router app with MDX pages, its own search index and Tailwind 4 styling, so the docs share the panel's tokens (`brand/files/tokens/`) and its builders.
- **Search is built in and static:** Fumadocs' own index, built with the site and served as a file. No hosted search service.
- **Each is pinned exactly** when milestone 7's ticket 21 adds it, at the newest release at least a day old (pnpm's policy, ADR 0007). **They were confirmed on 2026-11-19** under the maintainer's permission for that session's dependencies, recorded in ADR 0007's "Milestone 7" lines. If the maintainer withdraws them, ticket 21 builds the same pages on Next.js alone, from Markdown rendered by the panel's existing renderer (`@assistant-ui/react-markdown`), with a navigation of its own and no search, and says so in its `## Comments`.

## Where the words live

- **`docs/` stays the one source.** The configuration reference is `docs/configuration.md`, which `packages/domain`'s settings test already checks against every schema that reads a setting. The site renders that file; it never keeps a copy. A setting added in code without its line fails the test, as it does today.
- **The site's own pages are MDX in `apps/docs/content/`**, and a guide that a contributor reads in the repo (`docs/development.md`, `docs/agents/`) stays Markdown in `docs/` and is rendered too.
- **What the site holds** (F-058):
  1. **Start:** what ostra is (source-available, self-hosted), what you need before you start (a Linux machine with Docker, a GitHub organization, a model provider's base URL and token), and the 30-minute path.
  2. **Install:** `docker compose up`; the first sign-in and the forced password change; setup in the panel, step by step, in the checklist's order (F-076); Linear as the optional last step; Helm for Kubernetes; upgrading (ADR 0022).
  3. **Runners:** pools and join tokens; `docker`, `host` and `kubernetes`, with what each isolates and the allowed differences (ADR 0029); personal runners with `ostra runner`; the egress baseline; the HTTP fallback.
  4. **Agents and models:** model providers in either API format; OpenCode, the one agent at launch (Claude Code's page, on keys, its Anthropic-format requirement and its one-time image, waits with F-018 and ADR 0062, after v1 since 2026-11-19); agent profiles, approval rules, plan first.
  5. **Using ostra:** tasks, the three kinds, steering, approvals, reopening, review loops, automations, memory, budgets. Short, one page each, linking the panel's own words.
  6. **Security:** what the box does and doesn't contain, what `host` doesn't isolate, the key and git proxies, the security review's summary (ADR 0064), and how to report a vulnerability (`SECURITY.md`).
  7. **Reference:** the configuration reference (`docs/configuration.md`), the CLI's commands, the runner protocol's version window, the ports.
  8. **Contributing:** the adapter guide (each of the eight kinds, its base class, its contract suite, the tiny adapters as the worked example, ADR 0025), and the contributor agreement, linked to `CONTRIBUTING.md` (ADR 0048).
- **Every page's commands are checked.** A test reads each fenced `sh` block of the install guide and the runner pages, and runs the ones marked `run` against a fresh stack in the proof job, so a guide can't drift from what works.

## Where it's hosted

- **GitHub Pages**, from the public repo, as a static export (`output: "export"`). No vendor, no cost, and the maintainer's GitHub already holds the repo. The address is the repo's Pages address until the maintainer registers a domain (`build-order.md`, "Outside the code"); a custom domain is then one `CNAME` file.
- **Built and deployed by a manual workflow,** `docs.yml`, started with `gh workflow run Docs` and on each published release. Never on push and never in `ci.yml` (the maintainer's CI scope, 2026-11-19). `ci.yml` only typechecks and lints `apps/docs` with the rest of the repo, which costs seconds.
- **The docs carry the version they describe,** from the release line (ADR 0045), and the site keeps the current release only in v1.

## Its license

`apps/docs` is **Apache-2.0**: the guides are meant to be copied into people's own runbooks and adapters, and the adapter guide accompanies the Apache-2.0 SDK. It imports no Sustainable Use package (the license check holds it to that, ADR 0045); the configuration reference is read as a file, not imported from `packages/domain`.

## Considered options

- **Nextra.** Close to Fumadocs, also Next.js; Fumadocs follows the App Router and Tailwind 4 more closely, which is what the panel runs.
- **Starlight (Astro), Docusaurus, MkDocs.** Rejected: another stack beside the panel's, against ADR 0045.
- **The docs inside the panel**, at `/docs`. Rejected: a team reads the install guide before it has a panel.
- **Vercel or Netlify hosting.** Not chosen: a vendor the maintainer hasn't picked, for a static site GitHub serves for free.
- **A copy of the configuration reference in the site.** Rejected: two lists drift; one tested file doesn't.

## Consequences

- F-058 is `done` when the site is published at its address with the four things its row names, and the guide's commands pass in the proof job.
- F-076's measure (ADR 0064) follows these pages and nothing else, so a gap the newcomer hits is a docs bug, fixed before the run is repeated.
- A new setting, a new adapter kind or a new runner flag changes a page in the same commit, as `AGENTS.md`'s self-hosting line already asks for the reference.
