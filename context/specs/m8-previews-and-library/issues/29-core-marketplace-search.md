# 29: Core: the marketplace search

Status: ready-for-agent
Builder: core
Blocked by: 27
Features: F-146
Packages: `apps/core` (`library/search`), `packages/domain` (bodies)
Spec: `../spec.md`, section 4 ("The marketplace"); ADR 0069 ("The marketplace browser", "ADR 0021, amended")

## What to build

- **`searchMarketplace(organization, kind, words)`** (an organization admin), only when both the organization's `marketplaceSearch` and `OSTRA_MARKETPLACE_SEARCH` allow it. Otherwise it refuses with which of the two is off.
  - **Skills:** `GET <OSTRA_SKILLS_SEARCH_URL>?q=<words>`, parsed by ticket 06's tolerant schema, each result with its source, its skill, its name and its install count.
  - **MCP servers:** for each registry on the organization's list, `GET <registry>/v0.1/servers?search=<words>&version=latest`. Entries whose `status` isn't `active` are dropped, and each result keeps its version and whether it has a remote ostra can install.
  - Each result says whether its source is on the allowlist.
- **Deadlines and failures:** 8 s per call. A failed or malformed answer gives "search is unavailable" for that source, never an error for the whole page, and is logged with the source's host and the status only, never the words.
- **What's sent:** the admin's words and nothing else. No member, organization or install identifier, and a fixed `User-Agent` of `ostra/<version>`.
- **`setMarketplaceSearch`** (an organization admin), audited. The instance setting wins, and the switch shows why when it does.
- **A result's install** goes through ticket 27's `resolveReference` and `installItem` with its reference, never a shortcut.

## Done when

- [ ] Tests named for `F-146`, against the fake skills search and the fake registry:
  - search refused with each switch off (break-it: ignore the instance setting, and the case fails);
  - results with their sources and whether each is allowed;
  - an inactive entry dropped;
  - a failing source reported as unavailable while the others answer;
  - the words absent from every log line;
  - a result installed through the ordinary install.
- [ ] Checks for the touched packages pass (spec section 10).
- [ ] Committed as `✨ search skills.sh and MCP registries`.

## Comments
