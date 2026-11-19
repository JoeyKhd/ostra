# Research: project memory for coding agents

**Status:** Research v1 · **Checked:** 2026-11-19 (every source below was read on this date unless marked) · **Informs:** Q91, ADR 0044, F-109, F-110, F-111, F-129, Q83 to Q92, and milestone 4's memory tickets (02, 07, 15, 16, 20, 29, 38 in `specs/m4-the-organization/issues/`)

**Question (Q91):** how do Devin, Cursor, GitHub Copilot, Windsurf, Augment, Claude Code and Anthropic's API memory tool handle memory? For each: how memory is captured (by the agent, by the user, or proposed and then approved), who approves it, its scope, how agents retrieve it and how much, how stale or wrong memories are found or expired, and how each guards against prompt-injection poisoning. Also: the open-source building blocks and their licenses.

Facts come from the vendors' own docs, changelogs, READMEs, license files and package registries. An earlier run downloaded some of these pages; each one was fetched again from its vendor on 2026-11-19 and compared before it was used here. **Unverified** marks anything not confirmed from a primary source. **Secondary** marks a vendor forum reply, which is the vendor's staff speaking but not its documentation. Recommendations are marked as such and are not decisions.

---

## Summary

- **Every product has two layers, and they've converged.** A layer people write and review (rules, `AGENTS.md`, `CLAUDE.md`, custom instructions, skills, Knowledge) and a layer the agent writes on its own (Memories, auto memory, Copilot Memory). Each vendor tells teams to keep anything that must hold in the reviewed layer: Copilot ("To provide instructions consistently, use custom instructions instead"), Windsurf ("For knowledge you want Cascade to reliably reuse, write it as a Rule or add it to AGENTS.md"), Codex ("Keep required team guidance in `AGENTS.md`") and Claude Code (both layers are "context, not enforced configuration").
- **Agent-written memory is moving to the user, and team memory is moving to reviewed files.**
  - Devin retired its organization-wide Knowledge for Skills (migration from 2026-09-18). Its new Memory, which Devin writes itself, is **personal**: "not shared with your teammates or your organization".
  - Cursor shipped Memories in 1.0, added "user approvals for background-generated memories to preserve trust" in 1.2, and removed the feature in 2.1.x, telling users to export them into Rules *(secondary)*.
  - Windsurf's auto-generated memories stayed on one machine and one workspace. Its successor, Devin Local, "replaces memories and workflows with rules and skills".
- **GitHub Copilot Memory is the one shared, agent-written memory at scale, and it's the most defended.** Repository facts are shared with collaborators. Copilot writes them with no approval step in the cloud agent and code review. The defenses:
  - a secret scan that rejects a memory with a secret in it
  - rejection of "recognized model-control tokens, as a defense against prompt injection"
  - citations to code, which Copilot checks "against the current branch" before it uses a fact
  - internal up- and down-votes
  - expiry after 90 days without an upvote (7 to 180 days by policy), where "simply retrieving a memory does not reset this period"
  - audit-log entries by event, never by content
- **Approval before use exists, but only for one person at a time.** Devin's Knowledge suggestions (edit or dismiss), Devin's skill suggestions (a "Create PR" button), Cursor 1.2's approvals, Copilot CLI's interactive approval, and Augment's interactive Experts ("so you can correct or veto it") all ask the person in the session. None of them queues a proposal for a team to approve before any agent sees it, which is what ADR 0044 does.
- **Anthropic's own docs name the attack ADR 0044 designs against.** Managed Agents memory stores attach `read_write` by default, and the docs warn: "a successful prompt injection could write malicious content into the store. Later sessions then read that content as trusted memory. Use `read_only` for reference material". ostra's notes are read-only to agents, which is that advice.
- **Retrieval is the same pattern everywhere: a short index always loaded, the rest read on demand.**
  - Claude Code loads the first 200 lines or 25KB of `MEMORY.md`, and topic files on demand.
  - Devin's Memory loads `MEMORY.md`. Devin's skills put each name and description in every session, and the body when invoked.
  - Letta loads root memory files on every turn and leaves directories with their own `MEMORY.md` out until needed.
  - VS Code loads the first 200 lines of user memory.

  Most find the rest with plain file search. Letta's MemFS "does not include a semantic or vector index by default". No coding-agent product here makes vector search a requirement.
