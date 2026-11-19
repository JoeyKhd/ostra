# Milestone 1's demo: first PR, from a prompt

**Result, 2026-11-19 (01:12 UTC run):** a typed prompt became a real PR on the test repo, opened by the GitHub App, with the admin as co-author: **https://github.com/ostra-test/test1/pull/31**. All 13 checks after the run passed. `pnpm e2e:m1` passed twice in a row from a `git clone` of `origin/main` (`917c8af`) with a fresh `pnpm install`, each time from an empty data folder on a stack started fresh (`pnpm dev:reset --yes && pnpm dev`), in 93 s and 89 s. Before that it passed twice in a row on a new worktree of `origin/main` (#28 and #29). Each run closes the earlier runs' PRs, so only #31 is open.

The first record, 2026-11-18 at 23:38 UTC, opened #19 with a setup token and a hand-made admin. The server seeds the admin now (F-001), so steps 1 and 2 read differently below.

**On this machine:** Windows 11, Node 24.14, no Docker. So the demo runs on the **host executor**: a personal runner on the same machine, the task in a worktree, the key proxy and git proxy in the runner's process on loopback (spec section 1). The `docker` executor is written and unit-tested, but has never run (below).

## How to run it

```
pnpm dev:reset --yes && pnpm dev          # in one terminal: an empty stack
set -a; . ~/.config/ostra-dev/model.env; . ~/.config/ostra-dev/github.env; . ~/.config/ostra-dev/github-test.env; set +a
pnpm e2e:m1                               # in another
```

Start both with `OSTRA_ADMIN_EMAIL=<GITHUB_TEST_MEMBER_LOGIN>@users.noreply.github.com`, so the PR's `Co-authored-by` links to the test member, and give the demo `OSTRA_E2E_STACK_LOG`, the stack's output file, so the credential search covers it. The script drives the panel in Chromium (Playwright), starts `ostra runner` from source, waits for the PR, runs the checks, then closes every demo PR but its own and deletes their branches and hidden refs (`test1` only). It types secrets into the panel's forms and prints none. Screenshots go to [`demo/`](demo/); the dev endpoint's address, the admin's email and this machine's folders are masked in them. Details: `docs/development.md`, "Milestone 1's demo".

## The steps (spec section 3)

From the 01:12 UTC run on 2026-11-19, on the clone.

| Step | What happened | Screenshot |
|---|---|---|
| 1. Install | `pnpm dev` started the embedded Postgres (UTF-8), generated Prisma's client, applied the three migrations, and started web on :3000 and core on :8787. Core seeded the first admin (`demo`, in the organization `Demo`) with the default password. | |
| 2. The first admin | Signing in with the default password led straight to "Choose a new password", which the script did. The checklist came up with step 1 ticked. | [01](demo/01-change-password.png), [02](demo/02-checklist.png) |
| 3. A model provider | The base URL and token from `model.env`. Test connection: "Connected · OpenAI-compatible" with the endpoint's models (about 450), matched to the catalog. Then Allow on personal runners, and the dev model as the built-in OpenCode profile's model. | [03](demo/03-provider-tested.png), [04](demo/04-provider-saved.png) |
| 4. The GitHub App | "Use an existing App": App ID 5821041 and its PEM from `github.env` (the webhook secret is a throwaway: webhooks are milestone 2). ostra showed the slug `ostra-sandbox-036d7c`, its bot, its permissions and the installation `ostra-test`. | [05](demo/05-github-connected.png) |
| 5. The project | `ostra-test/test1` from the installation's repos. The environment draft, then Save. | [06](demo/06-project-new.png), [07](demo/07-environment-draft.png), [08](demo/08-environment-saved.png) |
| 6. The runner | `ostra runner --server http://localhost:8787 --executor host` printed a code; the script approved it at `/device`. The runner showed online: personal, host, not isolated, capacity 1. | [09](demo/09-device-approve.png), [10](demo/10-runner-online.png) |
| 7. The prompt | "Add a CONTRIBUTING.md with a short section on how to run the tests", Run on: the personal runner. Dispatched at 01:13:07. | [11](demo/11-prompt.png) |
| 8. Watching | Thoughts, tool calls with their paths and commands, the edit, the agent's message, live. A second tab showed the same thread, and a reload mid-turn brought the history back. | [12](demo/12-watching.png), [13](demo/13-second-tab.png), [14](demo/14-after-reload.png) |
| 9. The PR | The runner committed, pushed the branch and the hidden ref through the git proxy, and ended the session with changes at 01:13:27. Core opened PR #31 at 01:13:32, 25 s after the dispatch. The task moved to "in review" with the PR linked. | [15](demo/15-pull-request.png) |
| 10. On GitHub | Checked through octokit: opened by `ostra-sandbox-036d7c[bot]`; its one commit authored and committed by the bot, with `Co-authored-by: demo`; the title is the prompt; the body, written by the agent through `set_pull_request_text`, links `OSTRA_PUBLIC_URL/tasks/<taskId>`. `test1` has no PR template, so that path wasn't exercised live. | |

