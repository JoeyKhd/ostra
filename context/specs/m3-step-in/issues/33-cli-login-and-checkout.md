# 33: CLI: `ostra login` and `ostra checkout`

Status: done
Builder: runner
Blocked by: 01, 39
Features: F-103, F-028
Packages: `apps/runner` (`src/cli/`)
Spec: `../spec.md`, section 4 ("`ostra login` and `ostra checkout`"); ADR 0051, ADR 0046

## What to build

The CLI today prints that `login` and `checkout` come later (`src/cli/cli.ts`). Build them.

- **`ostra login [--server <url>]`:** the device-code grant on `/api/cli/v1/device` with purpose `cli`: print the code and the device page's URL, poll until approved, denied or expired, and save the CLI session's token in the member's own config folder (`$XDG_CONFIG_HOME/ostra/cli.json`, `%APPDATA%\ostra\cli.json` on Windows), readable by the user only. The machine's name goes with the request, for the panel's list. A second login replaces the first.
- **`ostra logout`:** `DELETE /api/cli/v1/session` and remove the file.
- **`ostra checkout <ref> [--dir <folder>]`:** `ref` is a ticket key, a task ID or a task's URL. Ask `GET /api/cli/v1/tasks/:ref/branches`. For each repo: find a clone whose `origin` matches the clone URL (the current folder, its children to depth 2, or `--dir`); clone it with the member's own git when there's none; refuse, naming the repo, when the clone has uncommitted changes; fetch the branch and check it out tracking the remote. Print each repo's folder and branch. ostra hands out no token: git uses the member's own credentials.
- **Errors in words:** not logged in, the session revoked or expired (the server's 401 message), no such task, no access, git's own failure with its message.
- Every git call goes through the async child-process API with an argument list, never a shell string, and with `GIT_CEILING_DIRECTORIES` above the clone.
- `ostra --help` lists both without "(not yet)".

## Done when

- [x] Tests: against the dev server and bare repos in a temporary folder: login, checkout of a two-repo task into existing clones and a fresh clone, a dirty clone refused, a revoked session refused with the server's message, logout; on Windows and in CI on Linux.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add ostra login and ostra checkout`.

## Comments

- 2026-11-19: built in `5098942` (`✨ add ostra login and ostra checkout`): `apps/runner/src/cli/login.ts` (login and logout), `checkout.ts`, `cli-session.ts` (the owner-only `cli.json`) and `cli-http.ts`. The tests (`login-checkout.test.ts`) run real git against two bare repos that the member's own git reaches through `insteadOf`, and a server built from `@ostra/protocol`'s CLI schemas (`src/testing/fake-cli-server.ts`): login, a two-repo checkout into an existing clone and a fresh one, a dirty clone refused, a revoked session refused with the server's message, logout. Break-it checks in `context/proof/F-103.md`. Passed on Windows; Linux is CI's run. **Left open, so the first box stays unticked:** "against the dev server" needs the web app's routes, ticket 39, which isn't built yet; the same test file should then point at the dev server. `ostra login` takes no `OSTRA_SERVER_URL`: that names core for a runner, and the CLI's routes are the web app's.
- 2026-11-19: the first box, in `✅ prove ostra checkout against the CLI route`. Ticket 39 built the CLI's routes, so the same flow now runs against them: the real CLI (`runCli`, exported from `@ostra/runner`) against `handleCliRequest`, the handler the web app's `/api/cli/v1/[...path]` route hands every request to, served over HTTP on a real Postgres, with real git and two bare repos (`packages/api/src/services/cli-http.ostra-cli.test.ts`): login through the device page, a two-repo checkout into an existing clone and a fresh one, a dirty clone refused by the task's URL, a revoked session refused in the server's words, then logout, which revokes the session in the database. It lives in `@ostra/api`, which takes `@ostra/runner` as a dev dependency: the runner is Apache-2.0 and can't import the API. It runs in CI on Linux with the API's tests, and passed here on Windows. Break-it checks in `context/proof/F-103.md`.
