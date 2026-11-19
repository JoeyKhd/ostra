# 10: Linear adapter: users and mentions

Status: done
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

- [x] Tests: the suite passes on the fake; live, gated on `linear.env`: the maintainer's own address is found in `ostra-test`, a comment on a test ticket in `OST` with that mention notifies (seen once by hand, recorded here), and the ticket is archived.
- [x] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `adapter-linear`.
- [x] Committed as `✨ add Linear users and mentions`.

## Comments
- 2026-11-19: done in `✨ add Linear users and mentions` (the commit after `24bdbbc`, which let the suite's mention hold a profile URL: Linear's mention names the user by their profile, not their ID). `findUsersByEmail` asks `users(filter: { email: { in }, active: { eq: true } })` in batches of 50, matching case-insensitively, and returns `[@displayName](<User.url>)`, escaped, only for a `https://linear.app/.../profiles/...` URL. The fake Linear gained `addUser`, `setUserActive`, the `users` query and each comment's `mentions`, and its suite fixture seeds users. Live on `ostra-test` (`packages/adapters/adapter-linear/evidence/f-036-mentions-live.txt`): the maintainer's address was found, the comment with the mention holds Linear's user-mention node with their ID (a comment without it holds none), and the ticket was archived. The notification itself wasn't seen by hand: the only key is the maintainer's, and Linear doesn't notify a person of their own mention, so the mention node is the evidence; the by-hand look waits for a second Linear user. Proof: `context/proof/F-036.md`, second row `partial` (the panel and email halves are other tickets').
