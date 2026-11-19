# 11: API: the theme

Status: ready-for-agent
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

- [ ] Tests named for `F-082`: `setTheme` saves the choice and sets the cookie; another member's theme is untouched.
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✨ add the theme to the API`.

## Comments
