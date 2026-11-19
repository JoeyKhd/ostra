# 34: Web: the refine draft

Status: ready-for-agent
Builder: web
Blocked by: 27, 30
Features: F-099
Packages: `apps/web` (the task page's "Draft" tab)
Spec: `../spec.md`, section 12 (`refine-draft`, and the task page and New task growing)

## What to build

- The draft editor with its typed fields, images, versions, the ticket preview, "Update ticket", "Mark ready" and "Create ticket", and the applied state with links, to the approved target.
- New task's kind picker (code, refine); the kind's badge on the task page; "Draft ready" on Home and in "Needs you".

## Done when

- [ ] Playwright: open a draft the drafting fake handed in, edit a criterion, upload an image, "Update ticket", "Mark ready", against the fake Linear server.
- [ ] Checked against its target at 1440 px and at phone width, in dark and light.
- [ ] The touched packages' checks pass (spec section 9).
- [ ] Committed as `✨ add the refine draft screen`.

## Comments
