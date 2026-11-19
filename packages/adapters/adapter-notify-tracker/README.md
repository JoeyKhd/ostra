# @ostra/adapter-notify-tracker

The ticket notification channel (ADR 0050, F-036): a comment on the task's ticket, through the board's own `TrackerAdapter`, so it works for Linear and for the Jira fake alike. Apache-2.0.

- `TrackerNotificationAdapter` extends `NotificationAdapter` (`name: "tracker"`, `channels: ["tracker"]`). It is built with a `TrackerAdapter` and the board, and its `edits` capability follows the tracker's `commentEdit`.
- `send` posts one comment per idempotency key: the moment in one sentence, the mentions of the recipients that have one (`trackerMention`, from the tracker's `findUsersByEmail`, which core calls), the task's title inside quotes and the link to the task. It needs the adapter's context to carry an idempotency store (core's does). A send that another attempt started and never finished answers `conflict` instead of posting twice.
- `update` edits that comment in place: a coalesced moment, or an answered or dismissed one.
- The comment's text comes from the pure renderer in `comment-text.ts`, never from agent output. The task's title is untrusted: it is flattened to one line, cut and escaped, so it can't make a link, a mention, a heading or a code block on the ticket.

It passes the notification contract suite on the fake Linear server and on the Jira fake.
