# 03: Adapter SDK: the runner notices

Status: ready-for-agent
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

- [ ] Tests: the two kinds render in both parts of a mail and in the panel; the tracker's refusal; no token or key in any rendered part.
- [ ] Committed as `✨ add the runner notices`.

## Comments
