# Starting from Linear, and tasks from outside

**Status:** accepted (2026-11-19, on the maintainer's delegation for milestone 6's spec). Settles Q214 to Q219. Covers F-012 and F-040, and builds on ADR 0013 (Linear's two modes, amended below it for this milestone), ADR 0031 (outside tasks wait for a member), ADR 0030 (no credential in the box) and ADR 0050 (what may leave the install).

Linear's agent mode lets anyone in a Linear workspace hand a ticket to ostra. Most of them are the organization's own members; some aren't, and ticket text from anyone reaches an agent that runs commands. This ADR says who is who, where a delegation goes, what ostra writes back, and what waits.

## Who is a member

- **A Linear user is a member when their address matches an active member's account address,** compared case-folded with surrounding space trimmed, and that member can open the project the task lands in. Plus-addresses are compared as written: `ana+x@` isn't `ana@`.
- **Anyone else is outside.** So is a user whose address Linear doesn't return.
- The match is made for each event and kept on the task and the session for display, never as a link: a member who changes their address in either place is matched by the new one next time.

## Where a delegation goes

- **A project admin turns on "Start from Linear" on a board,** and a Linear team can have it on in at most one project of an organization. A delegation for a team with none gets an error activity saying so, and ends.
- **Agent mode starts code tasks** on the project's default code profile. A refine is started in the panel. A mention in a comment on a ticket that already has an active task is a follow-up to it.

## What ostra posts in the session

- **ostra's own words, counts and links:** a thought when the task is received, waiting for approval, approved or working; an action when a PR opens, with its link; an elicitation with a link when the task needs someone; one final response when it ends, or an error. A link to the task page goes on the session where Linear's API has a field for it.
- **Never agent output, a tool's input, a plan, a draft or check output.** A Linear workspace's users may not be able to open a restricted project, and Linear isn't where the organization decided that text may go (ADR 0050's rule for mail, applied to the tracker).
- Every post is an outbox row with an idempotency key, sent with the app's own token, and moves the session's heartbeat 20 minutes on (ADR 0013).

## Follow-ups and stops from Linear

- **A stop is always honoured,** from whoever pressed it: Linear's rule is that the agent halts and posts one final response, and stopping only reduces what an agent does. The audit log names the Linear user.
- **A follow-up from a matched member** becomes their message, sent after the running turn as `@ostra`'s are (ADR 0052). It doesn't make them the driver.
- **A follow-up from anyone else** reaches no agent; ostra answers with a thought that says only members of the project can steer the task.

## Outside tasks

- **A task started by someone outside waits in "Needs approval"** when the project's switch is on, which it is by default (ADR 0031). It runs on the project's default profile for its kind, whatever was asked, and only on one of the project's pools, never on a member's personal runner, before or after approval.
- **Any member who can open the project approves or rejects it,** with an optional reason; the first answer wins, and it's an audit entry. Its needs-you item goes to the project's members.
- **Only an organization admin switches it off** for a project: it widens who can spend the organization's money and run code on its pools.
- **It doesn't expire.** A rejected task is stopped and its session ended; an unanswered one stays listed. The Linear session may show as stale meanwhile, and recovers on ostra's next post.
- **An automation's task isn't an outside task** (ADR 0056); a rule may ask for approval anyway.

## No Linear SDK

- **Agent mode speaks GraphQL over `fetch`,** with ostra's own Zod schemas for the webhook (tolerant of unknown fields) and the calls, as milestone 2's adapter does. `@linear/sdk` would be a dependency to approve and pin, with a DOM shim under strict typing (spike 5), for four calls.

## Considered options

- **An explicit Linear account link per member,** like the GitHub link (F-119). Rejected for v1: a second OAuth flow per member, for what the address already tells, inside a workspace the organization administers. Revisit if workspaces hold addresses ostra shouldn't trust.
- **Every delegation as an outside task.** Rejected: members would approve their own tasks.
- **Mirroring the agent's messages into the session.** Rejected above.
- **Stops only from members.** Rejected: Linear's contract is that a stop stops.
- **An expiry for unapproved tasks.** Rejected for v1: nothing runs while it waits, so it costs nothing.

## Consequences

- The schema gains agent sessions and their activities, the board's switch, the task's origin and starter, `poolOnly`, and the project's switch (milestone 6's spec, section 5.3).
- Admission must never offer a `poolOnly` task to a personal runner; its test is F-040's.
- F-012 is done only after spike 5's real bullets pass against ostra itself, which needs the maintainer's Authorize click and a person's stop (milestone 6's spec, section 3).
