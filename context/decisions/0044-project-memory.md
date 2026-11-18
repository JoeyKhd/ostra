# Project memory: notes that members approve and agents search

**Status:** accepted (2026-11-18, from the delegated answers in `context/history/answers-2026-11-18.md`). Settles Q83 to Q90 and Q92, with the fixes from the answers file's "Rounds 13 and 14: problems only". Ledger: F-109, F-110, F-111, and F-129 for what comes later. **Q91, the prior-art research, is still open.** `research/project-memory.md` doesn't exist yet. The v1 cut below stands until it does. If the research changes how notes are found, only the search changes.

Each task starts in a fresh box, so whatever one task learns is lost unless ostra keeps it. An agent's own memory belongs to one person or one machine. ostra keeps memory once per organization and once per project, for every member, runner and agent.

## What a memory note is

- **One fact per note.** For example: "regenerate the Prisma client before the API tests", or "percent math uses decimal.js, never floats".
- **Fields:** a title, a short body, a kind (convention, command, gotcha, decision, preference or term), a scope, its source (a task, a review comment or a member), its author and its status.
- **Versioned, in Postgres,** with Postgres full-text search (ADR 0017). Vector search comes only if full-text proves too weak, and it stays in Postgres with pgvector (F-129).
- **Two scopes in v1:** organization and project. A task sees both, and a project note wins over an organization note. Repo and path scopes, and personal notes, come later (F-129). Q83 listed three scopes, and Q92's v1 list had two. The v1 list stands.
- **Access follows the scope.** An organization note is visible to every member. A restricted project's notes are visible only to its members and the organization's admins (ADR 0026).

## How an agent receives it

It works the same for every agent.

1. **The index.** At session start, the box's sidecar gives the agent a short index (each note's title and one line) and the notes marked "always", as extra instructions for the session. They're never written into the repo and never committed.
2. **Search.** An **ostra MCP server** lets the agent search and read the rest, and propose new notes. It runs **in the sidecar, never in the agent's container**, with a token for that one task. No ostra credential enters the agent's container (ADR 0030).
3. **Memory is a declared agent capability** (ADR 0025). An agent without MCP gets the index only. The contract suite's scripted fake agent can declare a different set of capabilities from OpenCode's (Q45), so the case of an agent without MCP is tested.

The same MCP server carries the typed tools for refine drafts, review findings, PR text and environment proposals. ostra never calls a model itself (`project.md`), so every structured result has to come from the agent. Five features need the server, so it exists from milestone 1, where the PR's text comes through it. Memory adds its tools in milestone 4. The new dependency is `@modelcontextprotocol/sdk`, whose license is to confirm.

## Who writes

- **Members write and edit notes directly.**
- **Agents and the AI review only propose.** A member approves a proposal before any agent sees it. Ticket text and agent output are untrusted (AGENTS.md), and an unchecked note would steer every future task in the project.
- A proposal is proposed, then approved, rejected, or merged into another note. Proposals show as a count on the Memory page. They aren't amber "needs you".
- **Where proposals come from:**
  - **A standing instruction.** The agent calls the "propose a note" tool while it works. Q87 asked for a closing question at the end of every task. That costs a turn, and so tokens, on every task with no person asking, on top of the review loops (ADR 0041). So it's a profile option instead, off by default.
  - **"Remember this"** on any review comment or AI review finding, so a correction made twice becomes a rule.
  - **Decisions made in a refine conversation** (ADR 0028).

## Keeping it true

- **A secret scan runs on every note,** whoever wrote it. A hit is refused. Memory never holds credentials, and logs carry note IDs only. This is a safety rule, so it's in v1 (Q88).
- Every note links to its source and shows when it was last used. The task page lists the notes a session used and the notes it proposed.
- Every change goes to the audit log (F-073).
- **Later (F-129):** staleness checks, which flag notes that name files, commands or packages that no longer exist after a snapshot rebuild.

## Memory, repo files and the environment

- The repo's `AGENTS.md` and `CLAUDE.md` stay the repo's own. Agents read them natively.
- The environment holds the machine's setup. Memory holds what the organization and its projects have learned (ADR 0038).
- **"Promote to repo"** turns a note into a PR to `AGENTS.md`, so it helps people and tools outside ostra. **"Move to setup script"** turns a note that's really setup into environment setup. Both come later with F-129. Q92 lists neither in v1.

## Considered options

- **Only the repo's `AGENTS.md`, written by agents.** Rejected: it would put unreviewed text into commits. It also gives the organization no place to keep knowledge that belongs to no repo.
- **Each agent's own memory feature.** Rejected: it's tied to one person or one machine, and it isn't the same across agents.
- **Notes saved by agents with no approval.** Rejected: a note written from a ticket would steer every future task (Q86).
- **A closing question at the end of every task (Q87 as written).** Rejected for the cost above. It's an option on the profile.
- **Every note in every prompt.** Rejected: the index plus search keeps prompts short.
- **Vector search from the start.** Rejected: full-text comes first, and pgvector is still Postgres if it's needed.
- **A memory service or a vector database.** Rejected: Postgres is the only store an install needs (ADR 0017).
- **Repo and path scopes in v1.** Rejected: organization and project scopes cover what the first users need.

## Consequences

- **A project remembers what it learned,** which is the end of milestone 4.
- **Index and "always" notes cost tokens on every task.** The spec sets limits on both *(working values)*.
- **A note is text an agent will follow.** The secret scan, the approval step and the source link on every note are the checks that make that safe.
- **Nothing reaches memory from an agent without a person.** That is the domain model's rule for drafts and proposals.
- **The glossary** gains "Memory note" and "Proposal", and the branded IDs gain `NoteId`.
- **The research can still change the search.** Q91 stays in `open-questions.md` until it lands. It changes how notes are found, and nothing else here.
