# Target: one library item, with an update to review (approved 2026-11-21)

> **Committed images:** `library-update.png` (2880×1912, the render at 2×) and `library-update.webp` (1440×956, one image pixel per CSS pixel), rendered with Playwright from `html/library-update.html` with the panel's own tokens and fonts. Sizes in this file are CSS px. Re-render: `node html/render.mjs <playwright index.mjs> library-update`, then `python -I html/to-webp.py library-update`.

| Picture | State shown |
|---|---|
| `library-update.webp` | Alex Kim opened `webapp-testing`, a skill installed from `anthropics/skills` and pinned at `a3f9c1e`. Its ref `main` has moved to `9b2d4f0`: the **Update** tab is open with the three changed files and `SKILL.md`'s diff, `Keep a3f9c1e` and `Accept update`. The properties panel shows the source, the pin and hash, who installed it, the audits (off) and the three profiles that use it. |

- **Route:** new, `apps/web/src/app/(panel)/organization/skills/[item-id]/page.tsx`, `?tab=skill|files|used-by|update`. The tab opens on `Update` when one is waiting, else on `SKILL.md` (or `Server` for an MCP item).
- **Shell:** the double-sidebar shell, the rail's **Org** space, the Organization panel's **Skills and MCP** row selected.
- **Features:** F-021, and F-144 (the skills and MCP library). The milestone 8 spec proposes F-144 (`context/specs/m8-previews-and-library/spec.md`, section 13, target 12 `library-update`); it isn't in `features.md` yet. Facts: `context/research/skills-and-mcp-marketplaces.md`, sections 7.3 ("Updates", design B), 7.4 ("Pinning and drift", "Secrets") and 5 (why an update is reviewed, never automatic).
- **Status: approved 2026-11-21** (the maintainer: "yes to all").

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

A library item is text and tools that every agent on its profiles will trust. skills.sh's own audit partner warns that "skills can become malicious at any point" (research 7.3), and a remote MCP server can change its tools at any time (the "rug pull", research 7.4). So the item page has to show:

1. **Exactly what is installed:** source, path, ref, the pinned commit or version and the content hash, and who installed it when.
2. **Who gets it:** the attached profiles (and through them, how many projects), or every profile.
3. **What an update would change, before it reaches anyone:** the upstream diff, file by file, with one decision: accept or keep the pin.

## Layout

Page column 1136px: the page `minmax(0, 1fr)` and the properties panel 320px; page padding `26px 36px 20px`.

