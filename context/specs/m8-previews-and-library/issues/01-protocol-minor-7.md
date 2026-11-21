# 01: Protocol: minor 7

Status: done
Builder: core (contracts, first)
Blocked by: none
Features: F-121, F-140, F-141, F-142, F-143, F-144 (their wire shapes)
Packages: `packages/protocol`
Spec: `../spec.md`, section 5.1; ADR 0068

## What to build

Every change is additive. Each schema is written once, Zod first, and its type is `z.infer`. `main` is at minor 6 (F-138), so this is minor 7. If another minor has landed first, take the next number and write it under `## Comments`; the spec calls it "minor 7".

- **The minor,** negotiated in `hello` and `welcome`, with minor 6's codecs kept, and `PROTOCOL_MINOR`'s comment growing a line for milestone 8. A minor-6 peer is never sent an app process, the `app` tools, `dispatch.purpose`, `app.*`, `screenshot.take` or `preview.*`. `isTaskOfferable(spec, peerMinor)` refuses a spec that needs them for a minor-6 peer, and a new `isPreviewable(peerMinor, carrier)` returns `{ stream, tunnel }` or the reason the pane shows. A minor-5 peer is outside the window.
- **The task spec:**
  - `environment.appProcesses`, with each process's ready check as a discriminated union;
  - `environment.services[].preview`;
  - `environment.screenshots`;
  - `"app"` in `ostraToolSetSchema`;
  - the rules as refinements: at most one `primary`, unique names and ports, no port below 1024. `taskSpecResponseSchemaFor(minor)` returns each minor's shape.
- **Commands:** `dispatch.purpose` (`turn` when absent, or `app`); `app.start`, `app.stop`, `screenshot.take`, `preview.open`, `preview.close`; and `preview.input`, which the codec allows only on the HTTP carrier.
- **Events:** `app.process`, `app.browser`, `attachment.added` and `preview.list` as runner events. The server-only kinds of section 5.1 go in `serverOnlyKinds`, so the gateway refuses a batch that holds one.
- **The preview connection** in a new `src/runner/preview.ts`:
  - the endpoint's path and its query (`view`, the epoch);
  - the `stream` mode's message types and their JSON parts as strict objects, with an encoder and a decoder for the binary framing;
  - the `tunnel` mode's description;
  - `POST /runner/v1/preview/frames`'s body for the HTTP carrier.
- **`hello` and `status`:** `preview: { stream, tunnel }`, and a `host` runner's `browser`.
- **The MCP tools** in `src/mcp/tools.ts`:
  - `start_app`, `show_preview`, `take_screenshot` and `record_app`, each with its input schema, its description for the agent, and the result text for each refusal (a port that isn't allowed, no browser in this box, the limit reached, a process that didn't get ready);
  - `record_app`'s steps as a closed union;
  - `propose_environment` gains `appProcesses` and services' `preview`;
  - a finding gains `attachmentIds`.
