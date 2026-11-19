# Milestone 7: The second agent, and launch

**Status:** spec, 2026-11-19. Tickets in `issues/`, one file each (`docs/agents/issue-tracker.md`).
**Milestone:** 7 (`context/build-order.md`).
**Features:** F-018, F-058, F-081, F-076 (complete, measured), F-117 (the load test as the gate), and the final check of F-075, F-082 and F-083. Plus two pieces of work that aren't ledger rows: the security review of the box, and publishing (ADR 0045). It finishes F-039, which milestone 5 left `building` until the images are published, and F-033's "with another agent", which milestones 2 and 4 left for F-018. Its demo signs in as milestone 1's default first admin on this machine, and as a newcomer would on the Linux machine.
**Decisions it builds on:** ADR 0007 (the stack), 0018 (ACP is the agent interface), 0021 (no telemetry), 0022 (versions), 0025 (everything is an adapter), 0029 (executors and the allowed differences), 0030 (no credential in the agent's container), 0031 (the safety minimum), 0032 (OpenCode first, ostra's own driver, Claude Code in milestone 7), 0033 (either API format), 0044 (agents' own memory off), 0045 (layout, licenses, publishing), 0046 (one CLI, three images), 0048 (source-available; the CLA), 0049 (declared capabilities; repo config hidden), 0061 (proofs on other machines; the load test). **New for this spec:** ADR 0062 (Claude Code over ACP, on keys), 0063 (the docs site), 0064 (the launch gates and the release), and amendments to 0007 (three entries waiting for a yes), 0032, 0045, 0046 (agents ostra doesn't redistribute) and 0061 (the gate's run).
**Research it rests on:** `research/claude-code-acp.md` (new: the ACP adapter's package, license, launch and `initialize`, every claim cited), `research/agent-harnesses.md` §1 (Claude Code's sessions, permissions and terms), `research/rivet.md` R16 (redistribution).
**Builds on milestones 1 to 6** as they were built, not only as they were specified. Milestone 1 is done; 2 and 3 are being built; 4, 5 and 6 are specced. Where their code ends up different from their specs, this spec follows the code, and the ticket that meets the difference says so in its `## Comments`. Where this spec names something an earlier milestone owns (milestone 5's agent image builder, milestone 6's protocol minor, the read-only kinds), it uses that milestone's words as its spec settles them.

Terms follow `context/GLOSSARY.md`. Lifecycles follow `context/domain-model.md`.

---

## 1. What milestone 7 ends with

Public v1, with two agents. A team new to ostra goes from `docker compose up` to its first agent-made PR in under 30 minutes, following only the docs (`build-order.md`).

In more words: an organization admin makes an agent profile on Claude Code, picks a model from a provider in Anthropic's format, and a member starts a task on it, from a Linear ticket or a prompt, exactly as on OpenCode. Claude Code runs through ostra's own ACP driver, on the key proxy's placeholder key, with no subscription login anywhere, and every feature of milestones 1 to 6 that touches an agent works on it, or its absence is a declared capability. A member reaches every core action from the keyboard, sees the panel in dark, light or the system's choice, and uses the "needs you" moments on a phone; every string is in a message file. The docs site has the install guide, the configuration reference, the runner guide and the adapter guide, and two people new to ostra each followed it to a PR in under 30 minutes. The load test held 1,000 tasks on Linux, an independent security review of the box found nothing critical or high left open, and, once the maintainer has settled the legal items and said go, one workflow publishes the npm packages, the three images and the docs.

### What milestones 1 to 6 leave that milestone 7 starts from

Read from the code on `main` on 2026-11-19, and from milestones 2 to 6's specs for what they add, so builders don't rebuild what exists:

- **The agent interface is ready for a second agent.** `AgentAdapter` (`packages/adapter-sdk/src/agent/base.ts`) composes ostra's ACP driver through a `DriverPort`; an adapter writes its launch and its update quirks. `AgentCapabilities` declares `steerMidTurn`, `sessionLoad`, `nativePlan`, `rejectAndContinue`, `elicitationForm`, `modelBaseUrlAndPlaceholderKey`, `sessionArchive`, `permissionRules`, `planMode`, `skills`, `mcp` and `projectConfigOverride`; milestone 4 adds `memory` and milestone 6 `elicitation`. `repoConfigPaths` exists for an agent without `projectConfigOverride`.
- **The driver advertises** `elicitation.form`, no `fs` and no `terminal` in `initialize` (`packages/adapter-sdk/src/agent/acp/driver.ts:382-388`), so an agent asks its questions as forms and uses its own tools.
- **The key proxy takes a placeholder in `x-api-key`** and swaps in the real key with `anthropic-version` for an `anthropic-messages` provider (`apps/runner/src/sidecar/key-proxy.ts`, `packages/adapter-sdk/src/model/auth.ts`). `apiFormatSchema` has `openai-compatible` and `anthropic-messages` (`packages/protocol/src/common.ts:45`).
- **A profile names its agent as a string** (`AgentProfile.adapter`, `packages/db/prisma/schema.prisma`), and the task spec carries `agent.adapter` as a string (`packages/protocol/src/task/spec.ts:80`), so a second agent needs no enum migration.
- **`adapter-opencode`** is the pattern: a pinned version, SHA-256 per platform, the binary found in its platform package, `prepareLaunch` with an allowlisted environment, its contract test and its live test (`packages/adapters/adapter-opencode/src/`).
- **The panel has ⌘K** as a jump-to-page menu (`apps/web/src/components/shell/command-menu.tsx`), which milestone 4 grows into search (`app-targets/m4/search-palette`). It has no actions and no shortcut sheet.
- **The panel is dark only.** `layout.tsx` sets `data-theme="dark"`; `globals.css` says the light theme "is left for later". `brand/files/tokens/` holds the tokens.
- **Every string is read through `t`** from `apps/web/messages/en.json` (`apps/web/src/lib/messages.ts`); a missing key fails the typecheck. Nothing checks that no literal text slips past `t`, and next-intl isn't installed (ADR 0007 names it; milestone 1 built its own `t`).
- **`docs/configuration.md` is tested** against every schema that reads a setting (`packages/domain/src/settings.test.ts`). `docs/development.md` and `docs/agents/` exist. There's no `apps/docs`.
- **Setup in the panel** is milestone 1's checklist (F-076 `building`; its proof's second condition, the measure, is missing: `context/proof/F-076.md`).
- **Milestone 5 leaves** the load test's harness and this machine's ramp (F-117 `building`), the three images built in the Linux proof job but never published (F-039 `building`), the snapshot builder on `docker` and BuildKit with the registry on `kubernetes`, the runner's report of its capabilities, the manual `proof.yml` jobs on `ubuntu-24.04` and `macos-15` (ADR 0061).
- **Milestone 6 leaves** protocol minor 5, the read-only refine and review kinds, automatic turns with the neutral reply to an ACP elicitation, and `submit_draft`, `submit_review` and `propose_environment` on the sidecar's MCP server.
- **The maintainer's legal items are open:** Q110 (the licensor) and Q109 (the CLA), and the legal review ADR 0048 asks for before launch. So are the names (Q80, Q82: the npm scope, the CLI's package name, the image namespace). `build-order.md`'s "Outside the code" lists them.

### What is in, and what is not

**In:** the Claude Code adapter (`adapter-claude-code`) through ostra's driver, on the key proxy, with `--hide-claude-auth`, its config in the task's own folder, its repo config hidden, and every capability declared as the suite proves it; installing Claude Code on `host` runners and building agent images on `docker` and `kubernetes` runners, with the runner reporting its agents; Claude Code profiles on Anthropic-format providers only; its subagents shown nested on the task page; the agent contract suite on both agents; the docs site, built static and published on GitHub Pages; the command palette's actions and the shortcut sheet; a keyboard and contrast check on every screen; the light theme and each member's choice; the phone sweep; the message-file check with a pseudo-locale; setup's last pieces and its timeline; the 30-minute measure, twice; the load test on the release candidate, on Linux; the security review of the box with its adversarial run; `SECURITY.md`, `CONTRIBUTING.md` and the third-party notices; the release workflow with its dry run; and, after the maintainer's go, the release.

**Not in** (and when it comes):
- Codex on keys: F-038, right after v1. Copilot CLI, Cursor CLI and the rest: F-022, later
- a Claude subscription login, anywhere: never (Q45, Q47). `--hide-claude-auth` enforces it in the ACP adapter, and ostra never sets a subscription credential
- Claude Code in a published image before the maintainer records that Anthropic's terms allow it (Q266, ADR 0062, ADR 0046)
- providers that sign each request (Bedrock, Vertex): F-130, after v1. Claude Code can reach them, and ostra's key proxy can't yet
- other languages than English: v1 ships the message files and the pseudo-locale that proves a new file is enough (F-083)
- signed runner binaries: F-085, after v1
- a hosted version: the maintainer's, after v1 (ADR 0048)
- outside contributions: none until the CLA exists (Q109)
- answers to Q109 and Q110: the maintainer's and a lawyer's. This spec plans around them

### On this machine