1. **Top bar,** 46px: `Organization › Skills and MCP › {name}`; at the right `Check for updates` (outline, 28px, Lucide `refresh-cw`) and a ghost `ellipsis` menu: `Detach from every profile`, `Remove from the library` (both confirm in a `Dialog`; remove is refused while a profile still uses it).
2. **Key line,** mono 13px `--faint`: `Skill · installed {d MMM yyyy}` (`MCP server · …` for a server).
3. **Title,** the name, Manrope 700 26px (an identifier, lowercase as its source writes it).
4. **Lede,** 15px `--muted`: the item's description (the `SKILL.md` front matter's `description`, the registry's `description`), as plain text.
5. **Source line,** 8px under the lede, 14px `--muted`, one line: Lucide `folder-git-2` 14px, the repo as a `--teal` link to its page on the host, the path mono 13px `--text`, ` · pinned at ` + the commit mono, ` · ` + `sha256 {first 4}…{last 4}` mono `--faint` (the whole hash in its `title` and in the panel). An MCP item: Lucide `plug`, the registry name, ` · ` the version, ` · ` `remote` and the host of its URL.
6. **Tabs,** 18px under: `SKILL.md`, `Files {n}`, `Used by {n}`, `Update {n}` (only while one waits). An MCP item: `Server`, `Tools`, `Used by`, `Update`.
7. **The update's head** (the `Update` tab), 18px under the tabs: a 2px `--line-3` left rule, padding `12px 0 12px 14px`, no box:
   - line 1: Lucide `circle-arrow-up` 16px `--teal`; the ref mono `--text`; `moved to` + the new commit mono; ` · {age} · {n} files, ` `--faint`; `+{added}` `--green` and `−{removed}` `--red` mono; at the right `Keep {pinned}` (outline, 28px) and `Accept update` (the page's one primary, 28px, Lucide `check`).
   - line 2, 13px `--faint`, at most 560px: `Accepting moves the {n} profiles that use it to {commit}. Running tasks get it at their next session, never mid-turn.`
   - The rule is `--line-3`, not amber: an update waits on an admin's chore, not on a person an agent is blocked by.
8. **The diff,** 14px under: one frame, 1px `--line`, radius 8px, two panes:
   - **Files,** 226px, a 1px `--line` to its right, padding 6px: label `{n} files changed` 12px weight 500 `--faint`; one 30px row per file, mono 12.5px `--text-2`, the path with an ellipsis from the left (the file name stays), `+n` `--green` `−n` `--red` 12px at the right; the open file `--sel`. Added files show `added` `--faint`, removed ones `removed` `--red`.
   - **The file's diff:** a 34px head on `--surface` (`{file}` mono `--text`, `{old} → {new}` `--faint`, at the right a `Unified` / `Split` toggle, 12.5px `--faint`), then hunks: the hunk line (`@@ … @@`, 24px, `--surface`, 12px `--faint`), and lines on a 20px grid, mono 12.5px: old and new line numbers (34px each, 11.5px `--faint`, right-aligned), a 16px sign column, the text. Added lines `--diff-add` with a `+` `--green`; removed `--diff-del` with a `−` `--red`; context `--text-2`. Long lines wrap with a hanging indent (never cut). Binary or files over 1 MiB: `{file} · binary, {size}` and no lines.
9. **The note,** 10px under the frame, 12.5px `--faint` with Lucide `info`: `This is text the source changed. Read it before you accept: a skill is part of every prompt that loads it.` For an MCP item: `The registry entry changed. Its tools are checked when a task connects.` (open point 4).

### The other tabs

- **SKILL.md:** the file rendered as `.agent-md` (no raw HTML), its front matter as key/value rows above it.
- **Files:** the item's files as rows (path mono, size, a `View` link opening it as text), with the limits under them (`1 MiB a file, 20 files a skill`, research 1.1's working values).
- **Used by:** one 40px row per attached profile: Lucide `sliders-horizontal`, the profile name (a link), its projects `{n} projects` `--faint`, and `Detach` (ghost); `Attach to a profile` (`--teal`) opens a `Command` list of profiles. The `Every profile` switch heads the tab.
- **MCP `Server`:** the remote URL, the transport, each input with `secret` and `in the secret store` or `not set` `--red` (never its value), and `Edit secrets`.

### The properties panel (320px)

- **Source** (for a skill): `Repo` mono, `Path` mono, `Ref` mono, `Commit` mono, `Hash` (`sha256 7c1e…4b09` mono 13px, the whole hash on hover and copied by a click), `Fetched` (`from GitHub, public`, `from GitHub through the GitHub App` for a private repo, ADR 0040, `from {host}` for git and well-known sources), `Installed` (avatar 20px, name, ` · {d MMM}` `--faint`), `Audits`.
  - **Audits** says what's true: `Off · skills.sh audits` `--faint` while the organization hasn't turned on skills.sh's partner audits (open point 3); when on, one chip per partner (`Gen · pass`) as the marketplace shows them. ostra runs no audit of its own.
- **Source** (for an MCP item): `Registry` (the registry's host), `Name`, `Version`, `Remote` (the URL's host), `Secrets` (`1 in the secret store`), `Installed`, `Tools` (`12 · checked 14:02`, when open point 4 lands).
- **Used by:** the `Every profile` row with its switch (off: `--surface` track, `--control-line` edge, `--text` knob; on: `--teal` track); then the attached profiles, 32px each (Lucide `sliders-horizontal` `--faint`, the name, `{n} projects` 13px `--faint` at the right); then `Attach to a profile` `--teal` with Lucide `plus`. With `Every profile` on, the list reads `Every profile · {n} profiles` and the rows go.

