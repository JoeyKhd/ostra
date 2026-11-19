# A web panel, with accounts through better-auth

**Status:** accepted (plan signed off 2026-11-17). Amended 2026-11-18: the organization plugin maps to Organization, the username plugin, the device authorization plugin and the instance admin are added, and sign-in is as Q54 says (Q54, Q102, ADR 0026). **Amended again 2026-11-18 after spike 9** (`research/spike-auth-foundation.md`): the username plugin fits and the email-only fallback is dropped, `bearer` joins the plugin list, and the list of what better-auth lacks and ostra builds is added. First answered on 2026-11-17. The maintainer: "A webpage with better-auth so teammembers can join."

The control panel is a web app. Members sign up, are invited and sign in through better-auth, which also covers organizations and invitations (its organization plugin, which maps to ostra's Organization, ADR 0026) and enterprise sign-in later (F-004). A terminal or desktop panel isn't planned.

## Consequences

- The server is TypeScript (ADR 0008), so better-auth runs inside it.
- **v1 sign-in is a username or an email, plus a password** (the maintainer, 2026-11-18; Q54). GitHub sign-in and SSO come later as plugins (F-004).
  - Every account has a unique username and an email address, and a member signs in with either one.
  - An invite is a link. An admin can copy it, and ostra also mails it when email is set up (Resend, or SMTP; ADR 0007).
  - Without email, an admin creates a one-time reset link for a member who forgot their password.
  - Email addresses are verified only when email is set up.
  - Spike 9 (`auth-foundation`) confirmed the username plugin: a member signs in by username and by email on better-auth 1.7.25 with Prisma 7.10.1. So the fallback, "members sign in with their email only", doesn't apply and is dropped.
- The plugins ostra uses are:
  - the organization plugin
  - the username plugin
  - the device authorization plugin, for a member's personal runner signing in from a terminal (a pool runner joins with a join token instead, ADR 0029)
  - the admin plugin, for the instance admin
  - the `bearer` plugin. The device flow's token is "a Better Auth session token, not an RFC 8628 OAuth access token", and using it as a bearer token needs this plugin. The device flow's session is a full member session and its `scope` narrows nothing, so the personal runner trades it for a runner-only key at once (ADR 0029, Q115).
- **What better-auth lacks, and ostra builds** (spike 9). Each is a small piece of ostra's own code with its own test, in the server's auth package:
  - **Invite-only sign-up.** The library has no such mode: `disableSignUp` is all or nothing and would turn invitees away. ostra's `before` hook on the sign-up path lets through the first account, an invitee, or anyone when open sign-up is on. **The invitee is recognised by the invitation's ID, never by the address:** with no mail server nothing proves the mailbox, so matching the address alone would let a stranger who knew an invited address sign up as it.
  - **An admin's reset link.** The admin plugin has `set-user-password` and no "create a reset link". ostra calls the library's password-reset request for the target and catches the link it hands to its mail callback, into a per-request sink that only the asking admin reads. A reset also revokes the account's other sessions, which the library does only when told to. Only the instance admin may create one (F-002, Q116).
  - **The `owner` role block.** The library keeps its built-in role names valid whatever is registered, so an invitation for `owner` would pass and give a member a role ostra never defined. ostra's organization hooks refuse any role that isn't exactly `admin` or `member` (ADR 0026).
  - **The first account is the instance admin and the admin of the first organization** (F-001). *Amended 2026-11-19: the server seeds it at start, `demo@demo.com` / `demo` unless `OSTRA_ADMIN_*` says otherwise, flagged to change its password at the first sign-in; Q117's setup token is superseded (ADR 0026, "The first admin").* The promotion runs under a Postgres advisory lock so only one account gets it. Spike 9 made the instance admin but never created the first organization, so ostra creates it with the first account.
  - **Each new sign-in method needs its own invite check.** The sign-up gate acts on one path (`/sign-up/email`), and the GitHub or SSO sign-up that F-004 adds later creates accounts on other paths.
- **Versions.** better-auth and Prisma are both pinned exactly. Prisma's `latest` tag on npm is now the 8 release candidate, which better-auth's adapter doesn't support, so an unpinned install breaks the stack. The spike ran better-auth 1.7.25 and Prisma 7.10.1, and `@prisma/adapter-pg` is required (ADR 0007).
- **The schema** comes from better-auth's own generator, with ostra's edits marked in the file (a unique `(organizationId, userId)` on a membership, and the composite keys of ADR 0026). Nothing checks a Prisma schema against better-auth at start-up, so a contract test (sign up, session, role, and a check of the generated tables) is the upgrade gate. A better-auth upgrade doesn't merge until it is green.
- **Rate limits.** better-auth's limiter is on in production and off in development, and keeps its counts in memory by default, so with several replicas the counts live in Postgres. The sign-in and device endpoints get limits in milestone 4 (F-002), before the device flow ships in milestone 5, and the device user code (8 characters) is part of that. Spike 9 did not test them.
- The first account is the instance admin, and it can create more organizations (Q102, F-001), after v1 since 2026-11-19 (F-134, ADR 0026). Roles inside an organization and a project are in ADR 0026.
- Members link their GitHub account once, to prove who they are. That link is for identity only, and it isn't GitHub sign-in (F-119, ADR 0040).
- better-auth ships breaking changes in minor versions, so its version is pinned exactly.
- better-auth's tables and ostra's share one Postgres database (ADR 0017).
