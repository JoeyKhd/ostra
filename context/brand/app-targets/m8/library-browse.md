# Target: the marketplace browser (approved 2026-11-21)

> **Committed images:** `library-browse.png` (2880×1912, the render at 2×) and `library-browse.webp` (1440×956, one image pixel per CSS pixel), rendered with Playwright from `html/library-browse.html` with the panel's own tokens and fonts. Sizes in this file are CSS px. Re-render: `node html/render.mjs <playwright index.mjs> library-browse`, then `python -I html/to-webp.py library-browse`.

| Picture | State shown |
|---|---|
| `library-browse.webp` | Alex Kim, an org admin, opened the marketplace from the library (search is on for Acme Corp). The **Skills · skills.sh** source, the query `playwright`, five of 24 results: one already in the library, two installable, two whose source isn't on the allowlist (Install disabled). The second result, `e2e-writer`, is selected: its detail on the right, with its audits, a `SKILL.md` excerpt, its files and `Install`. |

**Demo data:** the results' owners, install counts, dates and audit verdicts are invented, except `anthropics/skills@webapp-testing`, which is the library's own row in `library.webp`. Nothing here claims what skills.sh returns for a real query.

- **Route:** new, `apps/web/src/app/(panel)/organization/skills/marketplace/page.tsx`, `?source=skills|mcp&q=…&selected=…`. Reached from the library's `Browse marketplace` and the palette (`Browse the marketplace`). Org admins only; for anyone else, and while search is off, the route shows the "off" state below.
- **Shell:** the double-sidebar shell, the rail's **Org** space, the Organization panel's **Skills and MCP** row selected.
- **Features:** F-146 (the marketplace browser), design C of the research ("a marketplace browser on top of B"). The milestone 8 spec builds it (`context/specs/m8-previews-and-library/spec.md`, section 13, target 14 `library-browse`). Facts: `context/research/skills-and-mcp-marketplaces.md`, sections 2.6, 3.1, 3.2, 7.3 (design C) and 7.6.
- **Status: approved 2026-11-21** (the maintainer: "yes to all"). It still depends on two of the maintainer's answers (open points 1 and 2): without them, the library ships with install by reference only, and this page doesn't exist.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

Let an org admin find a skill or an MCP server without leaving ostra, judge it, and install it into the library, pinned. Three rules shape the page (research 7.3, design C):

1. **The server searches, never the browser** (ADR 0021: "Browsers never call a third party"). The page says so, every time.
2. **Search is off until an admin turns it on,** an organization setting with the hosts it calls named (`library.md`, Policy).
3. **Installing is not attaching:** an install lands in the library attached to no profile, pinned at a commit (a skill) or an immutable registry version (a server). No agent gets it until a profile does.

## Layout

The page column is 1136px: the results `minmax(0, 1fr)` and the detail panel **380px** (a properties panel that holds a form, `app-design.md`). Page padding `26px 36px 20px`.

