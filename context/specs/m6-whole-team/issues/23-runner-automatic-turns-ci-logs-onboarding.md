# 23: Runner: automatic turns, CI logs and the onboarding commit

Status: ready-for-agent
Builder: runner
Blocked by: 01, 09
Features: F-101, F-035, F-113
Packages: `apps/runner` (`src/task-host/`, `src/sidecar/mcp-tools.ts`)
Spec: `../spec.md`, sections 4 ("A round", "The onboarding task") and 5.1

## What to build

- **The automatic turn:** a turn whose `dispatch` or `steer` carries `automatic: true` answers every ACP elicitation with `@ostra/protocol`'s neutral reply, at once and never as a decline, and emits `question.auto_answered` with the question's ID (not its text) and the reply. Approvals in an automatic turn still follow the profile's rules and wait for a person, as in any turn.
- **CI logs:** `contextFiles` under `ci/` are written into the task's config folder (milestone 2's ticket files), never into a repo; the prompt names their paths.
- **`commitPaths`:** after every turn, in each repo, the runner commits only paths that match; when the branch's diff against its base touches anything else (the agent committed it, or it's left in the tree), the runner rebuilds the branch's tip as one commit on the base with the allowed paths' content, leaves the rest in the working tree, and emits `commit.filtered`. A repo with nothing allowed changed isn't pushed.
- **`propose_environment`** on the sidecar's MCP server, forwarded to `/environment-proposal` like the other tools.

## Port from

`spikes/is-opencode-good-enough/` (the question case), through ticket 04's suite.

## Done when

- [ ] Tests named `it("F-101: ...")`: a question in an automatic turn gets the neutral reply and the turn carries on; the same question in a member's turn waits for a person.
- [ ] Tests named `it("F-113: ...")`: an onboarding turn that changed a lockfile and added `AGENTS.md` pushes only `AGENTS.md`; an agent commit touching other paths is rebuilt; `commit.filtered` lists what was left.
- [ ] Break-it: the reply sent as a decline (spike 10's failure) fails its test; recorded in `context/proof/F-101.md`.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add automatic turns and commit filters`.

## Comments
