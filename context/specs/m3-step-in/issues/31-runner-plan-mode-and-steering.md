# 31: Runner: plan mode, and steering on a real model

Status: ready-for-agent
Builder: runner
Blocked by: 01, 08
Features: F-063, F-024
Packages: `apps/runner` (`src/task-host/task-run.ts`)
Spec: `../spec.md`, section 4 ("Plan first"); ADR 0049, ADR 0032

## What to build

- **The plan turn:** when the spec's `firstTurnMode` is `plan`, start the agent in the adapter's plan mode, send the plan-mode preamble before the task's prompt, emit `turn.started { mode: "plan" }`, and at the turn's end emit `plan.proposed` with the latest plan entries and the turn's last agent message. Nothing is committed or pushed after a plan turn, and a change in the working tree after it is reported as a crash of the plan mode (`turn.failed` with the paths), never committed.
- **`plan-answer`:** `approve` switches the session to build mode (`setMode`, or the base class's relaunch with `session/load`) and prompts with the approved plan; `revise` prompts again in plan mode with the driver's request. A `plan-answer` while no plan is pending is `rejected`.
- **Steering on the real model** (ADR 0032: "milestone 3's steering test runs on the model in `model.env`"): a live test, gated on `model.env`, that sends a steer mid-turn during a tool step and checks the next model call carried it (from the key proxy's request log, by a marker, never the text), and an "Interrupt and send" that cancels within 5 s and starts the next turn with the message.
- **The steer probe** (ticket 02's port) runs here on the pinned OpenCode too, so a bump that drops `_session/steering` fails a test.
- **Intents:** a steer's `intent` is passed into `user.message`.

## Done when

- [ ] Tests: a plan turn on both fake agents and on OpenCode with the stub models changes no file and emits one `plan.proposed`; approve continues in build mode by both paths; revise stays in plan mode; the live steer and interrupt cases pass with `model.env` loaded.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add plan mode and live steering tests`.

## Decided 2026-11-19

Decided on the maintainer's delegation while preparing the build, from the open points of the milestone 3 targets (`context/brand/app-targets/m3/`) and the spec's gaps. If the maintainer disagrees with one, it goes back to `context/open-questions.md` and this section changes.

- **The plan-mode preamble, the approved plan and the revision request come from `@ostra/protocol`'s `src/agent/prompts.ts`** (Q190). The runner can't import `packages/domain`.

## Comments
