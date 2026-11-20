# 01: Protocol: minor 5

Status: done
Builder: core (contracts, first)
Blocked by: none (milestone 5's minor lands first)
Features: F-099, F-100, F-101, F-035, F-105, F-113, F-011, F-106, F-012, F-040 (their wire shapes)
Packages: `packages/protocol`
Spec: `../spec.md`, section 5.1

## What to build

Every change is additive. The schema is written once, Zod first; the types are `z.infer`. If milestone 5's minor isn't on `main` yet, this ticket waits for it, then takes the next number and writes it under `## Comments` (the spec calls it "minor 5").

- **The minor,** negotiated in `hello` and `welcome`, with the previous minor's codecs kept. A minor-4 peer never receives `review`, `tools`, `commitPaths` or `automatic`, and the server never offers it a refine, review or onboarding task: `isTaskOfferable(spec, peerMinor)` in this package says so, with the reason the dispatch note shows. A minor-3 runner is outside the window.
- **Events:** `question.auto_answered` and `commit.filtered` as runner events; the server-only kinds of spec section 5.1 added to `serverOnlyKinds`, so the gateway refuses a batch that holds one.
- **Commands:** `automatic: boolean` on `dispatch` and `steer`; the intents `fix-ci`, `fix-findings`, `changes-requested` and `linear-follow-up` on `user.message.intent` and `steer.intent`.
- **The task spec:** the optional `review`, `tools`, `commitPaths` and `automatic`; `taskSpecResponseSchemaFor(minor)` returns the shape for each minor in the window.
- **Runner HTTP** in `src/runner/http.ts`: request and response schemas for `POST /tasks/:taskId/draft`, `/review` and `/environment-proposal`, with their refusals.
- **The MCP tools** in a new `src/mcp/tools.ts`: `submit_draft`, `submit_review` and `propose_environment`, each with its input schema, its description for the agent (what it's for, the limits, that a member reads and checks what it hands in), and the result text for each refusal. The sidecar (ticket 22) and core (tickets 15, 17, 21) both import them.
- **The fixed prompts** in `src/agent/prompts.ts`: the neutral reply, and the framing lines of the `fix-ci`, `fix-findings` and `changes-requested` prompts, which put untrusted text inside a quoted block and say it is data.
- **Limits** in `limits.ts`, as spec section 5.1 lists them.
- Each schema's description says what's never logged: a draft's text, a finding's text, a log's text, a proposal's scripts, a follow-up's text.

## Done when

- [x] Tests: every new shape round-trips; the previous minor's specs still parse; a minor-4 peer's codec drops the new fields; `isTaskOfferable` refuses each new kind for a minor-4 peer and allows it for minor 5; a strict object refuses an unknown field; the server-only set includes every new server kind; each tool's schema refuses a finding over the limit, a draft over its limits and a proposal with a variable's value; the fixtures in `src/testing/` cover each new kind, command field and endpoint.
- [x] Every caller in the repo still compiles, and no existing schema changed shape.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add protocol minor 5`.

## Comments

- 2026-11-20, core: built as `✨ add protocol minor 5`. Readings and differences:
  - **The number:** `main` had milestone 5's minor 4 (`201b71aa`), so this is minor 5; the window is 4 to 6, and a minor-3 runner is refused at `hello`. Minor 4's codecs stay beside minor 5's (`taskEventSchemaV4`, `commandSchemaV4`, `taskSpecSchemaV3` for minors 3 and 4, `messageIntentSchemaV4`).
  - **`kind` inside an event:** `tracker.session_event`'s `kind` is `action`, and `round.started`'s and `round.capped`'s is `round`, since `kind` names the event in the union.
  - **The tools name a repo by `owner/name`,** as `set_pull_request_text` does; the HTTP bodies carry `repoId`. `reviewRequestFromTool` and `environmentProposalRequestFromTool` map one to the other for the sidecar (ticket 22). The endpoints' bodies are in `runner/http.ts`; the shapes, descriptions and result texts in `mcp/tools.ts`.
  - **CI logs:** a context file gains `folder: "ticket" | "ci"`, since a file name is one segment; `ci` files go under `CI_FILES_DIR` (`.ostra/ci`). A minor-4 runner is sent none.
  - **`isTaskOfferable(spec, peerMinor)`** returns the reason and the minor; `taskNotOfferableWords` is the dispatch note. A refine, review or onboarding task (a code task with `environment` or `commitPaths`), an automatic round, or a CI round's files need minor 5. `taskSpecMinMinor` folds in minors 2 and 3.
  - **The fixed prompts:** `NEUTRAL_REPLY`, `roundFraming` (opening and task lines per round kind) and `roundPrompt`, which quotes each piece of untrusted text in a marked block.
  - **Callers:** the budget gate maps `fix-ci` and `fix-findings` to `automatic-round`, and `changes-requested` and `linear-follow-up` to `message` until ticket 06 gives them their own origins; the fold and the ingest store the 16 new kinds with no row yet; the panel's intent tags gain four words. Tests that drove a minor-3 peer now run it against a minor-4 gateway (`serverMinor: 4`), and core's recorded matrix runs at `RECORDED_SERVER_MINOR`; `packages/protocol`'s matrix adds today's window over the same recordings and a synthetic minor 7.
