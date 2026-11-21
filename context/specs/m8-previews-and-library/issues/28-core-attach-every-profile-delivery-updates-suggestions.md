# 28: Core: attaching, every profile, delivery, updates and suggestions

Status: ready-for-agent
Builder: core
Blocked by: 14, 27
Features: F-145
Packages: `apps/core` (`library/`, `dispatch/profile-spec.ts`), `packages/domain` (bodies)
Spec: `../spec.md`, sections 4 ("Delivery", "Updates") and 5.4; ADR 0069 ("Attaching", "Delivery: unchanged", "Updates")

## What to build

- **Attaching** (an organization admin):
  - `attachItem` and `detachItem` on a profile, and `setEveryProfile` on an item, each through `profileItems` (ticket 06), which refuses a limit passed or a name the profile already uses, naming the profile;
  - a server with `needsOAuth` refused;
  - each with its audit entry;
  - `setEveryProfile(true)` checks every profile of the organization, the built-in Refine and Review profiles included, and refuses as a whole, naming each profile it would break.
- **Delivery** (`apps/core/src/dispatch/profile-spec.ts`): a profile's skills and MCP servers are its own, its attached items and the every-profile items, at their current versions.
  - A library skill's files are copied into the task's blobs with their digests, exactly as an own skill's are, so the runner's path doesn't change.
  - A library server is an `http` server on the MCP proxy, with its URL and its secret headers' references in the task's credentials.
  - A server marked read-only is passed as `readOnly`.
  - A library skill against a repo's own skill of the same name follows the `repo-skills` work's rule. This ticket's `## Comments` names the rule it found on `main`.
- **Updates:**
  - `library.check-updates`, once every `OSTRA_LIBRARY_UPDATE_HOURS` per organization (key: organization and the period), and on demand per item;
  - for a skill, it resolves the item's ref again and, when the commit moved and the hash changed, fetches into a new `available` version with `skillDiff`;
  - for a server, it reads the registry's latest version and, when it differs, writes an `available` version with `serverDiff` and a fresh test call's tools;
  - an update whose source is no longer on the allowlist is stored but can't be accepted;
  - `acceptUpdate` makes it current (the old one `superseded`) and `dismissUpdate` marks it `dismissed`, each with its audit entry;
  - nothing moves by itself, and the next dispatch of every attached profile's tasks uses the current version.
- **Suggestions:** `suggestItem` (any member): a reference, matched against the allowlist and saying so, and a note, never logged. `decideSuggestion` (an organization admin): install, which runs ticket 27's install and links the item, or dismiss. A quiet count for admins.
- **Removal:** `removeItem` detaches it from every profile in one transaction with its audit entry. Tasks lose it at their next session.

## Done when

- [ ] Tests named for `F-145`:
  - attach and every profile within the limits, and a clash and a passed limit refused;
  - a library skill reaching a task as blobs with their digests, the same way an own skill does, on `host` and on the `docker` fake;
  - a library server reaching the agent's config as a proxy path with `oauth: false` and no header (the agent's config searched for the header's value);
  - an update found, held until accepted (break-it: apply it on finding, and the case fails), and the next session getting it;
  - a dismissed update staying dismissed until a newer one;
  - a suggestion installed and one dismissed;
  - a removal detaching everywhere;
  - each audit entry.
- [ ] The whole-repo checks pass, since this touches credentials and what runs agent output (spec section 10).
- [ ] Committed as `✨ attach, deliver and update library items`.

## Comments
