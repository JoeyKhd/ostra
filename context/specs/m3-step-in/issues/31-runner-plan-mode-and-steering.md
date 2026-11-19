# 31: Runner: plan mode, and steering on a real model

Status: done
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

- [x] Tests: a plan turn on both fake agents and on OpenCode with the stub models changes no file and emits one `plan.proposed`; approve continues in build mode by both paths; revise stays in plan mode; the live steer and interrupt cases pass with `model.env` loaded.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add plan mode and live steering tests`.

## Decided 2026-11-19

Decided on the maintainer's delegation while preparing the build, from the open points of the milestone 3 targets (`context/brand/app-targets/m3/`) and the spec's gaps. If the maintainer disagrees with one, it goes back to `context/open-questions.md` and this section changes.

- **The plan-mode preamble, the approved plan and the revision request come from `@ostra/protocol`'s `src/agent/prompts.ts`** (Q190). The runner can't import `packages/domain`.

## Comments

- 2026-11-19: done in `✨ add plan mode and live steering tests`, after `✨ add the refused-plan re-prompt` (`PLAN_MODE_REFUSED_LINE` in `@ostra/protocol`, additive). The runner starts a plan-first task's first session in plan mode, sends the preamble, says `turn.started { mode }`, and after the turn sends one `plan.proposed` (the turn's latest `plan.updated` entries and its last agent message); nothing of a plan turn is committed or pushed, and a change it left in the working tree (each repo's `git status`, through the executor's `runAgentCommand`, so `docker` too) is `turn.failed` with the paths, the session crashes and its box isn't kept (`apps/runner/src/task-host/task-run.ts`). `plan-answer` approves (`setMode`, or the base class's relaunch, which the runner now provides) or revises; with no plan waiting it's `rejected`. Proved on both fake agents (`plan-mode.test.ts`), on the pinned OpenCode with the stub models (`plan-mode.opencode.test.ts`, which also holds the steer probe), and live on the model in `model.env` (`steering.live.test.ts`; its run is `apps/runner/evidence/f-024-steering-live.txt`: the steer reached the next model call, an interrupt cancelled in 102 ms). Break-it checks in `context/proof/F-063.md` and `F-024.md`. Three things to know:
  - **An agent that ends its turn on a refused request** (OpenCode, the `plain` fake: no reject-and-continue) would otherwise end a plan turn with nothing to propose. The runner re-prompts with `PLAN_MODE_REFUSED_LINE`, at most three times, and the plan carries over, so there's still one `plan.proposed`.
  - **Intents:** `user.message` is core's (`member-message.ts` writes the intent); the runner only names a steer's intent in its log line, never the text.
  - **The live test** sits a recorder in front of the provider that keeps each call's time, whether it offered tools and which marker it held, never a body; the key proxy needs no request log of its own.
