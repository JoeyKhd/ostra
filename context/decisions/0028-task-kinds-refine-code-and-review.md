# Task kinds: refine, code and review

**Status:** accepted (2026-11-18, from the delegated answers in `context/history/answers-2026-11-18.md`). Settles Q64, Q65, Q66, Q67 and Q71. Supersedes Q13.

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
