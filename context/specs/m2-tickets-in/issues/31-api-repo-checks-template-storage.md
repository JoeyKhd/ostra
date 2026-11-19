# 31: API: repo checks, the ticket template, storage and retention

Status: ready-for-agent
Builder: api
Blocked by: 06, 09
Features: F-055, F-060, F-064, F-114, F-079
Packages: `packages/api` (`routers/projects.ts`, `routers/organization.ts`), `packages/domain`
Spec: `../spec.md`, sections 2 and 3 (the checks after the run)

## What to build

- **Repo checks:** when a repo is added to a project, at every project page load (cached for 10 min *(working value)*) and when a task starts, read `readBranchRules` for its default branch. `projects.get` returns, per repo, `defaultBranchProtected` and `signedCommitsRequired` (each `true`, `false` or `unknown` with its reason). A task whose project has a repo requiring signed commits is refused at creation, with the message that ostra doesn't support signed-commit repos yet (F-055). An unprotected default branch never refuses; its warning says why that's allowed: the agent holds no token and the git proxy accepts only the task's refs (F-060).
- **The ticket template:** `projects.getTicketTemplate`, `projects.saveTicketTemplate` (project admins; validated by ticket 06's validator) and `projects.previewTicketTemplate` (renders it on one of the Inbox's tickets, the render shown, never logged).
- **Storage and retention:** `organization.storage` for instance admins: the store in use, its blob count and total size, the cap, and whether the S3 store is configured. `instance.saveRetention` sets the retention period (or none), with an audit entry.

## Done when

- [ ] Tests against the fake code host: each combination of the two checks shows as it should; a signed-commit repo refuses task creation and a prompt task alike; "unknown" never refuses; the template is validated, saved and previewed; the storage figures count only the organization's blobs; only instance admins change retention.
- [ ] Committed as `✨ add repo checks, template and storage`.

## Comments
