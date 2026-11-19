# Milestone 1's demo: first PR, from a prompt

**Result, 2026-11-18 (23:38 UTC run):** a typed prompt became a real PR on the test repo, opened by the GitHub App, with the admin as co-author: **https://github.com/ostra-test/test1/pull/19**. Every check after the run passed. The run is scripted (`e2e/m1-first-pr/`, `pnpm e2e:m1`) and passed five times in a row from an empty data folder, the last two at 1 min 36 s and 1 min 43 s each, after `pnpm dev` was up.

**On this machine:** Windows 11, Node 24.14, no Docker. So the demo runs on the **host executor**: a personal runner on the same machine, the task in a worktree, the key proxy and git proxy in the runner's process on loopback (spec section 1). The `docker` executor is written and unit-tested, but has never run (below).

## How to run it

```
pnpm dev:reset --yes && pnpm dev          # in one terminal: an empty stack
set -a; . ~/.config/ostra-dev/model.env; . ~/.config/ostra-dev/github.env; . ~/.config/ostra-dev/github-test.env; set +a
pnpm e2e:m1                               # in another
```

The script drives the panel in Chromium (Playwright), starts `ostra runner` from source, waits for the PR, runs the checks, then closes every demo PR but its own and deletes their branches and hidden refs (`test1` only). It types secrets into the panel's forms and prints none. Screenshots go to [`demo/`](demo/); the dev endpoint's address, the setup token, the admin's email and this machine's folders are masked in them. Details: `docs/development.md`, "Milestone 1's demo".

## The steps (spec section 3)

| Step | What happened | Screenshot |
|---|---|---|
| 1. Install | `pnpm dev` started the embedded Postgres (UTF-8), applied the migrations, and started web on :3000 and core on :8787. It printed the setup token in a box. | |
| 2. The first admin | `/` sent the browser to `/setup`. The setup token from `.ostra-dev/server/setup-token`, the org `ostra-test`, user `admin`. The checklist came up with step 1 ticked. | [01](demo/01-first-admin.png), [02](demo/02-checklist.png) |
| 3. A model provider | The base URL and token from `model.env`. Test connection: "Connected · OpenAI-compatible" with the endpoint's models (about 450), matched to the catalog. Then Allow on personal runners, and the dev model as the built-in OpenCode profile's model. | [03](demo/03-provider-tested.png), [04](demo/04-provider-saved.png) |
| 4. The GitHub App | "Use an existing App": App ID 5821041 and its PEM from `github.env` (the webhook secret is a throwaway: webhooks are milestone 2). ostra showed the slug `ostra-sandbox-036d7c`, its bot, its permissions (`checks: write`, `actions: read` among them) and the installation `ostra-test`. | [05](demo/05-github-connected.png) |
| 5. The project | `ostra-test/test1` from the installation's repos. The environment draft, then Save. | [06](demo/06-project-new.png), [07](demo/07-environment-draft.png), [08](demo/08-environment-saved.png) |
| 6. The runner | `ostra runner --server http://localhost:8787 --executor host` printed a code; the script approved it at `/device`. The runner showed online: personal, host, not isolated, capacity 1. | [09](demo/09-device-approve.png), [10](demo/10-runner-online.png) |
| 7. The prompt | "Add a CONTRIBUTING.md with a short section on how to run the tests", Run on: the personal runner. Queued at 23:39:26, the turn started at 23:39:33. | [11](demo/11-prompt.png) |
| 8. Watching | Thoughts, `read` and `execute` calls with their paths and commands, the edit, the agent's message, live. A second tab showed the same thread, and a reload mid-turn brought the history back. | [12](demo/12-watching.png), [13](demo/13-second-tab.png), [14](demo/14-after-reload.png) |
| 9. The PR | The runner committed, pushed the branch and the hidden ref through the git proxy, and ended the session with changes. Core opened PR #19 at 23:39:52, 26 s after the prompt. The task moved to "in review" with the PR linked. | [15](demo/15-pull-request.png) |
| 10. On GitHub | Opened by `ostra-sandbox-036d7c[bot]`. Its one commit is authored and committed by the bot, with `Co-authored-by: admin`. The title is the prompt. The body was written by the agent through `set_pull_request_text`, and links the task. `test1` has no PR template, so that path wasn't exercised live. | |

## The checks after the run

All from the 23:38 run; the script prints each one, and writes them to `.ostra-dev/e2e-m1/result.json`.

