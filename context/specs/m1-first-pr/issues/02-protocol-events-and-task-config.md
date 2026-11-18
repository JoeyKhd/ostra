# 02: Protocol: agent events, live text, task spec and config

Status: ready-for-agent
Builder: contracts
Blocked by: none
Features: F-023, F-019, F-030, F-050, F-089 (schemas only)
Packages: `packages/protocol`
Spec: `../spec.md`, section 5.1

## What to build

- `src/events/agent-events.ts`: ostra's event union, discriminated on `kind` (ADR 0018, ADR 0035, ADR 0036). Port the 29 kinds of spike 7, then add `environment.setup_started`, `environment.setup_output`, `environment.setup_finished`, `git.pushed`, `pr.text_set`, `session.ended`, `usage.recorded` and `session.usage` with the fields the spec lists. Tool events carry ACP's tool `kind`. Strict objects: ostra owns this format.
  - `readEventSchema`, which turns an unknown `kind` into `{ kind: "unsupported", rawKind }` for the read side, so a newer writer never breaks an older reader.
  - `storedEventSchema` (`taskId`, `seq`, `sessionId`, `sessionSeq`, `at`, `event`) and the runner-side `{ sessionId, sessionSeq, leaseEpoch, event }`.
- `src/events/live-text.ts`: the partial-text frame (task, session, segment, kind `message` or `thought`, offset, text), at most every 250 ms.
- `src/task/spec.ts`: the task spec a dispatch hands the runner (spec 5.1, every field), including each repo's LFS action hosts and the PR template text when the repo has one.
- `src/task/credentials.ts`: the task's credentials. The schema's description says the payload is never logged, and the type is branded `TaskCredentials` so a logger helper can refuse it by type.
- `src/runner/config.ts`: the runner's config from flags and `OSTRA_*` variables (server URL, data folder, transport, executor `host` or `docker`, capacity, labels, name). Strict, with defaults, and a `describe()` on each field that `docs/configuration.md` can quote.

## Port from

`spikes/live-stream-and-task-view/src/shared/events.ts`, `tools.ts`, `ids.ts`.

## Done when

- [ ] Every kind has a schema and a test fixture; the fixtures double as the fold's test data (ticket 36).
- [ ] An unknown kind reads as `unsupported`; an unknown field in a known kind is refused.
- [ ] `TaskSpec` and `TaskCredentials` parse a full example and refuse an unknown field.
- [ ] The runner config parses flags and environment variables with the same names `docs/configuration.md` will list (ticket 08 creates the file; add the runner lines there or in a comment ticket 08 picks up).
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add agent events and task spec schemas`.

## Comments
