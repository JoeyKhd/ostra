# Project memory: notes that members approve and agents search

**Status:** accepted (2026-11-18, from the delegated answers in `context/history/answers-2026-11-18.md`). Settles Q83 to Q90 and Q92, with the fixes from the answers file's "Rounds 13 and 14: problems only". Ledger: F-109, F-110, F-111, and F-129 for what comes later. **Amended 2026-11-19 for milestone 4's spec** (Q201 to Q205, "Milestone 4: memory in practice" below): the secret scan, the index's limits, the memory tools, how a contradiction is found, who approves, and where "Remember this" is in milestone 4. **Amended 2026-11-19 for Q91** ("Q91: what the prior art changed", at the end), on the maintainer's delegation: the prior-art research in `research/project-memory.md` confirms the design, and its five recommendations are accepted. Only a read counts as a note's use, which changes the index's order; the secret scan also refuses model-control tokens; edits and merges check the version; each agent's own memory stays off; and the memory block names its notes as approved. The v1 cut stands.

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

The same MCP server carries the typed tools for refine drafts, review findings, PR text and environment proposals. ostra never calls a model itself (`project.md`), so every structured result has to come from the agent. Five features need the server, so it exists from milestone 1, where the PR's text comes through it. Memory adds its tools in milestone 4. The new dependency is `@modelcontextprotocol/sdk`. Its license is confirmed (Q91): MIT on npm, with the MCP project moving to Apache-2.0. Both are permissive, so it fits either license line (ADR 0048).

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
- Every note links to its source and shows when a session last read it (Q91, below). The task page lists the notes a session used and the notes it proposed.
- Every change goes to the audit log (F-073).
- **Later (F-129):** staleness checks, which flag notes that name files, commands or packages that no longer exist after a snapshot rebuild, and notes no session has read for 90 days (Q91, below).

## Memory, repo files and the environment

- The repo's `AGENTS.md` and `CLAUDE.md` stay the repo's own. Agents read them natively.
- The environment holds the machine's setup. Memory holds what the organization and its projects have learned (ADR 0038).
- **"Promote to repo"** turns a note into a PR to `AGENTS.md`, so it helps people and tools outside ostra. **"Move to setup script"** turns a note that's really setup into environment setup. Both come later with F-129. Q92 lists neither in v1.

## Considered options

- **Only the repo's `AGENTS.md`, written by agents.** Rejected: it would put unreviewed text into commits. It also gives the organization no place to keep knowledge that belongs to no repo.
- **Each agent's own memory feature.** Rejected: it's tied to one person or one machine, and it isn't the same across agents. Since Q91, an adapter also turns it off (below).
- **Notes saved by agents with no approval.** Rejected: a note written from a ticket would steer every future task (Q86).
- **A closing question at the end of every task (Q87 as written).** Rejected for the cost above. It's an option on the profile.
- **Every note in every prompt.** Rejected: the index plus search keeps prompts short.
- **Counting a note's place in the index as a use (Q202 as first written).** Rejected for Q91: the notes in the index would stay in it for good (below).
- **Vector search from the start.** Rejected: full-text comes first, and pgvector is still Postgres if it's needed.
- **A memory service or a vector database.** Rejected: Postgres is the only store an install needs (ADR 0017).
- **Repo and path scopes in v1.** Rejected: organization and project scopes cover what the first users need.

## Consequences

- **A project remembers what it learned,** which is the end of milestone 4.
- **Index and "always" notes cost tokens on every task.** The spec sets limits on both *(working values)*.
- **A note is text an agent will follow.** The secret scan, the approval step and the source link on every note are the checks that make that safe.
- **Nothing reaches memory from an agent without a person.** That is the domain model's rule for drafts and proposals.
- **The glossary** gains "Memory note" and "Proposal", and the branded IDs gain `NoteId`.
- **Q91 is settled** (below). The research changed how the index is ordered and added four guards. Nothing else here changed.

## Milestone 4: memory in practice

Added 2026-11-19 (Q201 to Q205), for milestone 4's spec. It settles what the sections above left to the spec, and changes none of them. Q91's amendment (below) changes the index's order here and adds to the secret scan.

