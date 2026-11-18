# 11: The OpenCode adapter

Status: ready-for-agent
Builder: adapters
Blocked by: 10, 12
Features: F-019
Packages: `packages/adapters/adapter-opencode` (new, Apache-2.0)
Spec: `../spec.md`, sections 2 and 11 (item 6)

## What to build

`OpenCodeAdapter extends AgentAdapter`.

- **The binary.** `@opencode/cli` 2.3.2 (the V2 line, never `opencode-ai`), exact pin, install scripts off. Resolve the platform package's binary and check its SHA-256 against a value pinned in the adapter, per platform. A mismatch refuses to start, with a clear error.
- **Per-task directories:** workspace, home, XDG data, config, cache and state, and temp, under the task's folder, so nothing is shared with the runner's user or another task.
- **The config ostra writes per task** (ADR 0032): the provider (the key proxy's base URL, the fake key, the API format, the model ID), `experimental.todo` on, the permission set of spec section 11, item 6 (edit and shell inside the worktree allowed, `external_directory` denied), ostra's MCP server (ticket 20's URL and its per-task bearer), the model catalog as a file (`OPENCODE_MODELS_PATH`, `OPENCODE_DISABLE_MODELS_FETCH=1`).
- **The environment,** built from an allowlist (`PATH`, `HOME`/`USERPROFILE` set to the task's home, the XDG variables, `TEMP`/`TMP`, `SYSTEMROOT` on Windows, locale), plus the fake key and base URL. Never the runner's own environment.
- **Capabilities:** `steerMidTurn` only when `initialize` returns `_meta.steering.supported: true`; `sessionLoad` true; `nativePlan` false; `rejectAndContinue` false; `elicitationForm` true; `modelBaseUrlAndPlaceholderKey` true.
- **`mapUpdate`:** a `todowrite` tool call becomes `plan.updated`, from `rawInput.todos` and `rawOutput.metadata.todos`.
- The agent contract suite from ticket 10, against the stub models (ticket 12) in both formats, and gated on `model.env` against the real endpoint. Include the steer probe, which ADR 0032 runs on every OpenCode bump.

## Port from

`spikes/how-should-the-runner-drive-opencode/src/lib/opencode.ts` and its cases `t5-events.ts`, `t7-permissions.ts`, `steer-probe.ts`.

## Done when

- [ ] The agent contract suite passes against both stub formats on this machine.
- [ ] With `model.env` loaded, one real turn completes on the endpoint through a key proxy stand-in, and the suite's environment check passes.
- [ ] A test proves the checksum check refuses a changed binary.
- [ ] Package checks pass, and `pnpm check:licenses` shows the package as Apache-2.0 with no restricted dependency.
- [ ] Committed as `✨ add the OpenCode adapter`.

## Not in this ticket

The base image's pin (ticket 22).

## Comments
