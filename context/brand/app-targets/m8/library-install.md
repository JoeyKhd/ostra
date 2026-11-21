# Target: install by reference into the library (proposed 2026-11-21)

> **Committed images:** each `<name>.png` is the render at 2× (2880×1912), and each `<name>.webp` is 1440×956, one image pixel per CSS pixel. All three render from `html/library-install.html`, a query string choosing the state (`?kind=mcp`, `?kind=refusals`), with the panel's own tokens (`apps/web/src/app/globals.css`) and fonts (`apps/web/src/fonts`). Sizes in this file are CSS px. Re-render: `node html/render.mjs <playwright's index.mjs> <name>`, then `python -I html/to-webp.py <name>`.

| Picture | State shown |
|---|---|
| `library-install.webp` | Alex Kim, an org admin, pressed `Add from a source` on the library (`library.md`). **Skill:** the source `globex/agent-skills` (a repo, no `@skill`), ref `main` resolved to `4c81e0a`. The repo isn't on the allowlist, so the sheet offers `Allow this source` and `Install` is disabled with the reason. Four skills found: `db-seeding` picked, two more to pick, one that breaks the spec's name rule. `db-seeding`'s five files with their sizes, two pointed out as scripts, the spec check and the hash. |
| `library-install-server.webp` | **MCP server:** `dev.globex/incidents` from GitHub's MCP registry, `v1.8.2`, its namespace allowed. Its streamable-HTTP remote chosen and its SSE remote not offered; three inputs (a URL variable, a plain header, a secret header masked); the test call's six tools; `Read-only` off. `Install incidents` enabled. |
| `library-install-refusals.webp` | Four sheets' look-ups side by side, at the sheet's real width: (1) a server that needs OAuth sign-in, installable only as marked; (2) a registry entry with packages only; (3) a server whose only remote is SSE; (4) a well-known index whose digest doesn't match the files. Each with its words and its footer. |

- **Route:** no route of its own. It's the right `Sheet` the library's primary opens, over `apps/web/src/app/(panel)/organization/skills/page.tsx`, with `?add=skill|mcp` (and `&source=…` when it's opened from a suggestion or a marketplace result), so a link reopens it filled.
- **Shell:** the double sidebar (`app-shell.md`): the rail's **Org** space, the Organization panel's **Skills and MCP** row selected. The sheet covers the page and the panel; its scrim covers everything.
- **Features:** F-145 (the skills and MCP library), ADR 0069 ("Sources, and the allowlist", "Installing", "What isn't installable in this milestone"). F-146's marketplace results install through this same flow (`library-browse.md`). The milestone 8 spec names this target in section 13 (target 11, `library-install`), starting from `../m3/agent-profile`.
- **Status: a proposed target, waiting for the maintainer's approval.**

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with each picture.

## Purpose

The maintainer, 2026-11-20: "who adds skills manually in 2026 lol". An admin installs by **reference**, never by pasting. The sheet has to show what will be installed before anything is: the exact commit or version, every file with its size, which files are scripts the agent may run, the hash, whether the source is allowed, and for a server, where it's called and which tools it has. The registries "assume minimal-to-no moderation" (ADR 0069, "Why"), so the admin's look is the review.

## Layout

The sheet is shadcn's right `Sheet` (`components/ui/sheet.tsx`): `--side` fill, a 1px `--line` left edge, `--shadow-palette`, the `--scrim` behind it, the close `x` 16px `--faint` at `top 14px; right 14px`.

- **Width 560,** not `library.md`'s 440: a file's path, its script chip and its size share one line, and a header's name sits beside its value. At 1440 the page still shows the library's names column behind it. Below 1024 wide it's `min(560px, 100vw)`.
- **Head,** padding `20px 24px 0`: the title `Add from a source` (Plex Sans 600 17px), then 13.5px `--muted` `Installed once for {organization}, pinned, and attached to no profile until you choose.`, then the 28px segmented control `Skill | MCP server` (Lucide `book-open`, `plug`) 12px under it.
- **Body,** padding `4px 24px 12px`, scrolling on its own.
- **Footer,** pinned: a 1px `--line` above, padding `12px 24px 16px`. A 13px `--muted` line on what Install does, then a row: the reason Install is off (13px `--faint`, a 14px icon) at the left, `Cancel` (ghost) and `Install …` (the sheet's one primary, Lucide `download`) at the right.
- **Labels** 12px 500 `--muted`, 12px above their control. **Inputs** 32px, `--surface`, a 1px `--control-line` edge, 7px radius, Plex Mono 13.5px `--text`. **Help** 12.5px `--faint`, 6px under its control.
- **A note** (allowlist, scripts, refusals) is a block with a 2px `--line-3` left rule, 12px left padding, a 15px icon `--faint` and 13.5px `--muted` text; an error's rule and icon are `--red`. Never a card, never amber.
- **A section title** inside the body: Plex Sans 600 14px, a mono 12px `--faint` count, and a 12.5px `--faint` note at the right, 14px above.

### Skill (`library-install.webp`)

1. **Source and Ref,** one row, `1fr | 132px`, 10px apart:
   - `Source`, placeholder `owner/repo@skill`, with `Look up` (a 26px outline button) inside its right end. Enter also looks up.
   - `Ref`, placeholder `default branch`. Empty means the repo's default branch's head.
   - **Help:** `owner/repo, owner/repo@skill, a GitHub URL, or a site's well-known index` (the forms in mono).
