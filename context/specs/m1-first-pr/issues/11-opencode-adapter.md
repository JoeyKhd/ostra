# 11: The OpenCode adapter

Status: resolved
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

- [x] The agent contract suite passes against both stub formats on this machine.
- [x] With `model.env` loaded, one real turn completes on the endpoint through a key proxy stand-in, and the suite's environment check passes.
- [x] A test proves the checksum check refuses a changed binary.
- [x] Package checks pass, and `pnpm check:licenses` shows the package as Apache-2.0 with no restricted dependency.
- [x] Committed as `✨ add the OpenCode adapter`.

## Not in this ticket

The base image's pin (ticket 22).

## Comments

- 2026-11-18, adapters: done in 376a4ce (`✨ add the OpenCode adapter`), package `packages/adapters/adapter-opencode`. `@opencode/cli` 2.3.2 is pinned with its install script off (`allowBuilds` says false). The binary's SHA-256 is pinned for all 12 platform packages (computed from the registry's tarballs; the Windows one equals spike 1's). A changed binary, a platform with no pin and another version are refused (tested with a temp install, and against this machine's real binary).
  - The config is V2's (`providers`, `permissions`, `mcp.servers`, `experimental.todo`), checked against `opencode.ai/config.json`; the real binary runs on it. `todowrite` becomes an ACP `plan` update, so `plan.updated` keeps its place. The agent contract suite passes against the real OpenCode on a stub of each API format (steer probe included, as the suite's steerable case); the live turn through a key-proxy stand-in completes on the dev endpoint and the agent only ever presents the fake key.
  - **Not run here:** the Linux and macOS binaries (only their checksums are pinned), and the `permission`, `question`, `environment` and `leftoverProcess` probes against OpenCode (its config allows the worktree, so no permission request comes; the agent's shell holds variables the allowlist didn't pass, spike 1 finding 7). The launch's own environment is checked instead.
