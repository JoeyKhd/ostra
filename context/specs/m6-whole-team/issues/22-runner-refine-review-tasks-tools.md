# 22: Runner: refine and review tasks, and their tools

Status: done
Builder: runner
Blocked by: 01, 09
Features: F-099, F-100
Packages: `apps/runner` (`src/task-host/`, `src/sidecar/mcp-tools.ts`, `src/sidecar/git-proxy/`)
Spec: `../spec.md`, sections 4 ("A refine task", "The AI review") and 5.1

## What to build

- **Read-only kinds:** a spec of kind `refine` or `review` starts the git proxy in its read-only mode (milestone 1's), and the runner itself pushes nothing after a turn: no branch, no hidden ref (Q221). The session archive is still uploaded, so a reopen restores the conversation; the panel says prototypes in the box aren't kept.
- **The review checkout:** with `review` in the spec, each repo is fetched and checked out at its `headSha`, detached, with `baseSha` fetched too so the agent can diff; the agent starts at the workspace root when there are several.
- **The tools:** the sidecar's MCP server serves exactly the tools `tools` names. `submit_draft` and `submit_review` check their input against `@ostra/protocol`'s schemas, forward to `/runner/v1/tasks/:taskId/draft` and `/review` with the task's token, and return the protocol's result text, refusals included.
- **On `docker`** the proxy and the tools run in the sidecar on the box network, as milestone 4's memory tools do; unit-tested against the fake engine, live with F-017 on Linux.

## Done when

- [x] Tests: a refine task's push and hidden-ref push from the agent's shell are refused before anything reaches the fake upstream; the runner pushes nothing after a refine or review turn; a review task's repos sit at the given heads; the tools listed per kind; each tool's round trip through the fake core, with each refusal.
- [x] Break-it: the read-only mode not set for refine fails its test; recorded in `context/proof/F-099.md`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ run refine and review tasks`.

## Comments
- 2026-11-20 (ticket 22, commit 2c944863 `✨ run refine and review tasks`, after 0b5c5045 `✨ export the team cases' samples` in `@ostra/adapter-sdk`'s testing). Built in `apps/runner` and in the host executor's checkout, which `docker` and `kubernetes` run too:
  - **Read-only kinds.** `pushesWork` (`task-run.ts`) says a refine or review task pushes nothing: its git proxy starts in milestone 1's read-only mode, and after a turn the runner commits nothing and pushes neither the branch nor the hidden ref (Q221). The session archive still goes up, and `session.saved` names no head, so a reopen restores the conversation and nothing the agent prototyped. The milestone 1 one-turn path and a stop or crash push nothing either.
  - **The review checkout.** With `review` in the spec, the host executor fetches each repo's head and base by SHA through the read-only proxy (falling back to `refs/pull/<n>/head`), checks the head out detached, and keeps the base as `refs/ostra/review-base`. A review reopened on a kept box moves each repo to the new round's heads. With several repos the agent starts at the workspace root (milestone 4's `agentCwd`).
  - **The tools.** The sidecar's MCP server serves exactly the spec's `tools` (absent: milestone 4's set). `submit_draft`, `submit_review` and `propose_environment` take the protocol's schemas as their input, name repos by ID, and forward to core's `/draft`, `/review` and `/environment-proposal` with the link's token (`teamLink`, `server-link.ts`). Core's answer, each refusal included, goes back in the protocol's words. With core unreachable, the tool says nothing was saved. `propose_environment` is ticket 23's tool, built here with the other two since it's the same code; ticket 23's comment says so.
  - **The launch** passes the spec's `kind` and `tools` to the agent adapter (ticket 09's `PrepareLaunchInput`). The spec has no "allows prototyping" field, so `allowPrototyping` stays out (`false`, the built-in Refine profile's). A profile that allows it needs a spec field, which is core's to add.
  - **Docker.** The same cases run on `docker` as a box's sidecar drives it (`DockerExecutor` through the real bridge to a local init; the proxy and the tools run in the sidecar), in `read-only-kinds.docker.test.ts`. The proxy on a real box network on Linux with Docker is F-017's live run.
  - **Test seams.** The runner's fake server gains the three endpoints (`team`: records, a refusal switch for each, and `down`). The scripted fake's `git-push` takes a full ref name (the hidden ref), and `@ostra/adapter-sdk/testing` exports ticket 04's team cases and their samples. Both changes are additive, in their own commit.
  - **Proof.** These tests: `read-only-kinds.host.test.ts` and `.docker.test.ts` (both pushes refused with no upstream request, nothing pushed after a turn, the heads, the tools reaching the fake core), and `mcp-team-tools.test.ts` (the tool sets per kind, each tool's round trip and each refusal, a repo the task lacks, core down). Break-its, each restored: the proxy in `read-write` mode for refine (the refused-push case failed); `saveTurnWork` pushing for every kind (the pushes-nothing case failed); no review checkout (the heads case failed); `submit_draft` registered whatever the tool sets (the per-kind listing failed). The rows are in `context/proof/F-099.md` and `F-100.md`, still `partial` for core's, the panel's and the live parts.
  - **Checks.** Whole-repo typecheck and lint through turbo with `--concurrency 2`; the tests of `@ostra/runner`, `@ostra/adapter-sdk` and the three executors; `check:licenses`; `check:proof` (0 errors).
