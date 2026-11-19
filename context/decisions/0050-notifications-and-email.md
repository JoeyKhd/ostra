# Notifications and email

**Status:** accepted (2026-11-19, on the maintainer's delegation for milestone 3's spec: "continue working on everything throughout the night"). Settles Q172 to Q174. Covers F-036 and F-115, and builds on ADR 0007 (Resend first, SMTP second), ADR 0025 (everything is an adapter) and ADR 0011 (nothing acted on before it's saved).

A "needs you" moment (an approval, a question, a plan, a PR ready for review, a stall, a crash) is worth nothing if nobody sees it. F-036 sends it to its audience in the panel, on the ticket and by email.

## Channels

- **Each channel is a `NotificationAdapter`** (ADR 0025), one class each, one level deep:
  - `panel`: the "Needs you" page and the sidebar's count. Always on. Its rows sit behind a port that core backs, so the adapter stays Apache-2.0 (ADR 0048), as the built-in blob store does.
  - `tracker`: a comment on the task's ticket, through the board's own `TrackerAdapter`, so it works for Linear and for the Jira fake alike (adapter parity). On by default for tasks with a ticket.
  - `email`: Resend (`resend`) first, SMTP (`nodemailer`) second, one at a time per install (ADR 0007). On when the install has email set up.
- Slack (F-057) comes after v1 as a fourth adapter of the same kind.

## Audiences

- **The audience comes from the needs-you item** (`domain-model.md`): the driver for the task's questions, approvals, plans, stops and crashes; the project's members when the task has no driver.
- **Until reviewers and refine drafts exist** (F-102, F-099, milestone 6), "a PR ready for review" goes to the driver (Q172). The resolver returns nobody for the `reviewer` audience until then, so nothing is sent to a guess.
- **An approval** goes to its audience like any item, though any member of the project may answer it (F-026): it shows on every project member's Home, and notifies only the audience, so one approval doesn't mail a whole team.
- A member who can no longer open the project gets nothing.

## Delivery

- **Fan-out writes before it sends.** An item's creation, answer or dismissal enqueues a fan-out in the same transaction (ADR 0011). Fan-out writes one notification per member and one delivery per channel the member wants, each with an idempotency key of the item, the member and the channel; a replayed job sends nothing twice. Each delivery retries on its own, and a failing channel never holds the others back.
- **On the ticket: one new comment per moment,** so the tracker's own notifications fire, with the audience mentioned when the tracker has a user with the member's address (`findUsersByEmail`, matched per delivery and kept nowhere else). **Within 10 minutes** *(working value)* of the task's last such comment, a later moment edits that comment instead, so a task that asks three things in a row writes one comment. When the item is answered, the comment is edited to say who answered.
- **By email: a short delay, and only if still needed.** A mail waits 2 minutes *(working value)* after the moment, and is skipped when the member has read the notification in the panel or the item is no longer open, so a member watching the task isn't mailed about what they just saw.
- **Each member chooses** per moment and per channel. The defaults: every moment on for the panel (which can't be turned off) and the ticket; email on for approvals, questions, plans, PRs ready for review, crashes and the spend cap, and off for the rest.

## What a mail may carry

- **The organization, the project, the task's title and key, the moment, one line about it** (an approval's path or command, at most 200 characters) **and a link** (Q173). Never ticket text, agent output, a plan's text, a diff, check output or a comment. A mail leaves the install, and a mailbox is often read on devices the organization doesn't control.
- **No action buttons.** A link that answers an approval would be a bearer credential in an inbox. Every answer is made signed in, on the page the link opens.
- **Email is set per install, by the instance admin,** in the panel or by `OSTRA_EMAIL_*` settings, which lock the panel's fields. Secrets go to the secret store. Without email, everything else works, and the panel says mail is off (F-115).

## Templates

- **ostra's own pure renderers** in `packages/domain` (Q174): one per moment, giving a subject, an HTML body with inline styles and a table layout that mail clients render, and a text part with the same content. The mark is an image served from the install's own public address. No template library: the mails are few and short, and a library would be one more dependency to approve and pin.

## Considered options

- **The panel as built-in code rather than an adapter.** Rejected: ADR 0025 makes every channel an adapter, and the panel's rows behind a port cost one small interface.
- **Linear notifications through Linear's own notification API.** Rejected: an app can't notify a user directly on the plain API; a comment with a mention is what Linear notifies people about, and it works the same way on Jira.
- **One ticket comment per moment, always.** Rejected: a busy task would bury the ticket. The window keeps it to one comment per burst.
- **Mail at once.** Rejected: a member answering in the panel would be mailed anyway. Two minutes is short enough for a member who isn't looking.
- **Mails with the agent's question or plan text.** Rejected for what a mailbox may leak. The link carries the reader to the text.
- **One-click answers in the mail.** Rejected, as above.
- **React Email or MJML for the templates.** Rejected for now: a dependency each, for a handful of mails. Revisit if the mails grow past a dozen or need many layouts.

## Consequences

- The schema gains notifications, their deliveries, the members' choices and the instance's email settings (milestone 3's spec, section 5.3).
- `adapter-sdk`'s `NotificationAdapter` grows by its kinds, recipients, rendered mail, an optional `update`, and a contract suite every channel passes.
- Invites and reset links (F-002) and budget warnings (F-037) in milestone 4 use the same email channel and templates, and better-auth's mail callbacks call it.
- F-036 stays `building` until milestone 6's audiences exist; F-115 until milestone 4's mails do.