The same adjustment as milestones 1 to 6: the demo's first part runs here on the `host` executor, where a "box" is a worktree. What needs more than that:
- **Linux with Docker:** `docker compose up`, which is the measure's first command (F-076), Claude Code's agent image and its boxes (F-018 on `docker`), the adversarial run in a box, the images' last checks before they're published (F-039). In the manual `proof.yml` jobs on `ubuntu-24.04` (ADR 0061), with no secret, and, for the measure and the second part of the demo, on the maintainer's Linux machine with the test workspaces' credentials.
- **A machine of at least 16 vCPUs and 32 GB on Linux:** the load test's run that counts (F-117), the maintainer's (ADR 0061, ADR 0064).
- **Kubernetes:** Claude Code's agent image through BuildKit and the registry, and a Claude Code task in a pod, in the kind job of `proof.yml`. No row of this milestone waits on it alone.
- **macOS:** Claude Code on a `host` runner on a Mac, in the `macos-15` job with the stub model. Nothing else of this milestone is specific to it.
- **This Windows machine, as it is:** Claude Code runs from its `win32-x64` package. Its Bash tool needs Git for Windows' `bash.exe`; without it Claude Code falls back to PowerShell (`research/claude-code-acp.md`, D7), so the runner finds `bash.exe` from the `git` it already uses and passes it as `CLAUDE_CODE_GIT_BASH_PATH` (ticket 06). The palette's shortcut here is Ctrl+K. The adversarial run's `host` half runs here only with attempts that are safe by construction (ticket 28), and its Linux-only attempts (`/proc/*/environ`, `docker`, `kubectl`) are reported "not applicable on Windows", never as passed.
- **People:** the two newcomers of the measure, the maintainer's legal items and names, the maintainer's yes to three dependencies, and the go.

---

## 2. The features, and where each one lives

"At M7's end" is the ledger status the demo ticket (32) sets, if and only if every condition in the row's "done when" holds.

| F-ID | What milestone 7 builds | Packages | Tickets | At M7's end |
|---|---|---|---|---|
| F-018 Claude Code | `ClaudeCodeAdapter` through ostra's ACP driver, launching `@agentclientprotocol/claude-agent-acp` 0.108.1 with `--hide-claude-auth`, its binary's SHA-256 checked; `ANTHROPIC_BASE_URL` at the key proxy and the placeholder in `ANTHROPIC_API_KEY`; its `CLAUDE.md`, `settings.json` and skills in the task's `CLAUDE_CONFIG_DIR`; the repo's `.claude/settings*.json` and `.mcp.json` hidden; every capability declared as the suite proves it; profiles on Anthropic-format providers only; the install on `host` and the agent image on `docker` and `kubernetes`; subagents nested on the task page; the agent contract suite on it (ADR 0062) | `packages/protocol`, `adapter-sdk`, `adapter-claude-code` (new), `apps/runner`, executors, `packages/db`, `packages/domain`, `apps/core`, `packages/api`, `packages/task-view`, `apps/web` | 01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 14, 15, 31, 35, 38 | done, if the demo's live run had an endpoint in Anthropic's format (section 3, Q253); otherwise `building`, with every condition the stub model proves `proved` |
| F-058 Docs site | `apps/docs` on Fumadocs (or its fallback), built static, on GitHub Pages from `docs.yml`; the self-hosting guide, the configuration reference rendered from `docs/configuration.md`, the runner guide, the adapter guide; every `run` command block checked in the proof job (ADR 0063) | `apps/docs` (new), `docs/`, `.github/workflows/docs.yml` (new), `scripts/` | 21, 22, 23 | done, if the site is published at its address; otherwise `building` with the built site's proof |
| F-081 Keyboard and accessibility | The palette's actions (jump to "needs you", approve, answer, take over, reopen, and the rest of section 12, item 11), the shortcuts and the `?` sheet; a keyboard walk and a contrast check on every route, in both themes | `packages/domain`, `apps/web` | 05, 12, 13, 16, 17 | done |
| F-075 Responsive panel (final check) | Every route at 390 px with no horizontal scroll, and approve, answer and reopen done end to end at phone width | `apps/web` | 19 | done |
| F-082 Theme (final check) | The light theme from the brand tokens, and each member's choice of dark, light or "match my system" in Account, applied before first paint | `packages/db`, `packages/api`, `apps/web` | 04, 11, 12, 18 | done |
| F-083 Translatable interface (final check) | A check that no text reaches the screen except through `t`, that every key is used, and a pseudo-locale build in which every visible string is the pseudo one | `apps/web`, `scripts/` | 20 | done |
| F-076 Setup in the panel (complete, measured) | The checklist's Linear step live and skippable, its links to the docs, `setup.timeline`, `pnpm measure:setup`, and the measure: two newcomers under 30 minutes on Linux (ADR 0064) | `packages/api`, `apps/web`, `scripts/`, `context/specs/m7-launch/measure/` | 11, 24, 25 | done, if both measured runs are under 30 minutes; otherwise `building` with each run's record |
| F-117 Scale-out (the gate) | The load test on the release candidate, with Claude Code's recorded rates in the mix, here as a ramp and on Linux at 1,000 tasks (ADR 0061, ADR 0064) | `e2e/load`, `context/specs/m7-launch/load/` | 26 | done, if the Linux run passed; launch waits for it either way |
| F-039 Three images (finished) | Published by the release, by digest, with third-party notices and no Anthropic file (ADR 0046, ADR 0064); a new pool runner from the published runner image with one `docker run` and a join token | `deploy/`, `packages/deploy-checks`, `.github/workflows/release.yml` (new) | 29, 30, 33 | done once the release has run and the published runner joined a pool; otherwise `building` |
| F-033 Reopen anywhere ("with another agent") | A task reopened on a profile of the other agent: an agent's session archive is its own, so the new agent starts from the rebuild template, on the same branches and PRs, from OpenCode to Claude Code and back | `packages/domain`, `apps/core`, `packages/api`, `apps/web`, `packages/adapter-sdk` (the suite) | 37 | done, if its other conditions are proved (milestones 2 and 4 own them); otherwise `building`, with this one `proved` |

**Work that isn't a ledger row:**
- **The security review of the box** (ADR 0064): the threat model, the checklist with evidence, the adversarial run, the findings and their fixes, `SECURITY.md`. Tickets 27 and 28. It's a launch gate; its record is `context/specs/m7-launch/security-review.md`.
- **Publishing** (ADR 0045, ADR 0064): Changesets or its fallback, `release.yml` and its dry run, the notices, `CONTRIBUTING.md`, and the release itself after the go. Tickets 29, 30 and 33.

**Ledger text this spec amends** (2026-11-19, ADR 0062): F-039's "every v1 agent pinned" and F-021's "installing and updating the agents themselves is the base image's job" now say "every v1 agent ostra may redistribute", with an agent image or a `host` install for one it may not (Claude Code, until Q266). Without the amendment F-039 couldn't honestly be `done` with Claude Code outside the base image.

**Rows this milestone touches without finishing:** F-001 gains the measure's two `docker compose up` runs as live evidence for its first sentence; it's finished where milestone 5's Linux job left it. F-019 gains the parity table's test (every capability declared by both adapters) and its base-image pin in a published image. F-089 gains Claude Code's calls (`/v1/messages?beta=true`, `count_tokens`, `/v1/models`) counted. F-021, F-026 and F-063 gain their cases on a second real agent, with no new status. F-017 and F-093 gain a Claude Code box in their Linux and kind runs.

**Built in from the first milestone** (`build-order.md`), checked again by ticket 32:
- Organization-scoped data: every new row carries `organizationId` (04); milestone 4's generated isolation test covers `AgentImage`.
- The event log and the durable queue: an agent being prepared, an agent image built, a theme changed, and every task event of a Claude Code session are saved before they're acted on (01, 08, 09, 11).
- No credential in the agent's container: Claude Code's environment holds the placeholder and the proxy's address only; `CLAUDE_CODE_EXECUTABLE` is never set, so MCP headers stay off a command line; the agent image holds no credential (06, 08, 28).
- ACP as the only way to talk to an agent: Claude Code goes through the same driver; no Agent SDK API is called (06).
- Strict typing, dark first, responsive, English text in message files: the final checks of this milestone (17 to 20).

---

## 3. The end-to-end demo

Ticket 32 runs it and records the result under its `## Comments` and in `demo.md` next to this spec. Everything runs against the Linear workspace `ostra-test` (team `OST`) and the GitHub org `ostra-test` (repos `test1` and `test2`). Secrets come from `~/.config/ostra-dev/` with `set -a; . ~/.config/ostra-dev/<file>; set +a`, and are never printed, logged or committed.

**Two parts, two machines.** Part A runs here, scripted (`pnpm e2e:m7`) and once by hand: a fresh install from source, the docs' pages for it followed, both agents on real tickets. Part B runs once on the maintainer's Linux machine: `docker compose up` from the published-to-be images, following only the install guide, with both agents in boxes. The measure (ticket 25) and the load test (ticket 26) are their own runs; part B can be the maintainer's own rehearsal of the measure, but never one of its two counted runs.

**The endpoint for Claude Code (Q253).** `~/.config/ostra-dev/model.env` was read for its names only on 2026-11-19: `OSTRA_DEV_MODEL_BASE_URL`, `OSTRA_DEV_MODEL_API_KEY`, `OSTRA_DEV_MODEL_ID` and three `OSTRA_SPIKE_PRICE_*` prices. None names an API format, and none is a second endpoint. Milestone 1's demo saw "Connected · OpenAI-compatible" for it (`specs/m1-first-pr/demo.md`, step 3), and spike 10 ran OpenCode on the same provider "in Anthropic's format" (`research/spike-is-opencode-good-enough.md`). So:
- **First, test it.** Ticket 34's step 1, done by the script without printing anything: on the provider's page, "Test connection" with the format set to "Anthropic Messages" against the same base URL and token. If `/v1/messages` answers a one-token request, the demo adds a second provider from the same variables in Anthropic's format, and Claude Code's profiles use it.
- **If it doesn't,** the maintainer adds an endpoint that does, from any provider or gateway, as `OSTRA_DEV_ANTHROPIC_BASE_URL`, `OSTRA_DEV_ANTHROPIC_API_KEY` and `OSTRA_DEV_ANTHROPIC_MODEL_ID` in `model.env` (ticket 34, step 2). `docs/development.md` gets the names, never the values.
- **Without either,** part A runs Claude Code on milestone 1's stub model endpoint in Anthropic's format, marks its live steps `skipped: no Anthropic-format endpoint` in its report, and F-018 stays `building`, with every condition the stub proves `proved`. Nothing is faked as live.
- **The model may not be Claude's.** An Anthropic-format endpoint can serve another family's model. Claude Code's protocol works on it; how well it drives Claude Code's tools is recorded in `demo.md` as seen, not claimed.

