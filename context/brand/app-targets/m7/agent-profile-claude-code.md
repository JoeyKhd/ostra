# Target: an agent profile on Claude Code (milestone 7, screen 7)

> **Committed image:** `agent-profile-claude-code.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Prompt:** `agent-profile-claude-code.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation, kept. References: the approved 2048 original of `../m3/agent-profile` (the screen spec section 13 names as the start), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Routes:** milestone 3's, unchanged: `apps/web/src/app/(panel)/organization/agent-profiles/[profile-id]/page.tsx` and `.../new/page.tsx` → `components/agent-profiles/agent-profile-editor.tsx`.
- **Feature:** F-018 (Claude Code), with F-021 (agent profiles), F-026 (approval rules), F-063 (plan first). Spec section 3 step 1, section 5.2 (`requires`, `optionsSchema`), section 5.4 (the agent catalog, `saveAgentProfile`'s `model-format`), section 6 (what Claude Code declares), section 12 items 1 and 2; ADR 0062, ADR 0049. Ticket 11 (`agents.list`, `agentProfiles.save` grown, `models.list` grown), ticket 14 (this screen).
- **Status:** a proposed target, waiting on approval (ticket 12's `## Comments`). Ticket 14 builds its data and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

Milestone 3's editor, with a second agent to choose. When an admin picks Claude Code, the page has to say three things plainly, because each is a surprise otherwise:

- **Which models it can use.** Claude Code speaks Anthropic's Messages API only (`requires.apiFormats: ["anthropic-messages"]`). The model list holds only those providers' models, and the others are named apart with the reason, so nobody hunts for a missing model.
- **What it does here,** in the same words on every page: what Claude Code declares (ADR 0062's capability table), as the agent suite proved it. These words are designed once here and reused (the profiles list, the task page's agent badge tooltip, the docs' agent guide).
- **The one difference:** Claude Code has no `projectConfigOverride`, so the repo's own Claude settings are set aside for each task (ADR 0049). It's shown as a difference, not an error.

Then its options, and on which runners it's ready. No Claude subscription is used anywhere (Q45, Q47); the page says so once, under the picker.

The picture shows `Claude Code`, the milestone 7 demo's profile (spec section 3, step 1), saved 2h ago, on `Claude Sonnet 5.5` from the Anthropic provider, plan first off.

## Layout (CSS px at 1440 wide)

Milestone 3's (`../m3/agent-profile.md`): sidebar 234px from the shell, **Agent profiles** selected; top bar 46px with the breadcrumb `Acme Corp › Agent profiles › Claude Code` and **Save profile**, the page's one primary button, disabled until something changed; main column padding `28px 40px`, content max 720px; properties panel **340px** (`wideProperties`). The panel's measured scale (`../m1/README.md`, "Scale"): body 14.5px, rows 14px, secondary 13px, small 12px, title 26px, inputs 34px.

### Heading

As milestone 3: eyebrow mono 12px `--faint` `Agent profile · saved 2h ago`; title Manrope 700 26px, the profile's name; lede 15px `--muted`, **by agent** (the catalog's words):
- Claude Code: `Its rules and MCP servers apply to every task, and the repo's own Claude settings are set aside. Its instructions and skills sit beside the repo's.`
- OpenCode (unchanged): `Its permissions and MCP servers win over a repo's own agent config. Its instructions and skills sit beside the repo's.`

### Agent and model

1. **Agent:** label 12px 500 `--muted` `Agent`, then a **segmented control** (Radix `ToggleGroup`, `type="single"`, `aria-label="Agent"`), 34px, `--surface`, 1px `--line-2`, radius 7px, one equal segment per agent in `agents.list` (`OpenCode`, `Claude Code`), 150px each. The chosen one: `--sel` fill, `--text`, a `check` 14px before its name; the others `--muted`. Milestone 3's `Select` becomes this while there are at most four agents; a fifth turns it back into a `Select`. Under it, 12px `--faint`, by agent:
   - Claude Code: `Runs through ostra's ACP driver on your provider's key. No Claude subscription is used.`
   - OpenCode: `Bundled with every runner. Runs through ostra's ACP driver on your provider's key.`
2. **Name** and **Model,** one row 12px apart, labels above: `Name` an `Input` 260px; `Model` a `Select` (flex): the model's name 14px `--text` sans, the provider 13px `--faint`, `chevron-down`.
3. **The model list, with Claude Code chosen** (the open `Select`, not in the picture): groups by provider, each a label 12px `--faint` (`Anthropic`, `Acme gateway`) and its models as 34px options; then a separator and a last group **`Can't run Claude Code`** whose rows are disabled (`aria-disabled`, `--faint`): the provider's name, its format in mono 12px (`openai-compatible`), and one line 12px `--faint` under the group: `Claude Code needs Anthropic's Messages API.` Each provider of the organization is in exactly one of the two places. With OpenCode chosen, every model is listed as milestone 3 had it.
4. **The line under Model** (Claude Code only, when some provider is set apart), 12px `--faint` with `info` 13px: `Only providers in Anthropic's Messages format are listed. Set apart: OpenRouter and Local vLLM, which are OpenAI-compatible.` (up to three names, then `and {n} more`). Nothing set apart: no line.
5. **No Anthropic-format provider at all:** the `Select` is disabled and reads `No model Claude Code can use`; the line reads `Claude Code needs a provider in Anthropic's Messages format.` + a teal `Add one under Models` (`../m1/models`, which grows the format per provider).
6. **Switching the agent with a model it can't use** (OpenCode → Claude Code on an OpenAI-compatible model): the Model field keeps the value, gets a 1px `--red` border and 12px `--red` under it, `role="alert"`: `Claude Code can't use {model}: {provider} is OpenAI-compatible. Pick a model from an Anthropic-format provider.`; `Save profile` is disabled until fixed. The API refuses the same (`model-format`, ticket 11) with that text.

### What Claude Code does here

**Shown for every agent**, from the catalog, so OpenCode's page says what it does too (its rows are its own declared values, milestone 1 to 6's). Title `What {agent} does here` (section title 15px 600), inline note 13px `--muted` `as the agent suite proved it on {version}` (the pinned version, mono).

Rows 36px, a 1px `--line` under each: an icon 15px in a 28px column, the name 14px `--text` in a 170px column, the description 13px `--muted`, wrapping to two lines at most. The words are the catalog's (`agents.list`, from `messages/en.json` under `agents.claudeCode.capabilities.*`), one row per user-facing capability:

| Row | Icon | Claude Code's words | From |
|---|---|---|---|
| `Steering` | `check` | `Your messages reach the turn that's running.` | `steerMidTurn` |
| `Plan first` | `check` | `The first turn runs in its plan mode; its to-do list shows as the plan.` | `planMode: session-mode`, `nativePlan` |
| `Approvals` | `check` | `Claude Code and the runner both check the rules. A denied call goes back to the agent.` | `permissionRules: native`, `rejectAndContinue` |
| `Questions` | `check` | `It asks as a form you answer in the panel.` | `elicitationForm` |
| `Reopening` | `check` | `It resumes its own session, in place or on a fresh box.` | `sessionLoad`, `sessionArchive` |
| `Skills and MCP` | `check` | `Skills from its own config folder; MCP servers over HTTP and stdio.` | `skills`, `mcp` |
| `Memory` | `check` | `ostra's memory tools. Its own auto memory is off.` | `memory: mcp` (ADR 0044) |
| **`Repo config`** | `circle-minus` | `The repo's .claude/settings.json and .mcp.json are set aside for each task, so this profile wins.` | `projectConfigOverride: false` |

- **The safe value until proved** (ADR 0062: a capability reads its safe value until its suite case passes). The row's words change with the value, so the page never claims more than the suite proved:
  - `Plan first`, `nativePlan` false: `The first turn runs in its plan mode; the plan shows as its message.`
  - `Approvals`, `rejectAndContinue` false: `Claude Code and the runner both check the rules. After a denial, ostra prompts it again.`; `permissionRules: runner-only`: `The runner checks every rule before the call runs.`
  - `Reopening`, `sessionArchive` false: `It resumes its own session in place. On a fresh box it starts again from the task's record.`
  - `Skills and MCP`, `skills` false: `MCP servers over HTTP and stdio. Skills aren't passed to it yet.`
- **The difference row:** the icon `circle-minus` `--muted` (not red, not amber: the task runs). The paths in Plex Mono 12.5px `--text`. On hover or focus, a `Tooltip`: `Also .claude/settings.local.json. The repo's CLAUDE.md, AGENTS.md and .claude/ skills, commands and agents stay visible.` and a teal `Why` linking to the docs' agent guide (`OSTRA_DOCS_URL`).
- **OpenCode's rows** are its own declared values (milestones 1 to 6's), in the same form and from the same message keys; ticket 14 writes their words from its capabilities, never by hand on the page.

### Options

Shown when the chosen agent's `optionsSchema` has fields (Claude Code: one; OpenCode: none, so no section). Title `Options`. One row per field, from the schema's field list (ticket 11's `agents.list` options' fields):

- **`Strip pre-release API features`** (`stripExperimentalBetas`, default off): the name 14px `--text`, under it 13px `--muted` `For a gateway that refuses Anthropic's beta headers. Claude Code then sends only stable features.`; a `Switch` at the right (on: `--shell` track and `--ink` knob, as `../m6/review-settings`; off: `--line-2` track). Saved with `Save profile`, not at once. It sets `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` (ADR 0062).

### Instructions, Skills, MCP servers, Approval rules, the footnote

Milestone 3's sections, unchanged in layout. The notes change by agent:
- `Instructions`: Claude Code `written to CLAUDE.md in the task's own config folder, beside the repo's`; OpenCode as milestone 3 (`added beside the repo's AGENTS.md, never replacing it`).
- `Skills`: Claude Code `written to skills/ in the task's own config folder, never to the repo`.
- `MCP servers`: unchanged (`reached through the runner's MCP proxy, so no secret enters the box`).
- `Approval rules`: unchanged; the coverage line works the same (ADR 0049's rules are ostra's, and both agents get them).

### Properties panel

Milestone 3's groups, plus **Ready on**:

1. **Profile:** `Status` · `Active`; `Created` · `19 Nov by Alex Kim`; `Used by` · `3 tasks`.
2. **Plan first:** label and `Switch`, help as milestone 3.
3. **Ready on** (new): the runners the member's projects can use (personal and pools), 30px rows, max 6 then `and {n} more` teal linking to Runners:
   - the runner or pool name, Plex Mono 13px `--text`; its executor Plex Mono 12px `--faint`;
   - at the right the agent's state there: `--green` dot + `Ready` (a runner, or every runner of a pool); `{n} of {m} ready` `--muted` (a pool, some ready); `loader-circle` 13px spinning + `Preparing` `--muted`; `On first task` `--faint` (`available`: it can prepare it, `OSTRA_AGENT_PREPARE=auto`); `circle-x` `--red` + `Failed` (links to the runner's page, `runner-agents`); `Not available` `--faint` (`OSTRA_AGENT_PREPARE=off`, or a minor-5 runner, which runs OpenCode only).
   - help 12px `--faint`: `A runner without Claude Code prepares it when a task first needs it.`; when no runner can run it: 12px `--red` `No runner can run Claude Code yet. Tasks on this profile will wait.`
   - OpenCode: the group reads `Ready on` · `every runner` `--muted` (it's bundled), with no rows.
4. **Who may use it,** **Default for,** **Archive:** milestone 3's.

## States

| State | What changes |
|---|---|
| **Claude Code, saved, unchanged** (`agent-profile-claude-code.webp`) | As above; `Save profile` drawn enabled in the picture, but it's disabled until a change |
| New profile, Claude Code picked | eyebrow `New agent profile`; Model empty with placeholder `Pick a model`; Options at their defaults; `Ready on` shows the runners as they are; `Used by` hidden |
| Switching OpenCode → Claude Code | the lede, the notes, `What Claude Code does here` and `Options` change at once (no reload); a model it can't use shows the error above |
| A capability not proved yet | its row in the safe value's words (above) |
| No Anthropic-format provider | the disabled Model and the link to Models |
| No runner can run it | the red help in `Ready on` |
| Read-only (a member who may use it) | as milestone 3: text in place of inputs; the segmented control shows the chosen agent only, as text |
| Loading | milestone 3's skeletons; the capability rows as 8 skeleton rows |
| Save refused | milestone 3's alert; `model-format`: `Claude Code can't use {model}: {provider} is OpenAI-compatible.`; an option refused by the schema: `Strip pre-release API features: {reason}` |
| Narrow / phone | as milestone 3; the segmented control stays one row (two segments fit 390px); the capability rows stack the description under the name |

## Components (shadcn/ui names)

- **From the repo / milestone 3:** `PageFrame` (`wideProperties`), `PageHeading`, `Section`, `Input`, `Select`, `Switch`, `RadioGroup`, `Tooltip`, `PropGroup` / `PropRow`, `Skeleton`, `AlertDialog`.
- **New:** `ToggleGroup` (shadcn/ui on `radix-ui`, already a dependency) for the agent; `components/agent-profiles/agent-capabilities.tsx` (the rows, from `agents.list`, reused by the profiles list's tooltip and the task page's badge); `agent-options.tsx` (fields from the options' field list); `agent-readiness.tsx` (the `Ready on` group).
- **Icons** (Lucide 15px, stroke 1.75): `check`, `circle-minus`, `info`, `loader-circle`, `circle-x`, `chevron-down`.

## Tokens

The measured dark tokens. Green only for a `Ready` dot and `Active`; red only for an error and `Failed`; no amber (nothing waits on anyone here). The capability checks are `--muted`, not green: a declared capability isn't a health state.

## Contrast (WCAG AA, F-081), dark

| Pair | Ratio | Need |
|---|---|---|
| `--text` #F2F3F4 on `--bg` #0D0E10 (names, values) | 17.4:1 | 4.5 |
| `--muted` #B4B7BB on `--bg` (descriptions, lede) | 9.6:1 | 4.5 |
| `--faint` #8B8E93 on `--bg` (help, executors, the line under Model) | 5.9:1 | 4.5 |
| `--text` on `--sel` #1A1B1E (the chosen segment) | 15.5:1 | 4.5 |
| `--muted` on `--surface` #131416 (the other segment) | 9.2:1 | 4.5 |
| `--green` #4FB286 on `--bg` (the `Ready` dot, with its word) | 7.4:1 | 3 |
| `--red` #E5675C on `--bg` (errors) | 5.9:1 | 4.5 |
| **`--sel` against `--surface` (the chosen segment's fill)** | **1.1:1** | **3 (a state)** |

The fill alone doesn't mark the choice, so the chosen segment also carries the `check` icon and `--text` against `--muted` (and `aria-checked`). The `Switch` off track (`--line-2`) against `--bg` is 1.4:1: the knob (`--muted`, 9.6:1) and its position carry the state, and `aria-checked` names it.

## Data this screen needs beyond ticket 11

- **`agents.list`**: per agent: ID, display name, `requires.apiFormats`, the options' fields (name, kind, default, message keys), the pinned version, the capability rows' keys and values (so the panel picks the words), the lede and notes' keys.
- **`models.list`** with each model's provider format and `usableBy` (ticket 11).
- **Readiness per runner and pool** for this agent: `runners.list` gains `agents` (ticket 11 grows `runners.get`; the list needs the agent's state per runner, or a `agents.readiness { agent }` that returns the rows of `Ready on`). Recommended: `agents.readiness`, scoped to the runners the member's projects can use.

## Differences from the current code

1. **The editor** (milestone 3, ticket 42) has the Agent `Select` with one option. It becomes the segmented control; the lede and notes read the catalog.
2. **No capability rows, no options, no `Ready on`** exist; `AgentProfile.agentOptions` comes with ticket 04.
3. **`ToggleGroup`** may not be in `components/ui/` yet.
4. **Messages:** `agents.<agent>.*` (display name, lede, notes, the capability rows in every value, options' names and help), `agentProfiles.readyOn.*`, `agentProfiles.errors.modelFormat`.

## Open points (recommendations; ticket 14 records the answer)

1. **The capability rows for OpenCode too.** Recommended: yes, so the two agents compare row by row and the words are designed once. The spec asks for Claude Code's; OpenCode's are its milestone 1 to 6 values.
2. **A segmented control in place of the Select.** Recommended while there are at most four agents (it shows both at a glance, as spec section 13 asks: "the agent picker with both agents").
3. **`Ready on` scope.** Recommended: the runners the member's projects may use, not the organization's whole fleet, so it answers "will my task start".

## Wrong in the image (build from this file)

- **`Save profile` is enabled** on a saved, unchanged profile. It's disabled until a change.
- **The lede wraps to two lines.** Fine at this width; keep the copy.
- **The Name input is about 330px.** Build 260px.
- **`Claude Sonnet 5.5`** has its version digits in mono. All sans.
- **The capability rows' descriptions start at two x positions** (the `Approvals` row and below sit a few px right). One column at 170px after the icon.
- **The `Options` row's switch** sits lower than the name. Align it with the name's line.
- **`Ready on`'s rows** have hairlines between them. No hairlines inside a panel group.
- **The sidebar** is milestone 3's picture's. Build it from `sidebar.tsx`.
- **The picture has no open model list, error, new, read-only or narrow states:** they're in the tables above.

All visible copy is spelled right.
