# 42: Web: agent profiles and the profile picker

Status: done
Builder: web
Blocked by: 34, 41
Features: F-021, F-026, F-063
Packages: `apps/web` (`src/app/(panel)/organization/agent-profiles/`, `src/components/agent-profiles/` (new), `components/tasks/new-task-form.tsx`, the Inbox's start, `components/projects/project-properties.tsx`, the sidebar)
Spec: `../spec.md`, section 12 (`agent-profiles`, `agent-profile`; and `m1/project`, `m1/task-new`, `m2/inbox` growing)

## What to build

- **The profiles page** (`agent-profiles`) and **the editor** (`agent-profile`), to their targets: every field of ticket 34, the four presets as one-click rules that open editable, a custom rule's tool and match, the coverage line from `ruleCoverage`, MCP headers entered once and shown as "set", skills with their files, plan first with its one-line explanation, who may use it, archive with the count of projects that default to it.
- **The project's defaults** per task kind in the project's properties (`m1/project` grows).
- **The picker** in "New task" and the Inbox's "Start task" (`m1/task-new`, `m2/inbox` grow): the member's profiles, the project's default first, with plan first and the rules shown as small facts under the name.
- **The sidebar:** "Agent profiles" under Organization, for everyone (members see what they may use; admins edit).
- Every string in the message files; dark first; phone width per F-075.

## Done when

- [x] The screens match their targets, checked by eye against the pictures, with the differences recorded here.
- [x] Playwright: an admin makes a profile with a preset rule, plan first and a member limit; a listed member sees it in the picker and an unlisted one doesn't; a project default is picked first.
- [x] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `web`.
- [x] Committed as `✨ add the agent profiles screens`.

## Decided 2026-11-19

Decided on the maintainer's delegation while preparing the build, from the open points of the milestone 3 targets (`context/brand/app-targets/m3/`) and the spec's gaps. If the maintainer disagrees with one, it goes back to `context/open-questions.md` and this section changes.

- **Archive and the built-in profile:** as tickets 07 and 34 decided. The archive dialog says the projects that default to the profile move to the built-in one. An archived profile's page is read-only, with no restore. The built-in profile's "Who may use it" shows `Everyone`, disabled.
- **An MCP server's `Read-only` switch** saves `readOnly`, and the match picker for `mcp` offers `Any server not marked read-only` and `Any server` (ticket 01).

## Comments

- 2026-11-19: done in d568a65 (with `68469c0` and `a8769cd`, which add `forStart`'s `ruleCount` and the coverage line's near-miss samples to ticket 34's router). The list, the editor, the project's defaults (an `Agent profiles` group in the project's properties, in place of the `Agent` row), the picker in New task's footer and the Inbox's Start task, and `Agent profiles` in the sidebar and ⌘K for every member. Playwright: `apps/web/e2e/08-agent-profiles.spec.ts` (it seeds its two members, and a model on the built-in profile when `02-setup` left none, through `e2e/seed-profile-world.ts`); unit tests in `components/agent-profiles/*.test.ts`. Proof rows added to F-021, F-026 and F-063.
  - **Checked by eye** at 1440×956 against `agent-profiles.webp` and `agent-profile.webp`, and at 390px. Differences: the panel's own type scale (body 14.5px, lede 15px) is larger than the pictures' 13px, so the editor's lede wraps to two lines and the list truncates long model names; the open rule puts Name, tool, match and its input on one row, as the picture draws it; the instructions box starts at two lines, as drawn, not three; the Model select shows the `custom` chip for a model the catalog doesn't know. At phone width the list is one column of 52px two-line rows, and a tap opens the profile.
  - **Not done: adding a skill's files.** The skill Sheet lists a skill's stored files and removes them, but has no `Add files`: the panel has no route to core's blob service yet (ADR 0043 keeps blob bytes out of the panel), so new files would be lost on save. A skill's `SKILL.md` saves. This needs a follow-up ticket for the upload route.
  - The upstream e2e specs `01-shell` (`milestone 2` text), `02-setup`, `03-first-run` (the environment's `Saved.`), `04-task` and `07-prompt-task` fail on main before this change; `08` passes after them.