## The checks after the run

All 13 passed in all four runs. The script prints each one and writes them to `.ostra-dev/e2e-m1/result.json`. The figures are the 01:12 run's.

| Check | Result |
|---|---|
| The PR is the bot's (F-078) | PASS. Author `ostra-sandbox-036d7c[bot]`, 1 commit by the bot with `Co-authored-by: demo`, the prompt as title, a link to the task in the body. |
| Tokens stored whole (F-089) | PASS. 12 model calls; the sessions hold 6,198 input and 2,412 output tokens (92,416 cache reads), equal to the sum of their `usage.recorded` events. Both come from the key proxy, so this shows the counts reached the database whole. |
| No empty PR (F-065) | PASS. "In two sentences, explain what this repository is for…" ended without changes, opened no PR, and is in "needs you" with the agent's answer as its summary ([17](demo/17-needs-you.png)). |
| The git proxy refuses `main` | PASS. From the stopped task's checkout, while it ran: `remote: ostra: only the task's branch and its hidden ref can be pushed`. |
| The git proxy refuses another repo | PASS. A push to `ostra-test/test2`: `remote: ostra: this task's proxy serves only the task's own repos`. |
| Nothing refused reached GitHub | PASS. Through octokit, `main` on `test1` is the same commit before and after, and `test2` has no `ostra/e2e-probe` branch. |
| No credential in the task's folders | PASS. While the stopped task ran: 47 files in its folder (the worktree, OpenCode's home, data, config and temp folders) searched by value for the model token and every line of the App's key, and OpenCode's tool outputs in `%TEMP%`. None held one; none was unreadable. |
| The agent's environment | PASS. The live OpenCode process, read from its memory: every name is on the adapter's allowlist, or is one OpenCode sets itself with its own value (`OPENCODE_CLIENT=acp`, the loopback `NO_PROXY`). No value holds a secret. |
| Tokens against the agent's own (ADR 0042) | PASS. While the stopped task waited on its command, the key proxy's count of the 2 model calls OpenCode had closed equals OpenCode's own, read from its database: 4,310 input and 386 output on both sides (OpenCode's output plus its reasoning). |
| Stop ended the turn (F-025) | PASS. The stopped task's one session is `stopped`, and its branch has no PR. |
| Stop kept the work (F-025) | PASS. GitHub has the task's branch and `refs/ostra/wip/<taskId>`, and the hidden ref's commit holds `docs/numbers.md` with ten lines ([19](demo/19-before-stop.png), [20](demo/20-stopped.png)). |
| No credential in the logs | PASS. The event log, the runner's log and the stack's output searched for 26 secret values and the GitHub token pattern: none. |
| No task folder left | PASS. 0 task folders in the runner's data folder, and no agent process left on the machine. |
| Clean-up | Every PR the day's runs opened is closed and their branches and hidden refs deleted. Only #31, its branch and its hidden ref remain. |

## What it took

The first runs failed. Each fix is its own commit on `main`:

- **The dev database was WIN1252.** On Windows, initdb takes the machine's code page, so any emoji in an agent's output failed the whole events batch (SQLSTATE 22P05), and the runner reconnected 700 times in a few minutes, resending it. Every embedded cluster now uses `--encoding=UTF8 --locale=C`, and `pnpm db:dev` warns about an older cluster (`ed1a2f0`). Events whose text holds a real NUL, which `jsonb` refuses too, are stored with U+FFFD in its place (`8025638`). A failed frame now logs the database's error code (`3cabb9c`).
- **Connecting the App failed** when GitHub's anonymous rate limit (60 an hour per address) was used up: the bot's user ID was read anonymously. It's read as an installation now (`c63b4f7`).
- **The commits were authored "ostra <ostra@ostra.dev>",** a name the agent picked itself, so the PR's commit wasn't the bot's. The agent's environment now carries the bot as `GIT_AUTHOR_*`/`GIT_COMMITTER_*`, which outrank `git -c user.name` (`658818c`).
- **The agent read ostra's own `AGENTS.md`** from the folders above its worktree, because the demo's runner folder was inside this repo. That's what "personal, not isolated" means on `host`. The demo keeps the runner's folder in the system temp folder.
- **Shell calls showed as "shell", reads as "read",** with no command or path: OpenCode sends those in the call's first update, not the call. The mapper holds such a call until its input arrives, and shows paths relative to the session's folder, so a runner's local folders don't reach the panel (`d5cb188`, `49db388`). An edit whose output lists no file now shows its paths instead of an empty row (`6eb8900`).
- **Branch names collided.** The spec named them from the task ID's first 8 characters, which in a UUIDv7 are a timestamp: all three demo tasks got `ostra/01a1f0dd-…`, so the same prompt twice within about a minute would share a branch. They use the last 8 hex digits now; spec section 11, item 10 is updated (`87c0eef`).
- **core refused the dev env files** (`OSTRA_DEV_GITHUB_*`, `OSTRA_DEV_PUBLIC_URL`, `OSTRA_SPIKE_*`), so `pnpm dev` wouldn't start with them loaded (`63cbebe`).

On 2026-11-19, from a fresh checkout, three checks failed and a fourth passed without proving anything. Each was the check's error, not the product's, and each is fixed in `🐛 fix the demo's stop and live agent checks`:

