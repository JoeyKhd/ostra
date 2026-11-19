# Task kinds: refine, code and review

**Status:** accepted (2026-11-18, from the delegated answers in `context/history/answers-2026-11-18.md`). Settles Q64, Q65, Q66, Q67 and Q71. Supersedes Q13. **Amended 2026-11-19 for milestone 6's spec,** on the maintainer's delegation: refine and review push nothing, the built-in profiles, a draft on the tracker, and one review task per code task (Q221, Q223; the section "Milestone 6: refine and review in practice").

A task has a **kind**, which fixes how it ends. The kind is in the schema from milestone 1.

| Kind | Ends in | Pushes code? |
|---|---|---|
| **refine** | a draft a member turns into a ready ticket | No: its git proxy accepts fetches only |
| **code** | one or more PRs (ADR 0027) | Yes, to the task's branches |
| **review** | a PR review | No: it reads the PR's head |

The kinds share everything else: the box, the sidecar, the ACP driver, the session, steering, the driver role and "needs you". A project picks a default agent profile per kind (F-021).

**The lifecycle is a discriminated union per kind.** Every kind has awaiting approval, queued, preparing, running, needs you and stopped. Only code tasks have in review and merged. Refine and review tasks end in done.

## Refine

The name is "refine", from backlog refinement, the word product people already use (Q65). "Plan first" (F-063) stays a step inside a code task.

- A refine task may read the code, answer questions about it and prototype inside its box (Q66). It can't push to a branch or open a PR. ostra enforces that in the git proxy, not by trusting the agent, because its input is ticket text from anyone in the tracker.
- Its default profile is read-only, on a cheaper model that the admin picks.
- It ends with a **draft**, handed in through an ostra MCP tool as typed fields: description, acceptance criteria, edge cases, open questions and a split into sub-tickets (Q67).
- A finished draft is a "needs you" item. A member edits it. Then "Update ticket" writes it to the tracker, and "Mark ready" moves the ticket to the board's ready status. The board's status mapping gains "ready".
- Screenshots of the running app come after v1 (F-121). In v1, members upload their own images to a draft.

## Review

- An AI review is its own task, linked to the code task it reviews, with its own box, session and profile (Q71). The profile may use another model than the coder's.
- It runs on the PR's head, read-only, and reads the diff against the ticket's acceptance criteria.
- It hands in **findings** through an ostra MCP tool: each one blocking or a nit, with a file and a line.
- ostra posts them to GitHub as a comment-type review with line comments. The review agent never approves and never requests changes on GitHub.
- What happens to blocking findings is ADR 0041. Reviewing PRs that people wrote comes after v1 (F-123). The kind already allows a PR as its source.

## Considered options

- **Separate models for each kind of work.** Rejected. One task model keeps the box, the driver, steering and "needs you" written once.
- **A reviewer as an option on the coding profile (Q13).** Rejected. A separate review task keeps "one active session per task" true, and lets the reviewer use another model.
- **Adding the kind when refine and review ship.** Rejected. Adding it later is a rewrite of the data model, ADR 0010's reason.
- **A refine draft as free text.** Rejected. Typed fields can be edited one by one and checked. Free text would have to be parsed.
- **Refine writing to the tracker by itself.** Rejected. The draft is text an agent wrote from untrusted input. Nothing reaches the tracker without a person.
- **A review agent that approves or requests changes.** Rejected. Requesting changes would block merging until someone dismissed it, and an approval from a bot means nothing.
- **Onboarding as a fourth kind (Q49).** Rejected. It's a code task started from a built-in template.

## Consequences

- ostra never calls a model itself, so drafts and findings come from the agent, through ostra's MCP tools in the sidecar (ADR 0030). The same server serves memory proposals, PR text and environment proposals.
- The code host adapter needs a capability for posting a comment-type review with line comments. A tracker that can't take one of a draft's fields declares that, and the field goes into the description.
- Glossary: Task kind, Draft, Finding and Reviewer are terms.
- Ledger: F-099 (refine tasks) and F-100 (AI review) are v1 rows in milestone 6. F-102 (review screen and reviewers) ships there too.
- Refine is third on the list of what slips first. If it slips, the kind stays in the schema.
- Revisit if refine or review turns out to need different isolation from code, or if findings are mostly noise. Then AI review becomes off by default per project.

## Milestone 6: refine and review in practice

Added 2026-11-19 (Q221, Q223), for milestone 6's spec, which ships F-099 and F-100. The review loop around a review task is ADR 0058.

- **Refine and review tasks push nothing,** not even the hidden ref: the git proxy's read-only mode refuses every push, and the runner doesn't try one. Their conversation is kept in the session archive; a prototype in the box isn't kept past the box, and the panel says so. A prototype worth keeping becomes a code task.
- **The built-in profiles.** Every organization gets a "Refine" and a "Review" profile, read-only, on its default model, which an admin can edit and not delete; they are each project's defaults for those kinds until a project picks another. A refine profile may allow edits inside the box for prototyping; the built-in one doesn't.
- **A draft on the tracker.** "Update ticket" writes the description with a section per field the tracker can't hold as a field of its own (Linear holds none of them), attaches the member's images where the tracker takes attachments, and creates each sub-ticket as a sub-issue where the tracker has them, or as a linked ticket. "Mark ready" moves the ticket to the board's "ready" status, which the mapping gains, drafted as the first status of Linear's `unstarted` type. Either action, by a member, ends the task as done. A refine task on a prompt ends with "Create ticket" instead.
- **The draft's owner,** for its needs-you item and its notification, is the task's driver, or the project's members when it has none.
- **One review task per code task,** reopened for each round on every open PR's head, posting one comment-type review per PR (ADR 0058).
