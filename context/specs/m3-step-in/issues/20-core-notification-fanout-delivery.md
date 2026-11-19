# 20: Core: notification fan-out and delivery

Status: ready-for-agent
Builder: core
Blocked by: 07, 11
Features: F-036
Packages: `apps/core` (`src/notifications/` (new)), `packages/domain` (`fanOutNotification`, `recordDelivery`, `markNotificationRead`)
Spec: `../spec.md`, section 4 ("A notification"); ADR 0050

## What to build

- **The trigger:** every needs-you item's creation, answer and dismissal, in milestone 1's, 2's and 3's code paths alike, enqueues `notify.fanout` in the same transaction, keyed by the item and the change. A test lists every place that writes a `NeedsYouItem` and fails when one doesn't enqueue.
- **Fan-out:** resolve the audience to members (the domain's resolver), drop members who can no longer open the project, read each member's choices (defaults when no row), and write one `Notification` per member and one `NotificationDelivery` per wanted channel with its idempotency key. An answer or a dismissal updates the members' notifications to `answered` or `dismissed` and enqueues an `update` for channels that edit.
- **Delivery** (`notify.deliver`): through the channel's adapter, built per organization from the registry: the panel adapter on core's `PanelNotificationRows` (on `packages/db`), the tracker adapter on the task's board's `TrackerAdapter` (only for a task with a ticket), email in ticket 21. Retries with backoff (ADR 0037), the error in words and IDs on the delivery, never blocking another channel.
- **The tracker's coalescing:** within `OSTRA_TRACKER_NOTIFY_COALESCE_MINUTES` of the task's last tracker notification, a new moment edits that comment instead of posting another.
- **Mentions:** the tracker channel asks `findUsersByEmail` for the recipients' addresses once per delivery; no table keeps the match.
- **The live stream:** a notification change emits milestone 1's change notice for the member, so the sidebar's count and the Needs you page update without a reload.

## Done when

- [ ] Tests: one item reaches every audience member once per channel, and a replayed job sends nothing twice; a member without access gets nothing; turning a channel off for a kind stops it for that member only; the coalescing edits within the window and posts after it; a failing tracker leaves the panel and email delivered; every `NeedsYouItem` writer enqueues; another organization's members never get a notification.
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `core` and `domain`.
- [ ] Committed as `✨ add notification fan-out and delivery`.

## Comments
