# 20: Web: the message-file check and the pseudo-locale

Status: resolved
Builder: web
Blocked by: none
Features: F-083
Packages: `apps/web` (`src/lib/messages.ts`, `src/lib/messages.check.test.ts` (new), `messages/`, `e2e/pseudo-locale.spec.ts` (new))
Spec: `../spec.md`, sections 10.1 and 12 (item 14)

## What to build

- **The check,** a Vitest test in `apps/web`, so `pnpm test` runs it with no change to `ci.yml`: with the TypeScript compiler API over `apps/web/src/**/*.tsx` and `packages/task-view/src/**/*.tsx` (the task page's thread renders from there), no JSX text with a letter in it, and no string literal in `aria-label`, `title`, `placeholder`, `alt` or a toast's message, outside `t`. An allowlist file for the few that are names, not words (the product's name, a keyboard key), each with a reason. Every key of `en.json` used somewhere; none unused.
- **API refusals are codes:** a refusal the panel shows (`model-format`, a role refusal, a budget stop) reaches it as a code the panel words through `t`, never as English from the server; a test seeds one of each and finds it pseudo in the pass below.
- **The pseudo-locale:** a build-time switch (`OSTRA_PSEUDO_LOCALE=1`, development and test only, with its line in `docs/configuration.md` so the settings test knows it) that makes `t` wrap every string as `⟦…⟧` with accents added; a Playwright pass over every route asserts every visible text node is inside `⟦ ⟧`, except user data from the seed (marked in the seed as such).

## Done when

- [x] Tests named for `F-083`: the check finds a planted literal, an unused key and a literal `aria-label` (break-it, each); the pseudo-locale pass finds no unwrapped text on any route.
- [x] The check runs in `pnpm test`; `ci.yml` is unchanged.
- [x] Typecheck, lint and tests of `apps/web` pass.
- [x] Committed as `✅ check every string is in a message file`.

## Comments

- 2026-11-20: done in the commit `✅ check every string is in a message file` (its hash is on `origin/main`; this ticket's next edit records it).
  - **The check** is `apps/web/src/lib/messages.check.test.ts` over `src/lib/messages-check.ts` (the TypeScript compiler API), in `pnpm test`; `ci.yml` is unchanged. Names that aren't words are in `messages/allowed-literals.json`, each with its reason. It found 3 literals (a retention's "keep", "PR", "s ago"/"min ago") and 160 unused keys, which went.
  - **Refusals as codes:** `errorText` now words a FORBIDDEN (a role refusal) and a NOT_FOUND through `t` (`errors.forbidden`, `errors.notFound`); before, it showed the server's English. A budget stop already reached the page as a code (the limit block). **Deviation:** the spec's `model-format` refusal was Claude Code's format check, postponed with F-018 (2026-11-19), so there's none to seed.
  - **The pseudo-locale:** `OSTRA_PSEUDO_LOCALE=1` (dev and test only; its line is in `docs/configuration.md` and `devOnlyEnvNames`) builds into `.next-pseudo`. `e2e/pseudo-locale.spec.ts` runs on its own stack (`playwright.pseudo.config.ts`) over every route of `e2e/routes.ts`. The proof workflow's `e2e` job runs it, and `ci.yml` doesn't. The pass found, and this fixes: unit letters written straight into ten formatters ("now", "min", "h", "d", "s"), now `units.*` messages; a section's "{description}: {fields}" in the ticket template; the audit log's codes, marked `translate="no"`; and the NOT_FOUND English on an environment page.
  - **What the pass leaves out:** the seed's user data, including the install's pools and box sizes and the task keys; the allowed names; the month and weekday names `Intl` writes; and machine values in mono or code, or marked `translate="no"`.
  - **Break-its:** each fails the test that covers it:
    - a planted JSX text, a literal `aria-label` and an unused key each fail the check;
    - dropping FORBIDDEN from `errorText` fails both role-refusal tests;
    - dropping NOT_FOUND fails the pass on `/projects/[project-id]/environment`.
  - **Proof:** `context/proof/F-083.md`. F-083 is `done`.