2. **The resolved line,** 8px down, 13px `--muted`: Lucide `check` 14px `--green`, `{ref} is {commit}` (both mono), then `--faint` `· {age} · from GitHub, public`. A private repo reads `from GitHub, through the GitHub App` (ADR 0040, ADR 0065).
3. **The allowlist note,** when the source isn't on the list (Lucide `lock`): `{host/owner/repo} isn't on {organization}'s allowlist. Sources are matched by owner and repo, never by a skill's name.` Under it, 8px down: `Allow this source` (28px outline, Lucide `shield-plus`), 12.5px `--faint` `adds the repo, in your name ·`, and a teal `the whole owner instead`. Allowing adds the entry at once (an audit entry, with who added it, ADR 0069), the note goes, and Install turns on. Only org admins see the buttons.
4. **`Skills in the repo {n}`,** right note `at {commit} · up to four folders deep`. One row per folder with a `SKILL.md`, 8px padding, a 1px `--line` under each:
   - a 16px `Checkbox` (`--teal` fill and an `--on-primary` tick when checked; a `--control-line` edge when not);
   - line 1: the name in Plex Mono 500 14px, then its folder in mono 12px `--faint`; at the right, mono 12px `--faint` `{n} files · {size}`;
   - line 2: the description, 13px `--muted`, one line with an ellipsis;
   - the row whose files show below has a `--sel` fill.
   - **A skill that breaks the spec** is disabled: the checkbox's edge `--line-2`, the name `--faint`, and line 2 in `--red` naming the rule, as `Can't install: its name must be lowercase, digits and dashes, as its folder`. The rules (ADR 0069): `name` at most 64 characters, lowercase letters, digits and dashes, matching its folder; `description` 1 to 1,024 characters; at most 20 files of at most 1 MiB each.
   - With `@skill` in the source, the list is that one skill, checked.
5. **`{name} {n} files`,** right note `of 20, each under 1 MiB`: one 26px row per file of the row with the `--sel` fill, Plex Mono 13px `--text-2`, Lucide `file-text` 14px `--faint` (`file-code` for a script), the size at the right in mono 12px `--faint`.
   - **A script** gets a 20px chip after its path naming why: `script · in scripts/, shebang`, `script · executable bit`. A file is a script when it's under `scripts/`, starts with `#!`, or has the executable bit in the tree.
   - **The scripts note** (Lucide `file-code`): `{n} files look like scripts. The skill can tell the agent to run them in the task's box, so read them before you install.` and a teal `Read {first script}`, which opens it in a read-only viewer `Dialog` (mono, line numbers).
6. **`Checks`,** a `74px | 1fr` key-value row: `check` `--green` and `SKILL.md follows the Agent Skills spec`.
7. **`Hash`:** `sha256 {first 4}…{last 4}` mono, then `--faint` `· the skills CLI's hash, as in skills-lock.json` (the whole hash on hover and copied on click, as `library-update.md`).
8. **Footer:** `Install pins {commit} and keeps these {n} files with their hash.` The button reads `Install 1 skill` / `Install {n} skills`, and is disabled with nothing picked (`Pick a skill to install.`) or the source not allowed (`Allow the source to install from it.`, Lucide `lock`).

### MCP server (`library-install-server.webp`)

