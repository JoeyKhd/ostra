# Target: the organization's library of skills and MCP servers (proposed 2026-11-21)

> **Committed images:** `library.png` (2880×1912, the render at 2×) and `library.webp` (1440×956, one image pixel per CSS pixel), rendered with Playwright from `html/library.html` with the panel's own tokens (`apps/web/src/app/globals.css`) and fonts (`apps/web/src/fonts`). Sizes in this file are CSS px. Re-render: `node html/render.mjs <playwright index.mjs> library`, then `python -I html/to-webp.py library`.

| Picture | State shown |
|---|---|
| `library.webp` | Alex Kim, an organization admin of Acme Corp, opened Organization › Skills and MCP. The **All** tab: one member suggestion (`pdf`, from Sam Rivera) with Install and Dismiss; four of the nine skills, one with an update waiting; three of the five MCP servers, one with a newer registry version; the properties panel with the library's counts, its policy (marketplace search on) and how repo skills are read. |

- **Route:** new, `apps/web/src/app/(panel)/organization/skills/page.tsx` (the list, `?tab=all|skills|mcp|updates`). An item is `organization/skills/[item-id]` (`library-update.md`), the browser `organization/skills/marketplace` (`library-browse.md`), and "Add from a source" a `Sheet` over this page.
- **Shell:** the double-sidebar shell (`app-shell.md`): the rail's **Org** space lit, the Organization panel with **Skills and MCP** selected under Agents, its count the library's size.
- **Features:** F-021 (agent profiles: skills and MCP servers) gains a library to fill them from. Its row is F-144 (the skills and MCP library), which the milestone 8 spec proposes (`context/specs/m8-previews-and-library/spec.md`, section 13, target 10 `library`); it isn't in `features.md` yet. The facts and the shape (design B, "an organization library, then attach") come from `context/research/skills-and-mcp-marketplaces.md`, sections 7.3 to 7.6.
- **Status: a proposed target, waiting for the maintainer's approval.** Nothing builds it until then.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

The maintainer, 2026-11-20: "who adds skills manually in 2026 lol, you just want the skills.sh marketplace or anything that can be installed using npx skills". Today a skill is whatever an admin pasted into one profile, with no source, version or provenance (research, section 1.1). The library page has to make three things plain:

1. **What the organization has installed,** each skill and MCP server once, where it came from and the exact version it's pinned to.
2. **Who uses it:** the profiles it's attached to, or every profile.
3. **What's waiting on an admin:** an update to review, a member's suggestion to install or dismiss. These are admin chores, never "needs you" in amber: amber stays for an agent waiting on a person.

## Layout

The page column is `1440 − 64 (rail) − 240 (panel) = 1136px`: the page `minmax(0, 1fr)` and the properties panel 320px. Page padding `26px 36px 20px`.

