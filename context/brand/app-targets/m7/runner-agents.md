# Target: a runner's agents (milestone 7, screen 8)

> **Committed image:** `runner-agents.webp`, downscaled from the 2048×1360 generation to 1440×956, so one image pixel is one CSS pixel. Sizes in this file are CSS px.

- **Prompt:** `runner-agents.prompt.txt`. GPT Image 2.6 through Higgsfield (3:2, 2k, high), 1 generation, kept. References: the approved 2048 original of `../m5/runner` (the screen spec section 13 names as the start), `app-concepts/html/home-graphite.png` and the Hinge logo `kit/logo/export/ostra-hinge-single-color-2048.png`.
- **Route:** milestone 5's runner page, unchanged: `apps/web/src/app/(panel)/organization/runners/[runnerId]/page.tsx` → `components/runners/runner-view.tsx`. New: an **Agents** section, `components/runners/runner-agents.tsx`, and an **Agent images** group in the properties panel.
- **Feature:** F-018 (Claude Code: the install on `host`, the agent image on `docker` and `kubernetes`, the runner reporting its agents). Spec section 3 steps 2 and 10, section 4 ("Preparing an agent on a runner"), section 5.1 (`agents` on `hello` and `status`; `agent.preparing`, `agent.ready`, `agent.failed`; `agent.prepare`), section 5.3 (`AgentImage`), section 5.4 (`OSTRA_AGENT_PREPARE`, `OSTRA_AGENT_IMAGE_CLAUDE_CODE`, `OSTRA_NPM_REGISTRY`); ADR 0062 ("Where its binary comes from"), ADR 0046 (amended). Ticket 08 (the runner), ticket 09 (core), ticket 11 (`runners.get` grown, `runners.prepareAgent`), ticket 14 (this screen).
- **Status:** a proposed target, waiting on approval (ticket 12's `## Comments`). Ticket 14 builds its data and tests until then, not its UI.

> Build it in real HTML/React (`app-design.md`, rule 5), then screenshot the build at 1440×956 and compare it with the picture.

## Purpose

An organization admin sees which agents a runner can run, at which version, and what it's doing about the ones it can't yet: preparing one (and how far along), failed (and why, with **Try again**), or able to (with **Prepare now**). On `docker` and `kubernetes` the agent runs from an agent image, so its digest is shown; on `host` it's an install in the runner's data folder. The section also says, once, where Claude Code comes from: it's downloaded from npm under Anthropic's terms, and ostra's images don't include it (ADR 0062, Q266).

`runner-agents.webp` shows `build-03`, milestone 5's `docker` runner of `build-fleet`, now current (`v0.6.0`): OpenCode ready from the base image, and Claude Code **preparing** its agent image, step 4 of 6, after a first try failed when the npm registry didn't answer and Alex Kim pressed Try again (History tells it).

## Layout (CSS px at 1440 wide)

Milestone 5's (`../m5/runner.md`): sidebar from the shell, **Runners** selected; top bar with the breadcrumb and `Drain` / `Revoke`; page padding `28px 36px`; the title line, the lede, the status rows; then, **new, before Capacity:** **Agents**; then Capacity, Boxes and History as milestone 5. Properties panel 320px.

### Agents

- **Section head** 28px above: `Agents` (Plex Sans 600 15px) + Plex Mono 12px `--faint` count (the agents listed); at the right of the same line, 12px `--faint`, the runner's `OSTRA_AGENT_PREPARE` in words: `auto` `Prepares agents when a task needs them`; `manual` `Prepares an agent only when an admin asks`; `off` `Doesn't prepare agents: only what it has runs here`.
- **A `Table` with no box,** header 30px (12px 500 `--faint`), a 1px `--line` under each row. One row per agent in the catalog (`opencode`, `claude-code`), in catalog order, whatever its state:

| Column | Width | Contents |
|---|---|---|
| Agent | 180px | the display name 14px `--text` |
| Version | 120px | Plex Mono 14px `--text`, the pinned version (`2.3.2`, `0.108.1`; Claude Code's is `@agentclientprotocol/claude-agent-acp`'s, the adapter's pin). An installed version older than the pin: the installed one, then `--faint` ` → 0.108.1` |
| State | 160px | the state's icon and word (below), 14px |
| Image or install | `1fr` | `docker` and `kubernetes`: the image (below); `host`: Plex Mono 12.5px `--faint` `<data>/agents/claude-code/0.108.1` (relative to the runner's data folder, never an absolute path, spec section 5.1) |
| Action | auto, right | the state's button, if any (below) |

- **Row height** 40px; a row with a detail line (preparing, failed, the licence note) grows, each extra line 22px, indented to the Version column, 12.5px.

### Each state

The runner reports `agents: [{ name, version, state, image }]` (section 5.1). Words come from an exhaustive `switch` in `runner-words.ts`.

| State | Icon and word | Image or install | Detail line | Action |
|---|---|---|---|---|
| `ready` | 7px `--green` dot, `Ready` `--text` | `base image` `--faint` + mono `sha256:9c41e2a…` (OpenCode, bundled); `agent image` `--faint` + mono digest (Claude Code); kubernetes adds the registry's host, mono `--faint` (`registry.acme.internal/ostra-agent-claude-code`) | none | none |
| `preparing` | `loader-circle` 14px `--muted` spinning (still with reduced motion: a static `loader-circle`), `Preparing` `--text` | mono `--faint` `building` (an image) or `installing` (host) | 12.5px `--faint`, from `agent.preparing` and the builder's progress: docker `Building the agent image from base sha256:9c41e2a · step 4 of 6: npm install, then the SHA-256 check · 1m 12s`; kubernetes `Building in BuildKit, then pushing to registry.acme.internal · step 2 of 6 · 40s`; host `npm install @agentclientprotocol/claude-agent-acp@0.108.1, then the SHA-256 check · 25s` | none (it's working) |
| `failed` | `circle-x` 14px `--red`, `Failed` `--text` | the last good digest, or `none` `--faint` | 12.5px `--red`, by `reason`: `checksum` `The binary's SHA-256 didn't match the pinned one, so it wasn't used.`; `install` `npm install failed: {detail}`; `build` `The agent image's build failed: {detail}`; `registry` `Couldn't push to the registry: {detail}`; `unsupported` `This runner doesn't prepare agents (OSTRA_AGENT_PREPARE is off).` Then, 12.5px `--faint`, `{time}`, and a teal `See the runner's log` (the runner's page logs, milestone 5) | `Try again` (outline, 30px, `rotate-ccw`), not for `unsupported` |
| `available` | 7px ring `--faint`, `Not installed` `--muted` | `--faint` `—` | 12.5px `--faint`: `It prepares it when a task first needs it.` (`auto`); `It prepares it when an admin asks.` (`manual`) | `Prepare now` (outline, 30px, `download`) |
| absent (a minor-5 runner, which reports no agents) | the whole section reads 13px `--muted` `This runner is one minor behind, so it runs OpenCode only. Update it to report its agents.` with milestone 5's teal `How to update` | — | — | — |

