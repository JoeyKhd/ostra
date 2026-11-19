# 07: Domain: inputs, rules, audiences, templates, prompts, use cases, jobs and settings

Status: ready-for-agent
Builder: core (contracts, first)
Blocked by: 01, 06
Features: F-021, F-024, F-026, F-063, F-036, F-115, F-072, F-054, F-070, F-066, F-053, F-051
Packages: `packages/domain` (`src/lifecycles/`, `src/rules/` (new), `src/notifications/` (new), `src/prompts/` (new), `src/use-cases/`, `src/jobs.ts`, `src/settings.ts`, `src/testing/`), `docs/configuration.md`
Spec: `../spec.md`, section 5.4; ADRs 0049 to 0052

## What to build

- **Lifecycles:** the new task inputs (`plan_proposed`, `plan_answered`, `ticket_closed`, `keep_working`, `reopen_after_merge`) and the approval input's task rule and reason, with exhaustive tests and `satisfies never` in every switch. `domain-model.md`'s diagrams already allow each move; a move it doesn't allow is refused.
- **Rules** (`src/rules/`): the matcher of an `ApprovalRule` against a subject (path globs with `*` and `**`, matched on normalized repo-relative paths; command prefixes matched on the command's first words, split without a shell; "outside the allowlist"; a URL's host); the task-rule pattern drawn from a subject (spec section 11, item 3); the four presets with their default globs and allowlists (ADR 0049). Pure, with a table of cases.
- **Notifications** (`src/notifications/`): the audience resolver, the default choices per kind and channel (ADR 0050), the coalescing rule, and the email templates: one pure renderer per kind giving `{ subject, html, text }`, with inline styles, a table layout, the brand colours, the mark as an image from the install's own public address, and only the fields ADR 0050 allows. Snapshot tests of every kind's HTML and text.
- **Prompts** (`src/prompts/`): the plan-mode preamble, the approved plan, the deny re-prompt, diff comments, update branch, an `@ostra` comment, "fix the checks" and "keep working". Every piece of member, PR, ticket or agent text inside a marked block, tested with text that tries to close the block.
- **Use cases:** the signatures of section 5.4, with their ports; bodies come with the tickets that build them.
- **Jobs:** the new names and key rules (section 5.4), on exclusive queues where two must never run together.
- **Settings:** section 5.4's table, parsed by the strict config schema, each with its default and its line in `docs/configuration.md`.
- **`seedMember`** in `src/testing/` and the `pnpm dev:seed-member <username>` script beside milestone 1's first-admin seed: the same account code, refused unless `NODE_ENV` is `development` or `test`, left out of the production build (spec section 11, item 1).

## Done when

- [ ] Tests: every new lifecycle input, every rule case, every audience case, every template's snapshot, every prompt's marked blocks; `seedMember` refused with `NODE_ENV=production`.
- [ ] Every setting is in `docs/configuration.md` with its default, and a config with none of them set parses.
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `domain` and its dependents.
- [ ] Committed as `✨ add the milestone 3 domain`.

## Decided 2026-11-19

Decided on the maintainer's delegation while preparing the build, from the open points of the milestone 3 targets (`context/brand/app-targets/m3/`) and the spec's gaps. If the maintainer disagrees with one, it goes back to `context/open-questions.md` and this section changes.

- **Rules and the runner's prompts come from `@ostra/protocol`** (ticket 01, Q190). `src/rules/` re-exports the matcher and the pattern rule, and adds the four presets with `preset` set. "Reaching the network" is two rules, both `preset: "network"`: `fetch` with `any`, and `mcp` with `mcp-not-read-only`. `src/prompts/` re-exports the marked-block helper and the runner's four prompts, and adds the ones only core sends: diff comments, update branch, `@ostra`, fix the checks, keep working.
- **Archiving a profile a project defaults to** (`agent-profile.md`, point 1; Q189). `archiveAgentProfile` is allowed for any profile but the built-in one. In the same transaction, every project default (refine, code, review) that points at it moves to the organization's built-in profile, and the audit entry names those projects. Tasks that started with it keep it, reopens included. It leaves `profilesForMember` and the start picker. Tests: the defaults move, a running task's reopen keeps the archived profile, and the built-in profile can't be archived.
- **No restore in milestone 3** (point 2): an archived profile is read-only, and an admin makes a new one.
- **The built-in profile's access is always `everyone`** (point 3): `saveAgentProfile` refuses `listed` for it, so every project keeps a default open to all its members, and the archive's fallback has a target.
- **The email templates** (`email-needs-you.md`, open points): no web fonts, only the system stack the build spec names, and no `@font-face`. No `List-Unsubscribe` header in milestone 3 (ticket 21); the footer's Notifications link is how a member turns a kind off.

## Comments