1. **`Server's name in the registry`** (`1fr`, with `Look up`) and **`Name in the library`** (170px), one row. The library name is filled from the entry's last segment and editable: lowercase letters, digits and dashes, unique among the organization's servers.
2. **`Registry`,** a `Select`: the organization's registries, each named and its host in mono `--faint`. GitHub's (`https://api.mcp.github.com`) is first and there from the start; others are the ones an admin added by URL (ADR 0069, Q324). Help: `{organization}'s list: GitHub's, there from the start, and {name}, added by {admin}.`
3. **The resolved line:** `check`, the version mono, `--faint` `· latest · active · {date} · {namespace} is on the allowlist`. ostra reads `GET <registry>/v0.1/servers/{name}/versions/latest`; an entry whose `status` isn't `active` is refused (`It's {status} in the registry.`).
4. **`Remote`,** right note `streamable HTTP only`: a `RadioGroup` of the entry's `remotes[]`, each row `16px | 1fr`: a chip with the transport and the URL in mono 13px (`{variables}` kept as written), then 12.5px `--faint` under it. The chosen one: `The sidecar's MCP proxy calls it; the agent sees only the proxy's path.` An `sse` remote is shown disabled: `Not offered: MCP deprecated SSE, and ostra connects to streamable HTTP.`
5. **`Inputs {n}`:** a `150px | 1fr` row per URL variable and per header the entry declares:
   - the name in mono 13px, over 11.5px `--faint` `in the URL`, `header`, or `header · secret`;
   - a variable with choices is a `Select`; a plain value an input;
   - **a secret** (`isSecret`) is a password input with a `secret` chip (Lucide `lock`) inside its end, and the help `Kept in the secret store. Never shown again.` It's saved to the secret store and the item keeps a reference (ADR 0030). Reopened, it reads `Set: type to replace it`, as Environment's secrets.
6. **`Test call`,** with its result on the title line and `Test again` (26px outline, Lucide `refresh-cw`) at the right. The look-up runs it once the required inputs are filled: `tools/list` with the inputs, through core. The result: `check` `--green`, `tools/list answered in {ms} ms with {n} tools`, then each tool's name as a mono 12px chip, wrapping.
   - **Failing:** `circle-x` `--red`, `The server answered {status}: {first line}.` or `It didn't answer in 10 s.`, and Install stays off until a test passes.
7. **`Read-only`,** a `Switch`, off by default, with 12.5px `--faint` `Off: a registry has no read-only flag to trust. Plan mode leaves its tools alone, and "Reaching the network" asks before they run.` (ADR 0049, ADR 0069, "Attaching").
8. **Footer:** `Install pins {version}, an immutable registry version, and stores the secret.` and `Install {name}`.

### What can't be installed (`library-install-refusals.webp`)

Each replaces what follows the resolved line, and keeps the footer:

| Case | The words | Footer |
|---|---|---|
| **OAuth sign-in** (the test call met an OAuth challenge) | Lucide `key-round`. `{name} needs sign-in, which ostra doesn't do yet.` / `Its server answered the test call with an OAuth challenge. You can install it to keep track of it, marked needs sign-in, and no profile can attach it until ostra signs in to MCP servers, in a later release.` | `It can't be attached.` · `Cancel` · `Install, marked` (primary). The library row reads `needs sign-in` in its last cell, and the attach picker shows it disabled (`agent-profile-library.md`) |
| **Packages only** (`packages[]`, no `remotes[]`) | Lucide `package`. `Not installable yet: {name} runs only as a package.` / `Its entry offers {package} on npm and an OCI image, run over stdio, and no remote. Running one means a download in the box, which a docker runner's network forbids, and every runner has to behave the same. A server in a container of its own, beside the box, comes later.` Then 13px `--muted`: `A stdio server whose command is already in the box's image can still be added by hand on a profile.` | `Nothing to install.` · `Close` · `Install` disabled |
| **SSE only** | `circle-x` `--red`. `Not installable: its only remote uses SSE, which MCP deprecated.` / `ostra connects only to streamable-HTTP remotes. A version of {name} with one installs as any other server.` | as above |
| **A well-known digest that doesn't match** | `circle-x` `--red`. `{skill}'s files don't match the index.` / `The index gives sha256 {…}, and the files it served hash to sha256 {…}. A mismatch is an error, never a fallback: nothing is kept.` | `Nothing installed.` · `Close` · `Install 1 skill` disabled |

The packages list names each package's registry type (`npm`, `pypi`, `oci`, `nuget`) from the entry.

## Every state