- **Staleness is found three ways:** citations checked against the code (Copilot), expiry without reinforcement (Copilot, 90 days), and a background consolidation pass that a model runs (Devin's and Letta's "dreaming", Anthropic's Dreams, Agent Memory Repo). Devin's dreaming "removes transient details and stale notes that no session has used". Anthropic's Dreams write a **new** store and never modify the input, "so you can review the output and discard it".
- **Every consolidation pass calls a model on the vendor's side.** So do Mem0's extraction and Graphiti's graph building. ostra never calls a model (`project.md`), so consolidation in ostra can only be an agent task that proposes changes.
- **The agents ostra drives keep their own memory off when they run headless.**
  - Claude Code: "a session in a self-hosted environment runs with auto memory off by default".
  - Copilot CLI: programmatic sessions are off unless `--enable-memory` is passed.
  - Codex: local memories "are off by default".
  - OpenCode's docs list no memory feature.
- **Open-source building blocks** mostly come with licenses ostra could use, but the ones read here each bring a store, a model or both that ADR 0017 and `project.md` rule out:
  - **Apache-2.0:** Letta (now `letta-code`), Mem0, Graphiti, `claude-mem`, cognee, `mcp-memory-service`.
  - **MIT:** LangMem, Supermemory, Agent Memory Repo.
  - **MIT, moving to Apache-2.0:** the MCP reference memory server and the MCP TypeScript SDK.
  - **AGPL-3.0:** Basic Memory.
- **For ostra: Q91 changes nothing in ADR 0044's design, and one detail of the index's order.** The design matches the safest prior art, with one gap: `memory.used` with `via: "index"` updates a note's `lastUsedAt`, so every note in the index looks used in every session, and the index's order reinforces itself. Copilot's rule is the fix: count only reads. That, plus four smaller refinements, is in [What this means for ostra](#what-this-means-for-ostra).

---

## Comparison

| | Who captures | Who approves | Scope | Retrieval and limits | Stale or wrong | Injection guard |
|---|---|---|---|---|---|---|
| **Devin Memory** | Devin, on its own | Nobody. An "Updated memory" card shows the change | Personal, per organization. A Bot's memory is shared by its users | `MEMORY.md` at start; other notes searched and read | Daily "dreaming": merges notes and removes stale ones no session used. Each entry carries `[source: …; added: …]` | Secrets "not saved"; automations don't read or write memory |
| **Devin Knowledge** (deprecated) | Members; Devin suggests | The member edits or dismisses the suggestion | Organization, enterprise; pinned to no repo, one repo or all repos | Retrieved by its trigger description; pinned to a repo means always | Manual; per-user enable or disable | Not documented |
| **Cursor Memories** (removed) | Cursor, in the background | User approval from 1.2 | Per project, per individual | Not documented | Not documented | Approval "to preserve trust" |
| **Cursor Rules** | People | Review of the repo or the dashboard | Team, project, user; `AGENTS.md` nested | Always, by description, by glob or by mention; under 500 lines advised | Manual | Team Rules can be enforced |
| **Copilot Memory** | Copilot, as it works; or asked; or a JSONL import | None in cloud agent and code review; optional in the CLI and the app | Repository facts (shared) and user preferences | Relevance; upvoted memories more likely to be sent | Citations checked; votes; expiry 90 days (7 to 180) | Secret scan; model-control tokens rejected; audit without content |
| **Windsurf Cascade** | Cascade, or asked | Nobody | One workspace on one machine | Retrieved when Cascade thinks it relevant; rules: 6,000 characters global, 12,000 per workspace file | Not documented | Not documented |
| **Augment Experts** | The Expert; Code Review Memory from review signals | The user can veto in interactive sessions | The Expert's team; one scope per repo, or global, channel, project or user | Loaded at the start of relevant work | Noisy evidence must recur before it's promoted; contradictions flagged | Weighted evidence; human feedback counts most |
| **Claude Code** | People write `CLAUDE.md`; Claude writes auto memory | Nobody for auto memory | Managed, user, project, local; auto memory per repo, per machine | All `CLAUDE.md` above the working directory; `MEMORY.md` first 200 lines or 25KB | `modified` timestamp; reminders to merge or drop stale entries | Auto memory off in self-hosted sessions; a repo can't redirect it without trust |
| **Memory tool (API)** | Claude, through tool calls | Your application | Whatever your handler maps `/memories` to | Claude views the directory first; you cap sizes | "Periodically delete memory files that haven't been accessed" | Path traversal checks; strip sensitive data |
| **Managed Agents memory stores** | The agent, through its file tools; or the API | Your application | Workspace; up to 8 stores per session, `read_only` or `read_write` | Mounted under `/mnt/memory/`; 100 kB a memory, 10,000 a store | Versions; Dreams write a new store to review | Warns about injection; `read_only` advised |

---

## 1. Devin

Devin has three mechanisms today: **Memory** (new, personal, written by Devin), **Knowledge** (deprecated, organization-wide, written by people) and **Skills**, which Knowledge is migrating into. `AGENTS.md` is read too.

### 1.1 Memory and Dreaming

Source: [Devin Memory and Dreaming](https://docs.devin.ai/product-guides/memory), launched 2026-10-09 ([release notes](https://docs.devin.ai/release-notes/overview)).

- **Captured by Devin, on its own.** "Devin saves these on its own as you work, so you don't have to stop and write them down." It edits a note "when you correct Devin, explain a preference, or it works out something reusable".
- **Scope: personal.** "Memory is **personal to you** within each organization. It is not shared with your teammates or your organization." A [Devin Bot](https://docs.devin.ai/work-with-devin/bots) keeps its own memory, which "everyone who can use the Bot shares". People who can configure the Bot can delete a memory file.
- **Storage:** "a persistent Git repository of Markdown notes", with `MEMORY.md` for general preferences and topic files beside it. Each entry is "a one-line bullet tagged with the ID of the session where it was learned", e.g. `[source: 3f9c…; added: 2026-10-05]`.
- **Retrieval:** "Each session gets its own checkout of the drive and receives `MEMORY.md` as context. Devin searches and reads the other notes only when the task needs them."
- **Writes:** Devin commits, merges changes from other sessions and saves. "A stale write is rejected and retried, and conflicting edits are resolved rather than overwritten." An **Updated memory** card in the session shows what changed. "New memories apply to future sessions, not the one that wrote them."
- **What it won't save:** session summaries, task state such as PR numbers, "anything cheap to rediscover", and "secrets and credentials".
- **No approval.** Memory files "are read-only in the app". To change one, the user asks Devin in a session ("forget that I prefer npm").
- **Dreaming** runs "about once a day". It "consolidates overlapping notes", "removes transient details and stale notes that no session has used", "adds useful lessons that weren't captured during the original work" and reorganizes. "Source links and explicit preferences are preserved." It can be turned off, separately from Memory.
- **Admin controls:** on by default; an organization switch; enterprise "Default on / Default off / Always on / Always off". Since 2026-11-06 the v3 API takes `memory_enabled: false` per session ([release notes](https://docs.devin.ai/release-notes/overview)).
- **Injection:** the page names no guard beyond the secrets rule. "Sessions started by automations don't read or write your memory."
- **Open format:** Devin's memory is built on [Agent Memory Repo](https://github.com/AgentMemoryRepo/agentmemoryrepo) (MIT), a spec for memory as a Git repo with a `MEMORY.md` entry point, one-line entries with `[source: …; added: …]` metadata, and `[[path]]` links. Its loop is "Clone, Grep, Update entries as the agent learns, with no human in the loop, Push after every edit". Its own Dreaming merges duplicates, removes outdated entries and checks sources "to resolve contradictions".

### 1.2 Knowledge (deprecated) and Skills

Source: [Knowledge](https://docs.devin.ai/product-guides/knowledge), [Skills](https://docs.devin.ai/product-guides/skills), release notes for 2026-06-17, 2026-09-18 and 2026-11-16.

- **Deprecated.** "Knowledge is deprecated and will be removed in a future update. Existing Knowledge is being migrated to Skills in Plugins automatically." The release note of 2026-09-18 says notes become skills "in a `knowledge` plugin for each scope (organization, enterprise, or personal), with their content unchanged".
- **Capture: people, with suggestions from Devin.** "Devin will automatically suggest Knowledge to remember based on your feedback in chat. Edit the suggested Knowledge before saving, or dismiss the Knowledge if it's not helpful." Devin "can also suggest updates to existing knowledge items". Since 2026-06-17 a suggestion shows as a standalone event in the session's worklog.
- **Approval:** the person who sees the suggestion saves or dismisses it. The organization's Knowledge page has a **Suggestions** tab. Editing migrated organization skills needs an organization admin or "the **Manage Knowledge** permission"; enterprise skills need an enterprise admin.
- **Scope:** organization (visible to all members, the default), enterprise (across all organizations, managed by enterprise admins), and **Promote to Enterprise** for an item that proved useful. Each item can be pinned to no repo, one repo or all repos.
- **Retrieval:** each item has a required **trigger description**. "Devin retrieves Knowledge when relevant, not all at once or all at the beginning." Pinned to a specific repo, it "is always used whenever Devin is working in that specific repo". Each item can be enabled or disabled per user, and folders can be toggled in bulk. The enterprise limit was raised from 200 to 300 items on 2026-06-17.
- **Skills** replace it. "At the start of every session, Devin sees a list of all available skills (name + description). When a skill is invoked, Devin reads the full `SKILL.md`." Devin also **suggests skills**: "a summary of what was learned", "the proposed `SKILL.md` file contents" and "a **Create PR** button to commit the skill to your repo".
- **`AGENTS.md`:** "Devin automatically includes up to 16 KiB (16,384 bytes) from the beginning of each `AGENTS.md` file in its context", with a truncation notice beyond that ([AGENTS.md files for Devin](https://docs.devin.ai/onboard-devin/agents-md)).

## 2. Cursor

### 2.1 Memories (removed)

- **1.0, 2025-06-04:** "With Memories, Cursor can remember facts from conversations and reference them in the future. Memories are stored per project on an individual level, and can be managed from Settings." Beta, enabled from Settings → Rules ([changelog 1.0](https://cursor.com/changelog/1-0)).
- **1.2, 2025-07-03:** "Memories is now GA. Since 1.0, we've improved memory generation quality, added in-editor UI polish, and introduced user approvals for background-generated memories to preserve trust" ([changelog 1.2](https://cursor.com/changelog/1-2)).
- **2.1.x, late 2025:** removed. *(Secondary: forum replies, not documentation.)* A Cursor forum reply on 2025-11-25: "The Memories feature was intentionally removed starting from version 2.1.x. You can export your memories and move them into Rules", through the "Export memories" command, which writes an `.mdc` file ([forum](https://forum.cursor.com/t/are-my-memories-gone/144057)). A user reports Memories gone from settings after 2.1.17 ([forum](https://forum.cursor.com/t/agents-have-lost-access-to-memory-capability/143310)). The [2.1 changelog](https://cursor.com/changelog/2-1) (2025-11-21) doesn't mention it.

### 2.2 Rules

Source: [Rules](https://cursor.com/docs/rules).

- **Kinds:** Project Rules (`.mdc` files in `.cursor/rules`), User Rules, Team Rules and `AGENTS.md` (root and nested; "more specific instructions taking precedence").
- **Activation:** "Always Apply", "Apply Intelligently" ("when Agent decides it's relevant based on description"), "Apply to Specific Files" (globs) and "Apply Manually" (@-mention). "Keep rules under 500 lines."
- **Team Rules:** managed from the dashboard on Team and Enterprise plans. "Admins can configure whether or not each rule is required for team members." With **Enforce this rule**, "the rule is required for all team members and cannot be disabled". Precedence: "Team Rules → Project Rules → User Rules". The page adds: "AI guidance should not be your only security control."

### 2.3 The Agent SDK's memory hook

Source: [Agent SDK: Memory](https://cursor.com/docs/agent-sdk/reference/memory). Its import path is `@grok/agent-sdk/memory`.

- A hook "appends one record per turn to a journal" (`memory/journal.jsonl`), and the model reads it with its file tools. "The model has no recall tool."
- Its caveats are the poisoning case stated plainly: "All sessions and users share one journal, so one person's messages can surface in another's session", and "Anyone who can message the agent writes to the journal, so keep the scaffolded rule against following instructions found in records." The scaffolded instructions tell the model "to treat records as untrusted history".

## 3. GitHub Copilot Memory

Sources: [About GitHub Copilot Memory](https://docs.github.com/en/copilot/concepts/agents/copilot-memory), [Manually creating memories](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/copilot-memory/create-memories), [Managing Copilot Memory for an enterprise, organization, or repository](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/copilot-memory/manage-as-administrator), [Use memory with agents in VS Code](https://code.visualstudio.com/docs/agents/run/memory).

- **Two kinds.** "Repository-level facts describe a codebase and are shared with your collaborators." "User-level preferences describe how you personally like to work and follow you between repositories." Copilot picks the kind "based on who the memory applies to rather than on who stated it"; "if your intent is ambiguous, Copilot asks you to clarify the scope".
- **Capture: Copilot, on its own.** "Copilot creates memories itself, as a byproduct of working with you." Users can state a fact, ask Copilot to remember, or import JSONL with Copilot CLI (`copilot memories import`; every record needs `scope`, `subject`, `fact`, `reason` and `citations`). Asking "does not guarantee that it will be stored. The model decides".
- **Who can create a repository fact:** users with write access who have Copilot Memory enabled. Forks don't copy memories. Facts "are not pooled across an organization's repositories".
- **Approval:** "In the Copilot app, and Copilot CLI interactive sessions, Copilot can ask you to approve storing a memory. Copilot cloud agent and Copilot code review do not ask for this approval." In the CLI the user can approve once, reject with feedback, or allow future updates for the repository, directory or session. "Running the import command is treated as approval." "In Copilot CLI, only the root agent can use `store_memory` or `vote_memory`"; subagents only read.
- **Nobody edits a memory.** "You cannot directly create or edit an individual memory in the settings on GitHub.com." Users with write access can view and delete repository facts. Asking Copilot to "forget" only downvotes.
- **Shared across surfaces:** the app, the CLI, code review, the cloud agent, Agentic Autofix, Mobile, Slack and Teams. "If Copilot code review learns that certain settings must stay synchronized across two files, Copilot cloud agent will know to update both files." Code review and Autofix "never apply stored user-level preferences".
- **Retrieval:** "Not all memories from the memory store are sent to a model with your prompt. Upvoted memories are more likely to be sent." No size is published. Memories in context count toward token use and AI credits.
- **Staleness:**
  - Copilot "checks the fact's citations against the current branch to judge whether the information is still accurate". GitHub adds that "a stored fact should not be relied on as a rule that will always be followed", and that facts can come from PRs "closed without merging".
  - "It can upvote a memory that it's able to validate, and downvote a memory if it's found to be wrong or outdated." Votes are hidden; the settings list is ordered by them.
  - **Expiry:** "stored repository facts and user preferences expire after a period without reinforcement. … Simply retrieving a memory does not reset this period." The default is 90 days. Owners can set 7 to 180 days for repository facts, and the lower of an organization's and its enterprise's value wins. "Downvoting a memory does not alter the period remaining."
- **What it stores per memory:** text, subject area, agent, model, billing entity, citations, reason, voting data and expiry. The last four aren't displayed.
- **Injection and secrets:**
  - "Memories are checked for secrets, such as tokens, keys, or credentials. Memories in which a secret is detected are rejected and are not stored."
  - "The system can reject memories that contain recognized model-control tokens, as a defense against prompt injection."
  - Copilot "is instructed not to store sensitive personal information" or "short-lived or task-specific instructions".
- **Audit:** created and deleted memories are audit-log entries (`copilot.memory_created`). They "never contain the content of a memory, its citations, or the reason". "Retrieving a memory, voting on it, or its automatic expiry does not create a memory lifecycle audit event."
- **Governance:** separate organization controls for **User memories** and **Repository memories** (all, selected or no repositories). A repository admin can turn repository facts off. Administrators can export or delete members' preferences.
- **Defaults:** on for Pro, Pro+ and Max; for Business and Enterprise, user preferences are off until an owner enables them, while repository memories default to **All repositories**. Copilot CLI's programmatic sessions are "Off. Use `--enable-memory` for each run."
- **VS Code:** the same cloud service for the Copilot harness. An experimental option stores repository facts in `.github/copilot-memories.jsonl`, and the docs warn that "cloud-memory settings and organization policies on GitHub don't apply" and that the file "can be included in commits, including commits made by the agent". VS Code's local harness keeps files under `/memories/` (user, repo, session scopes), and loads "the first 200 lines" of user memory. It advises moving stable repository memory into "source-controlled project documentation" through the repository's "normal review process".

## 4. Windsurf (now Devin Desktop)

"On June 2, 2026, Windsurf is becoming Devin Desktop" ([FAQ](https://docs.devin.ai/desktop/devin-desktop-faq)). Cascade is now "the legacy agent", and "Devin Desktop no longer starts new Cascade conversations" ([Cascade](https://docs.devin.ai/desktop/cascade)). `docs.windsurf.com/windsurf/cascade/memories` redirects to the Devin Local customizations page, which offers rules, skills and plugins and no memories ([Devin Local Customizations](https://docs.devin.ai/desktop/devin-local/customizations)). The FAQ says Devin Local "replaces memories and workflows with rules and skills".

How Cascade Memories worked, from the [archived page of 2026-04-26](https://web.archive.org/web/20260426201645/https://docs.windsurf.com/windsurf/cascade/memories) and the still-live [JetBrains plugin page](https://docs.devin.ai/windsurf/plugins/cascade/memories):

- **Capture:** "Cascade can automatically generate and store memories if it encounters context that it believes is useful to remember", or on request ("create a memory of …"). Users can edit them.
- **Approval:** none.
- **Scope:** "associated with the workspace they were created in and are stored locally in `~/.codeium/windsurf/memories/`". "Memories generated in one workspace are not available in another, and they are not committed to your repository."
- **Retrieval:** "Cascade retrieves them when it believes they're relevant." No limits published for memories. Rules: global rules "Limited to 6,000 characters"; workspace rules "limited to 12,000 characters per file".
- **Advice:** "For knowledge you want Cascade to reliably reuse, write it as a Rule or add it to AGENTS.md in your repo rather than relying on auto-generated Memories. Rules are version-controlled, shareable with your team."
- **System-level rules (Enterprise):** loaded from OS directories such as `/etc/windsurf/rules/*.md`, "cannot be modified by end users without administrator permissions".
- No staleness or injection guard is documented.

## 5. Augment

Augment's memory is now part of **Cosmos Experts**. Its current docs index lists two memory pages, both under Cosmos ([llms.txt](https://docs.augmentcode.com/llms.txt)). The index has no page for the IDE extension's earlier memories *(unverified whether that feature still exists)*.

Source: [Memory](https://docs.augmentcode.com/cosmos/experts-memory), [Code Review Memory Manager](https://docs.augmentcode.com/cosmos/experts-code-review-memory).

- **Capture:** "A memory-enabled Expert identifies durable information that could change a future decision. In interactive sessions, it tells you when it remembers something so you can correct or veto it."
- **Storage and scope:** readable Markdown in a shared virtual filesystem. "An Expert's memory belongs to its team." "Repository-based Experts typically use one scope per repository, while other Experts can use a global, channel, project, or user-specific scope." Each Expert team "owns and maintains its memory rather than modifying another team's curated knowledge".
- **Two models:**
  - "Simple memory … writes explicit, high-quality human feedback directly to a curated knowledge file."
  - "Noisy memory uses an evidence log plus a curated knowledge file. It combines weaker signals over time and promotes a learning only after the evidence is strong enough."
- **Code Review Memory** (noisy) runs when a PR merges:
  - It records "useful human comments, reactions to agent findings, addressed change requests, and the outcome", and filters out "routine acknowledgments, bot updates, and process-only comments".
  - "Explicit human feedback carries more weight than reactions or an inferred outcome, so strong feedback can become useful memory immediately while weaker signals must recur."
  - Review Experts then load guidance "for the repository and changed paths".
- **Retrieval:** "At the start of relevant work, the Expert loads memory for the current scope." No size limits are published.
- **Staleness:** "Treat memory as evolving context, not an unquestionable rule. Experts should surface contradictions rather than ignore current evidence."
- **Rules and guidelines** are the reviewed layer ([Rules & Guidelines](https://docs.augmentcode.com/setup-augment/guidelines)): `.augment/rules/` (Always, Manual, Auto), user rules in `~/.augment/rules/`, and hierarchical `AGENTS.md` and `CLAUDE.md`.

## 6. Claude Code

Sources: [How Claude remembers your project](https://code.claude.com/docs/en/memory), [Projects](https://code.claude.com/docs/en/claude-projects), [Customize sessions in self-hosted environments](https://code.claude.com/docs/en/self-hosted-environments-configuration).

### 6.1 `CLAUDE.md` and rules (written by people)

- **Scopes, broadest first:** managed policy (`/etc/claude-code/CLAUDE.md` and OS equivalents, "Organization-wide instructions managed by IT/DevOps"), user (`~/.claude/CLAUDE.md`), project (`./CLAUDE.md`, shared through source control) and local (`./CLAUDE.local.md`). `.claude/rules/` adds path-scoped rules. A repository's `AGENTS.md` can load instead.
- **Retrieval:** files in the directories above the working directory load at launch and are concatenated; files in subdirectories load when Claude touches a file there. Each launch-time file is loaded whole up to 4 MiB; files over 200 lines "consume more context and may reduce adherence".
- **Not enforced:** "Claude treats them as context, not enforced configuration. To block an action regardless of what Claude decides, use a PreToolUse hook."
- **Guidance on what goes in:** "Claude makes the same mistake a second time", or "a code review catches something Claude should have known".

### 6.2 Auto memory (written by Claude)

- **Capture:** Claude saves four kinds of notes (`user`, `feedback`, `project`, `reference`) as it works, and "skips anything it can derive from the codebase" or that `CLAUDE.md` already says. No approval step.
- **Scope:** per repository and per machine. `~/.claude/projects/<project>/memory/` is shared by all worktrees of the repo. "Auto memory is machine-local. … Files are not shared across machines or cloud environments."
- **Retrieval:** "The first 200 lines of `MEMORY.md`, or the first 25KB, whichever comes first, are loaded at the start of every conversation." Topic files are read on demand. Near a limit, Claude Code reminds Claude to "merge or drop stale entries". Over it, the write succeeds but returns an error telling Claude to rewrite the index.
- **Staleness:** Claude Code writes a `modified` ISO timestamp into a memory file's frontmatter: "The timestamp shows how current the fact is, both to you and to Claude when it reads the memory back." Memory files are exempt from the transcript cleanup and "stay until you or Claude edits or deletes them".
- **Guards:** a project's settings can move the memory directory only "under the same workspace trust rule as hooks". With `blockReadsOutsideWorkingDirectories` on, Claude Code loads and saves no auto memory in a directory a repository's settings chose.
- **Headless:** "a session in a self-hosted environment runs with auto memory off by default. For instructions that should carry across sessions, use the `CLAUDE.md` in your runner image or in the repository." The runner's snapshot of `~/.claude/` leaves out `projects/`. `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` turns it off anywhere.

### 6.3 Projects (cloud)

Claude Code's cloud **Projects** keep project memory as files, separate from local auto memory: "Every cloud thread reads the index file `MEMORY.md` when it starts and opens the other files when it needs them." Claude writes them, and people "read, edit, and delete the files in **Project settings > Memory**". Project instructions go to every thread, "up to 16,000 characters".

## 7. Anthropic's memory for the API

### 7.1 The memory tool

Source: [Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) (tool type `memory_20250818`, stable).

- **Client-side.** "Claude requests file operations, and your application runs them." Commands: `view`, `create`, `str_replace`, `insert`, `delete`, `rename` under a `/memories` prefix "that your handler maps onto real storage, such as a per-user directory or keys in a database".
- **Capture and retrieval are Claude's.** The API adds a system-prompt instruction: "ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE." Scope, approval and storage are the application's.
- **Security is the application's job:**
  - "Claude usually refuses to write sensitive information to memory files. For stronger guarantees, add validation that strips sensitive data before your handler writes the file."
  - "Track memory file sizes and cap how large a file can grow."
  - "Periodically delete memory files that haven't been accessed in a long time."
  - Path traversal: "Your implementation must validate every path in every command."

### 7.2 Managed Agents memory stores and Dreams

Sources: [Using agent memory](https://platform.claude.com/docs/en/managed-agents/memory) (beta), [Dreams](https://platform.claude.com/docs/en/managed-agents/dreams) (research preview).

- **A store** is "a workspace-scoped collection of text documents", mounted in the session's sandbox under `/mnt/memory/`. The agent uses its ordinary file tools, and "a note describing each mount is automatically added to the system prompt".
- **Limits:** a memory is "capped at 100 kB (~25k tokens)", a store holds "a maximum of 10,000 memories", a session attaches "a maximum of 8 memory stores", and per-store session instructions are "capped at 4,096 characters".
- **Access:** `read_write` by default, `read_only` "enforced at the filesystem level".
- **The poisoning warning:** "If the agent processes untrusted input (user-supplied prompts, fetched web content, or third-party tool output), a successful prompt injection could write malicious content into the store. Later sessions then read that content as trusted memory. Use `read_only` for reference material, shared lookups, and any store the agent does not need to modify."
- **Versions:** "Every change to a memory creates an immutable memory version", kept 30 days (the recent versions of a live memory always). Versions can be **redacted** "for compliance workflows such as removing leaked secrets". Updates take a `content_sha256` precondition so a concurrent write isn't overwritten.
- **Dreams** read a store and 1 to 100 past sessions "then produces a new, reorganized memory store: duplicates merged, stale or contradicted entries replaced with the latest value". "The input store is never modified, so you can review the output and discard it if you don't like the result."

## 8. Other agents ostra drives or may drive

- **OpenAI Codex** ([Memories](https://learn.chatgpt.com/docs/customization/memories)):
  - Local memories "are off by default". Once on, Codex turns idle past chats into memory files in the background, and "redacts secrets from generated memory fields".
  - `memories.disable_on_external_context` keeps chats "that used external context such as MCP tool calls, web search, or tool search out of memory generation". That is a poisoning guard by source.
  - Its advice: "Keep required team guidance in `AGENTS.md` … Treat memories as a helpful recall layer."
- **OpenCode:** the [docs](https://opencode.ai/docs/) have pages for instructions, skills, MCP servers and compaction, and none for memory (navigation read 2026-11-19).

---

## 9. Open-source building blocks

Licenses from each repository's `LICENSE` file and the package registries, read 2026-11-19.

| Project | What it is | License | Store and model it needs | Fit for ostra |
|---|---|---|---|---|
| [MCP memory server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) (`@modelcontextprotocol/server-memory` 2.2.1) | Reference knowledge-graph memory: entities, relations, atomic "observations", tools such as `create_entities`, `search_nodes`, `open_nodes` | Repo: MIT, moving to Apache-2.0 ("All new code … licensed under Apache-2.0"); npm says "SEE LICENSE IN LICENSE" | A local JSONL file (`MEMORY_FILE_PATH`); no model | A reference for tool shapes only. A file per machine, no tenants, no access control |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) (`@modelcontextprotocol/sdk` 1.32.2, 2026-10-23) | The SDK ADR 0044 names for ostra's MCP server | MIT (npm), with the same MIT-to-Apache-2.0 transition in its `LICENSE` | — | Both licenses are permissive, so it fits ADR 0048's Apache-2.0 packages and the Sustainable Use ones |
| [Letta](https://github.com/letta-ai/letta) → [`letta-code`](https://github.com/letta-ai/letta-code) (`@letta-ai/letta-code` 0.34.66) | Stateful agents; memory as **MemFS**, "a git repository that belongs to the agent", root files always in context, `MEMORY.md` indexes for the rest; dreaming subagents | Apache-2.0 | Git; a model for dreaming. "MemFS does not include a semantic or vector index by default" ([MemFS](https://docs.letta.com/concepts/memfs)) | A design reference. It's an agent harness, not a library ostra would embed. "Agent reviews before applying" reviews with a model and "does not ask you for approval" ([Memory & dreaming](https://docs.letta.com/configuration/memory)) |
| [Mem0](https://github.com/mem0ai/mem0) (`mem0ai` 3.3.1 npm, 2.2.1 PyPI) | A memory layer: an LLM extracts memories from messages. v3 does "single-pass ADD-only extraction", multi-signal retrieval | Apache-2.0 | By default an OpenAI model and embedder; the self-hosted server uses Postgres + pgvector ([OSS overview](https://docs.mem0.ai/open-source/overview)) | Needs a model call per write, which ostra never makes (`project.md`). No approval step |
| [Graphiti](https://github.com/getzep/graphiti) (`graphiti-core` 0.31.2) | Temporal context graph: facts "have validity windows. When information changes, old facts are invalidated — not deleted" | Apache-2.0 | Neo4j, FalkorDB or Neptune, plus a model | A graph database is a second store (ADR 0017). The validity-window idea is the useful part |
| [Zep](https://github.com/getzep/zep) | The repo is now "Examples and Integrations"; Zep itself is Zep Cloud | Apache-2.0 (examples) | Zep Cloud | Not self-hostable; Graphiti is the open part |
| [Basic Memory](https://github.com/basicmachines-co/basic-memory) (1.0.0) | Notes that live "as Markdown files that both you and your AI can read, write", over MCP, with optional semantic search | AGPL-3.0-or-later | "Local-first. Plain text on your disk"; a hosted version on Postgres | AGPL; per person |
| [claude-mem](https://github.com/thedotmack/claude-mem) (16.0.0) | "runs a second agent beside it that takes notes while it works. The next session starts with a short index … and pulls in the details only when it needs them" | Apache-2.0 | A local worker service and a second agent (a model) | Per person and per machine; a model call per note |
| [cognee](https://github.com/topoteretes/cognee), [mcp-memory-service](https://github.com/doobidoo/mcp-memory-service) | Memory and knowledge-graph projects | Apache-2.0 | Not read beyond the license | **Unverified** |
| [LangMem](https://github.com/langchain-ai/langmem), [Supermemory](https://github.com/supermemoryai/supermemory) | Memory libraries and services | MIT | Not read beyond the license | **Unverified** |
| [Agent Memory Repo](https://github.com/AgentMemoryRepo/agentmemoryrepo) | Devin's open format: a Git repo of Markdown, `MEMORY.md` entry point, `[source: …; added: …]` metadata | MIT | Git | A format, not a service. Agent-written with "no human in the loop" |

---

## 10. Patterns across them

### 10.1 Capture

| Pattern | Who | Examples |
|---|---|---|
| The agent writes, nobody approves | Personal or one machine | Devin Memory, Claude Code auto memory, Windsurf, Codex, Letta, VS Code local |
| The agent writes, nobody approves, shared | A repository's collaborators | Copilot repository facts from the cloud agent and code review |
| The agent writes, the person in the session approves or vetoes | That one person | Cursor 1.2, Copilot CLI and app, Augment interactive Experts |
| The agent suggests, a person edits and saves | An organization | Devin Knowledge suggestions |
| The agent suggests a file, a person merges a PR | A repository | Devin skill suggestions ("Create PR") |
| Evidence from reviews, promoted when it recurs | A repository | Augment Code Review Memory |
| People write | Every scope | Rules, `CLAUDE.md`, `AGENTS.md`, Knowledge, Team Rules, managed policy files |

No product here queues an agent's proposal for any member of a team to approve before an agent sees it. ADR 0044's design is the stricter end of this table.

### 10.2 Retrieval and size

| Product | Always loaded | On demand |
|---|---|---|
| Claude Code | `CLAUDE.md` files (each up to 4 MiB); `MEMORY.md` first 200 lines or 25KB | Topic files, subdirectory `CLAUDE.md`, path rules |
| Devin | `MEMORY.md`; each skill's name and description; `AGENTS.md` up to 16 KiB | Other notes; a skill's body |
| Letta | Root memory files, every turn | Directories with their own `MEMORY.md` |
| VS Code local | First 200 lines of user memory | The rest |
| Cursor | "Always Apply" rules | Rules by description, glob or mention |
| Windsurf | Rules: 6,000 characters global, 12,000 per workspace file | Memories when relevant |
| Copilot | Not published: memories "more likely to be sent" when upvoted | — |
| Managed Agents | A note about each mount | Files under `/mnt/memory/` (100 kB each) |

ADR 0044's working values (100 notes and 8 KiB of index, 8 KiB of "always" notes) are inside this range and on the small side.

### 10.3 Stale and wrong memories

- **Citations checked against the code:** Copilot.
- **Expiry without reinforcement, where retrieval doesn't count:** Copilot (90 days).
- **A timestamp for the reader to judge:** Claude Code (`modified`), Devin and Agent Memory Repo (`added`).
- **A model's consolidation pass:** Devin's and Letta's dreaming, Anthropic's Dreams, Agent Memory Repo's Dreaming. Only Anthropic's writes its output somewhere to review before it replaces anything.
- **Repeated evidence before promotion:** Augment's noisy model.
- **Contradictions surfaced, not resolved silently:** Augment ("surface contradictions"), Anthropic Dreams ("stale or contradicted entries replaced with the latest value").

### 10.4 Poisoning

- **Secret scans:** Copilot rejects; Codex redacts; Devin, Claude and VS Code instruct the model.
- **Model-control tokens rejected:** Copilot.
- **Read-only memory for agents that read untrusted input:** Anthropic's Managed Agents advice.
- **Excluding sessions that touched outside content:** Codex's `disable_on_external_context`; Devin's automations don't read or write memory.
- **Telling the model memory is untrusted history:** Cursor's Agent SDK journal.
- **Human review before use:** Devin's suggestions, Cursor 1.2, Copilot CLI, Augment's veto. Each of those is one person, in the session.

---

## What this means for ostra

### The verdict on ADR 0044

The research **confirms the design** and changes nothing in its sections on what a note is, who writes, where proposals come from, the scopes, or memory and repo files. It suggests **one change to the index's order**, which is inside what the ADR said Q91 may change. Four further refinements are optional. Q91 can close.

Three things in the prior art back the design:

- **Approval before use is the defense the vendors only partly have.** Copilot writes shared repository facts with no approval and then needs a secret scan, a model-control-token filter, citation checks, votes and expiry to keep them honest. Anthropic tells Managed Agents users to mount memory `read_only` when the agent reads untrusted input. Every ostra task reads a ticket, which is untrusted (`AGENTS.md`), so Codex's rule (keep sessions that saw outside content out of memory) would exclude every task. A member's approval is the only way an ostra task can contribute, and ADR 0044 has it.
- **The index plus on-demand reading is what everyone does.** Claude Code, Devin, Letta, VS Code and Agent Memory Repo all load a short index and read the rest when needed, and none of them requires vector search. Full-text search in Postgres (ADR 0017) is enough to start; F-129's pgvector stays a later step.
- **Team memory belongs in a reviewed place.** Devin moved organization Knowledge into Skills that people own. Cursor folded Memories into Rules. Windsurf told users to write rules or `AGENTS.md`. VS Code tells users to move stable repository memory into source control through review. ostra's approved notes are that reviewed place for knowledge that isn't in a repo, and F-129's "Promote to repo" is the path the others took.

### Recommended changes *(recommendations, not decisions)*

1. **Count only reads as use (changes the index's order; tickets 15, 20, 06).** Today `memory.used` with `via: "index"` and `via: "always"` updates `lastUsedAt` and `useCount` (ticket 15), and the index is ordered "by the last time a task used them" (Q202). Every note in the index is then "used" by every session, so the notes in the index stay in it and a note past the cut can only come back through search. Copilot's rule avoids this: "Simply retrieving a memory does not reset this period." Proposed:
   - keep every `MemoryUse` row (the task page still lists what a session saw)
   - update `lastUsedAt` and `useCount` only for `via: "read"` and `via: "search"`
   - order the index by project before organization, then by that `lastUsedAt`, then by the note's last edit for notes never read
2. **Refuse model-control tokens in the secret scan (Q201, ticket 06's scan, ticket 15's proposals).** Copilot "can reject memories that contain recognized model-control tokens, as a defense against prompt injection". Approval is the main defense, but a member skimming a long proposal can miss a planted `</system>` or a chat-template token. Proposed: add a short fixed list of chat-template markers to the scan's shapes, refused the same way, naming the kind. No new dependency.
3. **Guard edits and merges against a stale version (tickets 16, 29).** Anthropic's memory stores take a `content_sha256` precondition so a concurrent write isn't overwritten; Devin rejects a stale write. Two members can open the same note, or merge two proposals into it. Proposed: `memory.save` and `memory.decide` (for "Merge into …") carry the version the member opened, and a mismatch is `CONFLICT`.
4. **Keep each agent's own memory off, and say so in the adapter contract (ticket 02; the Claude Code adapter).** Claude Code turns auto memory off in self-hosted sessions, Copilot CLI's programmatic sessions are off, and Codex is off by default. On a `host` executor (ADR 0029), Claude Code's `~/.claude/projects/<project>/memory/` would survive from task to task on a member's machine, unreviewed and on one runner only. That breaks runner parity and goes around approval. Proposed: the agent interface documents that an adapter turns its agent's native memory off (Claude Code: `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`). OpenCode documents no memory feature, so milestone 4 has nothing to switch off. Add a contract case once an agent with native memory ships.
5. **Frame the block as approved data (ticket 06's standing instruction).** Cursor's journal tells the model to treat records as untrusted history. ostra's notes are approved, so the block can say they're the organization's approved notes, each with its source. It should also tell the agent to propose with `relation: "contradicts"` when the code disagrees with a note, rather than follow it. That is Copilot's downvote, gated by a member (Q204).

### Later, for F-129

- **Staleness without a model.** Copilot's expiry and Devin's "stale notes that no session has used" suggest a second signal beside F-129's snapshot check: flag (never delete, since a member approved it) a note no session has *read* for 90 days *(working value)*. It depends on change 1.
- **Citations.** Copilot's facts cite files and lines and are checked against the branch. A note could carry optional file paths, which F-129's staleness check then tests after a snapshot rebuild.
- **Consolidation as an agent task.** Every "dreaming" pass is a model call on the vendor's side. In ostra it would be an ordinary task whose agent reads the notes and **proposes** merges and archives, which members decide like any proposal. Anthropic's Dreams write a new store "so you can review the output", which is the same idea.
- **Repo scope.** Copilot keeps facts per repository and "not pooled across an organization's repositories"; Augment uses "one scope per repository". With up to 10 repos in a project (Q206), repo-scoped notes are where the pressure will come from first.
- **Personal notes.** Devin made agent-written memory personal and kept team knowledge in reviewed skills. If F-129's personal notes come, they're the one place agent-written notes without approval would be safe, since they reach only their owner.

### Mapped to the questions

| Question | What the research says | Change |
|---|---|---|
| Q83 scopes | Organization and enterprise (Devin Knowledge, Cursor Team Rules, Claude managed policy); repository (Copilot, Augment, Devin's pinned repos); user (everyone) | None for v1. Repo scope is the first F-129 item to watch |
| Q84 what a note is | One fact, short, with a source: Copilot (text, subject, citations, reason), Devin (one-line bullet with `[source; added]`), the MCP memory server ("one fact per observation") | None |
| Q85 how agents receive it | Short index plus on-demand reading everywhere; no product requires vectors | Change 1 (the index's order); otherwise none |
| Q86 who writes | Only Copilot shares agent-written memory without approval, and it needs five other defenses to do so | None: approval stays. Change 2 adds a defense |
| Q87 where proposals come from | Devin suggests from feedback in chat; Augment mines review comments, weighting human feedback over reactions; Copilot learns from PR comments | None. "Remember this" on review comments matches Augment's strongest signal |
| Q88 keeping it true | Secret scans (Copilot, Codex); citations, votes and expiry (Copilot); consolidation (Devin, Letta, Anthropic) | Change 2 now; staleness by reads and citations in F-129 |
| Q89 memory, repo files, environment | Vendors push durable team rules into reviewed files | None. F-129's "Promote to repo" matches the trend |
| Q90 where it shows | Copilot: per-repository and personal settings pages, audit entries without content; Devin: a Memory tab and an "Updated memory" card | None. ADR 0044's Memory pages, the task's memory list and audit by note ID match |
| Q91 prior art | This file | Can close |
| Q92 what ships in v1 | Nothing found argues for moving an F-129 item into v1 | None |

### Mapped to the milestone 4 tickets

| Ticket | Effect |
|---|---|
| 02 (agent interface: memory) | Change 4: document that an adapter keeps its agent's native memory off |
| 06 (domain) | Change 1 in the index's order; change 2 in the scan's shapes; change 5 in the standing instruction |
| 07 (OpenCode) | None. OpenCode has no native memory to switch off |
| 15 (core: spec and endpoints) | Change 1: `memory.used` ingest updates `lastUsedAt` and `useCount` only for `read` and `search` |
| 16 (core: notes and proposals) | Change 3: version check on edit and merge |
| 20 (runner: block and tools) | None; it already emits each `via` |
| 29 (API) | Change 3: the expected version on `memory.save` and `memory.decide` |
| 38 (web) | Show the conflict from change 3; "last used" means last read |

ADR 0044 also says `@modelcontextprotocol/sdk`'s license is "to confirm": it's MIT on npm, with the MCP project's MIT-to-Apache-2.0 transition in its `LICENSE`. Both are permissive, so it fits both license lines (ADR 0048).

---

## Sources checked

| Source | What | Read |
|---|---|---|
| [docs.devin.ai/product-guides/memory](https://docs.devin.ai/product-guides/memory) | Devin Memory and Dreaming | 2026-11-19 |
| [docs.devin.ai/product-guides/knowledge](https://docs.devin.ai/product-guides/knowledge) | Knowledge, deprecation, migration FAQ | 2026-11-19 |
| [docs.devin.ai/product-guides/skills](https://docs.devin.ai/product-guides/skills) | Skills, suggestions, loading | 2026-11-19 |
| [docs.devin.ai/work-with-devin/bots](https://docs.devin.ai/work-with-devin/bots) | Bot instructions and memory | 2026-11-19 |
| [docs.devin.ai/onboard-devin/agents-md](https://docs.devin.ai/onboard-devin/agents-md) | 16 KiB `AGENTS.md` limit | 2026-11-19 |
| [docs.devin.ai/release-notes/overview](https://docs.devin.ai/release-notes/overview) | Dates: 2026-06-17, 09-18, 10-09, 10-19, 11-06, 11-16 | 2026-11-19 |
| [github.com/AgentMemoryRepo/agentmemoryrepo](https://github.com/AgentMemoryRepo/agentmemoryrepo) | Spec and MIT license | 2026-11-19 |
| [cursor.com/changelog/1-0](https://cursor.com/changelog/1-0), [1-2](https://cursor.com/changelog/1-2), [2-1](https://cursor.com/changelog/2-1) | Memories beta, GA with approvals; 2.1 | 2026-11-19 |
| [forum.cursor.com/t/are-my-memories-gone/144057](https://forum.cursor.com/t/are-my-memories-gone/144057), [/143310](https://forum.cursor.com/t/agents-have-lost-access-to-memory-capability/143310) | Removal in 2.1.x *(secondary)* | 2026-11-19 |
| [cursor.com/docs/rules](https://cursor.com/docs/rules) | Rules, Team Rules | 2026-11-19 |
| [cursor.com/docs/agent-sdk/reference/memory](https://cursor.com/docs/agent-sdk/reference/memory) | Agent SDK memory journal | 2026-11-19 |
| [docs.github.com/…/copilot-memory](https://docs.github.com/en/copilot/concepts/agents/copilot-memory) | Copilot Memory concepts | 2026-11-19 |
| [docs.github.com/…/create-memories](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/copilot-memory/create-memories) | Asking, approving, importing | 2026-11-19 |
| [docs.github.com/…/manage-as-administrator](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/copilot-memory/manage-as-administrator) | Policies, export, audit | 2026-11-19 |
| [code.visualstudio.com/docs/agents/run/memory](https://code.visualstudio.com/docs/agents/run/memory) | VS Code memory | 2026-11-19 |
| [web.archive.org/…/docs.windsurf.com/windsurf/cascade/memories](https://web.archive.org/web/20260426201645/https://docs.windsurf.com/windsurf/cascade/memories) | Cascade Memories as of 2026-04-26 | 2026-11-19 |
| [docs.devin.ai/windsurf/plugins/cascade/memories](https://docs.devin.ai/windsurf/plugins/cascade/memories) | Cascade Memories, JetBrains plugin | 2026-11-19 |
| [docs.devin.ai/desktop/devin-desktop-faq](https://docs.devin.ai/desktop/devin-desktop-faq), [/desktop/cascade](https://docs.devin.ai/desktop/cascade), [/desktop/devin-local/customizations](https://docs.devin.ai/desktop/devin-local/customizations) | Windsurf to Devin Desktop; Cascade legacy | 2026-11-19 |
| [docs.augmentcode.com/cosmos/experts-memory](https://docs.augmentcode.com/cosmos/experts-memory), [/experts-code-review-memory](https://docs.augmentcode.com/cosmos/experts-code-review-memory), [/setup-augment/guidelines](https://docs.augmentcode.com/setup-augment/guidelines), [llms.txt](https://docs.augmentcode.com/llms.txt) | Augment memory and rules | 2026-11-19 |
| [code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory) | `CLAUDE.md`, auto memory | 2026-11-19 |
| [code.claude.com/docs/en/claude-projects](https://code.claude.com/docs/en/claude-projects) | Projects memory | 2026-11-19 |
| [code.claude.com/docs/en/self-hosted-environments-configuration](https://code.claude.com/docs/en/self-hosted-environments-configuration) | Auto memory off when self-hosted | 2026-11-19 |
| [platform.claude.com/…/memory-tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) | Memory tool | 2026-11-19 |
| [platform.claude.com/docs/en/managed-agents/memory](https://platform.claude.com/docs/en/managed-agents/memory), [/dreams](https://platform.claude.com/docs/en/managed-agents/dreams) | Memory stores, Dreams | 2026-11-19 |
| [learn.chatgpt.com/docs/customization/memories](https://learn.chatgpt.com/docs/customization/memories) | Codex memories | 2026-11-19 |
| [opencode.ai/docs](https://opencode.ai/docs/) | No memory page | 2026-11-19 |
| [docs.letta.com/concepts/memfs](https://docs.letta.com/concepts/memfs), [/configuration/memory](https://docs.letta.com/configuration/memory) | MemFS, dreaming | 2026-11-19 |
| [docs.mem0.ai/open-source/overview](https://docs.mem0.ai/open-source/overview) | Mem0 defaults | 2026-11-19 |
| `LICENSE` files on `raw.githubusercontent.com` for each repo in section 9; `registry.npmjs.org` and `pypi.org` for versions | Licenses and versions | 2026-11-19 |
