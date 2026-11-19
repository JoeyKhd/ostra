# 37: Web: repo checks, the ticket template, storage and retention

Status: done
Builder: web
Blocked by: 31, 32 (the targets' approval, for the UI)
Features: F-055, F-060, F-064, F-114, F-079
Packages: `apps/web` (`src/components/projects/`, `src/app/(panel)/organization/storage/`, `messages/en.json`)
Spec: `../spec.md`, sections 3 (the checks after the run) and 12 (screens 8 to 10)

## What to build

To the approved targets for screens 8 to 10.

- **Repo checks** on the project's repos and on the new-task form: "Default branch not protected", with the reason it's allowed and how to protect it; "Requires signed commits: not supported yet", which disables starting a task; "Couldn't check", with the reason.
- **The ticket template editor** in the project's settings: the template, the placeholders it may use, a validation message, and a preview on a chosen Inbox ticket. Project admins only.
- **Storage and retention** in the organization's settings: the store in use, the blob count and total size, the cap, whether S3 is configured; the retention period (none by default) with a confirmation that says what will be deleted. Instance admins only.
## Decided 2026-11-19 (ticket 40)

The lead, on the maintainer's delegation, settled the open points the milestone 2 targets (`context/brand/app-targets/m2/`) and ticket 40 left. They're part of what to build:

- **One `CodeEditor`,** a `textarea` under a highlighted mirror, with the two-tone `{{…}}` highlight as an option. It's shared with the environment's setup script. No CodeMirror: the template language is small enough.
- **Storage is for instance admins.** The sidebar's `Storage` (`hard-drive`) comes after Linear. `AdminOnly` gains `scope="instance"`, which reads `an admin of this ostra instance`. In milestone 2 that's the same person as the organization admin.
- **Retention's source** shows under the radio: `Saved here`, `From OSTRA_RETENTION_DAYS on the server` or `Default`. A saved choice wins (ticket 31).
- **`PropRow`** gains a `labelWidth` for the storage panel.

## Done when

- [x] Component tests for each check state, the template's validation and preview, and the retention confirmation.
- [x] Committed as `✨ add repo checks, template and storage screens`.

## Comments

- 2026-11-19, web: done in `✨ add repo checks, template and storage screens` (this commit), built to `repo-checks`, `ticket-template` and `storage-settings` against ticket 31's routers, and checked by eye side by side at 1440×956.
  - **Repos** (`/projects/[id]/repos`, `components/projects/repo-checks.tsx`): the verdict per repo, the red-ruled notice, the panel's why and how, `?repo=` selection. `Check again` is shown to project admins only, since `projects.checkRepos` is a project-admin mutation (the target offered it to everyone). The composer and the new-task form disable Start on a signed-commit repo (`aria-describedby` on the line) and warn on an unprotected branch; the project panel's repo row gets the icon.
  - **Ticket template** (`/projects/[id]/settings/ticket-template`, `settings` redirects there): one shared `components/ui/code-editor.tsx` (a textarea over a mirror, one row per logical line, the two-tone `{{…}}` highlight as an option), which the environment's setup script now uses too. The validator runs in the page through a new additive subpath export, `@ostra/domain/ticket-template` (that file imports nothing). The placeholder list comes from the server's vocabulary, so it lists the language's real names (`labels`, `comments`, `instructions`…), not the target's proposed ones. The preview's ticket list waits on ticket 29's `inbox.list`: until it lands the page passes no tickets and says the Inbox has none. `getTicketTemplate` is project-admin only, so a member sees the admins-only line, not a read-only editor. In-app navigation away with unsaved edits isn't caught (only `beforeunload`).
  - **Storage** (`/organization/storage`, instance admins: `isInstanceAdmin` in `server/viewer.ts`, `AdminOnly scope="instance"`, the sidebar's `Storage` row for `me.instanceAdmin`). `organization.storage` has no author for the last change, so the panel says `Set to 90 days, 12 Nov` without a name; `OSTRA_RETENTION_DAYS` shows `–` once a saved choice overrides it (the server doesn't say the env's own value then).
  - Shared: `Section` gained `note`, `PropRow` gained `labelWidth` (and `labelClassName`), the project's navigation gained `Repos` and `Settings` (shown to organization admins: `projects.list` carries no project role).

