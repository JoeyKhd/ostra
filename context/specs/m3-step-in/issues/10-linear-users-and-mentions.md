# 10: Linear adapter: users and mentions

Status: ready-for-agent
Builder: adapters
Blocked by: 04
Features: F-036, F-026 (an approval on the ticket)
Packages: `packages/adapters/adapter-linear`
Spec: `../spec.md`, section 5.2 ("`TrackerAdapter`"); ADR 0050

## What to build

- **`findUsersByEmail(board, emails)`** through GraphQL `users(filter: { email: { in: [...] } })`, active users only, with the app's token (milestone 2's connection). Linear's mention is the user's profile URL in markdown (`[@Name](https://linear.app/<workspace>/profiles/<name>)`), which notifies the user; check it against the fake and once live.
- **Capability `mentions: true`.**
- **The fake Linear server** (milestone 2's) gains users with emails, and records the mentions in comments it receives.
- The tracker contract suite's new cases (ticket 04) pass against the adapter on the fake.
- Cache nothing about people beyond the delivery: the adapter returns the match, and core keeps it only in the delivery row's recipients.

## Done when

- [ ] Tests: the suite passes on the fake; live, gated on `linear.env`: the maintainer's own address is found in `ostra-test`, a comment on a test ticket in `OST` with that mention notifies (seen once by hand, recorded here), and the ticket is archived.
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `adapter-linear`.
- [ ] Committed as `✨ add Linear users and mentions`.

## Comments
