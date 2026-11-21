# 31: Web: the library, the profile's items and the marketplace browser

Status: ready-for-agent
Builder: web
Blocked by: 09, 30
Features: F-145, F-146
Packages: `apps/web`
Spec: `../spec.md`, section 13 (targets 10 to 15)

## What to build

To the approved targets `library`, `library-install`, `library-update`, `library-suggestions`, `library-browse` and `agent-profile-library`:
- **Organization → Library** (a row in the context sidebar, ticket 10):
  - skills and MCP servers, each with its source, pin, hash, "Every profile", the profiles it's on, an update waiting, and a source no longer allowed;
  - the suggestions' count for admins, never amber;
  - the empty state;
  - a member's read-only view with "Suggest".
- **Install by reference:**
  - the reference field;
  - the skills found in a repo to pick from;
  - the commit, the files with their sizes and the script files pointed out, and the hash;
  - "Allow this source";
  - for a server, its remote, the inputs with the secret ones masked, "Test" with the tools' names, and the OAuth and packages-only refusals in the target's words.
- **An update:** a skill's changed files with their diff, or a server's changed fields and tools, with "Accept" and "Dismiss".
- **Suggestions:** the member's form, and the admins' list with "Install" and "Dismiss".
- **The marketplace browser:**
  - the search and the skills and servers tabs;
  - results with their source, installs or version, and whether the source is allowed, each with "Install", which opens the same install dialog;
  - the off state with the switch and its words, and "search unavailable".
- **The profile editor:** the profile's own skills and servers, the attached library items with their pins, the inherited every-profile ones, the attach picker, and the limit's refusal.
- **Organization settings:** "Marketplace search", with its words on what it sends where.
- **Words** through `t`.

## Done when

- [ ] The targets' approval is recorded in ticket 09's `## Comments` before the UI is built.
- [ ] Tests named for `F-145` (this ticket's browser spec file only, against the fakes):
  - a skill installed by reference and attached to a profile;
  - a server installed with a secret input that never shows again;
  - an update's diff accepted;
  - a member's suggestion installed by an admin.
- [ ] Tests named for `F-146`: a search and an install from a result; the off state.
- [ ] Milestone 7's keyboard walk and contrast check pass on the new pages and dialogs, in both themes, and they work at 390 px.
- [ ] Checks for `apps/web` pass (spec section 10).
- [ ] Committed as `✨ add the library and the marketplace browser`.

## Comments
