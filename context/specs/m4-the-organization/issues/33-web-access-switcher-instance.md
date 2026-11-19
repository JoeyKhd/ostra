# 33: Web: project access, the switcher and the instance's organizations

Status: ready-for-agent
Builder: web
Blocked by: 23, 24, 31
Features: F-087, F-049, F-003
Packages: `apps/web` (`src/components/shell/`, `src/app/(panel)/projects/[project-id]/settings/access/`, `src/app/(panel)/instance/`)
Spec: `../spec.md`, sections 3 (steps 2, 12) and 12; targets `project-access`, `org-switcher`, `instance-settings`

## What to build

- **Project access** to the `project-access` target, in the project's settings: open or restricted, listed members with project roles, "Add member" from the organization's active members, and the line that organization admins always see it. Read-only for project members.
- **The switcher** to `org-switcher`, at the top of the sidebar: the member's organizations, the active one marked, "New organization" for whoever `organizations.create` lets create one (the instance admin), the create sheet. A link to a record of another of the member's organizations switches through `organizations.resolve` and shows "Switched to <organization>".
- **The instance's pages** (`/instance/organizations`, `/instance/accounts`) to `instance-settings`, for the instance admin only: organizations with their counts, accounts with "Create reset link" (shown once) and instance admins. *Changed 2026-11-19: open sign-up's two switches are out (ADR 0026, amended), and the target's "Creating organizations" and "Sign-up" sections with them.* The sidebar shows them under "Instance" to the instance admin alone.
- **What a member can't do is absent,** not disabled: admin pages and actions don't render for a member, and a direct URL shows "not found" or "Only admins can open this", as the API answers.

## Done when

- [ ] Playwright, named `it("F-087: ...")` and `it("F-049: ...")`: a restricted project disappears from an unlisted member's sidebar at once; a member of two organizations switches and every page follows; a link into the other organization switches with the notice.
- [ ] Each screen checked by eye against its target, dark and light, at 1440 px and phone width.
- [ ] Committed as `✨ add project access and the organization switcher`.

## Comments
