# 20: API: previews, sharing and the viewer's stream

Status: ready-for-agent
Builder: api
Blocked by: 19
Features: F-141, F-142
Packages: `packages/api`, `apps/web/src/app/api/previews/` (route handlers, new), `apps/web/src/app/p/` (the viewer page's server side, new)
Spec: `../spec.md`, sections 4 ("Opening a view", "A share") and 5.4; ADR 0068 ("Who can open a preview")

## What to build

- **tRPC, `previews.*`:**
  - `list`, `open`, `close`, `heartbeat`, `startApp` and `takeScreenshot`, for a member who can open the task;
  - `setLevel` and `createLink` (expiring, or public only where `OrganizationSetting.publicPreviewLinks` allows it), with "allow input", an expiry within `OSTRA_PREVIEW_LINK_MAX_DAYS`, and the link's URL shown once;
  - `revokeLink`;
  - `organization.setPublicPreviewLinks`, for an organization admin, audited.
- **The route handlers** on the web app, since Next.js can't upgrade to a WebSocket (ADR 0035):
  - `GET /api/previews/:viewId/stream` relays core's stream as a streamed response;
  - `POST /api/previews/:viewId/input` relays a batch of input.

  Each checks the member's session, or the link's token, and asks core with a panel token for that one view.
- **Named people:** a named member who can't open the project gets `previews.open` for that preview only. Every other procedure on the task still refuses them, and the matrices prove it.
- **The viewer page's server side** (`/p/<token>`): it resolves the link by its token's hash, checks its expiry and revoke, opens a view for the link, and gives the page only the preview's label, the organization's name, the expiry and whether input is allowed. The first use writes `preview.link_first_used` once.
- **Fail closed:** every refusal comes with its reason as a code the panel words through `t`.
- **Access:** milestone 4's query and write matrices get rows for each procedure, with a named person and a link as viewers.

## Done when

- [ ] Tests named for `F-142`:
  - each level for each kind of viewer;
  - a named person seeing the preview and refused everything else of the task (break-it: let `tasks.get` through for a named person, and the matrix fails);
  - an expired, a revoked and a forbidden public link each refused with their reason;
  - the link's token shown once and stored as its hash;
  - the first use audited once;
  - the viewer page's data holding nothing else of the task.
- [ ] Tests named for `F-141`: the stream and input routes relay for a member and refuse without a session or link.
- [ ] Checks for `packages/api` and `apps/web` pass, and the whole-repo checks, since this touches auth (spec section 10).
- [ ] Committed as `✨ add preview and sharing procedures`.

## Comments