## Every state

| State | What shows |
|---|---|
| **Update waiting** (the picture) | As above. `Check for updates` still works, and finds the same or a newer commit; a newer one replaces the waiting diff |
| **No update** | No `Update` tab; the page opens on `SKILL.md`. `Check for updates` shows a 13px `--faint` line under the source line for 5 s: `main is still at a3f9c1e. Checked just now.` |
| **Checking** | The button reads `Checking…` with a 12px spinner and is disabled; the page is unchanged |
| **The check fails** (host down, rate limit, private repo without access) | Under the source line, 13px: Lucide `circle-alert` `--red` + `Couldn't reach github.com: {reason}.` + `Try again` `--teal`. The pinned copy is untouched |
| **Accepting** | `Accept update` reads `Accepting…` with a spinner; the server fetches the new commit, recomputes the hash and checks it matches the diff shown (else it refuses: `The source changed again since this diff. Review the new one.`) |
| **Accepted** | The `Update` tab goes; the source line and the panel show the new commit and hash; a toast `Moved to 9b2d4f0. 3 profiles get it at their next session.`; the History of the item (the audit) gains the entry |
| **Kept** | The waiting update is dismissed for this commit; a later commit opens a new one. `Keep a3f9c1e` asks nothing |
| **Source not allowed** (the allowlist changed after install) | Under the source line: Lucide `lock` + `{source} is no longer on the allowlist. The pinned copy still reaches its profiles; updates are refused.` `Accept update` is disabled with that reason |
| **Source unavailable** (deleted, ref gone) | Under the source line, `--red`: `The source is gone since {date}. The pinned copy keeps working.`; `Check for updates` disabled |
| **A member (not an org admin)** | Read-only: no top-bar actions, no Accept/Keep (the `Update` tab is visible with `An org admin reviews updates.`), no switch or Detach |
| **An MCP item with a new version** | The `Update` tab shows the registry entry's changes as a diff of `server.json` fields (version, remote URL, inputs); a new `isSecret` input asks for its value before Accept |
| **Light theme** | `light-home.md`'s tokens: `--diff-add` `#E6F2EA`, `--diff-del` `#FBE9E6`, `--green` `#25734F`, `--red` `#B4382D` |

## Keyboard

