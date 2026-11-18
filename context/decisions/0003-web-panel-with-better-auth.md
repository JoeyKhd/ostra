# A web panel, with accounts through better-auth

**Status:** accepted (plan signed off 2026-11-17). Amended 2026-11-18: the organization plugin maps to Organization, the username plugin, the device authorization plugin and the instance admin are added, and sign-in is as Q54 says (Q54, Q102, ADR 0026). First answered on 2026-11-17. The maintainer: "A webpage with better-auth so teammembers can join."

The control panel is a web app. Members sign up, are invited and sign in through better-auth, which also covers organizations and invitations (its organization plugin, which maps to ostra's Organization, ADR 0026) and enterprise sign-in later (F-004). A terminal or desktop panel isn't planned.

## Consequences

- The server is TypeScript (ADR 0008), so better-auth runs inside it.
- **v1 sign-in is a username or an email, plus a password** (the maintainer, 2026-11-18; Q54). GitHub sign-in and SSO come later as plugins (F-004).
  - Every account has a unique username and an email address, and a member signs in with either one.
  - An invite is a link. An admin can copy it, and ostra also mails it when a mail server is set.
  - Without a mail server, an admin creates a one-time reset link for a member who forgot their password.
  - Email addresses are verified only when a mail server is set.
  - The username plugin isn't covered by the research files, so spike 9 (`auth-foundation`) confirms it. If it doesn't fit, members sign in with their email only.
- The plugins ostra uses are:
  - the organization plugin
  - the username plugin
  - the device authorization plugin, for a member's personal runner signing in from a terminal (a pool runner joins with a join token instead, ADR 0029)
  - the admin plugin, for the instance admin
- The first account is the instance admin, and it can create more organizations (Q102, F-001). Roles inside an organization and a project are in ADR 0026.
- Members link their GitHub account once, to prove who they are. That link is for identity only, and it isn't GitHub sign-in (F-119, ADR 0040).
- better-auth ships breaking changes in minor versions, so its version is pinned exactly.
- better-auth's tables and ostra's share one Postgres database (ADR 0017).