- **The stop didn't stop anything.** OpenCode 2.3.2 moved the ten-minute command to the background on its own and ended the turn, and the task opened a PR. The Stop then landed on a task in review, and the ref check passed on refs pushed at a normal end. The prompt now asks for the command in the foreground, and a new check requires the session to end `stopped`, with no PR.
- **The environment check named `NO_PROXY` and `OPENCODE_CLIENT`.** OpenCode sets both in its own process at startup (its `acp` command, its entry point); ostra doesn't pass them. The OpenCode adapter now lists them with their values (`selfSetEnv`), and the check accepts such a name only with exactly that value.
- **The token comparison was off** (proxy 4,348 in and 484 out, OpenCode 4,175 and 97, in one run). OpenCode records a model call's usage when its step ends, after the step's tool calls return, so the call that started the waiting command isn't counted yet. And it keeps reasoning tokens apart from its output, while the endpoint bills them as output. The check now compares the calls OpenCode has closed, with OpenCode's output plus its reasoning: equal, to the token.
- **One file was unreadable:** OpenCode's PTY service holds `xdg/state/opencode/pty/<id>/service.lock` exclusively while a shell runs. The file is empty. The scan now counts an empty file as read without opening it, and names any unreadable file by its path.

## What's still missing

**Waits for a Linux machine with Docker** (the ledger rows stay `building`, F-017 `planned`):
- `docker compose up` with the server, Postgres and the pool runner (F-001); the three images have never been built.
- A task in a box on the `docker` executor, its egress rules, and the sidecar container (F-017).
- The agent's container holding no credential, for the key proxy and the git proxy (F-089, F-090).
- OpenCode pinned and checksum-verified in the base image (F-019).
- The executor contract case for a detached helper on `docker` and on Linux `host` (ADR 0029). On Windows, process-tree containment held in every run here, but a helper whose parent exits between two snapshots can still escape (Q126, settled 2026-11-19: a job object, in milestone 2's ticket 42).

**Other milestone 1 work not done:**
- Ticket 40: the manifest flow ("Create a new App") run in a browser. F-006 stays `building` until it is.
- Ticket 34: the milestone 1 screen targets.

**Gaps found by the demo** (follow-ups, none blocks the demo):
- **A batch the server can't store is resent forever.** When saving a frame fails, core closes the socket with 1011, and the runner reconnects and resends the same batch, with no limit. Such a batch needs to be refused once, visibly, or held aside.
- **The agent works from the workspace root, not the repo.** With one repo, an agent told "create docs/numbers.md" once wrote it at the root, outside `test1/`. The task ended without changes and the file was lost without a word. Starting the agent in the repo when there is only one, or telling it where the repos are, would prevent it. The demo's prompt names the repo. *(Q133, settled 2026-11-19: the agent starts in the repo when there is one, and milestone 2's ticket 44 reports files left outside every repo.)*
- **OpenCode writes tool outputs to the machine's temp folder** (`%TEMP%\opencode\tool-outputs\<taskId>\…`), not the task's, although the launch sets `TEMP` and `TMP` to the task's folder. On `host` these files outlive the task.
- **The sidecar in a box uses the runner's own access token,** not one scoped to its task (protocol work, with core). *(Q129, settled 2026-11-19: ticket 41.)*
- **The panel:** `tasks.get` doesn't return the model or whether the agent can be steered; Stop still shows on a task in review, and pressing it moves the task to "stopped" with its PR still open; "Needs you" and "My tasks" aren't in the sidebar.
- **A checkout in a deep folder can't run the tests on Windows.** The embedded Postgres reads files under `node_modules/.pnpm/@embedded-postgres+windows-x64@…/native/share/extension/`, which pass Windows' 260-character path limit once the checkout's own path is longer than about 75 characters. initdb then fails, and every database test with it. A short path works.
- **OpenCode may move a long command to the background** without being asked, which ends the turn while the command runs on. On `host` it is killed with the agent at the session's end. ostra has no say in it yet: no permission rule or tool setting covers it.
- **A tool's output can carry the runner's local folders** to the panel: OpenCode's "moved to the background" message holds the absolute path of its output file. Tool inputs are made relative (`49db388`); outputs aren't.
- **Join tokens made in the panel** aren't accepted by core's register yet (F-091, milestone 5). *(Q130, settled 2026-11-19: ticket 42, with the approval switch enforced.)*
