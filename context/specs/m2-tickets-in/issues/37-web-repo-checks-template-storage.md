# 37: Web: repo checks, the ticket template, storage and retention

Status: ready-for-agent
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

- [ ] Component tests for each check state, the template's validation and preview, and the retention confirmation.
- [ ] Committed as `✨ add repo checks, template and storage screens`.

## Comments
