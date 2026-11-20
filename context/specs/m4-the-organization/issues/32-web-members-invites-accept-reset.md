# 32: Web: members, invitations, accepting and resets

Status: resolved
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
- *Changed 2026-11-19:* this ticket also grew `app-targets/m3/account` to list the account's organizations. With one organization per install in v1 there's nothing to list, so that moved to ticket 44 (`wontfix`, F-134 after v1).

## Done when

- [x] Playwright, named `it("F-002: ...")`: an admin invites, the invitee signs up through the link in a second context, and appears in the list; a revoked link shows its state; a reset by link changes the password and signs the other context out.
- [x] Each screen checked by eye against its target at 1440 px and at phone width, dark and light; differences fixed or listed under `## Comments`.
- [x] Committed as `✨ add members and invitations to the panel`.

## Decided 2026-11-19

Settled by the target's recommendation, on the maintainer's delegation (ticket 42, step 5); the maintainer may reopen any.

- **Sign-up on an invitation** (`accept-invite.md`): "Address in use" says the address has an account (open point 1); no confirm field, a show toggle instead (open point 2). Change-password and the reset page keep theirs.
- **The invitation's link is shown once** (`members.md`): `Copy link` lives only on an invitation made in this tab, as ADR 0053 and ticket 22 say; no stored readable link.
- **No "Leave" action** in milestone 4 (`members.md`). If one comes, it goes in the profile menu.
- **No sign-in after a reset** (`reset-password.md`, open point 1): the member signs in with the new password, so the link alone is never worth a session.
- **"Sent" names the address it was given** (`reset-password.md`, open point 2), to catch a typo; it reveals nothing the visitor didn't type.

## Comments

- 2026-11-20, builder: built to the targets on tickets 22 and 23's procedures. Members (`/organization/members`, `components/members/`), the invite sheet with the link shown once, `/invite/[invitation-id]` (sign-up with the address locked when email is set up, "Sign in to accept", "Check your inbox", and the expired, revoked and used pages), `/reset` and `/reset/new`, and "Forgot your password?" on the sign-in page only with email set up. Members sits under Organization for every member. Proved in `apps/web/e2e/10-members.spec.ts` on the e2e stack (no email, so the admin copies the link and the instance admin makes the reset link); break-its in `context/proof/F-002.md`.
- 2026-11-20, builder: three API additions rode in `✨ add the panel's reads for accounts and access`: `email.on` (public, for the pages before sign-in), `accounts.resetPreview` (public, rate-limited: valid with the address, used, expired or unknown), and the instance admin's link now opening `/reset/new?token=` like a mailed one, not better-auth's redirect. A fix rode too: the reset link's sink is one `AsyncLocalStorage` per process (`globalThis.ostraResetLinkSinks`), since Next loads `account-hooks.ts` once per route bundle and the panel's "Create reset link" got no link without it.
- 2026-11-20, builder, by-eye check at 1440 px and Pixel 7 width (the finals are `m4-<screen>-final.png` and `m4-<screen>-phone-final.png` in the builder's scratchpad `ui-check` folder). The panel has no light theme yet (`apps/web/src/app/globals.css` leaves it for later), so each screen was checked dark only. Differences left: the member panel has no `Invited by` and no `On their behalf` counts, and the removal dialog lists what removal ends without counts, since `members.list` returns neither; a removed member's row reads `removed {date}` without who removed them; a member with no restricted grant shows `Open projects` in the Projects column. The accept page's email-on states (locked address, "Check your inbox") are drawn but the e2e stack has no mail, so ticket 22's API tests prove them.
- 2026-11-20, builder: the commit is 0c74e999 (`✨ add members and invitations to the panel`); the API additions are d25bd5c8 (`✨ add the panel's reads for accounts and access`). Typecheck, lint and test of `@ostra/api` and `@ostra/web` through turbo, `check:licenses`, `check:proof` and the root tsc were green before the push. The whole Playwright suite's other failures (`01-shell`'s F-001 "milestone 2" line, `02-setup`'s checklist order, `03-first-run`, `07-prompt-task`, `08-agent-profiles`' task start) fail the same way without these changes, and the phone project only runs when every desktop spec passes, so the phone checks ran on their own at Pixel 7 width.
- 2026-11-20, apps/web review: the differences left against `members.md` are built. `members.list` gives an admin `invitedBy` (from the accepted invitation), `removedBy` and `onBehalf` (active personal runners, unrevoked CLI sessions, tasks they drive, draft comments, pending invitations they sent, with `removeMember`'s filters); a member's view gets `null` for each. The panel has the Organization group's "Invited by", the "On their behalf" group, the removal dialog's lines with their counts (only those not zero), and a removed row's "removed 14 Nov by Alex Kim". One deviation from the target's text: "On their behalf" uses a 132px key column, since 96px cut "Personal runners" and "Tasks they drive" (the picture draws it wider too). Proof in `context/proof/F-002.md`. Checked by eye at 1440 px and 390 px. Commit: `🐛 fix review findings in apps/web`.
