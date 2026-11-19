# 37: Reopening a task on another agent (F-033)

Status: wontfix
Note: Won't do now (2026-11-19): Claude Code (F-018) moved after v1 (the maintainer: "perhaps we can just skip Claude Code with its ACP for now"), and milestone 7 is the launch alone, on OpenCode. Reopening on another agent needs a second agent; F-033's note says the clause waits with F-018. This ticket waits for F-018 after v1; its text stays as written for then (ADR 0062, postponed).
Builder: core
Blocked by: 03, 05, 07
Features: F-033 ("with another agent"), F-018
Packages: `packages/domain`, `apps/core` (the reopen path), `packages/api` (`tasks.reopen`), `apps/web` (the reopen sheet), `packages/adapter-sdk` (`src/testing/agent-suite.ts`)
Spec: `../spec.md`, sections 2, 3 (step 5) and 6; ADR 0039; ADR 0006
Note: added by the spec's review. F-033's "done when" says a task can be reopened "with another agent", and milestones 2 and 4 left that clause for F-018 (`specs/m2-tickets-in/spec.md`, F-033's row; `specs/m4-the-organization/spec.md`, "Rows this milestone touches"). The spec as first written didn't plan it.

## What to build

- **Reopen with a profile:** the reopen sheet and `tasks.reopen` take a profile the member may use, of either agent, and the domain checks it as `saveAgentProfile` does (the model's format, the member's access). The default is the task's own profile, as today.
- **The restore step on another agent:** one agent's session archive means nothing to another, so a reopen on a profile of a different agent skips the same-box and archive steps of ADR 0039 and starts from the rebuild template, on the same branches and PRs, with the hidden ref's working tree restored as for any fresh box. The task page names the change ("Reopened on Claude Code; it starts from the task's history, not the agent's own session").
- **The other agent's archive is kept**, never imported, so a later reopen back on the first agent can still use it if its box or archive is there.
- **The other-agent case** in the agent suite: a task worked by one adapter, reopened on the other, both ways (OpenCode to Claude Code, and back), on the stub model.

## Done when

- [ ] Tests named for `F-033`: a reopen on another agent's profile uses the rebuild template and never the first agent's archive, both ways; it pushes to the same branches and updates the same PRs; a profile the member can't use, or whose model the agent can't take, is refused (break-it: the archive step not skipped fails, an archive of the wrong agent reaching `importSession`).
- [ ] The rows of `context/proof/F-033.md` (written with `pnpm proof:new F-033` if milestone 2 hasn't) for "with another agent" cite these tests, and part A step 5's last reopen is its live evidence (ticket 32).
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✨ reopen a task on another agent`.

## Comments

- 2026-11-19, lead: set `wontfix`. Claude Code (F-018) moved after v1 on the maintainer's word, and this ticket waits for it.