### Part A: here, from source

**Before:** a fresh clone, `pnpm install`, `pnpm dev:reset`, `tunnel.env` loaded, `pnpm dev`. The docs site built locally (`pnpm --filter @ostra/docs build`) and its "Run ostra from source" and "Personal runners" pages followed for what they cover. Milestones 1 to 6's helpers do the rest: a model provider from `model.env`, the test App, the Linear connection, projects `test1` and `test2`, a personal runner on `host`, the maintainer's GitHub user linked to Demo. The panel signs in as `demo@demo.com` / `demo`; the scripted run sets `OSTRA_ALLOW_DEFAULT_PASSWORD=true`.

1. **A Claude Code profile.** Organization, "Agent profiles", "New profile": the agent picker lists OpenCode and Claude Code. With Claude Code chosen, the model list holds only models of Anthropic-format providers, and a provider in the other format is listed as "Claude Code needs Anthropic's Messages API". The profile's page lists what Claude Code declares (section 6), with nothing marked missing but "the profile's settings win over the repo's own Claude config", shown as "the repo's `.claude/settings.json` and `.mcp.json` are set aside for each task". Demo saves "Claude Code" with the Anthropic-format model, an approval rule for `npm install`, and plan first off.
2. **Preparing Claude Code.** The personal runner's page shows its agents: OpenCode with its version, Claude Code "not installed". Demo starts a prompt task on the Claude Code profile in `test1` ("Add a line `claude-code-was-here` to `NOTES.md`"). The task waits with "Preparing Claude Code on this runner"; the runner installs the pinned package, checks the binary's SHA-256 (its log says which file and that it matched, never a path outside the runner's data folder) and the runner's page then shows Claude Code with its version. The task starts.
3. **A Linear ticket, worked by Claude Code, beside OpenCode.** The script creates two tickets in `OST`: "Add `docs/agents.md` listing the agents this repo has been worked by, with today's date" and "Add a `CONTRIBUTORS` line for ostra". Demo starts the first from `test1`'s Inbox on the Claude Code profile and the second on milestone 3's built-in OpenCode profile. Both sessions stream in their task pages at once; the Claude Code thread shows its plan as a plan (native) and any subagent's calls nested under the call that started it. Both open PRs on `test1`, each linked on its ticket, each opened by the App with Demo as co-author. The key proxy counted every call of both, the Claude Code task's `count_tokens` calls included, and each task's spend shows its four kinds of token. Claude Code's `HEAD /api/hello` warm-up probe reached the proxy, was answered, and isn't counted as a model call; no `/v1/models` call was made, since gateway model discovery stays off unless `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` is set, which ostra never sets (`research/claude-code-acp.md`, D3).
4. **No subscription, no credential.** The runner's launch record for the task (written in development and test only: the command, its arguments and its environment's variable names, never a value; ticket 08) shows every variable on ADR 0062's allowlist, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CODE_EXECUTABLE` absent, and `--hide-claude-auth` in the arguments with no MCP header among them. `ANTHROPIC_API_KEY`'s value is the task's placeholder, compared by hash. The real key's value appears in no log, event or file of the task (searched by value, never printed). The machine's own `~/.claude` is untouched (its listing before and after is the same).
5. **Stepping in, on Claude Code.** On a third ticket on the Claude Code profile, with plan first on for the run: the plan arrives as a needs-you item; Demo approves it. The agent asks to run `npm install`: the approval card shows it; Demo denies it with a reason, and the turn carries on with another way (or, if the suite found `rejectAndContinue` false, is re-prompted, and the card says so). Mid-turn, Demo sends "also add a trailing newline": it steers the running turn. Demo stops the task, then reopens it a minute later with "carry on": it resumes on the same worktree from Claude Code's own session; then Demo reopens it on a fresh worktree, and it resumes from the archive (or, if the suite found `sessionArchive` false, from the rebuild template, which the task page names). An approval answered "Allow for this task" during the run leaves the repo's `.claude/settings.local.json` as it was before the task, in the worktree and in the commit (ticket 38). Last, Demo reopens the OpenCode task of step 3 on the Claude Code profile, with "also list the date format": it starts from the rebuild template, on the same branch and PR, and the task page says it changed agent (F-033, ticket 37).
6. **Memory, review and the read-only kinds on Claude Code.** `test1`'s Review profile (milestone 6) is switched to Claude Code. The OpenCode task's PR from step 3 gets its AI review from Claude Code: one `COMMENT` review on GitHub, findings on their lines. A refine task on a fourth ticket, on a Claude Code refine profile, reads the code, pushes nothing, and hands in a draft through `submit_draft`. The Claude Code task of step 3, reopened with "remember that NOTES.md lines are sorted", proposes a memory note through `memory_propose`, which appears in `test1`'s proposals.
7. **The keyboard, the theme and the phone.** In one browser, with the keyboard only: Ctrl+K (⌘K on a Mac), "needs you", Enter, the approval from step 5's next rule, approved with its shortcut; Ctrl+K, "reopen", the stopped task, a message, sent. `?` shows the shortcut sheet. Account, Appearance: "Light"; the panel repaints and stays light after a reload, with no dark flash; "Match my system" follows the browser's emulated scheme. At 390 px, the same approval and a reopen are done by touch.
8. **The docs, as published.** `docs.yml`'s dry run builds the site; the built site's install guide, configuration reference, runner guide and adapter guide are each opened, and the configuration reference lists every setting `packages/domain`'s settings test knows. With the maintainer's go (ticket 33) it's the live site instead.

### Part B: on Linux, from the images

**Before:** the maintainer's Linux machine with Docker, the release candidate's images built by `pnpm images:build`, the test workspaces' env files copied by the maintainer into `~/.config/ostra-dev/` there (ticket 34, step 6). The docs site's install guide, open in a browser.

9. **`docker compose up`, by the guide.** Every step the guide gives, and nothing else: the compose file, the required settings, the first sign-in with its forced password change, the checklist. The server, Postgres and the pool runner on `docker` come up.
10. **Claude Code's agent image.** The first Claude Code task on the pool waits with "Preparing Claude Code on this runner" while the runner builds the agent image from the base image's digest; `docker image ls` then shows it, and `docker history` shows the pinned install. The published base image holds no `@anthropic-ai` file (`pnpm check:images`).
11. **Both agents, in boxes.** The tickets of step 3 again, one per agent, each in its own box: the agent container's environment holds only the placeholder and the sidecar's address, and both PRs open on `test1`.

**The checks after the run** (ticket 32 scripts what it can, in `e2e/m7-launch/`):
- **Nothing leaked.** The model key, the GitHub tokens, the task tokens and the MCP bearers appear in no log line, event, worktree or process command line (searched by value, never printed). No Claude Code process ever had `CLAUDE_CODE_EXECUTABLE`, `ANTHROPIC_AUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN` set.
- **Parity holds.** The parity test (ticket 03) passes: every capability is declared by both shipped adapters, and every feature of section 6 has its case on both, or its declared capability and the fallback ostra takes.
- **The agent suite passes** on OpenCode and on Claude Code, on the stub model, and on the live endpoint where there is one.
- **Repo config stays set aside.** A repo with a `.claude/settings.json` hook that writes a marker file, an `.mcp.json` server, and a `.claude/agents/` definition and a `.claude/skills/` skill whose frontmatter declares `hooks`, inline shell, `mcpServers`, `permissionMode: bypassPermissions` and `allowed-tools`, worked by Claude Code: no marker, no server started, every approval rule still asked, and the files back in place before the commit, unchanged (F-018, F-021, ADR 0049).
- **Keyboard and contrast.** Ticket 17's walk passes on every route in both themes.
- **Clean-up:** the demo's tickets archived in `OST`, its PRs closed, branches and hidden refs deleted, in `test1` and `test2` only.

---

## 4. How it fits together in milestone 7

```
 browser ──▶ apps/web: the palette's actions, the shortcut sheet, Appearance, the light theme,
                │       Claude Code in agent profiles, a runner's agents, nested subagent calls
                ▼
             packages/api ──▶ Postgres: agent options on profiles, agent images, a member's theme
                │
 apps/core: choosing a runner by its agents, "Preparing <agent>", agent images, setup.timeline
                │
 runner ──WS──▶ gateway   hello/status: agents [{ name, version, state }]
   ├─ host:    <data>/agents/claude-code/<version>/ (npm install --ignore-scripts, SHA-256 checked)
   ├─ docker:  agent image FROM base@digest + the pinned install (the snapshot builder)
   ├─ kubernetes: the same through BuildKit, in the organization's registry
   └─ the task: node claude-agent-acp/dist/index.js --hide-claude-auth
                 ──ACP stdio──▶ ostra's driver ──▶ the same TaskEvents as OpenCode's
                 ANTHROPIC_BASE_URL ──▶ key proxy (x-api-key placeholder → the real key)
 docs: apps/docs ──static export──▶ GitHub Pages (docs.yml, by hand and on a release)
 release: release.yml (by hand) ──▶ npm (trusted publishing) · images by digest · GitHub release
```

