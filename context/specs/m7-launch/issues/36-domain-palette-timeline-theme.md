# 36: Domain: the palette's actions, setup's timeline, the theme and the docs' address

Status: resolved
Builder: core
Blocked by: 04
Features: F-081, F-076, F-082
Packages: `packages/domain`
Spec: `../spec.md`, sections 4, 5.4 and 12 (items 11 and 13)
Note: split out of ticket 05 by the spec's review, so tickets 13, 18 and 24 don't wait on the agent work. Changed 2026-11-19: `OSTRA_DOCS_URL` moved here from ticket 05, which is `wontfix` since Claude Code (F-018) moved after v1.

## What to build

- **`PaletteAction`**, the registry's type, and the list of spec section 12, item 11, with each action's message key, shortcut, scope, role and the procedure it calls, so the API enforces what the panel offers.
- **`setupTimeline(organizationId)`**, pure over the audit entries of the setup steps and the first PR's event.
- **`setTheme`**, over `ThemePreference`.
- **`OSTRA_DOCS_URL`** (server): the docs site's address, which the panel's help links use, with its default and its line in `docs/configuration.md` (spec section 5.4).

## Done when

- [x] Tests named for `F-081`: every action of the list has a scope, a role and a message key, and no two share a shortcut in one scope (break-it: a duplicate shortcut fails).
- [x] Tests named for `F-076`: the timeline orders the steps and measures each from a given start, and a missing step is reported missing, not zero.
- [x] Tests named for `F-082`: a theme other than the three is refused.
- [x] `packages/domain`'s settings test passes with `OSTRA_DOCS_URL` in `docs/configuration.md`.
- [x] The whole-repo checks pass (spec section 10).
- [x] Committed as `✨ add the palette, timeline and theme domain`.

## Comments

- 2026-11-20, core: built in `packages/domain`: `palette/actions.ts` (`PaletteAction`, `paletteActions`, `shortcutClashes`, `registryProblems`, `isPaletteActionOffered`, `actionForShortcut`), `setup/timeline.ts` (`setupTimeline(organizationId, { start, entries, firstPullRequestOpenedAt })`), `use-cases/theme.ts` (`ThemePreference`, `parseSetThemeInput`, `themeFromCookie`, `dataThemeFor`, the `SetTheme` signature) and `OSTRA_DOCS_URL` (default `https://joeykhd.github.io/ostra/`, `settings.docsUrl`, its line in `docs/configuration.md`). Tests in `milestone-7.test.ts`; proofs in `context/proof/F-081.md`, `F-082.md` and a note in `F-076.md`. Differences from the spec: `setTheme`'s body writes the account's `theme` column, which is ticket 04's migration, so it lands with ticket 04 (this ticket gives its input check and signature); `account.theme_changed` is a domain audit action (the `action` column is a string, so it needs no enum value in the migration); the timeline marks the runner step with `runner.registered`, `runner.approved` or `runner.joined` (the earliest), the GitHub step with `github.connected` or `installation.linked`, and reads the first PR from its event; nothing writes `password.changed` yet, which ticket 24 meets. The whole-repo typecheck ran through turbo; lint and tests for `packages/domain` and `apps/docs`.
