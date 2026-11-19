# 10: OpenCode adapter: session export, import and replay

Status: done
Builder: adapters
Blocked by: 04
Features: F-033, F-096, F-047
Packages: `packages/adapters/adapter-opencode`
Spec: `../spec.md`, sections 5.2 and 11 (item 6)

## What to build

- **`exportSession`:** `opencode session export <id>` against the task's own OpenCode data directory, beside the live agent, returning the JSON on stdout. The per-task environment stays the allowlisted one: no credential, the fake key only.
- **`importSession`:** `opencode session import <file> --directory <the box's workspace>`, always with `--directory`, because the archive names the old box's absolute path (spike 2, surprise 5). A 409 from an archive already present is treated as imported.
- **The capability `sessionArchive: true`,** and a check at launch that the pinned version is one spike 2 ran (2.3.0 to 2.3.2) or a later one the agent suite has passed on; otherwise the capability reads `false` and reopening uses the template.
- **Replay:** OpenCode's `session/load` replays the whole history as updates before it answers. The adapter's `mapUpdate` passes the driver's replay mark through, so none becomes a new event.
- **`session/resume` after an import:** tried once in the agent suite, and its result recorded under this ticket's comments. If it works without the replay, a follow-up can use it.
- The agent suite runs for OpenCode against the stub models, and gated on `model.env` against the real endpoint.

## Port from

`spikes/can-a-session-move-to-a-fresh-box/src/lib/session-archive.ts`, and the harness's B1 and B3 cases as suite cases.

## Done when

- [x] The agent suite's archive cases pass for OpenCode and for the fake agent.
- [x] Gated on `model.env`: a real session exported after three turns, imported in a fresh directory, answers a question about its first turn correctly.
- [x] Committed as `✨ add OpenCode's session export and import`.

## Comments
- 2026-11-19, adapters: done in `afe66e1` (`✨ add OpenCode's session export and import`), after `55b07c6` (`✨ let an agent command write its stdout to a file`) and `e2c44be` (`♻️ make exportSession and importSession async`). For tickets 22 and 24 (the runner), and for whoever bumps OpenCode:
  - **Two small changes to ticket 04's shapes, both named here because the runner's builders code against them.** (1) `AgentCommand` gained an optional `stdoutTo`: a file that receives the command's standard output. OpenCode's `session export` has no output flag and prints the archive, so the executor opens the file and wires the child's stdout to it (no shell, no `>`); the import writes nothing. `runAgentCommand` in `@ostra/adapter-sdk/testing` does it for suites. (2) `exportSession` and `importSession` now return a `Promise<AdapterResult<AgentCommand>>`: naming the command means finding the binary and checking its pinned SHA-256, which the runner's code does with async calls only (the lint rule bans the sync ones), and a fresh box imports before it launches, so nothing is cached yet. Callers `await` them.
  - **`exportSession`:** `opencode session export <id> --standalone`, `cwd` the workspace, `stdoutTo` the archive path. **`importSession`:** `opencode session import <archive> --standalone --directory <workspace>`, always with `--directory`. Both run with the task's own folders and an allowlisted environment that holds no credential, **not even the fake key** (they call no model): `buildCliEnv`, which `buildAgentEnv` now extends. The session ID must be letters, digits, `_`, `-` or `.` and not start with a dash, and the paths absolute; anything else is `invalid-input`. `unsupported` for a version not in `ARCHIVE_VERIFIED_VERSIONS` (2.3.0 to 2.3.2); `capabilities.sessionArchive` reads `true` only when the pinned `OPENCODE_VERSION` is in that list, so a bump to a version the suite hasn't passed on turns it off and reopening uses the template.
  - **An archive already present is a success, with no code of ours:** a second `session import` exits 0, prints nothing on stdout and `Session already exists` on stderr (a first one prints `Imported session: <id>`). The runner needs only the exit code. `importedSessionId` reads the ID from the first.
  - **Replay:** the base class already counts what the ACP driver marks as replay and never calls `mapUpdate` for it, so OpenCode needed nothing: against the real binary a load after an import counted a replay and produced no event (B1), and a load with no import fails (B3).
  - **`session/resume` after an import, tried once on OpenCode 2.3.2, raw over stdio:** it works. `initialize` advertises `sessionCapabilities.resume`; `session/resume` answers with a result and sends **no replay**, only one `available_commands_update`; a prompt after it answered from the first turn. So a follow-up can use `resume` instead of `load` and skip the replay (and its cost on a long session). The ACP driver has no `resume` yet, so this ticket did not switch to it.
  - **Tests:** the agent suite's archive case passes for OpenCode on both API formats and for the fake agent on both profiles; `opencode-archive.test.ts` has OpenCode's own facts (the export holds the turns and the old directory, the import binds to the fresh workspace, no import means no load, the double import, the environment); `opencode-adapter.live.test.ts` (gated on `model.env`) exports a real session after three turns, imports it in a fresh directory, and the model names the codename from its first turn.
