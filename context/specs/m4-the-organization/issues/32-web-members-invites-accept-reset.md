# 32: Web: members, invitations, accepting and resets

Status: ready-for-agent
Builder: web
Blocked by: 22, 23, 31
Features: F-002, F-003
Packages: `apps/web` (`src/app/(panel)/organization/members/`, `src/app/invite/[invitation-id]/`, `src/app/reset/`, `src/app/sign-in/`)
Spec: `../spec.md`, sections 3 (steps 1, 14) and 12; targets `members`, `member-invite`, `accept-invite`, `reset-password`, `email-account`

## What to build

- **Members** (`/organization/members`) to the `members` target: the active list, pending invitations with "Copy link" and "Revoke", removed members folded, the row menu for role and removal with a confirmation that lists what removal does (ADR 0053). Members who aren't admins see the list without addresses or actions.
- **The invite sheet** to `member-invite`: the address, the role, restricted projects with roles; then the link once with "Copy link", "Send it privately", and "Mailed to …" or "Mail is off on this install".
- **The invitation page** (`/invite/[invitation-id]`) to `accept-invite`: from `invitations.preview`; sign-up with the locked address, or "Sign in to accept" for an existing account; "Check your inbox" while verification is pending; the expired, revoked and used states. Outside the panel's shell, like sign-in.
- **Resets** to `reset-password`: "Forgot your password?" on the sign-in page when email is set up (hidden otherwise), and the page a reset link opens, with the password policy's checks.
- **The sidebar** gains Members under Organization for every member.
- **Growing:** `app-targets/m3/account` lists the account's organizations; write the changes against it under `## Comments`.

## Done when

- [ ] Playwright, named `it("F-002: ...")`: an admin invites, the invitee signs up through the link in a second context, and appears in the list; a revoked link shows its state; a reset by link changes the password and signs the other context out.
- [ ] Each screen checked by eye against its target at 1440 px and at phone width, dark and light; differences fixed or listed under `## Comments`.
- [ ] Committed as `✨ add members and invitations to the panel`.

## Comments