- **`OSTRA_AGENT_IMAGE_CLAUDE_CODE` set:** Claude Code's row reads `Ready`, and the image column `set by the install` `--faint` + mono the image reference; no build, no `Prepare now`.
- **The digest** is the first 7 hex characters after `sha256:` then `…`, mono; a `Tooltip` holds the whole digest with a teal `Copy`. The image's tag (`ostra-agent-claude-code:0.108.1-9c41e2a`) is in the tooltip too.
- **The licence note,** under Claude Code's row in every state but absent, 12.5px `--faint`, Lucide `info` 13px: `Claude Code is downloaded from npm under Anthropic's terms. ostra's images don't include it.` (`docker` and `kubernetes`); on `host`: `Claude Code is downloaded from npm under Anthropic's terms, into this runner's data folder.` A teal `Terms` links to Anthropic's legal page named in `research/claude-code-acp.md` (`https://code.claude.com/docs/en/legal-and-compliance`). If the maintainer later records that the base image may include it (ADR 0062), the note goes and the row reads like OpenCode's.

### The buttons

- **`Prepare now`** and **`Try again`** call `runners.prepareAgent { runnerId, agent }` (ticket 11), which sends `agent.prepare`. Organization admins only; a member on their own personal runner's page sees them too (it's their machine). No confirm: preparing changes nothing a task depends on. While the call is pending the button reads `Preparing…` and is disabled; the row turns `preparing` when the runner reports it (the page polls every 5 s, as milestone 5).
- **Offline runner:** both buttons disabled with the `Tooltip` `It's offline. It prepares the agent when it connects and a task needs it.`
- **Failure of the call:** `role="alert"` 12.5px `--red` under the row: `errorText(error)`.

### History (milestone 5's section) gains three entries

From the audit actions `agent.prepared`, `agent.prepare_failed` (section 5.3) and the request:
- `A task asked for Claude Code: preparing 0.108.1`
- `Preparing Claude Code 0.108.1, by Alex Kim` (`Prepare now`) / `Preparing Claude Code 0.108.1 again, by Alex Kim` (`Try again`)
- `Claude Code 0.108.1 ready` / `Claude Code 0.108.1 failed to build: {reason in words}`

### Properties panel