1. **Top bar,** 46px: `Organization › Skills and MCP › Marketplace`; at the right `Add from a source` (outline, Lucide `link`): the way in by reference, for what search doesn't find. There is no primary in the top bar; the detail's `Install` is the page's one primary.
2. **Title** `Marketplace`, **lede** 15px `--muted`: `Find a skill or an MCP server and install it into the library, pinned. No agent gets it until a profile attaches it.`
3. **The notice,** 14px under: a 2px `--line-3` left rule, padding `10px 0 10px 12px`, Lucide `info` 15px `--faint`, 13.5px `--muted`: `Searches and installs go through the ostra server, never your browser. Search is an organization setting, off by default. {admin} turned it on, {d MMM}.` + `Policy` `--teal` (to the library's policy). Always shown; it isn't dismissable.
4. **Tools,** 16px under: the source switch, a segmented control (28px): `Skills · skills.sh` and `MCP servers · GitHub registry` (Lucide `book-open`, `plug`; the source host in `--faint` weight 400), then the search field filling the rest (30px, `--control-line` edge, the query in `--text`, Lucide `x` to clear). The registry segment names the registry an admin configured (open point 4).
5. **Count line,** 13px `--faint`: `{n} results · most installed first` (skills.sh's order), `{n} results · newest first` (a registry).
6. **Results,** one row per result, a 1px `--line` under each, padding `10px`, grid `1fr 84px 84px 118px`:
   - **Name block:** line 1, the name mono 14px weight 500 `--text` and the owner/repo (or the registry namespace) mono 12.5px `--faint`; line 2, the description 13px `--muted`, one line, ellipsis; line 3 (skills only), the audit chips (20px, 11.5px, Lucide `check` 11px `--green` + the partner's name), or the chip `Not audited yet` with no icon.
   - **Installs,** mono 13px `--muted` right-aligned, `installs` 11.5px `--faint` under it (skills.sh's count). A registry result shows its version here instead.
   - **First seen,** mono 13px `--muted`, `first seen` under it (skills.sh's first-seen date; a registry entry's publish date).
   - **The last cell,** right-aligned: `Install` (outline, 26px); or `In the library` 13px `--faint` with Lucide `check` `--green` (already installed, at any pin); or, when the source isn't allowed, `Install` at 45% opacity, disabled, with Lucide `lock` 11px + `Source not allowed` 11.5px `--faint` under it.
   - **Selected row:** `--sel` fill, radius 6px. Clicking a row selects it; the detail follows.
7. **The detail panel,** padding `20px`, a 1px `--line` on its left:
   - The name, mono 17px weight 600; the owner/repo mono 13px `--muted`; the path mono 13px `--faint`.
   - The description 14px `--text-2`, wrapping.
   - Fact chips: `{n} installs`, `first seen {MMM yyyy}`, the licence when the files carry one.
   - `Audits on skills.sh` label (12px weight 500 `--faint`) and one chip per partner with its verdict (`Gen · pass`). Shown only when audits are turned on (`library-update.md`, open point 3); otherwise the label reads `Audits` and the line `Off` `--faint`.
   - `SKILL.md`: the first 12 lines, as read by the server, mono 12.5px on `--surface`, 1px `--line`, radius 8px; front matter delimiters `--faint`. Rendered as text, never HTML.
   - `Files · {n}`: one 26px row per file (Lucide `file-text` or `file-code` 14px `--faint`, the path mono 13px, the size at the right 12px `--faint`), at most 8, then `and {n} more`.
   - **Footer,** pinned to the bottom with a 1px `--line` above: 13px `--muted` `Install pins the commit at HEAD, {commit}, and hashes its files. It lands in the library attached to no profile.`; then a ghost `Source` (Lucide `external-link`, opens the repo on its host in a new tab) and `Install` (primary, filling the row, Lucide `download`).

### An MCP server result (the `MCP servers` segment)

The same row and panel, with the registry's fields: the name is the registry name (`io.sentry/sentry-mcp`), the second line its description, the third its transport chips (`remote`, `streamable HTTP`), the installs column its version. The panel shows the remote URL's host, each input with `secret` when the registry marks it `isSecret`, and a field per secret input above `Install`: `Saved to the secret store. Agents never see it; the sidecar's MCP proxy adds it.` (ADR 0030; research 7.4, "Secrets"). A server offering only stdio packages, or OAuth, shows `Not supported yet: {stdio with a secret | OAuth sign-in}.` and no Install (research 7.4; open point 5).

## Every state

| State | What shows |
|---|---|
| **Results, one selected** (the picture) | As above |
| **Search is off** (the default), or a member opens the route | The tools and results are replaced by: Lucide `store` 28px `--faint`, `Marketplace search is off` 16px weight 600, `An org admin can turn it on in the library's policy. It lets the ostra server call skills.sh and the GitHub MCP registry.` 14px `--muted`, and for an admin `Turn it on` (outline) + `Add from a source` (link). A member sees `Suggest a skill or server` instead |
| **Before a query** | The count line reads `Most installed on skills.sh` and the list shows skills.sh's top results for the source; nothing is selected and the panel shows `Select a result to see its files.` |
| **Searching** | The count line `Searching skills.sh…` with a 12px spinner; the previous results stay, at 50% opacity |
| **No results** | `No results for "{query}" on skills.sh.` 14px `--muted` + `Add it by its source instead` `--teal` |
| **The source can't be reached** (skills.sh or the registry down, timed out, rate-limited) | Under the tools: Lucide `circle-alert` `--red` + `Couldn't reach skills.sh: {reason}.` + `Try again` `--teal`. Install by reference still works |
| **Source not allowed** | The row's disabled `Install` with `Source not allowed`; in the panel, `Install` disabled and the line `{owner/repo} isn't on the allowlist.` + `Allow it` `--teal` (opens the policy with the source filled in; the allowlist is matched by source, never by name) |
| **Already in the library** | `In the library` in the row; the panel's footer reads `In the library at {pin}.` + `Open` (outline) instead of Install. A newer upstream commit shows as the item's update, never as a second install |
| **Installing** | The panel's `Install` reads `Installing…` with a spinner; the server fetches the commit, checks the `SKILL.md` against the spec's rules (name, description, relative paths, the file limits) and hashes it |
| **Installed** | A toast `Installed e2e-writer at 4e1a9b2. Attach it to a profile to use it.` with `Attach` (opens the item's `Used by` tab); the row turns to `In the library` |
| **The install fails** (a rule the skill breaks, a file over the limit, the commit gone) | Under the panel's footer text, 13px `--red`: the reason, named (`scripts/run.sh is over 1 MiB.`); nothing is added |
| **Light theme** | `light-home.md`'s tokens; the audit checks `--green` `#25734F` |

## Keyboard

- The source switch: ←/→ between its two segments (a `ToggleGroup`, single).
- The search field takes focus when the page opens; Enter searches (no search on every keystroke: each query is an outbound call); Escape clears it.
- The results are a `listbox`: ↓/↑ from the field move the selection, and the detail follows; Enter on a result moves focus to its `Install`.
- `/` stays `Search tasks` and `⌘K` the palette (`../m7/shortcut-sheet.md`); the page adds no shortcut.

## Narrow and phone width

- **1024–1279px:** the contextual panel collapses (the shell's rule); the detail panel narrows to 340px.
- **Below 1024px:** no detail panel: a selected result opens its detail in a right `Sheet` (440px) with `Install` in its footer.
- **Phone (390px):** the shell's top bar and menu sheet (`app-shell.md`, "Phone"). The notice, the source switch (full width), the search field, then results as 64px rows (name, owner, installs; audit chips hidden); a tap opens the detail as a full-height bottom `Sheet`.

## Components (shadcn/ui names)

- **From the repo:** the shell, `ToggleGroup`, `Input`, `Button`, `Sheet`, `Tooltip`, `ScrollArea`, the toast.
- **New:** `components/library/marketplace-view.tsx`, `marketplace-results.tsx` (a `listbox`), `marketplace-detail.tsx` (skill and MCP variants: a union on the source kind with an exhaustive `switch`), `marketplace-off.tsx`.
- **Server:** a tRPC router `library.marketplace.search` and `.inspect` that call the source from the server only, through ostra's outbound fetch rules, behind the organization's switch.
- **Icons** (Lucide, stroke 1.75): `store`, `book-open`, `plug`, `search`, `x`, `info`, `check`, `lock`, `file-text`, `file-code`, `external-link`, `download`, `link`, `circle-alert`.

## Tokens

`--bg`, `--surface` (the excerpt, the segmented control), `--sel` (the selected row, the on segment), `--line`, `--line-2` (chips), `--line-3` (the notice's rule), `--control-line` (the search field), `--text`, `--text-2`, `--muted`, `--faint`, `--teal` (links), `--green` (audit checks, `In the library`), `--red` (failures). **No amber.**

## WCAG AA (F-081), dark

| Pair | Ratio | Need |
|---|---|---|
| `--faint` #8B8E93 on `--sel` #1A1B1E (the selected row's owner and counts) | 5.2:1 | 4.5 |
| `--muted` #B4B7BB on `--bg` (descriptions, the notice) | 9.6:1 | 4.5 |
| `--faint` on `--surface` #131416 (the excerpt's delimiters) | 5.6:1 | 4.5 |
| `--control-line` #686B71 on `--bg` (the search field's edge) | 3.6:1 | 3 |
| A disabled `Install` | exempt (WCAG 1.4.3), and its reason is text beside it at 5.9:1 | — |

## Data this screen needs (research, sections 2.6, 3.1, 3.2 and 7.3)

1. **A skills search source.** skills.sh's documented v1 API takes only a Vercel OIDC token, so an app has to run on Vercel to use it ([LIVE] got 401 without one); the `skills` CLI's own search endpoint answers with no token but **isn't documented as a public API**. Open point 2 decides; nothing on this page works until it is.
2. **An MCP registry.** The official registry asks host apps to use a sub-registry instead; GitHub's (`api.mcp.github.com`) is the candidate drawn, or a registry URL an admin names (open point 4).
3. **Audit verdicts** only if turned on (`library-update.md`, open point 3).
4. **Inspect:** for the selected result, the server fetches the repo at HEAD (tarball for a public repo, the GitHub App for a private one, ADR 0040), finds the skill's folder, reads `SKILL.md`, lists the files and resolves the commit the install would pin.
5. **Install** is the library's install by reference (`library.md`), with the commit the admin saw; it refuses when HEAD moved since (`The source changed since you looked. Here is the new commit.`).
6. **Telemetry:** ostra never forwards search queries to anyone but the source being searched, and never runs the `skills` CLI with telemetry on (research 7.4).
7. **Audit log:** each search session's first query (not its text: `marketplace searched` with the source), each install (ADR 0054).

## Differences from the current code

1. Nothing exists: no marketplace, no outbound search, no install by reference.
2. ADR 0021 allows the models.dev catalog as the server's only fetch of its own; this page needs that ADR amended (open point 1).
3. **Messages:** new keys under `library.marketplace.*`.

## Open points (the research's questions 7.6; recommendations, the maintainer's answers settle them)

1. **Outbound fetches** (question 4). May the server call skills.sh, a git host and an MCP registry when an admin searches or installs? Recommended: yes, off by default behind one organization setting, with ADR 0021 amended. Drawn as on.
2. **The search source** (question 5). skills.sh's documented API needs a Vercel OIDC token. Build on its undocumented CLI search endpoint, do without search (install by reference only), or use another index? Recommended: ship the library with install by reference first (research 7.5, step 2), and this browser only once a documented source exists or the maintainer accepts the undocumented one.
3. **A dependency or our own code** (question 6). Recommended: ostra fetches from the git host itself and computes the CLI's documented hash; it doesn't run the `skills` CLI.
4. **The MCP registry** (question 12). GitHub's curated sub-registry, a registry URL an admin names, or both. Drawn: GitHub's, named in the switch.
5. **MCP servers the box can't run yet** (questions 8 and 9): stdio servers with a secret, and OAuth remotes. Recommended: list them with `Not supported yet` and no Install until their ADRs land.
6. **Audits** (question 7): shown only when an admin turns them on; drawn as on, with invented verdicts.

## Wrong in the image (build from this file)

- **The audit chips and verdicts** are invented demo data and assume audits are on. Build them only from the source's real answer, and hide them while audits are off.
- **The detail's owner and path** sit on two lines without a label. Build them as drawn but with the path a link to the folder on its host.
- **`Source not allowed`** rows don't explain how to fix it. Build the panel's `Allow it` link for an admin (state table).

Right as drawn: the notice always on top, the source switch naming each source's host, the result rows' three columns and their last cell's three states, the selected row's fill, the detail's order (name, source, description, facts, audits, `SKILL.md`, files, the pin line and `Install`), no amber.