**The flows:**
- **A Claude Code task's launch.** The dispatch carries the profile's agent `claude-code`, its model (an `anthropic-messages` provider's), its options and the rest of milestone 6's spec. The runner checks it has Claude Code `ready` (else it never accepted the offer: section 5.1). `ClaudeCodeAdapter.prepareLaunch` returns `<node> <install>/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js --hide-claude-auth`, where `<node>` is the runner's own Node (`process.execPath`, 24.5 or later, above the ACP adapter's 22) on `host` and the base image's in a box, never whichever `node` comes first on `PATH`, with ADR 0062's environment, and the files `CLAUDE.md`, `settings.json` and `skills/` in `<agentDir>/claude/`. The runner hides the repo's three Claude config files (milestone 3's mechanism), starts the process through the executor, and the base class connects ostra's driver. Everything after is milestone 1 to 6's code path.
- **Preparing an agent on a runner.** A runner that is offered, or told to prepare, an agent it lacks reports `agent.preparing`; on `host` it runs `npm install --ignore-scripts --no-audit --no-fund --prefix <data>/agents/<agent>/<version> <package>@<version>` (with `OSTRA_NPM_REGISTRY`), as an argument array, then checks the binary's SHA-256 against the adapter's pins; on `docker` it builds the agent image through milestone 3's snapshot builder from a generated Dockerfile; on `kubernetes` through milestone 5's BuildKit pod, pushed to the organization's registry by digest. Success reports `agent.ready` with the version and, for an image, its digest, which core records as an `AgentImage`; failure reports `agent.failed` with a reason, and the tasks that waited stay queued with it. A task waiting for an agent shows "Preparing Claude Code on this runner", and admission offers it to another runner that has the agent first.
- **Choosing a runner** (milestone 5's rule, one more filter): a runner that reports the profile's agent `ready`, or that can prepare it (`host` with npm, `docker` and `kubernetes` with the builder); a runner on minor 5 or older reports no agents and is taken to have OpenCode only.
- **Claude Code's subagents.** Claude Code's Task tool runs a subagent. For a client that doesn't advertise ACP's draft `subagents` capability (ostra's driver doesn't), the ACP adapter sends the subagent's updates in the parent session, each stamped `_meta.claudeCode.parentToolUseId` with the call that started it: its tool calls and its message and thought chunks. Because ostra's driver advertises `plan` in `initialize`, every checklist arrives as an ACP plan operation, `plan_update` or `plan_removed` with a `planId`: `plan` for the session's own list, `plan:<parentToolUseId>` for a subagent's, `plan-mode` for an approved plan-mode plan. The shared mapping reads only the legacy `plan` update today, so it learns these (ticket 02), or Claude Code's plans would land as `agent.unknown` (`research/claude-code-acp.md`, section 6). The adapter's new `parentToolCallIdOf(update)` reads the stamp, or the plan ID's suffix, and the shared mapping sets the optional `parentToolCallId` on `tool.called`, `agent.message`, `agent.thought` and `plan.updated` (section 5.1). A `plan.updated` with a parent is the subagent's checklist and never replaces the task's plan. `packages/task-view` folds them under their parent, and the panel shows them nested and collapsed. An agent that sends no stamp gets flat calls, as today.
- **The theme.** A member's choice is saved on their account and set in a cookie; the root layout reads the cookie on the server and sets `data-theme` before first paint (`system` sets none and lets the CSS media query decide). The tokens for `light` are the brand's.
- **The palette's actions.** The palette's sources are the destinations (milestone 1), search (milestone 4), and, new, actions: each a typed command with an ID, its words, its shortcut, the condition under which it's offered (the page, the member's role, the item in focus) and the tRPC call it makes. The same registry drives the shortcuts and the `?` sheet, so a shortcut can't exist without its sheet line.
- **Setup's timeline.** `setup.timeline` (instance admin only) reads the audit entries of the setup steps and the first PR's event for the first organization and returns each step's time; `pnpm measure:setup` prints them against the time the person wrote down for the first command.
- **The docs.** `apps/docs` reads `docs/configuration.md` and the other `docs/` pages at build time, and its own MDX pages; `next build` with `output: "export"` writes the static site; `docs.yml` uploads it to GitHub Pages.
- **The release.** `release.yml` (by hand): every check, the images built, checked and pushed by digest, the npm packages published through trusted publishing with provenance, the GitHub release, then `docs.yml`. With `dry-run: true` it pushes to a `registry:2` inside the job and runs `npm publish --dry-run`.

---

## 5. The contracts

Every contract change in milestone 7 is **additive**: a new optional field, a new union member, a new endpoint, a new table, column or enum value. Nothing is renamed or dropped (`AGENTS.md`). Each lands as one small commit that names the contract and updates every caller in the same commit. Tickets 01 to 05 make them first, each with the fakes its callers test against; everything else builds on them.

### 5.1 `packages/protocol`: minor 6 (ticket 01)

