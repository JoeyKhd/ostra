# 37: API: notification choices and email settings

Status: done
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

- [x] Tests: a member's choices save and read back with defaults; an organization admin who isn't the instance admin can't change email; secrets never come back; locked settings refuse a save; the test mail's result returns; another organization's members' choices are untouched.
- [x] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `api`.
- [x] Committed as `✨ add notification and email settings API`.

## Decided 2026-11-19

Decided on the maintainer's delegation while preparing the build, from the open points of the milestone 3 targets (`context/brand/app-targets/m3/`) and the spec's gaps. If the maintainer disagrees with one, it goes back to `context/open-questions.md` and this section changes.

- **`notifications.preferences.get` adds** (`notification-settings.md`, "Data"): the connected tracker's name or none; the email delay in seconds (the instance setting, or `OSTRA_EMAIL_DELAY_SECONDS`); when the member's choices were last saved (the latest `NotificationPreference.updatedAt`, ticket 06), or never; and whether the viewer is the instance admin.
- **`email.settings.get` adds** (`email-settings.md`, "Data"): the delay in effect; the values of the non-secret settings that are set (`OSTRA_EMAIL_PROVIDER`, `OSTRA_EMAIL_FROM` and the SMTP host, port, security and user), never a secret's; the last email audit entry (who, what, when); and the admin's own address.

## Comments

- 2026-11-19: done in `727a8ba`. `notifications.preferences` (`routers/notifications.ts`, whose list and count ticket 36 adds) and `email` (`routers/email.ts`) are in; `saveNotificationPreferences`, `saveEmailSettings` and `recordEmailTest` are written in `packages/domain/src/use-cases/notification-settings.ts`. `SaveEmailSettings`' actor gained `memberId` and `organizationId` (additive: the secrets live in the saving admin's namespace, and the audit entry names the member). The test mail goes through `ApiDeps.email` (an `EmailDirectory` that builds the adapter for a configuration): `createApiRuntime` takes it as `email`, and `apps/web` has no Resend or SMTP adapter to hand it until tickets 12 and 13 land, so "Send a test mail" answers "This build has no ... adapter" until then; a test supplies a fake adapter. Proof rows: F-115 (3 partial) and F-036 (row 2 gains the choices' tests).
