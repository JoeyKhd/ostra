# Tasks are long-lived, and can be reopened anywhere

**Status:** accepted (plan signed off 2026-11-17). First answered on 2026-11-17. The maintainer: "Sometimes you want to make little changes in that branch/pr/feature/ticket. Basically re-open and continue prompting." The three steps below were accepted in grilling round 2.

A task is not one run of an agent. It lives as long as its ticket's work does, and its branch, workspace, sessions and PR stay together. Any member can reopen it at any time, also after the PR is open, and keep prompting on the same branch. New commits update the same PR (F-032).

Reopening tries three things, in order:

1. **Same runner:** the agent resumes its own session.
2. **Another runner:** ostra restores the session's full history from the server, if the agent can load one.
3. **Otherwise:** a fresh session starts from the ticket, a summary of the history so far, and the branch.

## Consequences

- ostra keeps every session's full history on the server. Agents' own stores are tied to one machine and one folder, and Claude Code deletes transcripts after 30 days by default (`research/agent-harnesses.md`).
- A task can switch agents when it's reopened, through step 3 (F-033).
- A task holds many sessions over its life (`GLOSSARY.md`), and the history the panel shows spans all of them.
- A workspace can be cleaned up at any time, because its task can always be rebuilt from its branch and history.
