# 30: API: the library and the marketplace

Status: ready-for-agent
Builder: api
Blocked by: 27, 28, 29
Features: F-145, F-146
Packages: `packages/api`
Spec: `../spec.md`, sections 4 and 5.4; ADR 0069

## What to build

- **`library.*`:**
  - `list` and `get` for any member, so members see what's installed and can suggest: an item's source, pin, hash, files' names and sizes, the profiles it's on, and an update waiting. A server's secret inputs show as "set", never their values;
  - `resolve`, `install`, `testServer`, `attach`, `detach`, `setEveryProfile`, `checkUpdates`, `acceptUpdate`, `dismissUpdate` and `remove`, for an organization admin;
  - `sources.list`, `sources.add` and `sources.remove`, for an organization admin;
  - `suggest` for any member, and `suggestions.list` and `suggestions.decide` for an organization admin;
  - `search` and `setMarketplaceSearch`, for an organization admin.
- **The profile editor's data:** `agentProfiles.get` gains the profile's attached items and the inherited every-profile items, each with its pin.
- **A file's content** for the update's diff and the install's look, for an organization admin, as text with a cap, never served as a page.
- **Access:** milestone 4's query and write matrices get a row for each procedure, with a member and an admin of the organization, and another organization's admin.

## Done when

- [ ] Tests named for `F-145`:
  - members list and suggest, and are refused every admin procedure (break-it: let `install` through for a member, and the matrix fails);
  - a secret input never in a response;
  - another organization's items invisible.
- [ ] Tests named for `F-146`: search for an admin only, and refused with the switch off.
- [ ] Checks for `packages/api` pass (spec section 10).
- [ ] Committed as `✨ add library and marketplace procedures`.

## Comments
