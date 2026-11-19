# 33: Web: project access and the instance's accounts

Status: ready-for-agent
Builder: web
Blocked by: 23, 31, 43 (it was also 24, which is `wontfix` since 2026-11-19)
Features: F-087, F-003, F-002 (the instance admin's reset link)
Note: changed 2026-11-19. One team runs each install, so v1 ships one organization per install, and several organizations (F-134) moved after v1 on the maintainer's word. The switcher and the instance's Organizations page moved to ticket 44, which is `wontfix` until F-134, and this ticket keeps project access and the instance's Accounts page. Its title was "Web: project access, the switcher and the instance's organizations".
Packages: `apps/web` (`src/components/shell/`, `src/app/(panel)/projects/[project-id]/settings/access/`, `src/app/(panel)/instance/accounts/`)
Spec: `../spec.md`, sections 3 (steps 2, 12) and 12; targets `project-access`, `instance-settings` (its Accounts page, `instance-settings-accounts.webp`)

## What to build

- **Project access** to the `project-access` target, in the project's settings: open or restricted, listed members with project roles, "Add member" from the organization's active members, and the line that organization admins always see it. Read-only for project members.
- **The instance's Accounts page** (`/instance/accounts`) to `instance-settings`' page 2, for the instance admin only: accounts found by username or address, "Create reset link" (shown once) and the instance admins, with the last one kept, from ticket 43's procedures and ticket 22's `accounts.createResetLink`. *Changed 2026-11-19: open sign-up's two switches are out (ADR 0026, amended), and the target's "Creating organizations" and "Sign-up" sections with them. Changed again 2026-11-19: the Organizations page (`/instance/organizations`, page 1) moved to ticket 44.* The sidebar shows it under "Instance" to the instance admin alone, with Storage and Email as the target says, and no Organizations row.
- **The sidebar's organization row** stays as milestone 1 built it: the organization's name at the top of the sidebar. Its menu of organizations and "New organization" are ticket 44's.
- **What a member can't do is absent,** not disabled: admin pages and actions don't render for a member, and a direct URL shows "not found" or "Only admins can open this", as the API answers.

## Done when

- [ ] Playwright, named `it("F-087: ...")`: a restricted project disappears from an unlisted member's sidebar at once.
- [ ] Playwright, named `it("F-003: ...")`: the Accounts page and its "Instance" group render for the instance admin only, and the last instance admin's own row has no "Remove".
- [ ] Each screen checked by eye against its target, dark and light, at 1440 px and phone width.
- [ ] Committed as `✨ add project access and the instance's accounts`.

## Comments

- 2026-11-19, lead: trimmed. The switcher, the Organizations page and the `F-049` Playwright cases for switching moved to ticket 44 (`wontfix`, F-134 after v1). Before that, this ticket's tests were: "a member of two organizations switches and every page follows; a link into the other organization switches with the notice".
