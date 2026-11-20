# 47: Web: checks, take it local and Account

Status: resolved
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

- [x] The screens match their targets, checked by eye, with the differences recorded here. (2026-11-20, screenshots from `apps/web/e2e/21-step-in.spec.ts` with `OSTRA_E2E_SHOTS`; the differences are under "Differences from the targets".)
- [x] Playwright: a failing check shows its output and sends "Ask the agent to fix"; the take-it-local popover copies the line; a CLI session approved on the device page appears in Account and is revoked; the GitHub link's start redirects to the fake OAuth and comes back linked. (`apps/web/e2e/21-step-in.spec.ts`: "F-054/c2", "F-028/c1", "F-103/c4" at desktop and phone width, "F-119/c1,c2" at desktop; 7 passed.)
- [x] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `web`. (2026-11-20, and for `@ostra/adapter-github`.)
- [x] Committed as `✨ add checks, take it local and Account`. (The parts as `57d40d6` `✨ add the checks, take it local and Account parts`, wired in `3af06b0`; this ticket's close in the commits named below.)

## Decided 2026-11-19

Decided on the maintainer's delegation while preparing the build, from the open points of the milestone 3 targets (`context/brand/app-targets/m3/`) and the spec's gaps. If the maintainer disagrees with one, it goes back to `context/open-questions.md` and this section changes.

- **A check with no repo** shows once, without a chip (`task-checks.md`, point 1; ticket 23).
- **Turn numbers** are the real ones, and may skip (point 2).

## Differences from the targets

Checked by eye on 2026-11-20 against `app-targets/m3/task-checks`, `take-it-local`, `account` and `app-targets/m1/device`, on the e2e stack at 1440 px.

- **Checks tab:** as drawn. A check's command sits beside its name rather than in a column of its own. A task with several repos has a section per repo with its commit (F-098, `abfe1090`, decided after the target). With no saved output the fix row says "The full output wasn't saved" where the target has the download.
- **Take it local:** as drawn; the popover's text is about 1px smaller. A prompt task's line names the task's full ID (`ostra checkout <task ID>`), not the short key in the breadcrumb (`tasks.local` names the ticket's key or the ID). Under the login hint, the `ostra login --server …` line has its own box with Copy.
- **Account:** as drawn, with Appearance (theme and shortcuts) above GitHub and in the properties panel (milestone 7's light theme, decided after the target).
- **Device page:** it said only the runner's words, whatever the code was for. Now a code from `ostra login` reads "Sign in the ostra CLI" and "Sign in the ostra CLI on <machine>", with the machine's name in the properties and "Open Account" after approving (`b3686fd`). The sidebar still marks Runners on `/device`.
- **Phone:** with Take it local, Review, a PR and Stop, a queued task's top bar was wider than the screen; Stop is now an icon below `sm`, as Review and Take it local are (`82c0e9d`).

## Comments

- 2026-11-19: the parts are in, `57d40d6` (`✨ add the checks, take it local and Account parts`). Checked by eye against `task-checks`, `take-it-local` and `account`: they match; the popover's text is about 1px smaller than the picture's. **Not done yet:** the Checks tab in the task page, the Account route, the device page's wording and the Playwright run wait on ticket 39 (`tasks.checks`, `tasks.local`, `account.*`) and ticket 33, not on `main` yet.
- 2026-11-19, integrate (ticket 50): the Checks tab over `tasks.checks`/`fixChecks`, Take it local over `tasks.local`, and `/account` (GitHub link, CLI sessions) are wired (`3af06b0`), and used live in milestone 3's demo (`../demo.md`). Not done: this ticket's Playwright cases, the by-eye check against the targets, and the differences `demo.md` lists.
- 2026-11-20, closed: the four Playwright cases are in `apps/web/e2e/21-step-in.spec.ts`, with the turn's check runs and the App's OAuth client secret seeded as ingest and the manifest flow write them (`apps/web/e2e/seed-step-in.ts`). Running them found three gaps, fixed: the device page spoke only of runners (`b3686fd`); the panel sent the link's sign-in and code exchange to github.com whatever `OSTRA_GITHUB_API_URL` said, so a GitHub Enterprise Server (or the fake) couldn't link (`b5b08fa`, the website now follows the API address); the phone task bar overflowed (`82c0e9d`). Break-it: the device page's CLI words and the website derivation broken together, the device case, the link case and the adapter's test failed, and the rest passed. F-054, F-028 and F-103 are `done`; F-119 stays `building` for ticket 51's sign-in on the real GitHub. Found and left open: an App connected with "Use an existing App" has no client secret, so its install can't link anyone (Q295).