1. **Top bar,** 46px: breadcrumbs `Organization › Skills and MCP`; at the right `Browse marketplace` (`Button` outline, Lucide `store`) and `Add from a source` (the page's one primary, Lucide `plus`). A member who isn't an org admin sees neither; the marketplace button is hidden too when search is off (state table).
2. **Title** `Skills and MCP servers` (Manrope 700, 26px), **lede** 15px `--muted`: `Installed once for {organization}, pinned, and attached to agent profiles. Agents get them at their next session.`
3. **Tabs,** 38px, 16px under the lede: `All {n}`, `Skills {n}`, `MCP servers {n}`, `Updates {n}` (counts mono 12px `--faint`). `Updates` shows only items with a version waiting.
4. **Tools,** 14px under the tabs: a filter field 280×30 (`Filter by name or source`, matches name, description and source) and a ghost `Profile: any` menu (the profiles, to show what one profile gets).
5. **The table,** `table-layout: fixed`, columns 232 / 178 / 74 / 102 / rest:
   - Head row 32px, 12.5px weight 500 `--faint`: `Name`, `Source`, `Pinned`, `Used by`, and an empty last head.
   - **Group bands** as milestone 1's lifecycle bands (30px, `--surface`, radius 6px, 14px Lucide icon `--muted`, label 13.5px weight 600, count mono `--faint`), in this order: `Suggested` (only when there is one), `Skills`, `MCP servers`. The `Skills` and `MCP servers` tabs drop the bands.
   - **A row,** 52px, a 1px `--line` under it:
     - **Name:** a 26px kind square (1px `--line-2`, radius 6px, Lucide `book-open` for a skill, `plug` for an MCP server, 14px `--muted`), then two lines: the name in Plex Mono 14px weight 500 `--text` (names are lowercase-dash identifiers, as `SKILL.md` and the registry write them), and the description 13px `--muted`, one line, ellipsis. For an MCP server the description ends with ` · remote` and ` · {n} secret(s)`.
     - **Source,** mono 13px `--muted`, ellipsis with the whole source in a `title`: `owner/repo@skill`, a git URL with `#ref`, a well-known URL, or a registry name (`io.sentry/sentry-mcp`).
     - **Pinned,** mono 13px `--text`: a skill's commit, 7 characters; a registry server's version (`v0.21.0`).
     - **Used by:** `{n} profiles` 13.5px `--muted`, or the chip `Every profile` (Lucide `layers`, `--text-2`), or `—` `--faint`.
     - **Last column,** right-aligned: `Up to date` 13px `--faint`; or an update chip (22px, 1px `--line-2`, radius 5px, Lucide `circle-arrow-up` 12px `--teal`, text `--text-2`): `Update · {n} files` for a skill, the new version for a server. Never amber.
   - **A suggestion row:** the name, then `{member} suggested it · {age}` 13px `--muted` as its second line; source as above; `—` pinned and used by; at the right `Dismiss` (ghost, 26px) and `Install` (outline, 26px).
   - The whole row is a link to the item page; the buttons in a suggestion row stop the click.
6. **`Show {n} more`,** 34px, Lucide `chevron-down`, 13.5px `--muted`, when a group holds more than its first rows (four skills and three servers on `All`; every row on the other tabs).

### The properties panel (320px)

Three groups, as every properties panel (`app-design.md`, layout item 4):
- **Library:** `Skills`, `MCP servers` (mono counts), `Updates {n}` + `waiting for an admin` `--faint`, `Suggested {n}`.
- **Policy,** with `Edit` 12.5px `--teal` in its label row (org admins only; opens Organization › Settings › Skills and MCP):
  - `Installs` `Org admins`, `Members` `Suggest` (research 7.3, design B: only org admins install; members suggest, as Devin's "Suggest MCP Integration").
  - `Sources`: the allowlist, mono 12.5px, one per line, at most four then `and {n} more` `--faint`. Entries are GitHub owners or repos, git hosts with a path glob, and registry namespaces (`registry io.sentry/*`), **matched by source, never by display name** (research 7.3, after Claude Code and Copilot: a name "is not a security control").
  - `Marketplace`: the switch (on: `--teal` track, `--on-primary` knob, `app-design.md`'s switch) and `Search on` / `Search off`.
  - `Calls out to`: the hosts the server fetches from for this organization, mono 12.5px (`skills.sh`, `api.mcp.github.com`, `github.com`), so an admin sees every outbound call ADR 0021 cares about.
- **Repo skills:** `Read from` `.agents/skills`, `.claude/skills`, `.opencode/skills` (research 7.2, fix 1); `Same name` `The profile's wins`; and the 12.5px `--faint` note `When a repo skill has a library skill's name, the task page names the one left out.` Both lines are open points 2 and 3 below; the picture shows the recommended answers.

## Every state

| State | What shows |
|---|---|
| **The library with items** (the picture) | As above |
| **Empty** | Under the tools, in place of the table: Lucide `blocks` 28px `--faint`, `No skills or MCP servers yet` 16px weight 600, `Install one from a source, or browse the marketplace. Profiles keep the skills they have until you attach library items.` 14px `--muted`, and the two top-bar buttons repeated (outline, then primary). Profiles' own hand-written skills (today's rows) stay on the profile and are listed under a `On profiles only {n}` band once the migration runs (open point 6) |
| **Loading** | Head row, then five 52px rows with `--surface` bars where the name, source and pin go; no spinner |
| **The list fails to load** | The table area: Lucide `circle-alert` `--red` + `Couldn't load the library.` 14px + `Try again` (outline). The panel's groups show `—` |
| **An update is fetched** (an admin pressed Check for updates on an item, or the daily check found one) | The row's last cell becomes the update chip; the `Updates` tab count grows. Nothing reaches a profile until an admin accepts (`library-update.md`) |
| **An update was accepted** | The chip goes; the row's `Pinned` shows the new commit or version; a toast `webapp-testing moved to 9b2d4f0. Attached profiles get it at their next session.` |
| **The upstream source is gone** (repo deleted, ref removed, registry entry withdrawn) | The last cell: Lucide `unlink` 12px + `Source unavailable` 13px `--red`. The pinned copy keeps working; the item page says since when |
| **A source left the allowlist** after install | The last cell: Lucide `lock` 12px + `Source not allowed` 13px `--faint`. Still attached and delivered (it was pinned when allowed); updates are refused until the source is allowed again or the item removed (open point 10) |
| **A suggestion** | The `Suggested` band and row (the picture). Dismiss removes it and notifies the member; Install opens the install sheet with the source filled in |
| **Marketplace search off** (the default) | No `Browse marketplace` button; the panel's switch reads `Search off`; installing by reference still works |
| **A member who isn't an org admin** | The same list, read-only: no top-bar buttons, no `Edit`, no Install/Dismiss; a suggestion row they made reads `You suggested it · {age}` with `Withdraw`; the page gains `Suggest a skill or server` (outline) in the top bar, which opens the install sheet in suggestion mode |
| **Filter with no match** | `No item matches "{query}".` 14px `--muted` + `Clear the filter` `--teal` |
| **Light theme** | `light-home.md`'s tokens; the kind squares' border `--line-2` `#D0D2D6`, the switch `--teal` `#1F6B5E` |

## Add from a source (the sheet the primary opens)

A right `Sheet`, 440px, title `Add from a source`:
1. A segmented `Skill` / `MCP server`.
2. **Skill:** one field, `Source`, placeholder `owner/repo@skill, a git URL, or https://…/.well-known/agent-skills/index.json`; under it `Ref` (optional, default the repo's default branch). `Look up` fetches through the server and lists the skills found with checkboxes, each with its description, file count and size.
3. **MCP server:** `Registry name` (`io.sentry/sentry-mcp`), `Look up` reads the configured registry's latest version and fills: the version, the remote URL (`remotes[]`), and one field per input marked `isSecret`, which is saved to the secret store, never to the row (research 7.3, design A).
4. Footer: `Install` (primary): `Installs pins {commit or version} and hashes the files. It attaches to no profile until you choose one.` A source outside the allowlist disables Install with `{source} isn't on the allowlist.` and an `Edit the allowlist` link for admins.

## Keyboard

- Tabs: ←/→ between tabs (Radix `Tabs`), as every tab bar.
- The filter has no key of its own: `/` stays `Search tasks` and `⌘K` the palette (`../m7/shortcut-sheet.md`). Tab reaches it after the tabs.
- The table: each row is one tab stop (a link); ↑/↓ move between rows when one has focus; Enter opens the item. In a suggestion row, Tab reaches `Dismiss` then `Install`.
- `Add from a source` and `Browse marketplace` are palette actions (the action registry), with no shortcut: `a` already approves a needs-you item.

## Narrow and phone width

- **1024–1279px:** the contextual panel collapses (the shell's rule, `app-shell.md`); the table keeps its columns, the description line ellipsizes sooner.
- **Below 1024px:** the properties panel moves under the table as a section (`Library`, `Policy`, `Repo skills` as hairline groups). The `Source` column drops; the source joins the name's second line in mono 12px.
- **Phone (390px):** the shell's bottom tab bar (`Org` lit). One row per item, 60px: kind square, name and `{pinned} · {used by}` mono 12px `--faint`; the update chip or `Up to date` on the right. Bands stay. The top-bar buttons move to a `+` in the top bar (`Add from a source`, `Browse marketplace` in its menu).

## Components (shadcn/ui names)

- **From the repo:** the shell (`components/shell/*`), `Tabs`, `Input`, `DropdownMenu`, `Button`, `Sheet`, `Switch`, `Tooltip`, the band and row styles of the project task list (`components/projects/project-view.tsx`).
- **New:** `components/library/library-table.tsx`, `library-row.tsx` (the item and the suggestion variants, a union with an exhaustive `switch` on the row kind), `library-policy.tsx` (the properties panel), `add-from-source-sheet.tsx`.
- **Icons** (Lucide, stroke 1.75): `blocks` (the panel row), `book-open`, `plug`, `layers`, `circle-arrow-up`, `store`, `plus`, `message-square-plus`, `lock`, `unlink`, `circle-alert`, `search`, `sliders-horizontal`.

## Tokens

The measured tokens of `globals.css`: `--bg` page and panel, `--surface` bands and the filter field, `--line` row hairlines, `--line-2` chips and kind squares, `--control-line` the filter's edge, `--text` names and pins, `--text-2` chip text, `--muted` descriptions, sources and counts, `--faint` labels and `Up to date`, `--teal` the update icon, the switch and `Edit`, `--red` only `Source unavailable`. **No amber on this page.**

## WCAG AA (F-081), dark

| Pair | Ratio | Need |
|---|---|---|
| `--faint` #8B8E93 on `--bg` #0D0E10 (`Up to date`, heads) | 5.9:1 | 4.5 |
| `--muted` #B4B7BB on `--bg` (descriptions, sources) | 9.6:1 | 4.5 |
| `--teal` #6FB8AA on `--bg` (`Edit`, the update icon) | 8.4:1 | 4.5 / 3 |
| `--faint` on `--surface` #131416 (band counts) | 5.6:1 | 4.5 |
| `--control-line` #686B71 on `--bg` (the filter's edge) | 3.6:1 | 3 |
| `--on-primary` #0C1D21 on `--teal` (the switch's knob) | 7.5:1 | 3 |

In light: `--faint` #62656B on `--bg` #FAFAFB 5.6:1, `--teal` #1F6B5E 6.1:1.

## Data this screen needs (research, sections 7.3 to 7.5)

1. **A library item** per organization: kind (`skill` | `mcp`), name, description, source (a union: GitHub `owner/repo` + path, git URL + ref, well-known URL, registry name), the pinned commit or version, a content hash computed the `skills` CLI's documented way (so it agrees with a repo's `skills-lock.json`), the files as blobs (today's `[{ path, blobId }]`), who installed it and when. A branded `LibraryItemId`.
2. **Attachments:** item × profile, plus an `everyProfile` flag on the item. Projects don't attach items; they pick profiles, as today (ADR 0049).
3. **Updates:** a pending version per item (commit or version, the diff's file list and counts), found by a check that re-resolves the ref. Never applied without an admin.
4. **Suggestions:** item source + member + time, until installed, dismissed or withdrawn.
5. **Policy** per organization: the allowlist entries, who installs (org admins), whether members may suggest, the marketplace switch (off by default), and the outbound hosts it implies.
6. **Delivery is unchanged:** at each dispatch core copies the attached items' files into task blobs with a digest, as profile skills today (research 7.1). An MCP item becomes a path on the sidecar's MCP proxy, its secrets from the secret store (ADR 0030).
7. **Audit:** install, update accepted, attach, detach, remove, allowlist change and the search switch are audit entries (ADR 0054), by field names, never values.

## Differences from the current code

1. **No library:** skills and MCP servers are rows of one profile (`AgentProfile` skills, the `mcpServers` JSON column), typed or uploaded by hand, with no source or version (research 1.1).
2. **No Organization › Skills and MCP page,** no panel row.
3. **Repo skills:** OpenCode is launched with `OPENCODE_DISABLE_PROJECT_CONFIG=1` and `OPENCODE_DISABLE_CLAUDE_CODE=1` and reads only `.opencode/skills`, so a repo's `.agents/skills` and `.claude/skills` never reach the agent *(inferred from source in the research, not run)*. The `Repo skills` group assumes research 7.2's fix 1.
4. **Messages:** new keys under `library.*`.

## Open points (the research's questions 7.6; recommendations, the maintainer's answers settle them)

1. **Scope.** An organization library attached to profiles, with an `Every profile` switch (recommended, drawn); no project or task attach.
2. **Repo skills by default.** Read `.agents/skills` and `.claude/skills` in every task (recommended, as Codex, Copilot, Cursor and Devin do), or only for repos a project admin marks trusted.
3. **Name clashes.** The profile's skill wins and the task page names the repo skill left out (drawn), or the repo's wins (the Agent Skills guide's project-over-user order).
4. **Outbound fetches.** The server may call skills.sh, a git host and a registry when an admin searches or installs, off by default behind one setting, with ADR 0021 amended (drawn as the `Marketplace` switch and `Calls out to`).
5. **Who installs and the allowlist.** Org admins install, members suggest; sources are GitHub owners or repos, git hosts and registry namespaces (drawn).
6. **Today's hand-written profile skills.** Leave them on their profiles and list them under `On profiles only`, or offer to move each into the library as a local item with no source. Recommended: leave them, and offer the move per skill.
7. **Updates.** Wait for an admin to accept the diff (recommended, drawn), never automatic; running tasks pick it up at their next session.

## Wrong in the image (build from this file)

- **Sources are cut** with an ellipsis and no way to read them whole. Build the `title` (and a `Tooltip` on focus).
- **The `Profile: any` menu** has no chevron; build it as a `DropdownMenu` trigger with Lucide `chevron-down` 12px.

Right as drawn: the bands and their order, the row's two-line name, the mono pins, the neutral update chip, the suggestion row's buttons, the properties panel's three groups, no amber anywhere.
