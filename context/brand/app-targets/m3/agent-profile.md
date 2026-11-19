# Target: one agent profile's editor (milestone 3, screen 2)

> **Committed image:** `agent-profile.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel.

- **Prompt:** `agent-profile.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 2 generations. The first had the layout and copy right but set the notes, descriptions and inputs in mono, misspelt `mcp-ripgrep`, boxed the ghost buttons and drew the panel's labels as bold headings. The second, kept, is a constrained redraw of the first. References: `app-targets/m1/environment.png` (the screen this one starts from, spec section 12), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`, plus the first generation for the second.
- **Routes (new):** `apps/web/src/app/(panel)/organization/agent-profiles/[profile-id]/page.tsx` and `.../agent-profiles/new/page.tsx` → `components/agent-profiles/agent-profile-editor.tsx`.
- **Features:** F-021 (agent profiles), F-026 (approval rules), F-063 (plan first). Spec section 12, screen 2; section 11, items 2, 6 and 7; ADR 0049. Ticket 34 (`agentProfiles.get`, `.save`, `.archive`, `.presets`, `.ruleCoverage`), ticket 42 (this screen).
- **Status:** a proposed target, waiting on approval (ticket 41's `## Comments`). Ticket 42 builds its data and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

Everything a task started with this profile gets, on one page: the agent and model, instructions, skills, MCP servers, the approval rules that make the agent wait for a member, plan first, and who may pick it. An admin edits and saves it, or archives it. A member who may use it opens it read-only, to see what it will do.

The page has to make two things plain, because both are easy to get wrong:
- **Secrets never come back.** An MCP server's header values go to the secret store and show only as `set`.
- **A rule is a person in the loop, not a wall** (ADR 0049). The editor shows what each rule catches (the coverage line) and says in one line that the box, not the rule, contains the agent.

The picture shows `Careful`, the milestone 3 demo's profile (spec section 3, step 1), with an admin writing its custom rule `Config files`.

## Layout (CSS px at 1440 wide)

| Region | Size | Contents |
|---|---|---|
| Sidebar | 232px, `--side`, 1px `--line` on its right | the shared sidebar, **Agent profiles** selected. Built from the shell, not the picture |
| Top bar | 44px, 1px `--line` below | breadcrumb `Acme Corp › Agent profiles › Careful` (`Agent profiles` links back to the list; the last part `--text` 500). Right, admins only: **Save profile**, the page's one primary button, disabled until something changed |
| Main column | `1fr`, padding `28px 40px`, content max 720px | eyebrow, title, lede, status line, then the sections Agent and model, Instructions, Skills, MCP servers, Approval rules, and the footnote |
| Properties panel | **340px** (`wideProperties`: it holds form controls), 1px `--line` on its left, padding `20px 18px` | Profile, Plan first, Who may use it, Default for, Archive |

The picture draws the sidebar at about 240px and the panel at about 400px. Build 232px and 340px.

### Heading

1. **Eyebrow,** Plex Mono 12px `--faint`: `Agent profile · saved 2h ago` (`agentProfiles.savedAgo`). New: `New agent profile`. Archived: `Archived 3 Nov`.
2. **Title:** the profile's name, Manrope 700 24px, letter-spacing −0.015em; it follows the Name field as it's typed. New and still unnamed: `New profile`. The built-in profile adds an outline chip `built-in` after the title, vertically centred.
3. **Lede,** 13.5px `--muted`, one line, 8px under the title: `Its permissions and MCP servers win over a repo's own agent config. Its instructions and skills sit beside the repo's.`
4. **Status line** (after a save, `role="status"`), 12.5px: a `check` icon and `Saved.` in `--green`.

Sections are `Section`s, 26px apart: a title line (Plex Sans 600 13px), an optional count (Plex Mono 11.5px `--faint`), an optional inline note (12.5px `--muted`, Plex Sans), then the content 10px down.

### Agent and model

Three labelled fields in one row, 12px apart; labels 12px 500 `--muted`, 6px above; controls 32px, `--surface`, 1px `--line-2`, radius 7px, 13px Plex Sans:

| Field | Width | Contents |
|---|---|---|
| Name | ~212px | `Input`, `Careful`. Required, unique in the organization, at most 60 characters |
| Agent | ~190px | `Select` of the registered agent adapters by display name (`agentDisplayName`): `OpenCode`. With one adapter it still shows as a select with one option, so a second agent (Claude Code, after v1 since 2026-11-19) slots in without a new layout |
| Model | flex (~295px) | `Select` of the organization's listed models, grouped by provider: the model's 15px logo (`logoPath`, Lucide `cpu` without one), its name in `--text` (`Claude Opus 5.5`), the provider in `--faint` (`Anthropic`). A custom model shows its endpoint ID in Plex Mono and a `custom` chip. No model listed anywhere: the select is disabled and reads `No models yet`, with a teal link under it `Add a provider under Models` |

### Instructions

- Title `Instructions`, note `added beside the repo's AGENTS.md, never replacing it`.
- An editor box: `Textarea`, `--surface`, 1px `--line-2`, radius 8px, padding `10px 14px`, **Plex Mono 12.5px / line-height 1.75**, no line numbers (it's prose, not a script), at least 3 lines, grows with its text. Placeholder: `What every task with this profile should know, on top of the repo's own instructions.`
- Demo text: `Add a line to CHANGELOG.md for every change you make.` / `Say in the PR why any file under config/ changed.`

### Skills

- Title `Skills`, count `1`, note `written to the task's own config folder, never to the repo`.
- Rows, 40px, a 1px `--line` hairline above each and under the last:
  1. Lucide `book-open` 15px `--faint`
  2. the name, Plex Mono 13px `--text` (`changelog`), ~150px
  3. the description, 13px `--muted`, flex, truncated: the `description` of the `SKILL.md` front matter, else its first line (`How a changelog line reads`)
  4. Plex Mono 12px `--faint`: `SKILL.md · 1 file` (`SKILL.md` alone with no files; `· 3 files`)
  5. a teal `Edit` link, no underline (underline on hover)
  6. a ghost icon button, Lucide `x` 14px `--faint`, `--red` on hover, `aria-label="Remove changelog"`
- Under them, 8px down, a ghost button, 24px, no border, `plus` 13px and `--muted` text: `Skill`.
- No skills: one 40px row in `--faint`: `No skills. A skill is a SKILL.md and up to 20 files the agent reads when it needs them.`
- **Adding or editing** opens a `Sheet` on the right, 420px: `Name` (Plex Mono `Input`, lowercase letters, digits and dashes; help `The folder name the agent sees.`), `SKILL.md` (Plex Mono `Textarea`, at least 14 lines), `Files` (a list of path · size rows with an `x` each, and a ghost `Add files` button that opens the file picker; help `Up to 20 files, at most 1 MiB each.`), and `Done` (primary). Saving still happens with `Save profile`.
  - Errors, 12px `--red` under the field: `Lowercase letters, digits and dashes only.`; `Another skill already has that name.`; `A skill holds at most 20 files.`; `{path} is over 1 MiB.`

### MCP servers

- Title `MCP servers`, count `2`, note `reached through the runner's MCP proxy, so no secret enters the box`.
- Rows, 40px, hairlines:
  1. Lucide `plug` 15px `--faint`
  2. the name, Plex Mono 13px `--text`, ~150px (`release-names`, `repo-search`)
  3. an outline chip, Plex Sans 12px: `HTTP` or `stdio`
  4. HTTP: the URL, Plex Mono 12.5px `--faint`, flex, truncated, full value in `title` (`https://names.acme.internal/mcp`). stdio: the command and arguments, the same face (`mcp-ripgrep --root .`)
  5. HTTP with headers: each header's name in Plex Mono 12.5px `--muted` (`Authorization`), then an outline chip with Lucide `lock` 12px and `set`. More than one: the first, then `+1` in `--faint`
  6. when the server is marked read-only: an outline chip `read-only` (see "Data")
  7. a teal `Edit` and the remove button
- Under them two ghost buttons: `HTTP server`, `stdio server`.
- No servers: one 40px row in `--faint`: `No MCP servers.`
- **Adding or editing** opens a `Sheet`, 420px:
  - HTTP: `Name`; `URL` (Plex Mono); `Headers`, rows of a name (Plex Mono `Input`) and a value (password `Input`, placeholder `Value`; a stored one shows `Set: type to replace it`, as Environment's secrets), with `x` and a ghost `Header`; help `Values go to the secret store and are never shown again. The runner's MCP proxy adds them; the agent sees only the proxy's address.`
  - stdio: `Name`; `Command` (Plex Mono; help `A command already in the box's image.`); `Arguments` (Plex Mono, one per line); `Variables`, name and value rows; help `No secrets here: a server that needs one runs as an HTTP server behind the proxy.`
  - Both: `Read-only` `Switch`, off by default, help `Its tools only read. Plan mode may call them, and "Reaching the network" doesn't ask for them.`
  - `Done` (primary).

### Approval rules

- Title `Approval rules`, count `3`, note `the agent waits until a member approves`.
- **Presets:** one row of four outline buttons, 26px, 1px `--line-2`, radius 6px, 12.5px `--muted`, `plus` 13px first, 8px apart, wrapping on narrow widths: `Adding a dependency`, `Writing a migration`, `Commands outside an allowlist`, `Reaching the network` (from `agentProfiles.presets`). Pressing one adds its rule with the preset's defaults **and opens it for editing** (ticket 42: "one-click rules that open editable"). A preset already in the profile is disabled: `--faint` text, `check` icon in place of `plus`, `Tooltip` `Already in this profile`.
- **Rules,** a 1px `--line` hairline above each and under the last, padding 9px 0, two lines:
  1. the tool's icon, 15px `--faint`: `file-pen` (edit), `terminal` (execute), `globe` (fetch), `plug` (mcp)
  2. line one: the name, 13px `--text`; for a rule added from a preset, an outline chip `preset`
  3. line two, 12px `--faint`: the tool in Plex Sans (`Edit files ·`, `Run a command ·`, `Fetch a URL ·`, `Call an MCP tool ·`), then the match in Plex Mono: the globs comma-separated (`**/migrations/**, **/migrate/**, **/*.sql, **/prisma/schema.prisma`); `outside 9 allowed: ls, cat, rg, git status, pnpm test …`; `pnpm add, npm install +7`; `any URL`; `any server not marked read-only`. Truncated with the full text in `title`
  4. at the right a teal `Edit` and the remove button
- **A rule open for editing** (the picture's third rule): in place of the row, a block with a 2px `--line-2` left rule (never amber, never a card) and 12px left padding:
  1. `Name` (label 12px `--muted`), an `Input` ~200px: `Config files`
  2. one line, 8px apart: a `Select` for the tool (`Edit files`, `Run a command`, `Fetch a URL`, `Call an MCP tool`); a `Select` for the match, whose options follow the tool (edit: `Path matches`, `Any file`; execute: `Command starts with`, `Command outside this allowlist`, `Any command`; fetch: `Any URL`; mcp: `Any server not marked read-only`, `Any server`); and the match's input in Plex Mono, flex: globs or commands, comma-separated (`config/**`); hidden for the "any" matches
  3. **the coverage line** (`agentProfiles.ruleCoverage`, debounced 300ms), 12.5px, 8px down: a `check` 13px and `Asks for` in `--muted` with the first matched sample in Plex Mono `--text` (`config/settings.json`); then 16px on, a `minus` 13px and `not for` in `--faint` with the first unmatched sample in Plex Mono (`src/config.ts`). For commands: `Asks for pnpm add zod · not for pnpm test`. Nothing in the samples matches: `Matches none of the sample paths.` in `--muted`
  4. `Done`, a small secondary button (26px) at the right, which closes the block. A preset just added opens with its defaults and the same line
  - Errors, 12px `--red` under the input, `role="alert"`: `Not a valid glob: {reason}`; `Give the rule at least one command.`; `Give the rule a name.` A rule with an error can't close, and `Save profile` is disabled.
- Under the rules, a ghost button `Custom rule`, which adds an empty rule open for editing (tool `Edit files`, match `Path matches`).
- No rules: one 40px row in `--faint`: `No rules: the agent asks nobody. Add a preset or a rule of your own.`

### Footnote

22px under the last section: Lucide `shield-check` 13px `--faint`, then 12.5px `--muted`: `A rule keeps a person in the loop. It doesn't contain the agent: a command can still write a file an edit rule watches. The box contains it.` (ADR 0049 requires the editor to say this.)

### Properties panel

`PropGroup`s with an 11px 500 `--faint` label, 30px `PropRow`s with the 96px key column, 12.5px; a 1px `--line` between groups. Help text 12px `--faint`, 6px under its control.

1. **Profile:** `Status` · a 7px dot and the word: `--green` with its halo, `Active`; `--faint`, `Archived`; `--faint`, `Not saved yet` on a new profile. `Created` · `12 Nov by Alex Kim`. `Used by` · `14 tasks` (the tasks that started with it, `Task.agentProfileId`), `No tasks yet` in `--faint`.
2. **Plan first:** the group's label `Plan first` shares its row with a `Switch` at the right, which it labels (`aria-labelledby`) (on: `--teal` track, `--ink` knob; off: `--line-2` track). Help: `The first turn only reads and proposes a plan. The driver approves it before anything changes.`
3. **Who may use it:** a `RadioGroup`, 28px rows: `Everyone` and `Only these members`. With `Only these members`, one 30px row per member: an 20px avatar, the name 13px `--text`, a remove `x` at the right; then a teal `Add member` link with `plus` 13px, opening a `Popover` + `Command` of the organization's members (search by name or email). Help: `Organization admins can use every profile.`
   - `Only these members` with nobody listed: 12px `--red` `Add at least one member, or choose Everyone.`, and `Save profile` is disabled.
4. **Default for:** one 30px row per project and kind: the project's 8px colour square, the name 13px `--text`, the kind at the right in `--muted` (`code tasks`). None: `No project defaults to it.` in `--faint`. A project picks its default in its own settings (`m1/project` grows), so nothing here is editable.
5. **Archive** (admins, never on the built-in profile): a ghost button, 28px, Lucide `archive` 14px, `--muted` text, `--red` text on hover: `Archive profile`. Help: `1 project defaults to it. Archived, it leaves every picker.` (`No project defaults to it. Archived, it leaves every picker.`)

## States and copy

| State | What changes |
|---|---|
| Loading | the title stays as `Skeleton` (180px); each section shows its title and two skeleton rows; the panel's values are skeleton bars |
| Saved, unchanged | `Save profile` disabled |
| Edited (the picture) | `Save profile` enabled. Leaving the page with changes opens an `AlertDialog`: `Leave without saving?` / `Your changes to Careful are lost.` / `Stay` and `Leave` |
| Saving | `Save profile` reads `Saving…`, disabled |
| Saved just now | the status line `Saved.`; the eyebrow `Agent profile · saved just now` |
| Save failed | under the lede, `role="alert"`, 12.5px `--red`: the error text (`errorText`). Ticket 34's refusals, worded: `Another profile is already called Careful.`; `calculator defaults to Careful for code tasks, so it has to stay open to all of calculator's members.` (the second when listed members don't cover a project that defaults to it) |
| New profile (`/new`) | eyebrow `New agent profile`, title `New profile` until named; Agent `OpenCode`, Model the built-in profile's model, nothing else filled; plan first off; `Everyone`; Profile `Status` · `Not saved yet`, no `Created` or `Used by`; no Default for or Archive group. `Save profile` is enabled once Name and Model are set; on success the page moves to the profile's route with `Saved.` |
| The built-in profile | the `built-in` chip by the title; everything editable except: `Who may use it` reads `Everyone` with no radios and the help `The built-in profile is open to everyone, so every project has a default to fall back on.`; no Archive group |
| Confirming archive | `AlertDialog`: title `Archive Careful?`; body `It leaves every picker, and nobody can start a task with it. Tasks that used it keep their record.` and, when projects default to it, `calculator defaults to it for code tasks: those start with OpenCode until an admin picks another.`; buttons `Cancel` and `Archive profile` (primary). `Archiving…` while pending; on success, back to the list with the profile under Archived |
| Archived | eyebrow `Archived 3 Nov`; every field read-only; no `Save profile`; the Archive group reads `Archived 3 Nov by Alex Kim.` in `--muted` |
| A member who may use it | read-only: no `Save profile`, no add, `Edit` or remove controls, no presets row; inputs render as text (as Environment's member view); the switch and radios are disabled; headers still show only `set`; no Archive group |
| A member who may not use it, or an unknown ID | `NotFound`-style page body: `No such profile.` and a teal link `All agent profiles` (the API doesn't tell a member a listed profile exists) |
| Load failed | the error alert in place of the sections |
| Narrow (below 1280px) | the panel drops under the main column (`PageFrame`); the three Agent and model fields wrap to one per line below 900px; the preset buttons wrap |
| Phone (F-075) | one column; rule rows keep two lines with `Edit` under them; Sheets are full-width |

## Components (shadcn/ui names)

`Sidebar`, `PageFrame` with `Breadcrumb` and `properties` (`wideProperties`), `PageHeading`, `Section`, `Input`, `Textarea`, `Select` (existing `ui/select.tsx`), `Button` (default = the Shell primary; secondary for `Done`, `Edit profile`; ghost for the add and remove buttons and `Archive profile`), `Badge` (outline: `built-in`, `preset`, `HTTP`, `stdio`, `set`, `read-only`), `Switch` (existing), `RadioGroup` (existing), `Avatar` (existing), `Popover` + `Command` (the member picker), `Sheet` (existing), `AlertDialog`, `Tooltip`, `Skeleton`, `PropGroup` / `PropRow`. Lucide 15px, stroke 1.75: `sliders-horizontal`, `book-open`, `plug`, `lock`, `file-pen`, `terminal`, `globe`, `plus`, `x`, `check`, `minus`, `chevron-down`, `shield-check`, `archive`.

## Tokens (`app-concepts/html/graphite.css`)

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0D0E10` | page, panel |
| `--side` | `#0A0B0C` | sidebar |
| `--surface` | `#131416` | inputs, selects, the instructions box, chips |
| `--raise` | `#17181B` | row hover, avatar fill |
| `--line` | `#1F2023` | row hairlines, panel edge, group lines |
| `--line-2` | `#2A2C30` | control borders, preset buttons, the open rule's left rule, the switch's off track |
| `--text` | `#EDEDEE` | names, values, matched samples |
| `--muted` | `#9A9DA3` | lede, notes, labels, descriptions, `Asks for` |
| `--faint` | `#64676D` | eyebrow, counts, icons, rule lines, help, `not for`, disabled presets |
| `--sel` | `#1A1B1E` | the sidebar item |
| `--teal` | `#6FB8AA` | `Edit`, `Add member`, links, the switch's on track |
| `--green` | `#4FB286` | `Active` dot (halo `rgba(79,178,134,0.15)`), `Saved.` |
| `--red` | `#E5675C` | errors, remove and archive on hover |
| `--amber` | `#FFB224` | only the sidebar's Needs you count. Nothing on this page is amber: a rule is set up here, nothing waits on anyone yet |
| `--shell` / `--ink` | `#F3F0E8` / `#0C1D21` | `Save profile`, the Sheets' `Done`, the archive dialog's confirm |

Type: Manrope 700 24px (title); IBM Plex Sans 13px body, 12.5px notes and secondary, 12px labels and help, 600 for section titles, 500 for buttons; IBM Plex Mono for the eyebrow, the instructions, skill and server names, URLs, commands, header names, globs and samples. Radii: 7px controls, 8px the instructions box, 6px chips and preset buttons.

## Data this screen needs beyond ticket 34

- **A read-only mark on an MCP server.** ADR 0049 uses it twice ("Reaching the network" asks for `mcp` on any server not marked read-only; plan mode may call only read-only MCP tools), but ticket 34's MCP server fields (name, transport, URL or command, secret refs for headers) don't carry it. Add `readOnly: boolean` (default false) to the server's schema (ticket 01) and the save (ticket 34), or the network preset can't be built as the ADR says.
- **The skill's description** for its row: read from `SKILL.md` on the client, so no field is needed.
- **`Used by`:** a count of tasks with `agentProfileId` set to this profile.
- **Created by and archived by:** from the profile's audit entries.
- **The coverage samples:** `agentProfiles.ruleCoverage` returns, per rule, matched and unmatched samples from the domain's sample subjects. The panel shows the first of each.

## Differences from the current code

Checked against `apps/web`, `packages/api` and `packages/db` on `main` (2026-11-19):

1. **New routes and view.** No editor exists; the only profile mutation is `agentProfiles.setDefaultModel`, which sets the built-in profile's model from the Models page.
2. **`AgentProfile`** has `name`, `adapter`, `modelId`, `instructions` and `builtIn`. Ticket 06 adds `approvalRules`, `planFirst`, `access`, `archivedAt`, `mcpServers`, and the `AgentProfileMember` and `AgentProfileSkill` tables.
3. **UI pieces:** `Select`, `Switch`, `RadioGroup`, `Sheet`, `Avatar` and `Skeleton` exist in `components/ui/`. `Popover`, `Command`, `AlertDialog`, `Tooltip` and `Textarea` don't yet; `radix-ui` is already a dependency. The shell's command menu (`components/shell/command-menu.tsx`) is built without `cmdk`; build the member picker the same way, since `cmdk` would be a new dependency (ask first).
4. **Messages.** New keys under `agentProfiles.*` in `messages/en.json`, including every error above.

## Open points (recommendations; the building ticket records the answer)

1. **Archiving a profile a project defaults to.** Recommended: allowed, and those projects fall back to the built-in profile for that kind, as the dialog says. The other option is refusing until each project picks another default. Ticket 34's `archiveAgentProfile` implements whichever is chosen.
2. **Restoring an archived profile.** Ticket 34 has `.archive` and no restore. Recommended: none in milestone 3 (an admin makes a new profile); the archived view is read-only.
3. **The built-in profile's access.** Recommended: always `Everyone`, so every project keeps a default open to all its members, and archive fallback has a target.

## Wrong in the image

Build the copy and details in this file, not these:

- The **Name** input's `Careful` and the Model select's `Claude Opus 5.5` are drawn in mono. Both are Plex Sans.
- The instructions text has uneven word spacing. It's ordinary Plex Mono 12.5px.
- The **preset buttons** have no border. They're outline buttons: 26px, 1px `--line-2`, radius 6px.
- Sections are about 20px apart and the lede sits 4px under the title. Build 26px and 8px.
- The `Edit` links are underlined. Teal, no underline (underline on hover only).
- `Archive profile` is drawn as an outline button. It's a ghost button.
- The panel's member rows have hairlines between them; they don't.
- The sidebar's **Linear** row has a circle icon. Linear's icon is Lucide `ticket` (`m2/connect-linear.md`).
- The sidebar is about 240px and the panel about 400px. Build 232px and 340px.
- No MCP server carries a `read-only` chip; the build shows it on servers so marked (see "Data").
- The picture has no loading, new, built-in, archived, member, error, Sheet or dialog states: they're in the tables above.

All visible copy in the image is spelled right.