- **The secret scan** (Q201) runs on every note and every proposal, in `packages/domain`, before anything is stored. It looks for two things: the values of the organization's own stored secrets (the environment's secrets, the providers' tokens, the MCP servers' headers), matched exactly as the snapshot scan does (ADR 0038), and a fixed list of credential shapes (GitHub, GitLab, Slack and cloud provider token prefixes, private key blocks, `Authorization:` and `Bearer` headers with a value, and URLs with a password in them). A hit refuses the save, naming the kind it found ("a GitHub token") and never echoing the value. An agent's proposal that hits is refused at the tool, and nothing is stored. No new dependency. Q91 adds model-control tokens to the shapes (below).
- **Who writes and approves** (Q201). Any member who can open the project writes, edits and approves that project's notes and proposals; any member of the organization does the same for organization notes (F-109). Archiving or deleting a note someone else wrote needs a project admin, or an organization admin for an organization note: that is what F-087's "a project admin edits its memory" covers. Every change is an audit entry by note ID (F-073).
- **The index and the "always" notes** (Q202). At most 100 notes and 8 KiB in the index, and 8 KiB of "always" notes *(working values)*. Project notes come before organization notes, then by the last time a session read them, then by the last edit (Q91, below; first written as "by the last time a task used them"). What doesn't fit is left out, and the index ends with "N more notes: search with `memory_search`". They reach the agent with the profile's instructions, in the task's own config folder (ADR 0049), never in a repo, and a contract case checks that `git status` in every repo is clean after launch. A runner on protocol minor 2 gets them folded into the instructions it already knows, and no tools.
- **The memory tools** (Q203), on the sidecar's ostra MCP server that milestone 1 built for the PR's text: `memory_search { query, limit }` (at most 20 results: a note's ID, title, one line, kind and scope), `memory_read { noteId }` (the note in full) and `memory_propose { title, body, kind, scope, relatesTo?, relation? }`. The sidecar forwards each to core over the runner's HTTP, with the task's token, so the agent holds no ostra credential (ADR 0030). A task proposes at most 20 notes *(working value)*. Every note the session saw through the index, the "always" list, a search result it then read, or a read, is recorded once per session, and the task page lists them. Only a read, or a search result the agent then read, moves the note's last use (Q91, below).
- **A contradiction** (Q204) is found two ways, and neither calls a model (`project.md`): the agent says so (`relatesTo` a note's ID, with `relation: "contradicts"` or `"refines"`), and ostra shows the three notes whose text ranks highest against the proposal's. The member sees them beside it and decides: approve as a new note, approve and archive the old one, merge into the old one (its new version, edited by the member, with the proposal as its source), or reject.
- **"Remember this" in milestone 4** (Q205) is on a diff comment (F-072) and on an accepted `@ostra` PR comment (F-053) in the thread. AI review findings get it with the AI review in milestone 6 (F-100), so F-111 stays `building` until then.
- **The closing turn** is a profile switch, "Ask what the next task should know", off by default. When it's on, after the session's last turn with changes, one more turn asks the agent to propose notes, and nothing else. It goes through the budget gate (ADR 0055) like any turn.

## Q91: what the prior art changed

Added 2026-11-19 on the maintainer's delegation, from `research/project-memory.md`, which read Devin, Cursor, GitHub Copilot, Windsurf, Augment, Claude Code, Anthropic's memory tool and Managed Agents memory, the other agents ostra drives, and the open-source memory projects. It found two layers everywhere: one that people write and review (rules, `AGENTS.md`, skills), and one that the agent writes. The vendors tell teams to keep what must hold in the reviewed layer, and team memory is moving there: Devin's organization Knowledge into Skills, Cursor's Memories into Rules. Copilot Memory is the one shared memory that agents write without approval, and it needs a secret scan, a model-control-token filter, citations, votes and expiry to keep it honest. Anthropic tells Managed Agents users to mount memory read-only when the agent reads untrusted input. ostra's approved notes are the reviewed layer for what no repo holds, so the design stands. Five changes, all accepted:

1. **Only a read counts as a note's use.** Every `memory.used` is still stored as a `MemoryUse` row, so the task page lists what a session saw. A note's `lastUsedAt` and `useCount` move only for `via: "read"` and `via: "search"` (a search result the agent then read), never for `via: "index"` or `via: "always"`. The index is ordered project notes first, then by last read, newest first, then by last edit for notes never read. *Why:* when the index counts as a use, every note in it is "used" by every session, so the index keeps its own notes and a note past the cut comes back only through search. Copilot's expiry has the same rule: "simply retrieving a memory does not reset this period". This replaces Q202's first order (above).
2. **The secret scan refuses model-control tokens.** Beside Q201's credential shapes, a short fixed list of chat-template and role markers (for example `<|im_start|>`, `<|endoftext|>`, `<|start_header_id|>` and `</system>`) is refused the same way, on notes and proposals alike, naming the kind ("a model-control token") and never echoing it. Approval stays the main defense, and this catches what a member skimming a long proposal might miss. Copilot "can reject memories that contain recognized model-control tokens, as a defense against prompt injection". No new dependency.
3. **Edits and merges check the version.** Saving an edit to a note, and "Merge into …", carry the version the member opened. When the note has moved on since, the change is refused with `CONFLICT`, and the panel keeps the member's text to apply again. Anthropic's memory stores take a `content_sha256` precondition for the same reason, and Devin rejects a stale write.
4. **Each agent's own memory stays off.** The agent interface says an adapter turns its agent's native memory off at launch, so nothing an agent writes for itself outlives the task or skips approval. On `host` (ADR 0029), Claude Code's auto memory in `~/.claude/projects/<project>/memory/` would otherwise carry from task to task on one machine, unreviewed, which breaks runner parity. The Claude Code adapter sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. OpenCode documents no memory feature, so its adapter has nothing to turn off and says so. A contract case checks the rule once an agent with native memory ships.
5. **The block names its notes as approved.** The standing instruction says the notes are the organization's and the project's approved notes, and each note in the block carries its source. When the code disagrees with a note, the agent proposes with `relation: "contradicts"` instead of following it. That is Copilot's downvote, with a member deciding (Q204).

**Unchanged:** what a note is, the two scopes, who writes and approves, where proposals come from, the index plus full-text search (no product the research read requires vector search), and the v1 cut (Q92). Nothing argues for moving an F-129 item into v1.

**Later, added to F-129:** flag a note no session has read for 90 days *(working value)*, which needs change 1, and never delete it, since a member approved it; optional file citations on a note, tested by F-129's staleness check after a snapshot rebuild; consolidation as an ordinary agent task that only proposes merges and archives, since every vendor's "dreaming" pass is a model call and ostra calls none; and repo scope, the first pressure point now that a project can have up to 10 repos (Q206).

**Where it lands in milestone 4:** tickets 02 (change 4), 06 (changes 1, 2 and 5), 07 (change 4's statement), 15 (change 1), 16 and 29 (change 3), 38 (change 3, and "last used" meaning last read), and the spec's sections 2, 3, 4, 5, 9.1 and 11.
