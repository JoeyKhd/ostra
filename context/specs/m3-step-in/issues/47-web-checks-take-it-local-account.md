# 47: Web: checks, take it local and Account

Status: ready-for-agent
Builder: web
Blocked by: 39, 41
Features: F-054, F-028, F-103, F-119
Packages: `apps/web` (`components/tasks/task-checks/` (new), `components/tasks/take-it-local.tsx` (new), `src/app/(panel)/account/` (new), `src/app/(panel)/device/`)
Spec: `../spec.md`, section 12 (`task-checks`, `take-it-local`, `account`; and `m1/device` growing)

## What to build

- **The Checks tab** (`task-checks`): each turn's checks with status, time and output (plain text, collapsed past 40 lines, the full output's download), a failed check's "Ask the agent to fix", and the PR's draft line.
- **Take it local** (`take-it-local`): in the task's header actions, a popover with `ostra checkout <key>` and copy, the plain git commands per repo, and the `ostra login` hint when the member has no CLI session.
- **Account** (`account`): the GitHub link (link through `/api/github/link/start`, linked as `@login` with unlink), and the CLI sessions with machine, created, last used and "Revoke". In the member menu.
- **The device page** (`m1/device` grows): the code's purpose, "Sign in the ostra CLI on <machine>" or the runner's wording.

## Done when

- [ ] The screens match their targets, checked by eye, with the differences recorded here.
- [ ] Playwright: a failing check shows its output and sends "Ask the agent to fix"; the take-it-local popover copies the line; a CLI session approved on the device page appears in Account and is revoked; the GitHub link's start redirects to the fake OAuth and comes back linked.
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `web`.
- [ ] Committed as `✨ add checks, take it local and Account`.

## Comments
