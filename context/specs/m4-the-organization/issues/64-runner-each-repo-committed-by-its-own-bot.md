# 64: Runner: each repo's commits by its own bot

Status: resolved
Builder: runner
Blocked by: 01, 46, 49
Features: F-136, F-078, F-098
Packages: `apps/runner` (`src/task-host/task-run.ts`, `src/testing/several-repos-cases.ts`), `packages/adapters/adapter-executor-host` (`src/host-executor.ts`, which `docker` and `kubernetes` run in the box), `packages/protocol` (`src/task/spec.ts`), `packages/adapter-sdk` (`src/executor/base.ts`, the fake agent's `commit`)
Spec: `../spec.md`, sections 4 ("Linked installations") and 5.1; ADR 0065 ("A bot per repo"), ADR 0040

## What to build

Milestone 4's final check found it: protocol minor 3 carries `repos[].gitIdentity` (ticket 01/46) and core fills it for a repo of a second App (ticket 49), but the runner committed every repo as the spec's top-level `gitIdentity`. So a task across two Apps' repos signed the second repo's commits as the first App's bot.

- **ostra's own commits** (`commitWork`, `commitAndPush`): each repo is authored and committed by its own bot, `repos[].gitIdentity`, else the top-level one, with the member's `Co-authored-by` trailers (ADR 0040).
- **The agent's own commits:** each checkout's local config names its repo's bot, as `user.*`, `author.*` and `committer.*` (the last two outrank a `git -c user.name` an agent passes). The agent's environment names one bot with `GIT_AUTHOR_*` and `GIT_COMMITTER_*` only when every repo has the same one; otherwise it names none, and no repo variable can either.
- One rule for the repo's bot, in the protocol beside `repoBranchName`: `repoGitIdentity`, and `taskSpecHasOneGitIdentity`, which `taskSpecNeedsMinor3` uses too.

## Done when

- [x] A case in the runner's several-repos cases, run on `host` and `docker` (`kubernetes` runs the same `HostExecutor` in its box): two repos, two bots, and each repo's commits, the agent's own and ostra's, have that repo's bot as author and committer in the fake upstream, with the member's trailer. Break-its recorded in `context/proof/F-136.md`.
- [x] Typecheck, lint and tests of the touched packages and their consumers; `pnpm check:proof`.
- [x] Committed as `🐛 commit each repo as its own bot`.

## Comments

- 2026-11-20 (`🐛 commit each repo as its own bot`): `HostExecutor.#commitLeft` commits each repo with `repoGitIdentity` in the environment; `#settings` takes the bot, the task's config gets the top-level one and each checkout its repo's own, on create and on `resumeBox`; `agentVariables` (`task-run.ts`) sets the identity variables only when `taskSpecHasOneGitIdentity`, and removes them otherwise. The fake agent's `commit` commits in each repo's folder from a workspace root. Test: `apps/runner/src/task-host/several-repos.host.test.ts` and `several-repos.docker.test.ts`, "F-136: on host (docker), repos of two Apps are each committed by their own bot, the agent's commits and ostra's, with the member's trailer". Four break-its, each failed the case: every repo committed as `message.author` in `#commitLeft`; each checkout's config given the top-level bot; the agent's environment set whatever the repos; the checkout config's `author.*` and `committer.*` dropped (the fake agent's `-c user.name` then authored its commits). The live run in a second GitHub organization stays ticket 55's, the maintainer's step, so F-136 stays `building`.
