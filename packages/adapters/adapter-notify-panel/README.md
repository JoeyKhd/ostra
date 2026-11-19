# @ostra/adapter-notify-panel

The panel notification channel (ADR 0050, F-036): the "Needs you" page and the sidebar's count. Apache-2.0.

- `PanelNotificationAdapter` extends `NotificationAdapter` (`name: "panel"`, `channels: ["panel"]`, `edits: true`).
- It writes nothing itself. Its rows sit behind the `PanelNotificationRows` port: mark a notification delivered, update its state. Core backs the port with the `Notification` table, as the built-in blob store's rows are backed; `createMemoryPanelRows` is the in-memory backing for tests.
- `send` marks the row named by `notification.notificationId` delivered, once (a second send keeps the first time). A recipient who isn't the row's member is reported as refused. `update` moves the row's state (`open`, `answered`, `dismissed`).
- Logs carry IDs and kinds, never a title or a body.

It passes the notification contract suite in `@ostra/adapter-sdk/testing`.