Milestone 5's groups (Runner, Labels, Joined, the consequence line), plus, after **Runner**, **Agent images** (`docker` and `kubernetes` only):
- `Base` · mono `sha256:9c41e2a…` (the base image's digest the agent images are built from), with the full one in a `Tooltip`
- `Built here` · the count of `AgentImage` rows for this runner (`ready`); kubernetes: `In registry` · the registry's host
- `Prepare` · mono `auto` / `manual` / `off` (`OSTRA_AGENT_PREPARE`)
- `npm registry` · mono, only when `OSTRA_NPM_REGISTRY` isn't the default (`registry.acme.internal`)

`host`: the group is **Agents dir** · mono `<data>/agents` and `Prepare` · the mode.

## States

| State | What shows |
|---|---|
| **docker, OpenCode ready, Claude Code preparing** (`runner-agents.webp`) | As above |
| Claude Code ready | its row `Ready`, `agent image` + digest, the licence note; History `Claude Code 0.108.1 ready` |
| Claude Code failed | the red icon and reason line, `Try again`; the tasks that waited stay queued (core offers them to a runner that has it, section 4), and the task page says `Preparing Claude Code on this runner` until one does |
| Claude Code available, `auto` | `Not installed`, `Prepare now`, `It prepares it when a task first needs it.` |
| `manual` | the head's words; `Prepare now` is the only way |
| `off` | the head's words; Claude Code `Failed` with `unsupported` and no button |
| A personal `host` runner (`alex-mbp`) | the install column shows the data-folder path; the host licence note; the panel's `Agents dir` |
| kubernetes | the registry's host in the image column and the panel; the BuildKit progress line |
| minor 5 | the one-line section (above) |
| Loading | the section head at once; two skeleton rows |
| Phone (F-075) | each agent becomes a block: name and version on one line, state and action on the next, the image or install, then the detail lines; buttons full width |

## Components (shadcn/ui names)

`Table` (existing `ui/table.tsx`), `Button` (outline), `Tooltip`, `Skeleton`, `PropGroup` / `PropRow`, `Status` (dot + word). New: `components/runners/runner-agents.tsx`, `agent-image-digest.tsx`. Lucide 15px stroke 1.75: `loader-circle`, `circle-x`, `rotate-ccw`, `download`, `info`, `copy`.

## Tokens

The measured dark tokens (`../m5/runner.md`). Green only for a ready dot; red only for a failure's icon and reason; no amber (a preparing agent waits on the runner, not on a person). The spinner is `--muted`.

## Contrast (WCAG AA, F-081), dark

| Pair | Ratio | Need |
|---|---|---|
| `--text` #F2F3F4 on `--bg` #0D0E10 (names, versions, state words) | 17.4:1 | 4.5 |
| `--muted` #B4B7BB on `--bg` (the spinner, `Not installed`) | 9.6:1 | 4.5 / 3 |
| `--faint` #8B8E93 on `--bg` (digests' labels, detail and licence lines) | 5.9:1 | 4.5 |
| `--green` #4FB286 on `--bg` (the ready dot, with its word) | 7.4:1 | 3 |
| `--red` #E5675C on `--bg` (the failure's icon and reason) | 5.9:1 | 4.5 |
| teal #6FB8AA on `--bg` (`Terms`, `See the runner's log`) | 8.4:1 | 4.5 |

Every state has a word beside its icon, so colour never carries it alone.

## Data this screen needs beyond ticket 11

- **`runners.get`** (grown): `agents` as the runner reported them, plus the latest `agent.preparing` progress (step, steps, the step's words, the start time) and the latest `agent.failed` (reason, detail, time) per agent; the runner's `OSTRA_AGENT_PREPARE`, base digest and registry; the `AgentImage` rows for this runner.
- **The progress line** needs the builder's step: add `progress: { step, of, label }` to the runner's status for a preparing agent (ticket 01's `status` schema) if ticket 08's report doesn't carry it; without it, the line shows the elapsed time only (`Building the agent image from base sha256:9c41e2a · 1m 12s`).
- **The `detail`** of `agent.failed` is shown as reported, after the runner strips paths outside its data folder (section 5.1); it never holds a token.

## Differences from the current code

1. **Milestone 5's runner page** (ticket 31) has no Agents section; `runner-agents.tsx` is new.
2. **`runners.prepareAgent`** and the grown `runners.get` come with ticket 11; `AgentImage` with ticket 04.
3. **`runner-words.ts`** gains the agent state's words, the failure reasons, the prepare modes and the licence notes, each an exhaustive `switch`.
4. **Messages:** `runner.agents.*`.

## Open points (recommendations; ticket 14 records the answer)

1. **The version shown for Claude Code.** The pin is the ACP adapter's (`0.108.1`), which pins the Agent SDK (`0.3.326`) and through it the Claude Code binary. Recommended: show the adapter's version, with the SDK's in the version's `Tooltip` (`claude-agent-acp 0.108.1 · Agent SDK 0.3.326`), since it's the one ostra pins and checks.
2. **`Prepare now` for a member's personal runner.** Recommended: yes, it's their machine.

## Wrong in the image (build from this file)

- **The detail lines** start at the Agent column's x + 54px, not the Version column. Indent them to the Version column.
- **History's sentences** are drawn in `--text` with hairlines between rows. Build `--muted` sans, no hairlines, as milestone 5.
- **The section head's right-hand words** sit lower than `Agents`. Same baseline.
- **`base image`** is drawn smaller than the digest. Both 12.5px; the label `--faint` sans, the digest mono.
- **The picture has no ready, failed, available, host, kubernetes, `off` or phone states:** they're in the tables above.
- **The sidebar** is milestone 5's picture's. Build it from `sidebar.tsx`.

All visible copy is spelled right, and the numbers agree (2 of 4 slots busy; 4 of 15 vCPU).
