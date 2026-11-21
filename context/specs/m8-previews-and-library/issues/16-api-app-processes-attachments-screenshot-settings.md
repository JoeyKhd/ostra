# 16: API: app processes, attachments and screenshot settings

Status: ready-for-agent
Builder: api
Blocked by: 15
Features: F-121, F-140
Packages: `packages/api`
Spec: `../spec.md`, sections 4 and 5.4; ADR 0068

## What to build

- **`environments.appProcesses`:** list, save (a project admin; the rules of ticket 05, refused with each rule's words), with an audit entry naming the fields that changed, never a command's text.
- **`environments.screenshots`:** read and save the after-turn switch, the routes and the widths (a project admin).
- **`environments.services`:** a service's preview label.
- **`tasks.attachments`:** list a task's attachments for a member who can open the task, with each one's kind, source, target, size, caption, browser and turn. Download each through the blob service as a file with its fixed content type, never served as a page (ADR 0043).
- **`tasks.attachmentToDraft`:** `addAttachmentToDraft`, for the refine draft's owner or a project member (milestone 6's rule for editing a draft).
- **`tasks.keepPreview`:** `proposeAppProcess`, for a member who can open the task.
- **`reviews.findings`** gains each finding's attachments.
- **Access:** every procedure checks the organization and the project's access. Milestone 4's write matrix and query matrix get a row for each.

## Done when

- [ ] Tests named for `F-140`: a save by a project admin and a refusal for a member; each rule's refusal; the audit entry without the command's text.
- [ ] Tests named for `F-121`: attachments listed for a member and invisible to another organization's and to a restricted project's outsider (break-it: drop the project filter, and the matrix fails); the download's content type fixed; "Add to draft" by the right people.
- [ ] Checks for `packages/api` pass (spec section 10).
- [ ] Committed as `✨ add app process and attachment procedures`.

## Comments
