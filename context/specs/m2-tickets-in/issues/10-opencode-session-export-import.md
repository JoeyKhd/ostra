# 10: OpenCode adapter: session export, import and replay

Status: ready-for-agent
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

- [ ] The agent suite's archive cases pass for OpenCode and for the fake agent.
- [ ] Gated on `model.env`: a real session exported after three turns, imported in a fresh directory, answers a question about its first turn correctly.
- [ ] Committed as `✨ add OpenCode's session export and import`.

## Comments
