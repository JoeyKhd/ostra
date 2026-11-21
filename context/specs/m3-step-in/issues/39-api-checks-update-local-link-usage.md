# 39: API: checks, update branch, take it local, CLI sessions, the GitHub link and usage

Status: done
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

- [x] Tests: the check output is served only to members of the project; `ostra checkout`'s endpoint resolves all three refs and refuses other organizations' tasks; a revoked CLI session gets 401 and can't call tRPC; the link stores the login and ID, refuses a GitHub account linked elsewhere, and unlinks; a task with a link credits the no-reply address; usage matches ticket 28's figures.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add checks, local and link API`.

## Decided 2026-11-19

Decided on the maintainer's delegation while preparing the build, from the open points of the milestone 3 targets (`context/brand/app-targets/m3/`) and the spec's gaps. If the maintainer disagrees with one, it goes back to `context/open-questions.md` and this section changes.

- **`account.cliSessions.list` adds** `expiresAt` per session and the session length (`OSTRA_CLI_SESSION_DAYS`) (`account.md`, "Data").
- **`account.github.get` adds** the GitHub user ID and `githubLinkedAt`, and whether GitHub is connected to the install, for the not-connected row. The command's address is `OSTRA_PUBLIC_URL`.

## Comments

- 2026-11-19: done in `f1e2d08`. **API (`packages/api`):** `tasks.checks` (`routers/task-checks.ts`: each turn's runs with the output's end from the `check.finished` event, the commit from `session.saved`, counts, the PRs and whether ostra drafted them, `fix` for the newest turn), `tasks.fixChecks` (ticket 23's `askAgentToFixChecks`), `tasks.updateBranch` and `tasks.keepWorking` (ticket 24's `requestUpdateBranchWith` and `keepWorking`; the other answer to a closed ticket is `tasks.stop`), `tasks.local` (`routers/task-local.ts`: the `ostra checkout` line by key or ID, the login line, the plain git commands with a shell-safe quote, `hasCliSession`), and in `tasks.get` each repo's `behindBy` and `pullRequests` from `TaskPullRequest`, and `usage` (`task-usage.ts`, ticket 28's `readTaskUsage`, estimates marked). `account.cliSessions.list` (with `expiresAt`, `days` and `serverUrl`) and `.revoke`, `account.github.get` (`connected`, and the link with its ID and time) and `.unlink`, and `account.deviceRequest` (the purpose and the machine's name of a code the member opened, for the device page). **HTTP:** `services/cli-http.ts` answers `/api/cli/v1/` (the web app's one catch-all route calls it): the device grant is its own `DeviceCode` row (purpose `cli`, client `ostra-cli`, which better-auth's token endpoint refuses, so the grant is never a login), approved on the milestone 1 `/device` page and traded here for a `CliSession` whose token is shown once and stored as a hash; `GET /tasks/:ref/branches` resolves a key, an ID or a URL within the account's organizations and the member's projects; `DELETE /session`. Every tRPC procedure refuses a CLI token in words (`trpc/init.ts`). `services/github-link.ts` is `/api/github/link/start` and `/callback` (`OAuthState` bound to the member's panel session for ten minutes and one use; the App's client ID comes from `GET /app` (`AppInfo.clientId`, additive) and its secret from the secret store; a connection made without a manifest has no client secret, so it cannot link). `services/check-output.ts` serves a check's full output as `text/plain`, an attachment, after the access check, from `/api/tasks/<task>/checks/<run>/output`; the panel reads the built-in store's tables itself (`BlobStoreView.read`), so **a check output kept in an S3-compatible store answers 503 until the panel is given that store: the follow-up is to read it through core's blob service**. **Domain:** `startCliSession`, `revokeCliSession`, `resolveCliSession`, `linkGitHubUser`, `unlinkGitHubUser` (`StartCliSession`'s input gained an optional `sessionDays`). **Core:** the task spec credits a linked member by `<id>+<login>@users.noreply.github.com` (`dispatch/task-spec.ts`), read at dispatch so a link made after the task began counts from the next commit. **Open:** the device page does not name the purpose yet (ticket 47 reads `account.deviceRequest` or the grant's `client_id`); ticket 33's "against the dev server" box can now use these routes. Proof rows in F-103, F-119, F-054, F-084, F-070, F-066 and F-028; 21 break-it checks, all caught (`context/proof/`).
- 2026-11-21, the blob-reads follow-up: the panel reads every blob through core's blob service now, so a check's full output kept in an S3-compatible store reads as one in Postgres does. `coreBlobReader` (`packages/api/src/services/blob-store-view.ts`) finds the blob's row for its owner, asks `GET /panel/v1/blobs/<blobId>` on `OSTRA_CORE_INTERNAL_URL` with a one-minute read token for that blob, organization and task, and streams core's bytes on, checked against the row's size and SHA-256; the download's headers are unchanged. ADR 0043 amended. Tests: `apps/core/src/blobs/panel-blob-reads.test.ts`, against the fake S3.
