# 22: API: invitations, sign-up, verification and resets

Status: ready-for-agent
Builder: api
Blocked by: 06, 19
Features: F-002
Packages: `packages/api` (`src/auth/create-auth.ts`, `src/auth/`, `src/routers/members.ts` (new), `src/routers/accounts.ts` (new))
Spec: `../spec.md`, section 4 ("An invitation", "A reset"); ADR 0053, ADR 0003

## What to build

- **`members.invite`** (organization admin): an address, a role, and restricted projects with a role each (each checked to be a project of the organization). Through better-auth's organization plugin, with the `owner` block, plus ostra's `projectGrants` and an audit entry, and `account-mail.send` when email is set up, in one transaction. Returns the link once (`linkShownAt` set); a second read of the invitation never returns it. `members.revokeInvitation` and `members.invitations` (pending, accepted, revoked, expired, without links).
- **Sign-up through the link:** the `before` hook on `/sign-up/email` (ported from `spikes/auth-foundation/src/auth/create-auth.ts`) lets through the first account, an invitee whose pending, unexpired invitation's ID the request carries, or anyone when open account sign-up is on. The account, the membership (`pending_verification` with email set up, `active` without), the project grants and the invitation's acceptance are one transaction. The address on the form must equal the invitation's when email is set up; without email it's taken as written.
- **An existing account:** `invitations.accept` for a signed-in account whose invitation it is by ID, adding the membership and grants.
- **Verification:** with email on, better-auth's verification mail callback enqueues `account-mail.send`; its verify callback moves the membership to `active` and records `member.verified`.
- **Resets:** with email on, "Forgot your password?" (better-auth's reset request) mails a verified address and answers the same either way; `accounts.createResetLink` (instance admin only, ported from `src/auth/link-sink.ts`) returns the link once. Either reset revokes the account's other sessions and its CLI sessions, writes `ResetLinkGrant` by token hash, and is an audit entry in each of the account's organizations.
- **The public reads** for the pages: `invitations.preview(id)` → the organization's name, the inviter's name, the address (locked or not), and the state, nothing more, rate-limited by IP.

## Done when

- [ ] Integration tests through better-auth's HTTP, named `it("F-002: ...")`, ported from `spikes/auth-foundation/src/scenarios/accounts.ts` and `reset-link.ts`: sign-up refused without an invitation; allowed by its ID; refused for a stranger who knows only the address; one use; refused after 7 days (clock) and after a revoke; `owner` refused; with email on, a membership stays pending until verified and a pasted link alone activates nothing; an existing account joins without a second account; a reset link works once within 24 hours and signs out the other sessions; a member who isn't the instance admin can't create one; "Forgot your password?" answers the same for an unknown address.
- [ ] Break-it checks recorded in `context/proof/F-002.md`.
- [ ] No link, token or address in a log line (searched by value).
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add invitations and resets`.

## Decided 2026-11-19

Settled by the target's recommendation, on the maintainer's delegation (ticket 42, step 5); the maintainer may reopen any.

- **How long a verification link works** (`email-account.md`): 24 hours, the reset link's value in ADR 0053, through better-auth's `emailVerification.expiresIn`; no new setting. "Send it again" on the "Check your inbox" page (`accept-invite.md`) asks for a fresh one.
- **"Address in use" on an invitation's sign-up** (`accept-invite.md`, open point 1): it says the address has an account, since only the link's holder sees it and the address is the invitation's.

## Comments
