# 33: CLI: `ostra login` and `ostra checkout`

Status: ready-for-agent
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

- [ ] Tests: against the dev server and bare repos in a temporary folder: login, checkout of a two-repo task into existing clones and a fresh clone, a dirty clone refused, a revoked session refused with the server's message, logout; on Windows and in CI on Linux.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add ostra login and ostra checkout`.

## Comments