| Check | Result |
|---|---|
| No credential reached the agent | PASS. The model token and the App's key were searched for by value, and GitHub tokens by pattern, in every event payload, the runner's log and the whole stack's output: none. No task folder was left behind. |
| The git proxy holds | PASS. From the stopped task's checkout, while it ran: a new commit pushed to `main` got `remote: ostra: only the task's branch and its hidden ref can be pushed`; a push to `ostra-test/test2` got `remote: ostra: this task's proxy serves only the task's own repos`. `main` on `test1` is unchanged. |
| No empty PR (F-065) | PASS. "In two sentences, explain what this repository is for…" ended without changes, opened no PR, and is in "needs you" with the agent's answer as its summary ([17](demo/17-needs-you.png)). |
| Stop (F-025) | PASS. A task told to write `docs/numbers.md` and then run a ten-minute command was stopped mid-turn: "Stopped", and GitHub had its branch and `refs/ostra/wip/<taskId>`. No agent process was left on the machine ([19](demo/19-before-stop.png), [20](demo/20-stopped.png)). |
| Tokens counted (F-089) | PASS. 11 model calls through the key proxy; the session holds 19,722 input and 2,009 output tokens (86,656 cache reads), equal to the sum of its `usage.recorded` events, which the proxy reads from the endpoint's own usage fields. |
| Clean-up | Every PR the earlier runs opened (#11 to #18) is closed and their branches and hidden refs deleted. Only #19, its branch and its hidden ref remain. |

## What it took

The first runs failed. Each fix is its own commit on `main`:

- **The dev database was WIN1252.** On Windows, initdb takes the machine's code page, so any emoji in an agent's output failed the whole events batch (SQLSTATE 22P05), and the runner reconnected 700 times in a few minutes, resending it. Every embedded cluster now uses `--encoding=UTF8 --locale=C`, and `pnpm db:dev` warns about an older cluster (`ed1a2f0`). Events whose text holds a real NUL, which `jsonb` refuses too, are stored with U+FFFD in its place (`8025638`). A failed frame now logs the database's error code (`3cabb9c`).
- **Connecting the App failed** when GitHub's anonymous rate limit (60 an hour per address) was used up: the bot's user ID was read anonymously. It's read as an installation now (`c63b4f7`).
- **The commits were authored "ostra <ostra@ostra.dev>",** a name the agent picked itself, so the PR's commit wasn't the bot's. The agent's environment now carries the bot as `GIT_AUTHOR_*`/`GIT_COMMITTER_*`, which outrank `git -c user.name` (`658818c`).
- **The agent read ostra's own `AGENTS.md`** from the folders above its worktree, because the demo's runner folder was inside this repo. That's what "personal, not isolated" means on `host`. The demo keeps the runner's folder in the system temp folder.
- **Shell calls showed as "shell", reads as "read",** with no command or path: OpenCode sends those in the call's first update, not the call. The mapper holds such a call until its input arrives, and shows paths relative to the session's folder, so a runner's local folders don't reach the panel (`d5cb188`, `49db388`). An edit whose output lists no file now shows its paths instead of an empty row (`6eb8900`).
- **Branch names collided.** The spec named them from the task ID's first 8 characters, which in a UUIDv7 are a timestamp: all three demo tasks got `ostra/01a1f0dd-…`, so the same prompt twice within about a minute would share a branch. They use the last 8 hex digits now; spec section 11, item 10 is updated (`87c0eef`).
- **core refused the dev env files** (`OSTRA_DEV_GITHUB_*`, `OSTRA_DEV_PUBLIC_URL`, `OSTRA_SPIKE_*`), so `pnpm dev` wouldn't start with them loaded (`63cbebe`).

## What's still missing

**Waits for a Linux machine with Docker** (the ledger rows stay `building`, F-017 `planned`):
- `docker compose up` with the server, Postgres and the pool runner (F-001); the three images have never been built.
- A task in a box on the `docker` executor, its egress rules, and the sidecar container (F-017).
- The agent's container holding no credential, for the key proxy and the git proxy (F-089, F-090).
- OpenCode pinned and checksum-verified in the base image (F-019).
- The executor contract case for a detached helper on `docker` and on Linux `host` (ADR 0029). On Windows, process-tree containment held in every run here, but a helper whose parent exits between two snapshots can still escape (Q126).

**Other milestone 1 work not done:**
- Ticket 40: the manifest flow ("Create a new App") run in a browser. F-006 stays `building` until it is.
- Ticket 34: the milestone 1 screen targets.
- `pnpm e2e:m1` from a fresh clone (2026-11-19) got through every step to a PR (#21) but failed 3 of its 12 checks, twice: no credential in the task's folders (1 file unreadable), the agent's environment allowlist (`NO_PROXY`, `OPENCODE_CLIENT` outside it) and token counts within 2% of OpenCode's own. Until they pass from a fresh clone, ticket 39's first and third boxes stay open. See ticket 39's comments.

**Gaps found by the demo** (follow-ups, none blocks the demo):
- **A batch the server can't store is resent forever.** When saving a frame fails, core closes the socket with 1011, and the runner reconnects and resends the same batch, with no limit. Such a batch needs to be refused once, visibly, or held aside.
- **The agent works from the workspace root, not the repo.** With one repo, an agent told "create docs/numbers.md" once wrote it at the root, outside `test1/`. The task ended without changes and the file was lost without a word. Starting the agent in the repo when there is only one, or telling it where the repos are, would prevent it. The demo's prompt names the repo.
- **OpenCode writes tool outputs to the machine's temp folder** (`%TEMP%\opencode\tool-outputs\<taskId>\…`), not the task's, although the launch sets `TEMP` and `TMP` to the task's folder. On `host` these files outlive the task.
- **No protocol event for a provider's rate limit:** the key proxy detects it, but core can't hold dispatches on it yet (F-089).
- **The sidecar in a box uses the runner's own access token,** not one scoped to its task (protocol work, with core).
- **The panel:** `tasks.get` doesn't return the model or whether the agent can be steered; Stop still shows on a task in review; "Needs you" and "My tasks" aren't in the sidebar.
- **Join tokens made in the panel** aren't accepted by core's register yet (F-091, milestone 5).
