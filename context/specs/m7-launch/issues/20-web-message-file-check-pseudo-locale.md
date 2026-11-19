# 20: Web: the message-file check and the pseudo-locale

Status: ready-for-agent
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

- [ ] Tests named for `F-083`: the check finds a planted literal, an unused key and a literal `aria-label` (break-it, each); the pseudo-locale pass finds no unwrapped text on any route.
- [ ] The check runs in `pnpm test`; `ci.yml` is unchanged.
- [ ] Typecheck, lint and tests of `apps/web` pass.
- [ ] Committed as `✅ check every string is in a message file`.

## Comments
