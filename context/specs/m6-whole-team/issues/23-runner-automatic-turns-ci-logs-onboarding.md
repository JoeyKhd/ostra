# 23: Runner: automatic turns, CI logs and the onboarding commit

Status: done
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

- [x] Tests named `it("F-101: ...")`: a question in an automatic turn gets the neutral reply and the turn carries on; the same question in a member's turn waits for a person.
- [x] Tests named `it("F-113: ...")`: an onboarding turn that changed a lockfile and added `AGENTS.md` pushes only `AGENTS.md`; an agent commit touching other paths is rebuilt; `commit.filtered` lists what was left.
- [x] Break-it: the reply sent as a decline (spike 10's failure) fails its test; recorded in `context/proof/F-101.md`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add automatic turns and commit filters`.

## Comments
- 2026-11-20 (ticket 23, commit `✨ add automatic turns and commit filters`, after `✨ report a commit's filtered paths` in `@ostra/adapter-sdk`; ticket 22 landed as `✨ run refine and review tasks`). Built in `apps/runner` and in the host executor's commit, which `docker` and `kubernetes` run too:
  - **The automatic turn.** The session's first turn is automatic when the spec's `automatic` is true (or the dispatch's). A box's sidecar makes its own dispatch from its settings and has no `automatic`, so the spec is what it reads. A later turn is automatic when every message in it is a steer with `automatic: true`; a person's message, queued with it or steered into the running turn, makes the turn theirs. In an automatic turn, an ACP elicitation gets `NEUTRAL_REPLY` at once as an answer (every text field; a select's first option, since it can't take free text), never as a decline, and the runner emits `question.auto_answered` with the question's ID and the reply, not `question.asked`. The question's text is never logged. Approvals follow the profile's rules and wait for a person, as in any turn.
  - **CI logs.** The spec's `ci` context files are written by `writeCiFiles` (`ticket-files.ts`) as `<blobId>.log` under `.ostra/ci/`, in the folder the agent's session opens on, beside the ticket's files: plain text only, at most 5, each checked against its size and digest. Every repo's git excludes `.ostra/`, so a log never reaches a commit or the hidden ref. The round's prompt that names the paths is core's (ticket 18, `roundFraming`). The ticket files' `ticket.files_ready` leaves the CI files out.
  - **`commitPaths`.** The host executor's commit (`#commitAllowed`) stages only the allowed paths' changes in each repo and leaves the rest in the working tree. When the branch's own commits since its base touch another path, its tip is rebuilt as one commit on the base: a mixed reset to the merge base keeps every change in the tree, and only the allowed ones are committed again, with the runner's message. A repo with nothing allowed isn't ahead, so it isn't pushed. `CommittedRepoWork` and `RepoPushResult` gain an optional `filtered` (additive, in its own commit), and the runner emits `commit.filtered` for each repo that left something out: what the branch holds against its base, and at most 50 of the paths left, with their count.
  - **`propose_environment`** on the sidecar's MCP server forwards to core's `/environment-proposal` with the link's token, its refusals in the protocol's words. It was built in ticket 22's commit with `submit_draft` and `submit_review`, since it's the same code, and its tests are in `mcp-team-tools.test.ts`.
  - **A limit, noted in F-113.md:** the agent can still push its own commits to the task's branch through the git proxy. When the repo is ahead, the runner's forced push of the filtered tip replaces them. When nothing allowed changed, the runner pushes nothing, and such a push would stay on the branch, with no PR. Refusing an onboarding agent's own pushes would be a proxy mode of its own; I didn't add one.
  - **Test seams.** The scripted fake gains `commit` (it writes the files given and commits them itself), additive, in the `@ostra/adapter-sdk` commit.
  - **Proof.** These tests in `team-turns.host.test.ts` and `.docker.test.ts`: the automatic question; the member's question that waits, then an automatic round's on the same session, then a member's that waits again; an approval in an automatic turn that waits; only `AGENTS.md` pushed with the lockfile left in the tree; an agent commit rebuilt as one commit on the base; a repo with nothing allowed not pushed, with `commit.filtered`'s 50-path cap and count; CI logs under `.ostra/ci/`, kept out of the branch and the hidden ref. The ticket's break-it: the reply sent as a decline made the fake end its turn `cancelled`, and the automatic-question case failed. The other break-its, each restored: every steer queued as a person's; an automatic turn allowing what a rule asks; `commitPaths` ignored; no rebuild; no cap on the list; the CI files not written. Each made its case fail. The rows are in `context/proof/F-101.md` (the neutral-reply row now `proved`, so all five of F-101's rows are), `F-113.md` and `F-035.md` (still `partial` for core's, the panel's and the live parts). F-101's ledger status is left to ticket 39, which checks every row.
  - **Checks.** Typecheck and lint through turbo with `--concurrency 2` for the runner, `@ostra/adapter-sdk` and the three executors, plus a whole-repo typecheck after the additive type change. Tests of the same packages, `check:licenses`, and `check:proof` (0 errors).
