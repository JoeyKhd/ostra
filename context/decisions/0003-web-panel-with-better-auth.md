# A web panel, with team accounts through better-auth

**Status:** accepted (plan signed off 2026-11-17). First answered on 2026-11-17. The maintainer: "A webpage with better-auth so teammembers can join."

The control panel is a web app. Members sign up, are invited and sign in through better-auth, which also covers teams and invitations (its organization plugin) and enterprise sign-in later (F-004). A terminal or desktop panel isn't planned.

## Consequences

- The server is TypeScript (ADR 0008), so better-auth runs inside it.
- **v1 sign-in is username (or email) and password only** (the maintainer, 2026-11-18). GitHub sign-in and SSO come later as plugins (F-004).
- The first plugins ostra uses are the organization plugin and the device authorization plugin, for runners signing in from a terminal (`research/platform-auth-github.md`).
- better-auth ships breaking changes in minor versions, so its version is pinned exactly.
- better-auth's tables and ostra's share one Postgres database (ADR 0017).
