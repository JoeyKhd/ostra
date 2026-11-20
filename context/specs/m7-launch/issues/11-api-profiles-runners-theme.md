# 11: API: the theme

Status: resolved
Builder: api
Blocked by: 36 (it was also 05 and 09, which are `wontfix` since 2026-11-19)
Features: F-082
Note: changed 2026-11-19. Claude Code (F-018) moved after v1, so this ticket keeps the theme alone. `agents.list`, the grown `agentProfiles.save` and `models.list`, a runner's agents and `runners.prepareAgent` wait with F-018; they're in this file's history.
Packages: `packages/api`
Spec: `../spec.md`, sections 4 and 5.4

## What to build

- **`account.setTheme`** and the theme in the session's payload, with the cookie set on the response.
- The procedure checks the session, as milestones 1 to 6's do: a member sets only their own theme.

## Done when

- [x] Tests named for `F-082`: `setTheme` saves the choice and sets the cookie; another member's theme is untouched.
- [x] The whole-repo checks pass (spec section 10).
- [x] Committed as `✨ add the theme to the API`.

## Comments

- 2026-11-20, api: built. `account.setTheme({ theme })` (a member procedure; the input is the theme alone, strict, so no other account can be named) saves through the domain's `setTheme` and sets `ostra-theme=<theme>; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly` (and `Secure` when `OSTRA_PUBLIC_URL` is https) on the response. The theme is in the session's payload twice: better-auth's own user (an additional field with `input: false`, so no profile update sets it) and `me.get`'s `theme`. Tests in `packages/api/src/routers/theme.test.ts`: the choice saved, the cookie set, the audit entry, the same choice again a no-op, the other member untouched; a fourth theme and an extra `userId` refused; and a real better-auth sign-in whose session carries the saved theme while `updateUser` can't set it. Break-its: the `Set-Cookie` dropped failed the first; `setTheme` writing every account failed both. The cookie is `HttpOnly`: the root layout reads it on the server (ticket 18), and the panel's own toggle goes through this procedure.
