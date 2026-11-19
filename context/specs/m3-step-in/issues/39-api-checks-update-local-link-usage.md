# 39: API: checks, update branch, take it local, CLI sessions, the GitHub link and usage

Status: ready-for-agent
Builder: api
Blocked by: 23, 24, 25, 28
Features: F-054, F-070, F-028, F-103, F-119, F-084, F-066
Packages: `packages/api` (`routers/tasks.ts`, `routers/account.ts` (new)), `apps/web` (`src/app/api/cli/v1/`, `src/app/api/github/link/`)
Spec: `../spec.md`, sections 4 and 5.1 ("HTTP for the CLI"); ADRs 0051, 0052

## What to build

- **Checks:** `tasks.checks(taskId)` lists each turn's check runs with status, time, the output's tail and a link to the full output (served by the web app after the access check, as `text/plain` with `Content-Disposition: attachment`); `tasks.fixChecks(taskId)` sends ticket 23's message.
- **Update branch:** `tasks.updateBranch(taskId)`, and the task's repos' `behindBy` in `tasks.get`.
- **After the merge:** `tasks.get` lists every PR of each task repo from `TaskPullRequest`; the ticket-closed item's two answers as `tasks.stop` and `tasks.keepWorking`.
- **Take it local:** `tasks.local(taskId)` returns the `ostra checkout` line with the task's key (or ID) and, per repo, the plain git commands (`git fetch origin <branch>`, `git switch <branch>`), and whether the member has a CLI session.
- **The CLI's HTTP** at `/api/cli/v1/` on the web app: the device-code grant with purpose `cli` (milestone 1's device flow and page, which now names the purpose), creating a `CliSession` (a random token shown once, its hash stored, `OSTRA_CLI_SESSION_DAYS` long); `GET /tasks/:ref/branches` resolving a key, an ID or a URL within the session's organizations and the member's projects; `DELETE /session`. Each refuses a revoked or expired session with 401 and the protocol's message. A CLI session can do nothing else: every tRPC procedure refuses it.
- **`account.cliSessions.list` and `.revoke`:** the member's own, with machine name, created and last used.
- **The GitHub link:** `/api/github/link/start` (a `state` bound to the member's session, 10 minutes, milestone 2's `OAuthState`) and `/api/github/link/callback` (ticket 09's exchange; stores `githubUserId`, `githubLogin`, `githubLinkedAt` on the account; refuses an ID linked to another account); `account.github.get` and `.unlink`. Co-author trailers then use `<id>+<login>@users.noreply.github.com` (ADR 0052).
- **Usage:** `tasks.get` returns ticket 28's totals and, in its turns, each turn's figures, with `estimated` marks.

## Done when

- [ ] Tests: the check output is served only to members of the project; `ostra checkout`'s endpoint resolves all three refs and refuses other organizations' tasks; a revoked CLI session gets 401 and can't call tRPC; the link stores the login and ID, refuses a GitHub account linked elsewhere, and unlinks; a task with a link credits the no-reply address; usage matches ticket 28's figures.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add checks, local and link API`.

## Comments