- **The version.** One minor past milestone 6's: minor 6, if milestone 6 took minor 5; ticket 01 reads `main` and names the number. The window stays one minor, so a minor-5 runner still works: it reports no agents and is offered OpenCode tasks only (Q264).
- **What a runner reports:** `hello` and `status` gain `agents: [{ name, version, state: "ready" | "preparing" | "failed" | "available", image: { digest } | null }]`, where `available` means "not installed, and this runner can prepare it". Absent on a minor-5 runner.
- **Events, new members of the union:** `agent.preparing { agent, version }`, `agent.ready { agent, version, digest | null }`, `agent.failed { agent, version, reason: "checksum" | "install" | "build" | "registry" | "unsupported", detail }` (runner events, not task events; the gateway stores them on the runner's row and in the audit log). Their kinds share the `agent.` prefix with the task events `agent.message`, `agent.thought`, `agent.content` and `agent.unknown`, so they live only in the runner events' union, and ticket 01's test fails if any union the gateway parses holds both.
- **Subagent events:** `tool.called`, `agent.message`, `agent.thought` and `plan.updated` gain an optional `parentToolCallId`, the call that started the subagent this update is from. `tool.progress`, `tool.completed` and `tool.failed` already name their call, so they need none. (The task events have no `tool.started` or `tool.updated`; `packages/protocol/src/events/agent-events.ts` is the list.)
- **Commands:** `agent.prepare { agent, version }`, from core to a runner, for an admin's "Prepare now" and for a queued task's runner of choice.
- **Offers:** a runner declines an offer for an agent it can't run or prepare with the reason `agent-missing`; `isTaskOfferable(spec, peer)` says no to a minor-5 peer for any agent but `opencode`.
- **The agent's options in the task spec:** `agent.options: Record<string, unknown>` (optional, absent meaning none), validated by the adapter's own schema on the runner and in core.
- The schemas' descriptions say what's never logged: an install's full path outside the runner's data folder, an agent's environment.

### 5.2 `packages/adapter-sdk` (tickets 02 and 03)

**`AgentAdapter`** (ticket 02):
- **Options, new:** `readonly optionsSchema: z.ZodType<AgentOptions>` (default: an empty strict object), so a profile's agent options are typed by the adapter that reads them. Claude Code's: `{ stripExperimentalBetas: boolean }` (default false).
- **Requirements, new:** `readonly requires: { apiFormats: readonly ApiFormat[] }`. OpenCode takes both; Claude Code `["anthropic-messages"]`. Core refuses a profile whose model's provider isn't in the list, and the panel filters by it.
- **Installing, new:** `readonly install: AgentInstall`, the pinned package and how to check it: `{ kind: "bundled" }` (the adapter's own dependency, as OpenCode's is) or `{ kind: "npm", package, version, binary: { packageByPlatform, path }, sha256ByPlatform }`, plus `imageInstall(baseDigest)`, the Dockerfile lines that install and check it in an agent image. The runner uses it; the adapter never downloads anything itself.
- **Plan operations, new in the shared mapping:** ostra's driver already advertises `plan` (`driver.ts:388`), so the mapping reads `plan_update` and `plan_removed` beside the legacy `plan`: an `items` plan maps to `plan.updated` (and `plan_removed` to an empty one) for its `planId`, the session's own (`plan`) as the task's plan; a `markdown` plan (Claude Code's `plan-mode`, the approved plan of plan first) maps as F-063's case decides, to the plan-first card's approved text or dropped as the duplicate of the `ExitPlanMode` approval that carried it, never to `agent.unknown`.
- **The subagent parent, new:** `parentToolCallIdOf(update): ToolCallId | undefined` on `AgentAdapter` (default: none), which the shared ACP mapping (`acp/map.ts`) calls for a tool call, a message chunk, a thought chunk and a plan, and copies onto the event. A plan with a parent maps to `plan.updated` with it, and never to the task's plan. Nothing else changes in the mapping.
- **The scripted fake agents** grow: one that runs a "subagent" (tool calls and message and thought chunks stamped `_meta.claudeCode.parentToolUseId`, and a `plan_update` with `planId` `plan:<call>`, as the ACP adapter sends them), one that sends its plans as plan operations, one that sends an unknown notification after `initialize` (as Claude Code's `_auth/status_update`), one that queues a prompt sent mid-turn (`promptQueueing`), and one that requires `anthropic-messages`.

**The suites and parity** (ticket 03):
- **The agent contract suite runs on every shipped adapter by name:** `runAgentSuite(adapter, { model: "stub" | "live" })`, so the same cases run on OpenCode, on Claude Code and on the scripted fakes, and a case an adapter's capability rules out runs its declared fallback instead and checks that.
- **New cases:** an unknown notification after `initialize` is tolerated; a turn's every model call reaches the key proxy and nothing else (the stub endpoint counts them, and answers a warm-up `HEAD /api/hello` that isn't counted as a call); the proxy's count equals the agent's own reported usage for the calls it closed (F-089's "within 2%"); the environment of the launch is exactly the adapter's allowlist; a repo's agent config files named in `repoConfigPaths` are hidden for the task and restored byte for byte, and a file the agent creates at one of those paths during the task (Claude Code's "always allow" writes `.claude/settings.local.json`) is removed before the commit; a repo's agent and skill definitions can't run a hook or inline shell, add an MCP server, enter a bypass mode or skip an approval rule; a subagent's calls, messages and thoughts carry their parent, and its plan never replaces the task's; a ticket whose text starts with `/` is never run as a slash command (ostra's prompt never starts with ticket text); no subscription credential is stored in the agent's config folder or in its session archive; a profile with a provider in a format the adapter doesn't take is refused before launch; the binary's checksum mismatch refuses the launch; a task reopened on another agent starts from the rebuild template (ticket 37).
- **The parity test** (`src/testing/parity.test.ts`): for every shipped agent adapter, every key of `AgentCapabilities` is declared (the type already forces it) and every feature of section 6's table names the case that proves it on that adapter, or the capability it's declared under and the fallback case. A new feature that touches agents adds its row there.

### 5.3 `packages/db`: the milestone 7 migration (ticket 04)

One new migration, after milestone 6's, additive only. Every row carries `organizationId`.

| Change | What |
|---|---|
| `AgentProfile` | + `agentOptions` (JSON, default `{}`, parsed by the adapter's `optionsSchema`) |
| New `AgentImage` | `runnerId` (null when it's in the registry), `poolId`, `registryId`, `agent`, `agentVersion`, `baseDigest`, `imageRef`, `digest`, `state` (`building`, `ready`, `failed`), `failure`, `builtAt`, `createdAt`. Unique `(organizationId, agent, agentVersion, baseDigest, runnerId)` and `(organizationId, agent, agentVersion, baseDigest, registryId)` |
| `Runner` | + `agents` (JSON, default `[]`, parsed by the protocol's schema), where milestone 5's `capabilities` doesn't already hold it |
| The account (better-auth's user row, ostra's columns) | + `theme` (`ThemePreference`: `dark`, `light`, `system`; default `dark`) |
| Enums | New `ThemePreference`, `AgentImageState`. The audit actions gain `agent.prepared`, `agent.prepare_failed`, `account.theme_changed` |

The migration backfills nothing: every profile's options start empty, every member's theme dark.

### 5.4 `packages/domain` (tickets 05 and 36)

- **The agent catalog:** the shipped agent adapters by name (`opencode`, `claude-code`), each with its display name, its `requires`, its `optionsSchema` and its capabilities, read from the adapter classes (Apache-2.0, importable here), so core, the API and the panel ask one place.
- **Profiles:** `saveAgentProfile` refuses an agent the catalog lacks, a model whose provider's format the agent doesn't take (`model-format`), and options its schema refuses; existing profiles keep working.
- **Lifecycles,** with exhaustive tests: an agent on a runner (`available` → `preparing` → `ready` | `failed` → `preparing`), an agent image (`building` → `ready` | `failed`).
- **Admission:** milestone 5's runner choice gains the agent filter and the "prepare" outcome: the best runner that has the agent, else the best that can prepare it (with `agent.prepare`), else the task waits with the reason "No runner of <pool> can run Claude Code" naming the nearest miss.
- **The palette's actions and shortcuts** (ticket 36, with setup's timeline and the theme, so tickets 13, 18 and 24 don't wait on the agent work): the registry's type (`PaletteAction`: ID, message key, shortcut or none, scope, role, the procedure it calls), so the API checks the same conditions the panel offers.
- **Setup's timeline:** `setupTimeline(organizationId)`, pure over the audit entries and the first PR's event.
- **Use-case signatures:** `saveAgentProfile` (grown), `prepareAgent`, `recordAgentState`, `recordAgentImage`, `chooseRunner` (grown), `setTheme`, `setupTimeline`.
- **Settings, new,** each with a working default and its line in `docs/configuration.md`:

| Setting | Default |
|---|---|
| `OSTRA_AGENTS_DIR` (runner) | `<OSTRA_RUNNER_DATA_DIR>/agents` |
| `OSTRA_NPM_REGISTRY` (runner) | `https://registry.npmjs.org` |
| `OSTRA_AGENT_PREPARE` (runner) | `auto`: prepare an agent when a task needs it; `manual`: only on an admin's "Prepare now"; `off`: never, report it `failed: unsupported` |
| `OSTRA_AGENT_IMAGE_CLAUDE_CODE` (runner) | unset: build the agent image; set to an image reference, use that image for Claude Code instead, for an install that builds its own |
| `OSTRA_DOCS_URL` (server) | the docs site's address, which the panel's help links use |
| `OSTRA_PSEUDO_LOCALE` (web, development and test only) | unset: English; `1` builds the pseudo-locale (ticket 20). Ignored in production |

---

## 6. Adapter parity: every agent-touching feature, on both agents

`AGENTS.md`: a feature that touches agents works through the shared interface for every shipped adapter, or the interface declares it an optional capability and each adapter states whether it has it. This is every such feature of milestones 1 to 6, and what Claude Code does for it. "Proved by" is the agent suite's case (ticket 03), run on both adapters. Where Claude Code's value is "as proved", it's declared as ADR 0062's table says once its case passes, and the safe value until then.

| Feature (milestone) | What it asks of the agent | OpenCode | Claude Code | Proved by |
|---|---|---|---|---|
| F-023 Live activity (1) | ACP updates mapped to ostra's events: text, thinking, tool calls with raw input and output, plans, usage | yes | yes, plus `parentToolCallId` for subagents | the suite's mapping cases; the subagent case |
| F-025 Stop (1) | `session/cancel` ends the turn `cancelled` | yes | yes | the stop case |
| F-089 Key proxy (1) | a base URL and a placeholder key (`modelBaseUrlAndPlaceholderKey`); a count within 2% of the agent's own usage | yes | yes: `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`; its four usage counters over ACP | the every-call-at-the-proxy case; the usage-match case |
| F-090 Git proxy (1) | the agent's own `git` through the proxy | yes | yes (Claude Code's Bash runs `git`) | the push-and-refuse cases |
| F-016, F-098 Workspace, several repos (1, 4) | the agent at the workspace root, repos side by side | yes | yes | the two-repo case |
| F-030 Open the PR (1) | ostra's MCP tool `set_pull_request_text` | yes | yes (`mcp.http`) | the MCP tools case |
| F-078 Repo conventions (1) | the repo's `AGENTS.md` read natively | yes | yes: read when the repo has no `CLAUDE.md`; a repo's `CLAUDE.md` is its own choice | the instructions case |
| F-064 Ticket context (2) | the ticket's files in the config folder, images as files | yes | yes (and `promptCapabilities.image` for later) | the context-files case |
| F-032, F-033, F-096 Reopen anywhere, after every turn (2) | `sessionLoad` in place; `sessionArchive` to a fresh box | yes, yes | yes; archive as proved | the load and archive cases; the rebuild template as the fallback |
| F-033 "With another agent" (2, finished here) | a session started from the rebuild template, since one agent's archive means nothing to another | to Claude Code: the template | to OpenCode: the template | the other-agent case, both ways (ticket 37) |
| F-047 Agent crashes (2) | a killed agent's session marked crashed, resumable | yes | yes | the kill case |
| F-021 Agent profiles (3) | instructions beside the repo's, `skills`, `mcp`, `permissionRules`, `projectConfigOverride` | instructions, skills, MCP, rules native, override as milestone 3 left them | instructions in `CLAUDE.md` of its config folder, skills as proved, MCP HTTP and stdio, rules native as proved; **no `projectConfigOverride`**: the repo's `.claude/settings.json`, `.claude/settings.local.json` and `.mcp.json` are hidden for the task. The repo's `.claude/agents/`, `.claude/skills/` and `.claude/commands/` stay visible, but their frontmatter can declare hooks, inline shell, MCP servers, a permission mode and pre-approved tools (`research/claude-code-acp.md`, D8), so ostra's `settings.json` sets `disableAllHooks`, `disableSkillShellExecution` and `permissions.disableBypassPermissionsMode: "disable"`; if the frontmatter case shows a repo agent's `mcpServers` or `permissionMode` still wins, `.claude/agents/` joins `repoConfigPaths` and the docs say so | the profile cases; the repo-config case; the frontmatter case |
| F-024 Steer (3) | `steerMidTurn` | yes | yes (`_session/steering`) | the steer probe on every bump |
| F-026 Approvals (3) | permission requests; `rejectAndContinue`; "allow for this task" | yes; no (re-prompt); task-scoped | yes; as proved (re-prompt until then); Claude Code's `allow_always` option writes its rule to the repo's `.claude/settings.local.json` (P18), a hidden path, so the rule holds for the task and the runner's restore removes the file before the commit | the approval and deny cases; the allow-for-this-task case |
| F-063 Plan first (3) | `planMode`, `nativePlan` | as milestone 3 left it; todo list mapped | `session-mode` (`plan`); native plans as proved, which arrive as ACP plan operations (`plan_update`) that the shared mapping learns in ticket 02 | the plan-turn cases; the plan-operations case |
| Questions (3, F-062) | `elicitationForm` | yes | yes (`AskUserQuestion`) | the question case |
| F-084, F-037 Usage, budgets (3, 4) | the key proxy counts; every call on the profile's model | — | every subagent on the profile's model too: `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`, since a model the agent passes at spawn or a repo agent's `model:` otherwise outranks `CLAUDE_CODE_SUBAGENT_MODEL` (D6) | the every-call case; the subagent-model case |
| F-070, F-053, F-054, F-035, F-105 Update branch, `@ostra`, checks before the PR, failing CI, changes requested (3, 6) | a new turn with a prompt | yes | yes | the turn case |
| F-068 Runaway protection (2) | agent events to reset the stall clock; the spend cap at the key proxy | yes | yes: a subagent's stamped updates count as the task's events | the stall and cap cases |
| F-110, F-111 Memory (4) | `memory`; the agent's own memory off | `mcp`; has none | `mcp`; `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` | the memory cases; the native-memory-off case (milestone 4 named it for Claude Code) |
| F-014, F-015, F-093 Runners, pools, `kubernetes` (5) | the agent present on the runner or in the box, behaving as in a box | bundled, in the base image | installed on `host`, an agent image on `docker` and `kubernetes`. On `host`, a machine's managed Claude Code policy (a `managed-settings.json`, a macOS profile, a `Policies\ClaudeCode` registry value) outranks every setting ostra writes and can't be hidden (D5), so the runner reports Claude Code `failed: unsupported` there with that reason, and the task goes to another runner rather than run differently (Q267) | the runner's agent tests, the managed-policy case; the Linux and kind jobs |
| F-039 Three images (5) | the base image pins every v1 agent | yes | **declared:** in an agent image until the terms allow the base image (ADR 0062) | `pnpm check:images` |
| F-116 Egress baseline (5) | no traffic of the agent's own beyond the proxies | yes | yes: nonessential traffic, telemetry, error reports and updates off | the network case in the Linux job |
| F-099, F-100 Refine, review (6) | read-only: the git proxy's mode, the profile's rules, the kind's tools only | yes (milestone 6's ticket 09 maps them to OpenCode's config) | yes: the kind's permissions as `deny` rules in its `settings.json`, and the MCP tools a kind doesn't get denied by name (`mcp__ostra__submit_review` and the rest), ticket 38 | the read-only and tools cases |
| F-012 Start from Linear (6) | the task's events as Linear agent activities | yes | yes: a subagent's events are posted under their parent's activity, never as a second stream | the agent-mode case on both agents |
| F-101 Automatic turns (6) | `elicitation`: a question answered with the neutral reply | yes | yes | the automatic-turn case |
| F-113 Onboarding (6) | `propose_environment`; `commitPaths` | yes | yes | the proposal and commit cases |

**What Claude Code lacks** is one capability, `projectConfigOverride`, which the interface already declares and handles. On `host`, a machine with a managed Claude Code policy can't run it, which the runner reports and the panel shows; nothing runs differently in silence. **What OpenCode lacks** stays as milestones 1 to 6 declared it. No feature works only on one agent.

---

## 7. Packages, licenses and owners

| Package | License | New in M7 | Built by |
|---|---|---|---|
| `packages/protocol` | Apache-2.0 | minor 6: agents on a runner, their events, `agent.prepare`, `parentToolCallId`, agent options | core (01) |
| `packages/adapter-sdk` | Apache-2.0 | options, requirements and installs on `AgentAdapter`; the suite by adapter; the parity test; the fakes | adapters (02, 03) |
| `packages/adapters/adapter-claude-code` (new) | Apache-2.0 | the adapter, its pins, its config files, its contract and live tests | adapters (06, 38, 07) |
| `packages/adapters/adapter-opencode` | Apache-2.0 | its `install`, `requires` and options; the suite by name | adapters (03) |
| `apps/runner` | Apache-2.0 | `ostra agents`, installs on `host`, reporting agents, Claude Code's calls at the key proxy | runner (08, 10) |
| `adapter-executor-docker`, `adapter-executor-kubernetes` | Apache-2.0 | agent images through the snapshot builder and BuildKit | runner (35) |
| `packages/db` | Sustainable Use | the M7 migration | core (04) |
| `packages/domain` | Sustainable Use | the catalog, profiles, admission by agent, settings (05); the palette's type, setup's timeline, the theme (36); reopening on another agent (37) | core (05, 36, 37) |
| `apps/core` | Sustainable Use | preparing agents, agent images, choosing by agent (09); reopening on another agent (37) | core (09, 37) |
| `packages/api` | Sustainable Use | profiles, runners' agents, theme, `setup.timeline` | api (11, 24) |
| `packages/task-view` | Sustainable Use | nested subagent calls | web (15) |
| `apps/web` | Sustainable Use | the M7 screens and the final checks | web (13 to 20) |
| `apps/docs` (new) | Apache-2.0 | the docs site | web (21), with core and adapters writing pages (22, 23) |
| `e2e/m7-launch`, `e2e/load` | Sustainable Use | the demo; the gate's run | core (26, 32) |
| `deploy/`, `packages/deploy-checks` | as milestone 5 left them | no Anthropic file in a published image; third-party notices | runner (29) |

The license line holds (ADR 0045, ADR 0048): no Apache-2.0 package depends on a Sustainable Use one. `adapter-claude-code` lists no Anthropic package in its `package.json`: the pinned version and checksums are constants, and the install happens at run time (ADR 0062). `apps/docs` reads `docs/configuration.md` as a file. `pnpm check:licenses` runs on every commit.

---

## 8. The builders and their tickets

Five builders, as before: **core**, **runner**, **web**, **api** and **adapters**. Core and adapters make the contracts first (01 to 05), each with the fakes its callers need. Ticket 27's review is written by a session that built none of the box (ADR 0064). Tickets 25, 33 and 34 need the maintainer or people the maintainer picks.

| # | Ticket | Builder | Blocked by |
|---|---|---|---|
| 01 | Protocol: minor 6 | core | none (milestone 6's minor lands first) |
| 02 | Adapter SDK: options, requirements, installs and the subagent parent | adapters | 01 |
| 03 | Adapter SDK: the suite by adapter, the new cases, and the parity test | adapters | 02 |
| 04 | DB: the milestone 7 migration | core | none |
| 05 | Domain: the agent catalog, profiles and admission by agent | core | 02, 04 |
| 06 | Claude Code adapter: the package, its pins, its launch and its environment | adapters | 02 |
| 07 | Claude Code adapter: the agent suite on the real Claude Code | adapters | 03, 06, 08, 38 |
| 08 | Runner: installing agents on `host` and reporting them | runner | 01, 02 |
| 09 | Core: preparing agents, agent images and choosing a runner by agent | core | 05, 08 |
| 10 | Runner: Claude Code's calls at the key proxy | runner | 06 |
| 11 | API: Claude Code profiles, runners' agents and the theme | api | 05, 09, 36 |
| 12 | Milestone 7 screen targets | web | none |
| 13 | Web: the palette's actions and the shortcut sheet | web | 12, 36 |
| 14 | Web: Claude Code in agent profiles, models and runners | web | 11, 12 |
| 15 | Web: nested subagent calls on the task page | web | 02, 12 |
| 16 | Web: keyboard paths for the core actions | web | 13 |
| 17 | Web: the keyboard walk and the contrast check on every screen | web | 16, 18 |
| 18 | Web: the light theme and Appearance | web | 11, 12 |
| 19 | Web: the phone sweep | web | 12 |
| 20 | Web: the message-file check and the pseudo-locale | web | none |
| 21 | Docs: the site, its build and `docs.yml` | web | 12, ticket 34's yes or the fallback |
| 22 | Docs: install, setup and runners, with checked commands | core | 21 |
| 23 | Docs: agents, using ostra, security, reference and the adapter guide | adapters | 21 |
| 24 | Setup in the panel: the last pieces and its timeline | api | 36 |
| 25 | The 30-minute measure | core (lead), with two newcomers | 22, 24, 29, 31 |
| 26 | The load test as the gate | core | 07 |
| 27 | Security review: the threat model, the checklist and the findings | an independent session (core assigns) | 07, 08, 28, 29, 31, 35, 38 |
| 28 | Security review: the adversarial run | runner | 07, 08, 35, 38 |
| 29 | Images: agent images, notices, and no Anthropic file published | runner | 08, 35 |
| 30 | Release: versions, `release.yml` and its dry run, `SECURITY.md`, `CONTRIBUTING.md` | core | 29, ticket 34's yes or the fallback |
| 31 | Proof jobs: Claude Code on Linux, kind and macOS | runner | 07, 08, 35 |
| 32 | The end-to-end demo and the ledger | core (lead) | 03, 06 to 11, 13 to 24, 31, 35 to 38 |
| 33 | The launch: the release run, after the go | maintainer, with core | 25 to 32, 35 to 38, ticket 34's legal items, names and go |
| 34 | The maintainer's steps outside the code | maintainer | none for the decisions |
| 35 | Runner: agent images on `docker` and `kubernetes` | runner | 08 |
| 36 | Domain: the palette's actions, setup's timeline and the theme | core | 04 |
| 37 | Reopening a task on another agent (F-033) | core | 03, 05, 07 |
| 38 | Claude Code adapter: its config files, the task kinds, the repo's config and sessions | adapters | 06 |

**Who starts when.** core takes 01 and 04 at once, then 36 and 05; adapters take 02 after 01, then 03 and 06 together, then 38; runner takes 08 after 01 and 02, then 35 and 10. Tickets 35 to 38 were split out of 05, 06 and 08 (and F-033 added) by the spec's review, so that each is one builder's change. web takes 12 and 20 at once; its screen tickets wait for the targets' approval (section 13). The docs (21 to 23) start once 12's docs targets are approved; their words can be drafted before. The gates (25 to 28) start once their parts are in. Milestones 2 to 6's tickets come first wherever both touch a file: a milestone 7 ticket that meets an earlier milestone's ticket still open on the same package waits for it, and says so in its `## Comments`.

---

## 9. Test seams

Agreed here so builders don't each invent one.

- **Postgres:** milestone 1's helper, a database per test file. Milestone 4's generated isolation test gets a fixture for `AgentImage`.
- **The model:** milestone 1's stub model endpoint, in **Anthropic's format** as well as the other, scripted per request, counting every call by path (`/v1/messages?beta=true`, `/v1/messages/count_tokens`, `/v1/models`, and the `HEAD /api/hello` warm-up, which is answered and never counted as a model call) so the suite can assert where every call went. The live cases run against `OSTRA_DEV_ANTHROPIC_*` or the tested `OSTRA_DEV_MODEL_*` provider (section 3), only when loaded.
- **Claude Code itself:** the real pinned package, installed by the runner's own install code into a test folder under `.data/agents/` (gitignored) once per machine, and reused; the suite's real-agent cases run on the stub model, so they need no credential and run in the proof jobs. They're live evidence only where they need the live endpoint.
- **The npm registry:** a fake registry (an in-process HTTP server serving a tarball and its metadata) for the install's unit tests: a checksum mismatch, a missing platform package, a registry that's down.
- **The image builder:** milestone 3's fake Docker engine and milestone 5's fake BuildKit, for the agent image's Dockerfile and its build calls; the real builds in the Linux and kind jobs.
- **The browser:** Playwright, as milestone 1's e2e stack: the keyboard walk and the contrast check on the production build, in both themes, at 1440 px and 390 px; the browser's emulated `prefers-color-scheme` for "match my system".
- **The hostile repo:** a fixture repo in the fake git upstream (ticket 28) with a `.claude/settings.json` hook, an `.mcp.json` server, a `.claude/agents/` definition and a `.claude/skills/` skill whose frontmatter declares hooks, inline shell, an MCP server, `permissionMode: bypassPermissions` and `allowed-tools`, an `opencode.json` command and a `postinstall`, each of which would write a marker or call a canary address if it ran.
- **Text that is data:** every prompt test feeds ticket text holding shell syntax and instructions, and asserts none reaches a log line, a shell command or a process's argument list.

---

## 10. Every ticket's checks and commit

As milestones 1 to 6 (`../m1-first-pr/spec.md`, section 9). In short:
- `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for the touched packages, and `pnpm check:licenses` passes.
- Tickets that touch auth, credentials, the schema, the runner protocol or anything that runs agent output (01, 02, 04, 06, 07, 08, 09, 10, 28, 29, 30, 32, 35, 37, 38) run all the checks for the whole repo.
- Every new setting has a working default and its line in `docs/configuration.md`. A fresh install with only the required settings still works: with no Claude Code profile, no runner ever prepares an agent, the theme is dark, and every task behaves as in milestone 6.
- **Proof** (`AGENTS.md`, `context/proof/README.md`): a test that proves a condition of a row's "done when" names the row's ID in its title (`it("F-018: a Claude Code launch's environment holds the placeholder key and no subscription credential", ...)`), runs in CI, and has a break-it check. The ticket adds its rows to `context/proof/F-nnn.md` (`pnpm proof:new F-nnn` writes the file), and `pnpm check:proof` passes. A condition only a live run shows cites the run's log or screenshot kept in the repo. A test that needs live credentials or hardware this machine lacks is live evidence: cite its run's log, never the test.
- No secret in the commit. Logs carry IDs and fields, never tokens, prompts, ticket text, an agent's environment or a path outside ostra's data folders.
- A `package.json` change goes with its `pnpm-lock.yaml`. Nothing new is added without an ADR 0007 line: the three entries of its "Milestone 7" section were confirmed on 2026-11-19 under the maintainer's permission for that session, and each ticket that needs one adds it then. If the maintainer withdraws one, its ticket builds the fallback.
- Stage only the ticket's own paths, a gitmoji message of at most 50 characters, no AI attribution, `git pull --rebase origin main`, `git push origin main`, retrying on a rejected push.
- The ticket file gets its `Status:` updated and a line under `## Comments` with the commit's hash.

### 10.1 How each row gets proved

Each condition of a row's "done when" gets a row in its proof file. This is where the proofs are expected to come from; the building tickets write them, and ticket 32 checks every one. "Needs" names hardware or people this machine lacks; such a condition stays `missing` or `partial` until it has run, with the plan in its proof file's notes, never a pass the run didn't show.

| F-ID | Proved by tests (kind, ticket) | Live evidence | Needs |
|---|---|---|---|
| F-018 | The launch's argument array and environment against ADR 0062's allowlist; no subscription variable, no `CLAUDE_CODE_EXECUTABLE`, `--hide-claude-auth` always; the checksum refusal; the Anthropic-format requirement refused in the domain and the API; the suite on the real Claude Code with the stub model, every case of section 6; no subscription credential stored in the config folder or the archive ("stored"); the parity test (03, 05, 06, 07, 11, 35, 38) | Part A steps 2 to 6; part B steps 10 and 11; the suite's live log on the Anthropic-format endpoint | An endpoint in Anthropic's format for the live run (Q253); Linux with Docker for the box (part B, and the Linux job for the agent image) |
| F-058 | The configuration reference rendered from `docs/configuration.md` holds every setting the settings test knows; the four parts the row names exist as pages; the guide's `run` blocks parse (21, 22, 23) | `docs.yml`'s run log and the site's address; the proof job's run of the guide's commands | The maintainer's yes for Fumadocs (or the fallback), and Pages enabled on the repo (ticket 34) |
| F-081 | The palette's actions for "needs you", approve, answer, take over and reopen, each run from the keyboard in Playwright; every shortcut on the sheet and every sheet line a shortcut (one registry); the keyboard walk on every route and on every dialog, sheet and menu a route opens (every control reached, a visible focus, no trap, Escape closes); the contrast check on the same, in both themes, at 4.5:1 for text and 3:1 for large text and controls (13, 16, 17) | Part A step 7 | none |
| F-075 | Every route at 390 px with no horizontal scroll; approve, answer and reopen done by touch at 390 px, end to end (19) | Part A step 7 | none |
| F-082 | Dark for a new member; light and "match my system" saved per member and applied before first paint after a reload; the emulated scheme followed; the tokens' light set from `brand/files/tokens/` (18) | Part A step 7, with screenshots of both themes | none |
| F-083 | No JSX text, `aria-label`, `title`, `placeholder` or `alt` outside `t` (an AST check over `apps/web/src` and `packages/task-view`); every key in `en.json` used; an API refusal the panel shows (a `model-format`, say) arrives as a code the panel words through `t`; the pseudo-locale build shows no visible string that isn't pseudo on every route, error states included (20) | none | none |
| F-076 | The checklist's order and each step's tick (milestone 1's tests, kept); the Linear step skippable and ticked when connected; `setup.timeline`'s times from the audit entries (24) | Ticket 25's two measured runs, each a timeline under 30 minutes with its notes; F-076's first condition's "after `docker compose up`" from the same runs, and from milestone 1's `02-setup` and `03-first-run` specs run against `docker compose up` in the Linux proof job (ticket 22), as the proof file's note asks | Linux with Docker, and two people new to ostra |
| F-117 | Milestone 5's harness tests, kept; the mix with Claude Code's recorded rates (26) | This machine's ramp on the release candidate; the Linux run at 1,000 tasks | A Linux machine of at least 16 vCPUs and 32 GB (the maintainer's) |
| F-039 (finished) | `pnpm check:images`: the pins, no secret, no `@anthropic-ai` file, the notices (29) | `release.yml`'s run: each image's digest in the registry; one `docker run` of the published runner image with a join token, joining a pool on the maintainer's Linux machine (33) | The maintainer's names and go; Linux with Docker |
| F-033 ("with another agent") | The other-agent case, OpenCode to Claude Code and back, on the stub model: the rebuild template used, never the other agent's archive, the same branches and PRs (37) | Part A step 5's last reopen | none |

---

## 11. What each ticket ports

| From | What | To (ticket) |
|---|---|---|
| `packages/adapters/adapter-opencode/src/binary.ts` | the pinned version, the checksums per platform, the binary found in its platform package and checked before launch | 06 |
| `packages/adapters/adapter-opencode/src/opencode-adapter.ts` | `prepareLaunch`'s allowlisted environment and its config files; the live test's shape | 06, 07 |
| `deploy/Dockerfile.base` (the OpenCode stage) | `npm install --ignore-scripts` at an exact version and the `sha256sum -c` of the binary, for the agent image | 08, 29 |
| `spikes/how-should-the-runner-drive-opencode/` (the steer probe) | the steer probe, run on Claude Code on every bump | 07 |
| milestone 5's `e2e/load` | the generator's event mix, with a second agent's rates | 26 |

No spike code is ported for Claude Code: it was never spiked (`build-order.md`), and the agent suite is its bar.

**Dependencies.** Three entries are confirmed for this milestone (ADR 0007, "Milestone 7", 2026-11-19, under the maintainer's permission for that session, pending their review): Fumadocs for the docs site, Changesets for versions, and Claude Code's ACP adapter, installed at run time and never listed in a `package.json`. Each has a fallback if withdrawn, except Claude Code, which F-018 needs. Nothing else is added: the docs' fallback renders plain Markdown with the panel's renderer and has no search (so the pages are written as Markdown that both paths render); the third-party notices come from `pnpm licenses list --json`; the fake npm registry is `node:http`; the session archive uses the system's `tar` (Windows 10 and later ship one). A ticket that finds it needs another package stops and asks, with its ADR 0007 line drafted. The keyboard walk, the contrast check, the message-file check, the pseudo-locale and the measure's script are ostra's own code on Playwright, the TypeScript compiler API and Node, already installed. `@axe-core/playwright` (MPL-2.0) was considered for the contrast check and isn't added: the check is a small computation over computed styles, and the walk covers what this milestone's row asks.

---

## 12. Choices this spec makes

The maintainer delegated every decision of this spec on 2026-11-19. Each choice below is the recommendation applied, recorded in `context/open-questions.md` under its number and, where it's hard to reverse, in an ADR. If the maintainer disagrees with one, it moves back to the open list and the ticket that holds it changes. **None of them answers Q109 or Q110**, which stay open for the maintainer and a lawyer, **or Q266** (whether ostra's public images may include Claude Code), which this spec opens for the same reason and designs around.

1. **How ostra runs Claude Code** (Q250, ADR 0062). `@agentclientprotocol/claude-agent-acp` 0.108.1 through ostra's own driver, launched with the runner's own Node and `--hide-claude-auth`, its binary's SHA-256 checked, `CLAUDE_CODE_EXECUTABLE` never set; `ANTHROPIC_BASE_URL` at the key proxy, the placeholder in `ANTHROPIC_API_KEY`, the profile's model in all five model variables with `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`, auto memory, telemetry, error reports, updates, nonessential traffic and prompt suggestions off; on Windows, Git Bash's path from the runner's `git`.
2. **What Claude Code declares, and its repo config** (Q251, ADR 0062). Every capability but `projectConfigOverride`, each as the suite proves it; its config in the task's `CLAUDE_CONFIG_DIR`; the repo's `.claude/settings.json`, `.claude/settings.local.json` and `.mcp.json` hidden for the task; the repo's `CLAUDE.md`, `AGENTS.md` and `.claude/` skills, commands and agents left visible, with hooks, inline shell and bypass mode off in ostra's `settings.json`.
3. **Where its binary comes from** (Q252, ADR 0062, ADR 0046 amended). No published image holds it until the maintainer records that the terms allow it; `host` runners install it on first need; `docker` and `kubernetes` runners build an agent image from the base image's digest, once per version. The redistribution question itself is the maintainer's.
4. **The demo's endpoint** (Q253, section 3). The existing provider tested in Anthropic's format first; else a second endpoint the maintainer adds; else the stub, and F-018 stays `building`.
5. **The docs' generator and host** (Q254, ADR 0063). Fumadocs on Next.js 16, pending the maintainer's yes, with a plain-Next.js fallback; a static export on GitHub Pages; `docs.yml` by hand and on a release; Apache-2.0.
6. **What the docs hold, and one source for the reference** (Q255, ADR 0063). Eight sections, the configuration reference rendered from the tested `docs/configuration.md`, every `run` command block checked in the proof job.
7. **The 30-minute measure** (Q256, ADR 0064). Two people new to ostra, on Linux with Docker, the docs only; the clock from the guide's first command to the PR; ostra's own audit entries as the timeline; both under 30 minutes.
8. **The load test as the gate** (Q257, ADR 0064, ADR 0061 amended). The run that counts on the release candidate, with Claude Code's recorded rates in the mix; launch waits for it.
9. **The security review of the box** (Q258, ADR 0064). Ten areas; a threat model, a checklist with evidence, and an adversarial run with a hostile repo and ticket on both agents; written by a session that built none of it and signed by the maintainer; an outside test is the maintainer's choice; no open critical or high finding at launch.
10. **Publishing** (Q259, ADR 0064, ADR 0045 amended). One manual `release.yml` with a dry run; npm trusted publishing with provenance; images by digest; `1.0.0`; waiting for the legal items, the names and the maintainer's go.
11. **The palette's actions and the shortcuts** (Q260, F-081). Actions: go to "needs you", approve, deny, answer, take over, reopen, stop, steer ("message the agent"), new task, new project, switch organization, toggle theme. Shortcuts, never with a modifier but ⌘K or Ctrl+K: `g` then `n` ("needs you"), `g` then `h` (Home), `g` then `t` (tasks), `c` (new task), `/` (search), `?` (the sheet); on a focused needs-you item `a` (approve), `d` (deny), `r` (reply or answer); on a task `o` (reopen), `t` (take over), `s` (stop, which asks to confirm). None fires while typing in a field. One registry drives the palette, the shortcuts and the sheet.
12. **How keyboard use and contrast are checked** (Q261, F-081). ostra's own Playwright walk and contrast computation on every route, both themes, two widths; no new dependency.
13. **The theme** (Q262, F-082). Account, "Appearance": dark (the default), light, match my system; saved on the account and in a cookie, applied on the server before first paint; the light tokens from the brand's files.
14. **The message-file check** (Q263, F-083). An AST check that no text or user-facing attribute bypasses `t`, every key used, and a pseudo-locale build checked on every route; next-intl stays unneeded while one language ships (ADR 0007's line is left as is until a second language comes).
15. **What a runner one minor older gets** (Q264, section 5.1). OpenCode tasks only; it reports no agents.
16. **How subagents show** (Q265, section 4). An optional `parentToolCallId` on `tool.called`, `agent.message`, `agent.thought` and `plan.updated`, read by an adapter that knows its agent's stamp; nested and collapsed on the task page; a subagent's plan never replaces the task's; flat for an agent that doesn't say.
17. **Claude Code on a `host` machine with a managed policy** (Q267, ADR 0062). Such a policy outranks every setting ostra writes, so the runner reports Claude Code `failed: unsupported` there, with the reason, and never runs it differently from a box. Raised by the spec's review.

---

## 13. Screens that need a design target

`build-order.md`: a milestone's screens are designed first, image first. The maintainer requires the `ui-taste` skill and Higgsfield targets, approved before building, against `context/brand/brief.md` and `context/brand/app-design.md`. **This spec names them; ticket 12 makes them,** in the form milestones 1 to 6's approved targets have (`context/brand/app-targets/m1/README.md`: a picture, a build spec and a prompt per screen). Until they're approved (recorded in ticket 12's `## Comments`), tickets 13 to 19 and 21 don't start their UI; their logic and tests can go ahead.

**New targets**, for what's new in milestone 7:

| # | Target | Screen | Feature | Starts from |
|---|---|---|---|---|
| 1 | `docs-home` | The docs site's landing: what ostra is (source-available, self-hosted), the 30-minute path as three steps, "Before you start", the sections as a grid, the version, search, the header with the logo and GitHub link, dark and light | F-058 | `app-targets/m1/home` |
| 2 | `docs-guide` | A guide page (the install guide): the left navigation by section, the page's steps with numbered headings, code blocks with copy and a "run" marker, callouts (note, warning, "not isolated"), "on this page", previous and next, "edit on GitHub", at desktop and phone width | F-058, F-076 | `app-targets/m1/environment` |
| 3 | `docs-reference` | The configuration reference: settings grouped as `docs/configuration.md` groups them, each with its name, default, what it does and where it's read (server or runner), a filter box, anchors to copy | F-058 | `app-targets/m4/audit-log` |
| 4 | `docs-search` | The docs' search dialog: results by page and heading, the keyboard hints, the empty state | F-058 | `app-targets/m4/search-palette` |
| 5 | `command-palette` | ⌘K with actions: the groups (actions for this page, go to, search results), each action with its shortcut, an action that needs a choice (approve which item, reopen with a message) as a second step, the role-hidden state, at phone width as a sheet | F-081 | `app-targets/m4/search-palette` |
| 6 | `shortcut-sheet` | The `?` sheet: every shortcut by scope (anywhere, a needs-you item, a task), the two-key sequences shown as such, a link to the palette, closed with Escape | F-081 | `app-targets/m4/search-palette` |
| 7 | `agent-profile-claude-code` | The agent profile editor with Claude Code chosen: the agent picker with both agents, the model list filtered to Anthropic-format providers with the others listed apart and why, what Claude Code declares (and the one difference, "the repo's own Claude settings are set aside for each task"), its options ("strip pre-release API features" with when to use it), and on which runners it's ready | F-018 | `app-targets/m3/agent-profile` |
| 8 | `runner-agents` | A runner's page, its agents section: each agent with its version and state (ready, preparing with its progress line, failed with the reason and "Try again", available with "Prepare now"), the agent image's digest on `docker` and `kubernetes`, the license note for Claude Code ("downloaded from npm under Anthropic's terms") | F-018 | `app-targets/m5/runner` |
| 9 | `task-subagent` | The task page with a Claude Code session: a subagent's calls nested under the call that started it, collapsed with a count and expandable, the agent's badge in the header, a "Preparing Claude Code on this runner" waiting state | F-018, F-023 | `app-targets/m1/task` |
| 10 | `account-appearance` | Account, "Appearance": dark, light and match my system as three previews, the current one selected, the keyboard shortcuts' link | F-082, F-081 | `app-targets/m3/account` |
| 11 | `light-home` | Home in the light theme: the brand's light tokens on milestone 3's Home, the needs-you rows, the sidebar | F-082 | `app-targets/m1/home` |
| 12 | `light-task` | The task page in the light theme: the thread, tool calls, the diff's colors, an approval card | F-082 | `app-targets/m1/task` |

**Screens that only grow**, built against their existing targets with the changes listed in the ticket that builds them:
- `app-targets/m3/agent-profiles`: the agent column, with Claude Code's mark; a profile whose model's provider isn't in Anthropic's format marked as needing a change.
- `app-targets/m1/models`: each provider's format shown, and "Claude Code can use this provider" on an Anthropic-format one.
- `app-targets/m1/task-new` and `app-targets/m2/inbox`: the profile picker shows each profile's agent.
- `app-targets/m5/runner` and `app-targets/m1/runners`: an agent count per runner and "Preparing" in the list (the section itself is `runner-agents`).
- `app-targets/m2/home-first-run`: the checklist's links to the docs' matching pages, and Linear's step skippable.
- `app-targets/m4/instance-settings`: the version, the license line ("source-available"), and the docs' address.
- `app-targets/m3/needs-you` and `app-targets/m3/phone-approval`: each item's shortcut hint at desktop width, none on a phone.
- The sidebar (`app-targets/m1/README.md`'s shell): "Docs" in the help menu, the theme's quick toggle, and `?` for the sheet.
- Every screen of milestones 1 to 6 in the light theme follows `light-home` and `light-task`'s rules and gets no picture of its own; ticket 18 lists any screen whose light rendering needs a decision the two targets don't settle, and adds a target for it before building it.
