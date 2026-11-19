# Checks, update branch, and work after a merge

**Status:** accepted (2026-11-19, on the maintainer's delegation for milestone 3's spec: "continue working on everything throughout the night"). Settles Q178 to Q183. Covers F-054, F-070, F-066, F-053 and F-119, and builds on ADR 0027 (one PR per changed repo), ADR 0039 (after every turn), ADR 0040 (the App opens every PR; the verified link) and ADR 0041 (only `@ostra` and linked members reach the agent from GitHub).

## Checks before the PR

- **Checks run after every turn with changes, before the push** (Q178). F-054 says "when a session ends", which was one turn in milestone 1; since milestone 2 a session spans turns, and every turn that changed something pushes and may open or update a PR, so every such turn runs the checks. A turn without changes runs none.
- **A failing check doesn't stop the push.** The work is saved either way. The PR opens as a draft, or an open PR is converted to one, and the PR body's "Checks" section names what failed. When every check passes on a later turn, a PR that ostra made a draft is marked ready; one a person made a draft stays one.
- **Nothing loops by itself.** The panel offers "Ask the agent to fix", which sends the failing checks' output tails as a prompt. The automatic loop is F-035's, in milestone 6, after budgets (ADR 0041, `build-order.md`).
- **A check runs as the agent does,** in its environment and working tree, with the environment's variables and never a model key or a GitHub token. Its command is the admin's, never built from task text. Its output is untrusted: escaped in the PR body, never interpreted.

## Update branch

- **A merge, never a rebase** (Q179): one turn asks the agent to merge each behind repo's base into its branch and fix the conflicts. A merge pushes as a fast-forward of the task's branch, so the git proxy forces nothing and a member's local clone of the branch keeps working. Projects that want a linear history squash on merge on the code host.
- **ostra knows how far behind each repo is** from the App's `push` webhooks on base branches and the reconcile, and offers the action only where a repo is behind.

## After the merge

- **A fresh branch per merged repo** (Q180): the old name with `-2`, then `-3`, from the base's current head, and a new PR on the first push, linked on the same ticket. Every PR a task repo has had is kept, so the task page and the rebuild template list them all.
- **A ticket closed or cancelled while its task runs** (Q181) interrupts the turn (the work so far is saved as after any turn) and asks the driver: "Stop the task" or "Keep working", which sends "Carry on where you stopped." A ticket closed after the PR merged (Linear's GitHub integration does that) isn't "while it runs" and changes nothing.

## `@ostra` on the PR

- **Issue comments and line comments on the task's PRs** whose text starts with `@ostra`, or holds it on a line of its own (Q182). A line comment carries its file and line into the prompt.
- **Only from a member with a verified link who can open the project.** Anyone else, bots included, is dropped without a reply: a reply would tell an outsider which repos ostra drives and who its members are (ADR 0041). The drop is recorded by IDs.
- **A comment while a session is going waits for the turn's end,** then runs as the next turn, attributed to its author, who becomes a co-author of what follows (ADR 0040). It doesn't take the driver's seat: the comment is one message, not a session of messages.
- The App reacts 👀 on an accepted comment, once.

## The verified GitHub link

- **On the account, not the membership** (Q183): one GitHub identity per person, the same in every organization they belong to, and unique per install, so two accounts can't claim one GitHub user.
- **The OAuth token is revoked before the callback returns,** and ostra keeps only the user's ID and login (F-119, ADR 0040). A revocation that fails stores nothing and says so.
- **The callback URL is in the App's callback URL list:** a new App gets it from its manifest; an existing App needs it added once in GitHub's settings.
- **Co-author trailers use the link's no-reply address,** `<id>+<login>@users.noreply.github.com`, which GitHub resolves to the member (spike 4). Without a link, milestone 1's trailer from the member's ostra name and email stays.

## Considered options

- **Checks only before the first PR.** Rejected: later turns change the PR too, and a green first push says nothing about the fifth.
- **Failing checks block the push.** Rejected: the work would sit only in the hidden ref, and the PR would show an older state than the task.
- **Rebase for update branch.** Rejected: a forced push of the task's branch, and every local clone of it broken.
- **A new task for the work after a merge.** Rejected by F-066, which keeps the task and its history.
- **Answering an unlinked commenter with "link your account".** Rejected for what it tells an outsider; the panel's Account page and the docs say how linking works.
- **The link on the membership.** Rejected: a person would link once per organization, and co-author credit would differ between them.

## Consequences

- Protocol minor 2 carries the checks and their events, and `session.saved` their results (milestone 3's spec, section 5.1). The executor interface gains `runChecks`.
- The schema gains `CheckRun`, `TaskPullRequest`, `TaskRepo.behindBy` and `generation`, and the GitHub columns on `User` (section 5.3).
- The code host interface gains drafts, the comment and push webhooks, reactions and the user link.
- F-054's "when a session ends" now reads "after every turn with changes": the ledger row carries the note.
