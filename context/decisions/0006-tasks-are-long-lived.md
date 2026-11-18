# Tasks are long-lived, and can be reopened anywhere

**Status:** accepted (plan signed off 2026-11-17). Amended 2026-11-18: the three steps are reworded for boxes (the same box while it's kept, a fresh box from the archive, then the rebuild template), and step 2 is the normal path (Q42, Q53, ADR 0039). First answered on 2026-11-17. The maintainer: "Sometimes you want to make little changes in that branch/pr/feature/ticket. Basically re-open and continue prompting." The three steps were first accepted in grilling round 2.

A task is not one run of an agent. It lives as long as its ticket's work does, and its branches, workspace, sessions and PRs stay together. Any member can reopen it at any time, also after a PR is open, and keep prompting on the same branches. New commits update the same PRs (F-032).

A box serves one task, and it stops after 15 idle minutes *(working value)*, so almost every reopen lands on a fresh box. Reopening tries three things, in order:

1. **The same box**, while it's kept: the agent resumes its own session in place.
2. **A fresh box, from the archive:** ostra starts a new box from the project's snapshot. It restores the unfinished work from the task's hidden ref and the agent's own session archive from the server, and the agent loads the session. This is the normal path.
3. **The rebuild template:** if the archive can't be restored, a fresh session starts from a fixed template: the ticket (if the task has one), the PR's text, every member message, the agent's last message and the branch's log. ostra calls no model to write it (Q53).

## Consequences

- ostra keeps every session's full history on the server, and the agent's own session archive is uploaded after every turn. Agents' own stores are tied to one machine and one folder, and Claude Code deletes transcripts after 30 days by default (`research/agent-harnesses.md`).
- A task can switch agents when it's reopened, through step 3 (F-033).
- A task holds many sessions over its life (`GLOSSARY.md`), and the history the panel shows spans all of them.
- A box can be thrown away at any time, because its task can always be rebuilt from its branches, its hidden ref, its session archive and its stored history.
- If spike 2 shows that an archive can't be restored reliably, step 3 becomes the normal path, and F-033 says so.
