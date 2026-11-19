# 08: Runner: installing agents on `host` and reporting them

Status: wontfix
Note: Won't do now (2026-11-19): Claude Code (F-018) moved after v1 (the maintainer: "perhaps we can just skip Claude Code with its ACP for now"), and milestone 7 is the launch alone, on OpenCode. Installing agents on runners exists for an agent ostra may not redistribute; OpenCode is in the base image and bundled on `host`. This ticket waits for F-018 after v1; its text stays as written for then (ADR 0062, postponed).
Builder: runner
Blocked by: 01, 02
Features: F-018, F-014, F-015, F-093 (their agents)
Packages: `apps/runner` (`src/agents/` (new), `src/cli/`, `src/connection/`, `src/task-host/`)
Note: agent images on `docker` and `kubernetes` moved to ticket 35 in the spec's review, so this ticket is one builder's change.
Spec: `../spec.md`, sections 4 and 5.1; ADR 0062; ADR 0046 (amended)

## What to build

- **On `host`:** `prepareAgent(adapter)` runs `npm install --ignore-scripts --no-audit --no-fund --prefix <OSTRA_AGENTS_DIR>/<agent>/<version> <package>@<version>` with `--registry <OSTRA_NPM_REGISTRY>`, through the async child-process API, as an argument array, with the `npm` beside the runner's own Node (else the one on `PATH`, else the agent is reported `failed: unsupported`, "npm not found"); then `verifyAgentBinary`. A half-done install is removed; two tasks asking at once share one install. The binary's checksum is checked again before every launch. The adapter's `health()` (ticket 06) runs before the agent is reported `ready`, so a machine with a managed Claude Code policy reports `failed: unsupported` with its reason.
- **Saying what it downloads.** The first preparation of an agent version prints one line in the runner's terminal and its log: the package, its version, its size on disk once installed, and, for Claude Code, that it comes from npm under Anthropic's terms. On a personal runner, the member's own machine is the one downloading it. `OSTRA_AGENT_PREPARE=manual` makes it wait for `ostra agents install` or an admin's "Prepare now".
- **`OSTRA_AGENT_PREPARE`:** `auto`, `manual` or `off`, as spec section 5.4 says.
- **Reporting:** `agents` on `hello` and `status`; the three events; `agent.prepare` handled; an offer for an agent it can't run or prepare declined with `agent-missing`.
- **`ostra agents list`** and **`ostra agents install <agent>`**.
- **The launch record,** in development and test only: the command, arguments and environment's variable names of each agent launch, for the demo's checks; never a value, never in production.

## Done when

- [ ] Tests named for `F-018`: an install against the fake registry succeeds and is reported `ready`; a checksum mismatch, a missing platform package, a registry that's down and no `npm` each report `failed` with their reason and leave nothing half-installed; two tasks share one install; a planted managed-policy file reports `failed: unsupported` and the task is declined `agent-missing`; an offer for a missing agent with `OSTRA_AGENT_PREPARE=off` is declined `agent-missing`; the first preparation's line names the package and size and no path outside the data folder; the launch record holds names only.
- [ ] `ostra agents install claude-code` installs the real pinned package here, and its checksum matches.
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✨ install agents and build agent images`.

## Comments

- 2026-11-19, lead: set `wontfix`. Claude Code (F-018) moved after v1 on the maintainer's word, and this ticket waits for it.
