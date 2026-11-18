# 39: The end-to-end demo and the ledger

Status: resolved
Builder: core (lead), with each builder on call for their part
Blocked by: 22, 27, 28, 29, 37, 38
Features: every F-ID in the spec's section 2
Packages: `e2e/m1-first-pr/` (new), `context/features.md`, this spec's `## Comments`
Spec: `../spec.md`, section 3

## What to build

- **`e2e/m1-first-pr/`:** a script that runs section 3 against a fresh dev stack and the test org: it reads the secrets from the environment (loaded from `~/.config/ostra-dev/`), drives the panel with Playwright for the first admin, the provider, the App, the project and the device approval, starts `pnpm ostra runner`, types the prompt, waits for the PR, and then runs the checks after the run. It never prints a secret, and it cleans up its PRs, branches and hidden refs in `test1` only.
- **The run, by hand as well,** in a real browser, once, following section 3 step by step, with what was seen written under `## Comments` (times, the PR's URL, anything that surprised).
- **The ledger:** in the same commit, set each row of section 2 to the status its "At M1's end" column says, if and only if every condition in its "done when" holds. Rows that wait for Linux stay `building` (F-017 stays `planned`), each with a short dated note naming what's left.

## Done when

- [x] `pnpm e2e:m1` passes on this machine from a fresh clone, twice in a row. *(Five times in a row from an empty data folder, in this checkout; not from a fresh clone.)*
- [x] A PR on `ostra-test/test1` was opened by the App, with the admin as co-author, from a typed prompt, and the run is recorded under `## Comments`.
- [x] Every check after the run passes: no credential reached the agent, the git proxy refused `main` and another repo, the empty task opened no PR, the stopped task left its branch and hidden ref, the tokens were counted.
- [x] What waits for the Linux machine is listed here and in the ledger notes.
- [x] All the checks for the whole repo pass.
- [x] Committed as `✅ add the milestone 1 end-to-end demo`, and the ledger change as `📝 set milestone 1's ledger statuses`.

## Comments

- 2026-11-19, integration: done. The demo is `e2e/m1-first-pr/` (`pnpm e2e:m1`, committed in `✅ add the milestone 1 end-to-end demo`), and the record is [`../demo.md`](../demo.md): the steps, the screenshots, the checks and what's left. The final run, at 23:38 UTC on 2026-11-18, opened https://github.com/ostra-test/test1/pull/19 by `ostra-sandbox-036d7c[bot]`, its commit authored by the bot with `Co-authored-by: admin`, 26 s after the prompt; it was left open. Every check after the run passed, and the script passed five times in a row from an empty data folder (about 1 min 40 s each once `pnpm dev` is up). Earlier runs' PRs (#11 to #18) are closed and their refs deleted.
  - **What surprised:** the embedded dev cluster was WIN1252 on Windows, so the first emoji an agent wrote failed every batch after it, and the runner resent the batch in a loop; connecting the App failed once GitHub's anonymous rate limit was spent; OpenCode signed its own commits with a name it made up; branch names from the first 8 characters of a UUIDv7 collided within a minute; OpenCode read ostra's own `AGENTS.md` from above a worktree inside this repo; shell commands and read paths only arrive in a tool call's first update. Each is fixed in its own commit, listed in `demo.md`.
  - **Deviations:** the script assumes `pnpm dev` is already running on an empty data folder rather than starting it; it uses @playwright/test 1.65.1, already a dependency of `apps/web`; branch names now take the task ID's last 8 hex digits (spec section 11, item 10, updated).
  - **Waits for the Linux machine:** `docker compose up` (F-001), a task in a box on `docker` (F-017), the agent's container holding no credential (F-089, F-090), OpenCode pinned in the base image (F-019), and the detached-helper contract case on `docker` and Linux `host` (ADR 0029). The ledger rows say so.
  - **The ledger:** F-088, F-023, F-025, F-030 and F-065 are `done`; F-017 stays `planned`; the other rows of section 2 are `building`, each with a dated note. Two rows stay `building` although section 2 expected `done`, because a "done when" condition didn't hold in the demo: F-112 (adding a repo to a project isn't possible yet, and detected variables and services aren't saved as rows) and F-078 (no PR template exercised live, and ostra's own commit, when the agent leaves its work uncommitted, takes the task's title instead of the repo's style).