- Tabs: ←/→ (Radix `Tabs`).
- In the diff, the file list is a `listbox`: ↑/↓ choose a file, Enter shows it; `n` and `p` jump to the next and previous hunk while the diff has focus (scoped like the task page's keys; listed on the `?` sheet under `On a library update`).
- `Accept update` and `Keep` are ordinary buttons; Accept is never the default action of Enter on the page.
- Focus order: top-bar actions, source link, tabs, update head buttons, file list, diff, panel.

## Narrow and phone width

- **1024–1279px:** the contextual panel collapses (the shell's rule); the file list narrows to 180px.
- **Below 1024px:** the properties panel moves under the diff; the file list becomes a `Select` above the diff.
- **Phone (390px):** the shell's top bar and menu sheet (`app-shell.md`, "Phone"). The update head stacks: the summary line, the note, then `Keep` and `Accept update` full width (44px). The diff shows one column of numbers (the new one), lines wrapping. The panel's groups follow as sections.

## Components (shadcn/ui names)

- **From the repo:** the shell, `Tabs`, `Button`, `Switch`, `DropdownMenu`, `Dialog`, `Command`, `Tooltip`, the diff renderer of the task's Changes tab (`components/tasks/task-changes/diff-view.tsx`, `--diff-add`/`--diff-del`), `.agent-md`.
- **New:** `components/library/item-header.tsx`, `item-update.tsx` (the head and its accept flow), `item-diff.tsx` (file list + the task diff renderer), `item-used-by.tsx`, `item-properties.tsx`. The item kind and the update state are unions with exhaustive switches.
- **Icons** (Lucide, stroke 1.75): `folder-git-2`, `plug`, `circle-arrow-up`, `check`, `refresh-cw`, `ellipsis`, `sliders-horizontal`, `plus`, `info`, `lock`, `circle-alert`.

## Tokens

`--bg`, `--surface` (diff head, hunk lines), `--sel` (the open file), `--line`, `--line-2`, `--line-3` (the update's rule), `--text`, `--text-2` (diff text, file names), `--muted`, `--faint`, `--teal` (links, the update icon, the switch), `--green`/`--diff-add`, `--red`/`--diff-del`. **No amber.**

## WCAG AA (F-081), dark

| Pair | Ratio | Need |
|---|---|---|
| `--text-2` #D6D8DB on `--diff-add` (#141E1C over the page) | 11.9:1 | 4.5 |
| `--green` #4FB286 on `--diff-add` (the `+` sign) | 6.5:1 | 4.5 |
| `--text-2` on `--diff-del` (#231718) | 12.2:1 | 4.5 |
| `--red` #E5675C on `--diff-del` (the `−` sign) | 5.3:1 | 4.5 |
| `--faint` #8B8E93 on `--surface` (hunk lines, line numbers on the head) | 5.6:1 | 4.5 |
| `--faint` on `--sel` #1A1B1E (the open file's counts) | 5.2:1 | 4.5 |

In light: `--green` on `--diff-add` 5.0:1, `--red` on `--diff-del` 5.1:1, `--faint` on `--sel` 4.8:1.

## Data this screen needs

1. **The item** (`library.md`, data item 1) with its whole hash and the installer.
2. **A pending update:** the new commit (or version), when the ref moved there, the changed files with counts, and each file's diff, computed by the server from the two fetched trees. The accept step re-fetches and refuses when the content no longer matches what the admin saw.
3. **Attachments** with each profile's project count.
4. **Audits** (only when turned on): the skills.sh audit result per partner, fetched by the server (research 7.3: the documented API needs a Vercel OIDC token; the CLI's lookup is gated by its telemetry setting). Until that's settled, `Off`.
5. **Audit log:** accept, keep, attach, detach, remove, each by field names (ADR 0054).

## Differences from the current code

1. **No item page;** a profile's skill is edited in the profile editor as a `SKILL.md` text box and a file picker.
2. **No provenance, no hash, no update check, no diff** (research 1.1).
3. **Messages:** new keys under `library.item.*`.

## Open points (recommendations; the maintainer's answers settle them)

1. **Updates wait for an admin** (recommended, drawn), never automatic; a running task gets an accepted update at its next session (research 7.6, question 11).
2. **Keep means "skip this commit"** (recommended): the next upstream commit opens a new review, so a kept pin never goes stale silently.
3. **Show skills.sh's partner audits?** They need a call to skills.sh per skill and its OIDC API or the CLI's telemetry-gated lookup (research 7.6, question 7). Recommended: off by default, shown only when an admin turns them on; drawn as `Off`.
4. **Tool-list pinning for MCP items** (research 7.4): the sidecar's MCP proxy could hash a server's `tools/list` and report a change. Whether the proxy can read replies under the 2026-07-28 spec's flow is **unverified** in the research; the page leaves a `Tools` line for it and claims nothing until it lands.

## Wrong in the image (build from this file)

- **Diff line 8** (`Use scripts/with_server.py: it starts each server and wa…`) is cut with an ellipsis. Build long lines wrapping with a hanging indent.
- **The diff head's `Unified`** is plain text. Build the `Unified` / `Split` toggle as a small segmented control.
- **The file rows' paths** truncate at the end (`scripts/with_s…`). Build them truncating from the left, so the file name stays.

Right as drawn: the source line, the update head with its neutral rule and its two buttons, the two-pane diff, the note, the properties panel's `Source` and `Used by` groups, `Audits: Off`.