| State | What shows |
|---|---|
| **Empty** (just opened) | The segmented control on `Skill`, an empty Source with its placeholder, an empty Ref, the help line. Nothing under it. `Install` disabled, no reason line |
| **Looking up** | `Look up` reads `Looking up…` with a 12px spinner; the area below shows three 26px `--surface` skeleton bars |
| **Not found** | `circle-x` `--red`, 13px: `No repo globex/agent-skils on GitHub, or the GitHub App can't see it.`; `No server dev.globex/incident in GitHub's MCP registry.`; `{site} has no /.well-known/agent-skills/index.json or /.well-known/skills/index.json.` |
| **No skill in the repo** | `globex/agent-skills has no SKILL.md in its first four folder levels at {commit}.` |
| **A ref that doesn't resolve** | Under Ref, 12px `--red`: `No branch, tag or commit main2 in globex/agent-skills.` |
| **A code host without `readTree`** | `{host} can't be read at a commit through ostra yet, so nothing can be installed from it.` (ADR 0069, "ADR 0025, amended") |
| **Source not allowed** | The picture. For a server, the note names the registry and the namespace: `dev.globex/* in GitHub's registry isn't on the allowlist.` with `Allow this namespace` and `the whole registry instead` |
| **Over the limits** | The skill's row is disabled with `Can't install: {n} files, over the 20 a skill holds.` or `Can't install: {path} is {size}, over 1 MiB.` |
| **A name the library already has** | The row's line 2, `--muted`: `The library has a db-seeding from acme/agent-skills. Name this one in the library:` with a mono input, filled `db-seeding-globex` |
| **Already installed, same source** | The row reads `In the library at {pin}` with `check` `--green`, and isn't checked. A newer commit is the item's update (`library-update.md`), never a second install |
| **Installing** | `Install` reads `Installing…` with a spinner. Core fetches the commit the admin saw; if the ref moved since, it refuses: `The source moved to {commit} since you looked. Here is the new one.` and the sheet reloads the look-up |
| **Installed** | The sheet closes; a toast `db-seeding installed at 4c81e0a. Attach it to a profile to use it.` with `Attach…` (opens the item's Used-by tab); the library's row appears |
| **Install fails** | Under the footer line, 13px `--red`: the reason, named (`scripts/seed.sh changed size since you looked.`). Nothing is added |
| **Opened from a suggestion or a marketplace result** | The fields filled and looked up at once; the head adds 13px `--faint` `Suggested by Sam Rivera` or `From skills.sh` |
| **A member, not an admin** | Never sees this sheet: their button is `Suggest a skill or server` (`library-suggestions.md`) |
| **Light theme** | `../m7/light-home.md`'s tokens: the sheet on `--side` `#F3F3F5`, inputs on `--surface` with a `--control-line` `#80838A` edge |

## Keyboard

- The sheet is a Radix `Dialog`: focus starts in `Source`, Tab cycles inside, Escape closes (asking first when something was looked up and not installed: `Discard this look-up?`).
- `Skill | MCP server` is a `ToggleGroup`: ← and → switch.
- Enter in `Source`, `Ref` or the server's name looks up.
- The skills list is a group of checkboxes, each one Tab stop; Space toggles; ↑ and ↓ move between rows; the focused row's files show below.
- The remotes are a `RadioGroup`: ↑ and ↓ choose.
- ⌘Enter (Ctrl+Enter) installs when Install is on.

## Narrow and phone width

- **768 to 1023:** the sheet is `min(560px, 100vw)` over the page.
- **Phone (390):** the shell's phone pattern (a 54px top bar whose menu button opens the rail and the panel as one sheet; `app-shell.md`). This sheet becomes a full-screen bottom `Sheet`:
  - a 54px head with `x`, the title, and the segmented control under it at full width;
  - Source and Ref stack; every control is 44px tall (F-075);
  - file rows put the script chip under the path;
  - the footer stays pinned with `Cancel` and `Install` side by side, each half the width.
- Installing from a phone is allowed. It's rare, and nothing about it needs a wide screen.

## Components (shadcn/ui names)

- **From the repo:** `Sheet`, `ToggleGroup`, `Input`, `Select`, `Checkbox`, `RadioGroup`, `Switch`, `Button`, `Dialog` (the script viewer), `Tooltip`, the toast.
- **New:**
  - `components/library/add-from-source-sheet.tsx`: the head, the toggle, the footer, the state machine;
  - `skill-lookup.tsx`: the found skills, the files and the checks;
  - `server-lookup.tsx`: the registry, the remotes, the inputs and the test call;
  - `allowlist-note.tsx` (also used by `library-suggestions.md` and `library-browse.md`);
  - `install-refusal.tsx`.

  The look-up's result is a union with an exhaustive `switch`: `found-skills | found-server | not-found | not-allowed | needs-sign-in | packages-only | sse-only | digest-mismatch | unreadable-host`. A source is a union: `github | git | well-known | registry`.
- **Icons** (Lucide, stroke 1.75): `book-open`, `plug`, `x`, `check`, `lock`, `shield-plus`, `file-text`, `file-code`, `download`, `refresh-cw`, `key-round`, `package`, `circle-x`, `ban`, `info`, `chevron-down`.

## Tokens

`globals.css`'s, both themes: `--side` the sheet, `--scrim` behind it, `--surface` the inputs, `--sel` the row whose files show and the chosen remote, `--line` hairlines, `--line-2` chips and disabled controls, `--line-3` a note's rule, `--control-line` inputs, checkboxes and radios, `--text` values, `--text-2` file paths and tool names, `--muted` labels and notes, `--faint` help, sizes and paths, `--teal` a checked box, a chosen radio, links and the on switch, `--green` a passed check, `--red` a refusal and a broken rule, `--primary` Install. **No amber.**

## WCAG AA (F-081)

| Pair | Dark | Light | Need |
|---|---|---|---|
| `--faint` on `--side` (help, sizes, folders) | 6.0:1 | 5.3:1 | 4.5 |
| `--muted` on `--side` (labels, notes) | 9.8:1 | 7.6:1 | 4.5 |
| `--faint` on `--sel` (the picked row's folder and size) | 5.2:1 | 4.8:1 | 4.5 |
| `--muted` on `--sel` (its description) | 8.6:1 | 7.0:1 | 4.5 |
| `--teal` on `--side` (links) | 8.5:1 | 5.7:1 | 4.5 |
| `--red` on `--side` (a broken rule, a refusal) | 6.0:1 | 5.3:1 | 4.5 |
| `--green` on `--side` (the check icons) | 7.5:1 | 5.2:1 | 3 |
| `--control-line` on `--surface` (an input's edge) | 3.4:1 | 3.4:1 | 3 |
| `--control-line` on `--side` (an unchecked box) | 3.7:1 | 3.4:1 | 3 |
| `--on-primary` on `--teal` (a checked box's tick) | 7.5:1 | 6.1:1 | 3 |
| A disabled `Install` at 45% | exempt (WCAG 1.4.3); its reason is text beside it at 6.0:1 | | — |

## Data it needs

From ADR 0069 and the milestone 8 spec (tickets 27 and 30):
1. **`library.lookUp({ kind, source, ref })`**, through core, never from the browser (ADR 0021): for a skill, the resolved commit, how it was read (public or the App), the skills found with each one's folder, name, description, files (path, size, mode, script reason) and the spec check's result; the hash of the picked ones. For a server, the entry's version, status, remotes, inputs (`isRequired`, `isSecret`, `choices`) and packages.
2. **`library.testServer({ registry, name, version, remote, inputs })`:** the tool names, or the failure, or the OAuth challenge.
3. **The allowlist** and `library.allowSource({ entry })` (org admins), an audit entry.
4. **`library.install`** with the commit or version the admin saw, refused when it moved.
5. **The secret store** for each secret input, written before the item, kept as a reference.

## Differences from the current code

1. **No install by reference:** a skill is typed or uploaded into one profile's editor (`../m3/agent-profile.md`, "Skills"), and an MCP server is typed by hand.
2. **No allowlist, no registry, no test call, no hash.**
3. `CodeHostAdapter` has no `readTree` yet (ADR 0069, "ADR 0025, amended", ticket 02).
4. **Messages:** new keys under `library.install.*`.

## Open points (recommendations; the maintainer's approval settles them)

1. **The sheet's width:** 560 (drawn) instead of `library.md`'s 440. Recommended: 560, for the files' and inputs' rows.
2. **OAuth servers:** install them marked and unattachable (drawn, as F-145's row reads "is marked and can't be attached"), or refuse the install outright until sign-in comes. Recommended as drawn: the library then lists what the organization wants, and the daily update check covers it.
3. **`Allow this source` in the same sheet** (drawn, ADR 0069: "asks the admin to add it in the same dialog"), defaulting to the repo, with the whole owner one click away. Recommended as drawn; the owner is wider than most installs need.
4. **Several skills from one repo in one install** (drawn as checkboxes): each becomes its own library item with the same commit. Recommended: yes; a repo such as `anthropics/skills` holds dozens.

## Wrong in the image (build from this file)

- **`library-install.webp`:** the selected skill's description is cut (`…between…`) by the row's width. Build it with the ellipsis and the whole text in a `title` and a `Tooltip` on focus.
- **`library-install.webp`:** `Install 1 skill` is drawn at 45% opacity, a stand-in for the disabled `Button`. Build the real disabled state (`disabled` and `aria-disabled`, the reason as its `aria-describedby`).
- **`library-install-refusals.webp`** is a board of four look-ups, not a screen: each card is the sheet's body from the resolved line down, at the sheet's 560 width, without the head's lede and the scrim.
- **The library behind the sheet** is trimmed (no `Updates` chip column, no suggestion band). Build the page from `library.md`.
