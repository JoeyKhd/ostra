# 03: Adapter SDK: the runner notices

Status: done
Builder: adapters (contracts, first)
Blocked by: none (milestone 4's ticket 04 lands first where both touch `Notification.kind`)
Features: F-091, F-036 (grown)
Packages: `packages/adapter-sdk` (`src/notification/`), the panel and email channels' templates where milestone 3 put them
Spec: `../spec.md`, section 5.2 ("`NotificationAdapter`"); section 11, item 18

## What to build

- `Notification.kind` gains `runner_joined` and `runner_awaiting_approval`, both in the `moment` category, with the organization's admins as their audience.
- The panel and email channels render both: the runner's name, its pool, its executor, the token's label and a link to the runner's page; never the token or the key. The tracker channel refuses both.
- The contract suite: each kind renders on each channel that takes it, its text names no secret, and the tracker channel refuses.

## Done when

- [x] Tests: the two kinds render in both parts of a mail and in the panel; the tracker's refusal; no token or key in any rendered part.
- [x] Committed as `✨ add the runner notices`.

## Comments

- 2026-11-19: built. `runnerNotificationKinds` (`runner_joined`, `runner_awaiting_approval`) join `MomentNotificationKind`, with a `runner` subject that has no field for a token or a key (`packages/adapter-sdk/src/notification/base.ts`). The tracker channel refuses both as `unsupported` on send and update. The panel's words and the mail's parts come from one renderer, `renderRunnerNotice` (`packages/domain/src/notifications/runner-notices.ts`), beside milestone 3's; the mails' shared parts moved to `email-parts.ts`. The notification contract suite runs both kinds on every channel. Two differences from the ticket: the panel channel only marks a row delivered, so "renders in the panel" is the renderer's panel words, which the web shows from ticket 31; and the database's `NotificationKind` gains the two values in ticket 04. Proof: `context/proof/F-091.md`, last row, stays `partial` until core sends the notice in the join's transaction (ticket 12). Commit: see the next line.
- 2026-11-19: commit af950a47 (`✨ add the runner notices`).
