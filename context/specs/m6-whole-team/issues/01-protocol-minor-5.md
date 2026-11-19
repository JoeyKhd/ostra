# 01: Protocol: minor 5

Status: ready-for-agent
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

- [ ] Tests: every new shape round-trips; the previous minor's specs still parse; a minor-4 peer's codec drops the new fields; `isTaskOfferable` refuses each new kind for a minor-4 peer and allows it for minor 5; a strict object refuses an unknown field; the server-only set includes every new server kind; each tool's schema refuses a finding over the limit, a draft over its limits and a proposal with a variable's value; the fixtures in `src/testing/` cover each new kind, command field and endpoint.
- [ ] Every caller in the repo still compiles, and no existing schema changed shape.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add protocol minor 5`.

## Comments
