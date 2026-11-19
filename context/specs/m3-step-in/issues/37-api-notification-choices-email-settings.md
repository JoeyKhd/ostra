# 37: API: notification choices and email settings

Status: ready-for-agent
Builder: api
Blocked by: 20, 21
Features: F-036, F-115
Packages: `packages/api` (`routers/notifications.ts`, `routers/email.ts` (new))
Spec: `../spec.md`, sections 4 and 5.4; ADR 0050

## What to build

- **`notifications.preferences.get` and `.save`:** the member's own choices per kind and channel, with the defaults shown for kinds they never changed, and whether mail is on for the install.
- **`email.settings.get`** (instance admin): the provider, the from address and name, Resend's key or SMTP's host, port, security and user, each secret shown only as "set" or "not set", `lockedBySettings` with the setting names that lock it, the last test's time and result.
- **`email.settings.save`** (instance admin; refused while locked): secrets into the secret store; an audit entry naming the provider, never a value.
- **`email.sendTest`** (instance admin): sends the test mail to the admin's own address, and returns the result in words.
- **`email.status`** (any member): on or off, for the panel's "Mail is off on this install".

## Done when

- [ ] Tests: a member's choices save and read back with defaults; an organization admin who isn't the instance admin can't change email; secrets never come back; locked settings refuse a save; the test mail's result returns; another organization's members' choices are untouched.
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `api`.
- [ ] Committed as `✨ add notification and email settings API`.

## Comments
