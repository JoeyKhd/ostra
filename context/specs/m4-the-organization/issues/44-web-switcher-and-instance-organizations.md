# 44: Web: the organization switcher and the instance's Organizations page

Status: wontfix
Note: Won't do now (2026-11-19): split from ticket 33 when several organizations per install (F-134) moved after v1. One team runs each install, with its clients as projects inside one organization; the lead proposed moving F-049's multi-organization features after v1, and the maintainer answered "sure". This ticket holds ticket 33's multi-organization half as it was written, and waits for F-134.
Builder: web
Blocked by: 24, 31, 33
Features: F-134 (F-049 until 2026-11-19)
Packages: `apps/web` (`src/components/shell/`, `src/app/(panel)/instance/organizations/`)
Spec: `../spec.md`, section 12; targets `org-switcher`, `instance-settings` (its Organizations page, `instance-settings.webp`)

## What to build

- **The switcher** to `org-switcher`, at the top of the sidebar: the member's organizations, the active one marked, "New organization" for whoever `organizations.create` lets create one (the instance admin), the create sheet. A link to a record of another of the member's organizations switches through `organizations.resolve` and shows "Switched to <organization>".
- **The instance's Organizations page** (`/instance/organizations`) to `instance-settings`' page 1, for the instance admin only: organizations with their counts, and "New organization" with the switcher's create sheet. Its "Creating organizations" section is out (open sign-up isn't planned, ADR 0026). The sidebar's "Instance" group gains its Organizations row.
- **Growing:** `app-targets/m3/account` lists the account's organizations (from spec section 12's second list).

## Done when

- [ ] Playwright, named `it("F-134: ...")`: a member of two organizations switches and every page follows; a link into the other organization switches with the notice; only the instance admin sees "New organization".
- [ ] Each screen checked by eye against its target, dark and light, at 1440 px and phone width.
- [ ] Committed as `✨ add the organization switcher`.

## Comments

- 2026-11-19, lead: made `wontfix` from ticket 33's text. Several organizations per install (F-134) moved after v1 on the maintainer's word, and this ticket waits for it.
