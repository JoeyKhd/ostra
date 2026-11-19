# 53: Web: Models, a project's Models and keys, the profile's model and "no key"

Status: ready-for-agent
Builder: web
Blocked by: 36 (the spend page), 50, 52
Features: F-135, F-021, F-037
Packages: `apps/web` (the organization's Models page, a project's settings `models/` (new), the agent profile editor, New task, the task page, Home's needs-you, the spend page, New project)
Spec: `../spec.md`, sections 3 (steps 16 and 17) and 12; targets `models-keys`, `project-models-keys`, `agent-profile-model`, `no-key-for-model`

## What to build

- **Organization, "Models"** to the `models-keys` target: each provider with the projects that use it and its month's spend, the default list with "Edit", "Add provider" with no list ticked, and the upgrade's choices to confirm.
- **A project's settings, "Models and keys"** to `project-models-keys`: follow the default or use the project's own list, each model with its provider and "Change", the save's preview, and the read-only view for a project admin or member.
- **The agent profile editor's model** to `agent-profile-model`: a model name, with the providers that list it and the projects where none serves it.
- **"No key"** to `no-key-for-model`: on New task before Start with Start disabled, on a queued task, as a held message's line, and as Home's needs-you row for organization admins.
- **The screens that only grow** (section 12): the task page's "Key · <provider>", spend by key, and the provider list at project creation.

## Done when

- [ ] Playwright cases named `F-135: ...`:
  - an organization admin gives a project its own list, and sees the preview before the save
  - a project admin and a member see the view, with no edit and no token
  - New task shows "no key" with Start disabled
  - the needs-you row shows for an organization admin and not for a member
  - the task page names its key
  - a profile's model picked by name
- [ ] Every string is in the message files; dark and light; phone width.
- [ ] Committed as `✨ add keys per project to the panel`.

## Comments
