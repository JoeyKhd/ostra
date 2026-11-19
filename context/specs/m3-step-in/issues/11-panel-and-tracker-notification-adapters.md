# 11: The panel and tracker notification adapters

Status: ready-for-agent
Builder: adapters
Blocked by: 04
Features: F-036
Packages: `packages/adapters/adapter-notify-panel` (new), `packages/adapters/adapter-notify-tracker` (new), `pnpm-lock.yaml`
Spec: `../spec.md`, sections 4 ("A notification") and 6; ADR 0050

## What to build

Two Apache-2.0 packages, each with one class that extends `NotificationAdapter`, one level deep (ADR 0025), a README and the package skeleton milestone 1's adapters have.

- **`adapter-notify-panel`** (`name: "panel"`, `channels: ["panel"]`, `edits: true`): it writes nothing itself. Its rows sit behind a `PanelNotificationRows` port (mark a notification delivered, update its state), which core implements on `packages/db` (ticket 20), as `adapter-blob-postgres` does with `BlobRows`. An in-memory implementation for tests.
- **`adapter-notify-tracker`** (`name: "tracker"`, `channels: ["tracker"]`, `edits: true`): constructed with a `TrackerAdapter` and the board. `send` posts one comment on the task's ticket: the moment in one sentence, the mentions of the recipients that have one, and the link to the task; `update` edits that comment (an answered approval, a coalesced moment). It works for any tracker with `comment` and `updateComment`, so the Jira fake runs it too (adapter parity). The comment's text comes from a pure renderer in this package, never from agent output; the subject line is the task's title, inside quotes.
- Both pass the notification contract suite (ticket 04): the panel one with its in-memory rows, the tracker one on the fake Linear server and on the Jira fake.
- `pnpm check:licenses` passes: neither imports a Sustainable Use package.

## Done when

- [ ] Tests: the suite passes for both; the tracker one sends one comment per key, edits on `update`, mentions only recipients with a mention, and posts on Linear and the Jira fake alike.
- [ ] `pnpm-lock.yaml` updated in the same commit.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm check:licenses` pass.
- [ ] Committed as `✨ add panel and tracker notifications`.

## Comments