- **The frame reel** in a new `src/task/frame-reel.ts`: a small header (a version, the size, the frame count, the duration, the steps), then each frame's time and JPEG, with an encoder for the runner and a decoder for the panel's player, which refuses a reel past its limits.
- **CLI HTTP** in `src/cli/http.ts`: `cliPaths.previewTunnel(ref)` and `cliPaths.startApp(ref)`, their requests and responses with the refusals, and core's `/cli/v1/tunnel` path and query.
- **The fixed words** in `src/agent/prompts.ts`: the app's block for the agent's instructions (each process's label, its in-box address, and the one-origin convention), and `appAddressName(name)` for `OSTRA_APP_<NAME>_URL` and `OSTRA_SERVICE_<NAME>_URL`.
- **Limits** in `limits.ts`, as section 5.1 lists them, and the reserved ports by name (the key proxy, the git proxy, the MCP proxy, the sidecar's control API, OpenCode's loopback port, the browser's).
- **Never logged:** each schema's description says what's never logged: a caption, a recording's steps, an app's log and command, a link's token, a code and a ticket.

## Done when

- [x] Tests:
  - every new shape round-trips, and minor 6's specs still parse;
  - a minor-6 peer's codec drops the new fields;
  - `isTaskOfferable` refuses a spec with app processes or the `app` tools for a minor-6 peer and allows it at minor 7;
  - `isPreviewable` gives no tunnel on the HTTP carrier;
  - a strict object refuses an unknown field;
  - the server-only set holds every new server kind;
  - the stream framing's decoder refuses a truncated or oversized message;
  - each tool refuses a reserved port, a port below 1024, a 21st step and a second primary;
  - `src/testing/` has fixtures for each new kind, command, field and endpoint.
- [x] Every caller in the repo still compiles, and no existing schema changed shape.
- [x] The whole-repo checks pass (spec section 10).
- [x] Committed as `✨ add protocol minor 7`.

## Comments

- 2026-11-21, core: built as `✨ add protocol minor 7`. No other minor had landed: `main` was at minor 6, with the repo-skills work's `agent.repoSkills` in it, so this is minor 7 (window 6 to 8), and a synthetic minor 9 recording is two ahead. Readings and differences:
  - **Where the code differs from the spec:** services are the spec's top-level `services[]`, not `environment.services`, so a service's `preview: { label } | null` sits there; `environment.appProcesses` and `environment.screenshots` are in `environment` as written. `kind` names the event in the union, so `attachment.added`'s is `attachmentKind` and `preview.link_created`'s is `linkKind`. `app.browser` carries `browser: { available: true, name, version } | { available: false, reason }`, since the event union is keyed on `kind`.
  - **Added beyond the spec, all optional or on new shapes:** `screenshot.take` carries the `memberId` it's for, and `attachment.added` carries `requestId`, so the pane matches its own screenshot; `preview.level_changed` and the link events carry the `memberId` who acted. A preview's `key` is its target's (`app-<name>`, `port-<port>`, `service-<name>`), the same on every box. Every command carries the `sessionId` it's routed by, as `interrupt` does.
  - **The DB:** the six command kinds need `CommandKind` values for the outbox, so this commit adds them in a small migration (`20261201100000_command_minor_7`) and `commandKindToDb`, as minor 4 did for `resume`. The rest of milestone 8's schema is ticket 04's.
  - **`preview.input`** is in the `Command` type; the WebSocket's `downFrameCodec` refuses it and `httpDownFrameCodec` (the long poll's) reads it. `commandKindSupportedOn(kind, minor, carrier)` is the outbox's check.
  - **`isPreviewable(peerMinor, carrier, reported)`** fails closed: below minor 7, or a runner that reported no `preview` in `hello` or `status`, gives no view, with the pane's words (`previewRefusalWords`). The runner reports none until its tickets (12, 13, 18) land, and refuses the new commands until then.
  - **The reserved ports** are named (`reservedPortNames`) and numbered at run time (`ReservedPorts`), since the sidecar picks them; `portRefusal` and `appToolRefusal` apply them with the 1024 floor. `appToolRefusal` also refuses a second primary, a process the environment lacks, no browser and the turn's 21st picture; a 21st recording step is the schema's.
  - **New files:** `src/task/app.ts` (the running app's words, a leaf that the spec, the events, the commands and the tools all import, so none import each other through it), `src/runner/preview.ts` and `src/task/frame-reel.ts` (magic `OSRL`, a JSON header, then each frame's time and JPEG). The one-origin words are `ONE_ORIGIN_RULE` in `src/agent/prompts.ts`, beside `appAddressName` and `appInstructionsBlock`.
  - **A sidecar talking to a minor-6 core** sends no app process, service preview or finding attachment: `encodeEnvironmentProposalForMinor` and `encodeReviewRequestForMinor`.
  - **Callers:** the fold, the task state and the ingest store the ten new kinds with no row yet; the runner's handlers refuse the six commands (a `docker` or `kubernetes` runner says the box's sidecar takes them); the pinned minors in core's and the runner's tests move up one.
  - **Checks:** the whole repo's typecheck; lint and tests of the touched packages (protocol, db, task-view, domain, runner, core, e2e-load), on the lead's rules of 2026-11-20.
