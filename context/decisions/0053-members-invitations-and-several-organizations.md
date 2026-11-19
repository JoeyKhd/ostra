# Members, invitations and several organizations

**Status:** accepted (2026-11-19, on the maintainer's delegation for milestone 4's spec). Settles Q191 to Q196 and Q208. Covers F-002, F-003, F-087 and F-049, and builds on ADR 0003 (better-auth, and what ostra builds on top of it), ADR 0026 (organizations, projects and the access matrix) and ADR 0050 (the email channel).

Milestone 4 is where a second person arrives. ADR 0026 fixed who sees what, and ADR 0003 how an invitation and a reset link work inside better-auth. This ADR settles what neither said: what removing a member does, who may invite to what, how an address is verified, how a member moves between organizations, and how isolation is proved for every kind of record.

## Invitations

- **Organization admins invite** (Q192). An invitation names an address, an organization role (`admin` or `member`, anything else refused, ADR 0026) and, optionally, the restricted projects the invitee joins with a project role each. A project admin doesn't invite new people: they add the organization's existing members to their project (F-087).
- **The link is the invitation's ID,** at least 128 random bits, and it's the secret (F-002). The panel shows it once with "Copy link" and the line "Send it privately: anyone with this link can join as this person". With email set up, ostra also mails it.
- **An address that already has an account** joins without a new account: the link asks them to sign in, and then to accept. The account belongs to every organization it joined (ADR 0026).
- **Without email,** the link alone is enough, and the address is taken as written, unverified (F-002, Q118).
- **With email set up** (Q193), the address on the sign-up form is the invitation's, locked, and the account is created unverified. ostra mails a verification link to that address at once, and the membership becomes active when the link is opened. Until then the invitee sees "Check your inbox" and nothing of the organization. So a pasted link still can't make a stranger a member: they would need the mailbox too.
- **One use, 7 days, revocable** *(working value)*, as F-002 says. An expired, revoked or used link shows which it is and who to ask, and never the organization's members.

## Resets

- **Without email, only the instance admin** creates a reset link (F-002, Q116): one use, 24 hours *(working value)*, shown once. ADR 0003's sink catches the link better-auth hands its mail callback, for the asking admin only.
- **With email set up, a member resets their own password** (Q193): "Forgot your password?" on the sign-in page mails a reset link to the account's address, if it's verified. The page says the same thing whether or not the address has an account, so it can't be used to find accounts. The instance admin's link still works.
- **Every reset signs out the account's other sessions** and revokes its CLI sessions (F-103), and is an audit entry in each of the account's organizations, by ID.

## Removing a member

Q191. **Removal is ostra's own use case, not better-auth's `removeMember`,** whose endpoint ostra's hooks refuse, so that history keeps its names:

- The membership is marked removed (`removedAt`, `removedByMemberId`), never deleted. Audit entries, events and task records keep pointing at it, and show the person's name with "(removed)".
- In the same transaction: the member's project roles go, their personal runners in that organization are revoked (F-014's revoke), their CLI sessions are revoked, they stop driving any task (each task gets a `driver.changed` to nobody, and its needs-you items fall back to the project's members), their draft diff comments are deleted, and their pending invitations are revoked.
- The account stays: it may belong to other organizations. An account with no active membership signs in to a page that says so.
- A removed member invited again gets a new membership, and the old one stays removed.

## Roles, and the last admin

Q194. **An organization always has an admin:** the last one can't be demoted, removed or leave, checked under a row lock as `setMemberRole` already does. **An install always has an instance admin:** the instance admin can make another account an instance admin, and the last one can't give it up. The instance admin role is about the install (organizations, email, retention); it grants no access inside an organization the account isn't a member of.

The matrix stays ADR 0026's: an organization admin is an admin of every project; a project member starts, drives and reopens tasks; a project admin edits the project. Every procedure checks it through `requireProjectAccess`, and a refusal of a project the member can't open is `NOT_FOUND`, never `FORBIDDEN`, so its existence doesn't leak.

## Several organizations

Q195.

- **The active organization lives in the session** (better-auth's `activeOrganizationId`, which the panel already reads), and the account remembers the last one for its next sign-in. The sidebar's switcher lists the member's organizations and changes it.
- **Links work across organizations.** IDs are unique per install, so a link to a record in another of the member's organizations switches to it, and the panel says "Switched to <organization>". A link to a record in an organization the member doesn't belong to is "not found", like any other.
- **The instance admin creates organizations** (ADR 0026). The creator is its admin. *Changed 2026-11-19: open organization sign-up, which let any account create one, is no longer planned (ADR 0026).* A new organization gets what the first one got at the seed: a default pool and the built-in agent profile. It has no model provider, GitHub App or Linear connection until its admin adds them (each organization has its own, ADR 0026).
- **What is per organization stays per organization:** a member's personal runner, CLI session and notification choices belong to one membership. A person in two organizations registers a runner in each.

## Proving isolation for every kind of record

Q196. F-049 asks for a test per kind of record. **The test is generated from the schema:**

- A list in `packages/db` names every Prisma model with an `organizationId` and a fixture builder for it. A model without `organizationId` must be on a short reviewed allowlist (the account tables, the device code, the instance's settings and email settings). A test reads the schema's model list and fails when a model is on neither list, so a new table can't skip the check.
- For each listed model, the test seeds a row in organization A and one in organization B, then calls every tRPC procedure that lists or reads that kind as a member of A, and asserts B's row appears in none of them, by ID. The same run does it as a member of A who can't open a restricted project, for every project record (F-087).
- Search, the audit log, Insights, memory and the live stream are in the list, since each reads across many tables.
- Spike 9's `isolation` scenario (`spikes/auth-foundation/src/scenarios/isolation.ts`) is the template.

## For development only

Q208. The demo needs the reviewer user of `GITHUB_TEST_REVIEWER_TOKEN` linked to a member, and the scripted run can't sign in to GitHub in a browser. **`pnpm dev:link-github <username> <github-login>`** reads the GitHub user's ID with the test token and writes the link as F-119's callback would. Like `pnpm dev:seed-member` (Q165), it refuses to run unless `NODE_ENV` is `development` or `test`, and production builds leave it out. The manual run links through the App's OAuth for real.

## Considered options

- **better-auth's `removeMember`.** Rejected: it deletes the row, so every reference to the member would cascade away or dangle, and the audit log would lose who did what.
- **Project admins inviting new people.** Rejected for v1: inviting adds someone to the organization, and the organization admin owns who belongs (F-003).
- **Matching an invitee by address, with email on.** Rejected: the link's ID stays the key (Q118). Verification is added on top, not instead.
- **Self-service resets without email.** Rejected: nothing would prove the person owns the account (Q116).
- **The organization in the URL** (`/o/<slug>/…`). Rejected for now: every route and link would change for no gain while IDs are unique. *Changed 2026-11-19: this added that a hosted version with custom domains could add it, and none is planned (ADR 0001).*
- **A hand-written isolation test per model.** Rejected: the next table would be forgotten. The generated list fails until it's added.

## Consequences

- `Member` gains `removedAt` and `removedByMemberId`; `Invitation` gains its project grants and the state it's in; the account remembers its last organization (milestone 4's spec, section 5.3).
- Every query on members filters out removed ones, except the ones that show history.
- Mail for invitations, verification and resets goes through ADR 0050's email channel as account mails: sent at once, with no delay and no choice to turn them off, since the person can't sign in to choose.
- The glossary gains Invitation, Reset link and Instance admin.
- Revisit when F-004 brings SSO and SCIM: an identity provider may then own who belongs, and removal follows it.
