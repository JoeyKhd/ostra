# Milestone 7: Launch

**Status:** spec, 2026-11-19. Tickets in `issues/`, one file each (`docs/agents/issue-tracker.md`). **Changed 2026-11-19, on the maintainer's word:** "I think we agreed to only use Open Code, which is perfectly fine. So perhaps we can just skip Claude Code with its ACP for now." Claude Code (F-018) moves after v1, so this milestone is the launch alone, on OpenCode. The tickets that existed only for Claude Code are `wontfix` until F-018 is built, with their text kept for then; the mixed ones keep only their launch parts. The spec as first written, with Claude Code in it, is `git show 79f49c4:context/specs/m7-launch/spec.md`.
**Milestone:** 7 (`context/build-order.md`).
**Features:** F-058, F-081, F-076 (complete, measured), F-117 (the load test as the gate), and the final check of F-075, F-082 and F-083. Plus two pieces of work that aren't ledger rows: the security review of the box, and publishing (ADR 0045). It finishes F-039, which milestone 5 left `building` until the images are published. F-033's "with another agent", which milestones 2 and 4 left for a second agent, waits with F-018 after v1 (F-033's note). Its demo signs in as milestone 1's default first admin on this machine, and as a newcomer would on the Linux machine.
**Decisions it builds on:** ADR 0007 (the stack), 0018 (ACP is the agent interface), 0021 (no telemetry), 0022 (versions), 0025 (everything is an adapter), 0029 (executors and the allowed differences), 0030 (no credential in the agent's container), 0031 (the safety minimum), 0032 (OpenCode, ostra's own driver, one agent at launch), 0033 (either API format), 0045 (layout, licenses, publishing), 0046 (one CLI, three images), 0048 (source-available; the CLA), 0049 (declared capabilities; repo config hidden), 0061 (proofs on other machines; the load test). **New for this spec:** ADR 0063 (the docs site), 0064 (the launch gates and the release), and amendments to 0007 (two entries confirmed), 0045 and 0061 (the gate's run). ADR 0062 (Claude Code over ACP, on keys), ADR 0007's third entry, and the amendments to 0032 and 0046 for agents ostra doesn't redistribute were written for this spec too; they're postponed or withdrawn with F-018 (2026-11-19).
**Research it rests on:** none new. `research/claude-code-acp.md` was written for this spec's Claude Code half, and stays for F-018.
**Builds on milestones 1 to 6** as they were built, not only as they were specified. Milestone 1 is done; 2 and 3 are being built; 4, 5 and 6 are specced. Where their code ends up different from their specs, this spec follows the code, and the ticket that meets the difference says so in its `## Comments`. Where this spec names something an earlier milestone owns (milestone 5's images and load test, milestone 6's read-only kinds), it uses that milestone's words as its spec settles them.

Terms follow `context/GLOSSARY.md`. Lifecycles follow `context/domain-model.md`.

---

## 1. What milestone 7 ends with

Public v1, on OpenCode. A team new to ostra goes from `docker compose up` to its first agent-made PR in under 30 minutes, following only the docs (`build-order.md`).

In more words: a member reaches every core action from the keyboard, sees the panel in dark, light or the system's choice, and uses the "needs you" moments on a phone; every string is in a message file. The docs site has the install guide, the configuration reference, the runner guide and the adapter guide, and two people new to ostra each followed it to a PR in under 30 minutes. The load test held 1,000 tasks on Linux, an independent security review of the box found nothing critical or high left open, and, once the maintainer has settled the legal items and said go, one workflow publishes the npm packages, the three images and the docs. OpenCode is the one agent, as it has been since milestone 1. The interface it runs through (ostra's own ACP driver, the `AgentAdapter` base class, and the agent contract suite with its scripted fakes) is what a second agent plugs into after v1 (F-018, F-038).

### What milestones 1 to 6 leave that milestone 7 starts from

Read from the code on `main` on 2026-11-19, and from milestones 2 to 6's specs for what they add, so builders don't rebuild what exists:

- **The agent interface is ready for a second agent after v1.** `AgentAdapter` (`packages/adapter-sdk/src/agent/base.ts`) composes ostra's ACP driver through a `DriverPort`; an adapter writes its launch and its update quirks. `AgentCapabilities` declares `steerMidTurn`, `sessionLoad`, `nativePlan`, `rejectAndContinue`, `elicitationForm`, `modelBaseUrlAndPlaceholderKey`, `sessionArchive`, `permissionRules`, `planMode`, `skills`, `mcp` and `projectConfigOverride`; milestone 4 adds `memory` and milestone 6 `elicitation`. `repoConfigPaths` exists for an agent without `projectConfigOverride`. Milestone 7 adds no agent; what Claude Code would have built on is in the first version of this spec and in ADR 0062.
- **The panel has ⌘K** as a jump-to-page menu (`apps/web/src/components/shell/command-menu.tsx`), which milestone 4 grows into search (`app-targets/m4/search-palette`). It has no actions and no shortcut sheet.
- **The panel is dark only.** `layout.tsx` sets `data-theme="dark"`; `globals.css` says the light theme "is left for later". `brand/files/tokens/` holds the tokens.
- **Every string is read through `t`** from `apps/web/messages/en.json` (`apps/web/src/lib/messages.ts`); a missing key fails the typecheck. Nothing checks that no literal text slips past `t`, and next-intl isn't installed (ADR 0007 names it; milestone 1 built its own `t`).
- **`docs/configuration.md` is tested** against every schema that reads a setting (`packages/domain/src/settings.test.ts`). `docs/development.md` and `docs/agents/` exist. There's no `apps/docs`.
- **Setup in the panel** is milestone 1's checklist (F-076 `building`; its second condition, the measure, waits for ticket 25).
- **Milestone 5 leaves** the load test's harness and this machine's ramp (F-117 `building`), the three images built in the Linux proof job but never published (F-039 `building`), the snapshot builder on `docker` and BuildKit with the registry on `kubernetes`, the runner's report of its capabilities, the manual `proof.yml` jobs on `ubuntu-24.04` and `macos-15` (ADR 0061).
- **Milestone 6 leaves** protocol minor 5, the read-only refine and review kinds, automatic turns with the neutral reply to an ACP elicitation, and `submit_draft`, `submit_review` and `propose_environment` on the sidecar's MCP server.
- **The maintainer's legal items are settled** (2026-11-19, ADR 0048): the contributor agreement is in `CONTRIBUTING.md` with its pull request check (Q109), the licensor line stays as it is (Q110), and no lawyer's review is waited for. **The names are open** (Q80, Q82: the npm scope, the CLI's package name, the image namespace). `build-order.md`'s "Outside the code" lists them.

### What is in, and what is not

**In:** the agent contract suite run on every adapter by name, with its new cases and the parity test, on OpenCode and the scripted fakes; the docs site, built static and published on GitHub Pages; the command palette's actions and the shortcut sheet; a keyboard and contrast check on every screen; the light theme and each member's choice; the phone sweep; the message-file check with a pseudo-locale; setup's last pieces and its timeline; the 30-minute measure, twice; the load test on the release candidate, on Linux; the security review of the box with its adversarial run; `SECURITY.md`, `CONTRIBUTING.md` and the third-party notices; the release workflow with its dry run; and, after the maintainer's go, the release.

**Not in** (and when it comes):
- Claude Code on keys: F-018, after v1 (moved out of this milestone on 2026-11-19). Its adapter, installing agents on runners and building agent images, its profiles, its subagents on the task page, reopening a task on another agent, and its proof jobs are this spec's `wontfix` tickets (section 8), kept for then
- Codex on keys: F-038, right after v1. Copilot CLI, Cursor CLI and the rest: F-022, later
- a Claude subscription login, anywhere: never (Q45, Q47)
- providers that sign each request (Bedrock, Vertex): F-130, after v1
- other languages than English: v1 ships the message files and the pseudo-locale that proves a new file is enough (F-083)
- signed runner binaries: F-085, after v1
- a hosted version: not planned (2026-11-19). ostra is an app people host themselves (ADR 0001, amended)
- a lawyer's review of the license, the licensor line or the contributor agreement: the maintainer's choice, and not a gate (ADR 0048, amended 2026-11-19)

### On this machine

The same adjustment as milestones 1 to 6: the demo's first part runs here on the `host` executor, where a "box" is a worktree. What needs more than that:
- **Linux with Docker:** `docker compose up`, which is the measure's first command (F-076), the adversarial run in a box, the images' last checks before they're published (F-039). In the manual `proof.yml` jobs on `ubuntu-24.04` (ADR 0061), with no secret, and, for the measure and the second part of the demo, on the maintainer's Linux machine with the test workspaces' credentials.
- **A machine of at least 16 vCPUs and 32 GB on Linux:** the load test's run that counts (F-117), the maintainer's (ADR 0061, ADR 0064).
- **Kubernetes:** the adversarial run's kind half (ticket 28), in the kind job of `proof.yml`. No row of this milestone waits on it alone.
- **macOS:** nothing of this milestone is specific to it.
- **This Windows machine, as it is:** the palette's shortcut here is Ctrl+K. The adversarial run's `host` half runs here only with attempts that are safe by construction (ticket 28), and its Linux-only attempts (`/proc/*/environ`, `docker`, `kubectl`) are reported "not applicable on Windows", never as passed.
- **People:** the two newcomers of the measure, the names the maintainer registers, the maintainer's yes to two dependencies, and the go.

---

## 2. The features, and where each one lives

"At M7's end" is the ledger status the demo ticket (32) sets, if and only if every condition in the row's "done when" holds.

| F-ID | What milestone 7 builds | Packages | Tickets | At M7's end |
|---|---|---|---|---|
| F-058 Docs site | `apps/docs` on Fumadocs (or its fallback), built static, on GitHub Pages from `docs.yml`; the self-hosting guide, the configuration reference rendered from `docs/configuration.md`, the runner guide, the adapter guide; every `run` command block checked in the proof job (ADR 0063) | `apps/docs` (new), `docs/`, `.github/workflows/docs.yml` (new), `scripts/` | 21, 22, 23 | done, if the site is published at its address; otherwise `building` with the built site's proof |
| F-081 Keyboard and accessibility | The palette's actions (jump to "needs you", approve, answer, take over, reopen, and the rest of section 12, item 11), the shortcuts and the `?` sheet; a keyboard walk and a contrast check on every route, in both themes | `packages/domain`, `apps/web` | 12, 13, 16, 17, 36 | done |
| F-075 Responsive panel (final check) | Every route at 390 px with no horizontal scroll, and approve, answer and reopen done end to end at phone width | `apps/web` | 19 | done |
| F-082 Theme (final check) | The light theme from the brand tokens, and each member's choice of dark, light or "match my system" in Account, applied before first paint | `packages/db`, `packages/domain`, `packages/api`, `apps/web` | 04, 11, 12, 18, 36 | done |
| F-083 Translatable interface (final check) | A check that no text reaches the screen except through `t`, that every key is used, and a pseudo-locale build in which every visible string is the pseudo one | `apps/web`, `scripts/` | 20 | done |
| F-076 Setup in the panel (complete, measured) | The checklist's Linear step live and skippable, its links to the docs, `setup.timeline`, `pnpm measure:setup`, and the measure: two newcomers under 30 minutes on Linux (ADR 0064) | `packages/domain`, `packages/api`, `apps/web`, `scripts/`, `context/specs/m7-launch/measure/` | 24, 25, 36 | done, if both measured runs are under 30 minutes; otherwise `building` with each run's record |
| F-117 Scale-out (the gate) | The load test on the release candidate, here as a ramp and on Linux at 1,000 tasks (ADR 0061, ADR 0064) | `e2e/load`, `context/specs/m7-launch/load/` | 26 | done, if the Linux run passed; launch waits for it either way |
| F-039 Three images (finished) | Published by the release, by digest, with third-party notices (ADR 0046, ADR 0064); a new pool runner from the published runner image with one `docker run` and a join token | `deploy/`, `packages/deploy-checks`, `.github/workflows/release.yml` (new) | 29, 30, 33 | done once the release has run and the published runner joined a pool; otherwise `building` |

**Rows this spec planned and no longer builds** (2026-11-19): F-018 Claude Code, now after v1, and F-033's "with another agent", which needs a second agent and waits with it. Their rows' notes in `features.md` say so, and the tickets that held them are `wontfix` (section 8).

**Work that isn't a ledger row:**
- **The security review of the box** (ADR 0064): the threat model, the checklist with evidence, the adversarial run, the findings and their fixes, `SECURITY.md`. Tickets 27 and 28. It's a launch gate; its record is `context/specs/m7-launch/security-review.md`.
- **Publishing** (ADR 0045, ADR 0064): Changesets or its fallback, `release.yml` and its dry run, the notices, `CONTRIBUTING.md`, and the release itself after the go. Tickets 29, 30 and 33.

**Ledger text this spec amended** (2026-11-19, ADR 0062): F-039's "every v1 agent pinned" and F-021's "installing and updating the agents themselves is the base image's job" now say "every v1 agent ostra may redistribute", with an agent image or a `host` install for one it may not. With Claude Code after v1, OpenCode is the only v1 agent and the base image pins it, so no v1 agent takes that path; both rows' notes say so.

**Rows this milestone touches without finishing:** F-001 gains the measure's two `docker compose up` runs as live evidence for its first sentence; it's finished where milestone 5's Linux job left it. F-019 gains the parity test (every capability declared by OpenCode and by each scripted fake, each feature with its case) and its base-image pin in a published image.

**Built in from the first milestone** (`build-order.md`), checked again by ticket 32:
- Organization-scoped data: milestone 7 adds no organization record. Its one new column, a member's theme, is on the account (04).
- The event log and the durable queue: a theme changed is saved and audited before it's acted on (11).
- No credential in the agent's container: the adversarial run searches for every credential by value in the agent's container, on `docker` and on kind (28).
- ACP as the only way to talk to an agent: OpenCode, through ostra's own driver, as since milestone 1. Milestone 7 adds no agent.
- Strict typing, dark first, responsive, English text in message files: the final checks of this milestone (17 to 20).

---

## 3. The end-to-end demo

Ticket 32 runs it and records the result under its `## Comments` and in `demo.md` next to this spec. Everything runs against the Linear workspace `ostra-test` (team `OST`) and the GitHub org `ostra-test` (repos `test1` and `test2`). Secrets come from `~/.config/ostra-dev/` with `set -a; . ~/.config/ostra-dev/<file>; set +a`, and are never printed, logged or committed.

**Two parts, two machines.** Part A runs here, scripted (`pnpm e2e:m7`) and once by hand: a fresh install from source, the docs' pages for it followed, OpenCode on real tickets. Part B runs once on the maintainer's Linux machine: `docker compose up` from the published-to-be images, following only the install guide, with OpenCode in boxes. The measure (ticket 25) and the load test (ticket 26) are their own runs; part B can be the maintainer's own rehearsal of the measure, but never one of its two counted runs.

**On OpenCode alone** (changed 2026-11-19). The demo runs on `model.env`'s provider, as milestones 1 to 6 did. The Anthropic-format endpoint this section first planned for Claude Code (Q253) waits with F-018. Steps 1, 2 and 10 were Claude Code's and are withdrawn; the other steps keep their numbers, which the tickets and the screen targets cite.

### Part A: here, from source

**Before:** a fresh clone, `pnpm install`, `pnpm dev:reset`, `tunnel.env` loaded, `pnpm dev`. The docs site built locally (`pnpm --filter @ostra/docs build`) and its "Run ostra from source" and "Personal runners" pages followed for what they cover. Milestones 1 to 6's helpers do the rest: a model provider from `model.env`, the test App, the Linear connection, projects `test1` and `test2`, a personal runner on `host`, the maintainer's GitHub user linked to Demo. The panel signs in as `demo@demo.com` / `demo`; the scripted run sets `OSTRA_ALLOW_DEFAULT_PASSWORD=true`.

1. *Withdrawn 2026-11-19 with F-018: a Claude Code profile.*
2. *Withdrawn 2026-11-19 with F-018: preparing Claude Code on the runner.*
3. **Two Linear tickets, worked by OpenCode.** The script creates two tickets in `OST`: "Add `docs/agents.md` listing the agents this repo has been worked by, with today's date" and "Add a `CONTRIBUTORS` line for ostra". Demo starts both from `test1`'s Inbox on milestone 3's built-in OpenCode profile. Both sessions stream in their task pages at once, each thread showing OpenCode's plan, mapped from its todo list. Both open PRs on `test1`, each linked on its ticket, each opened by the App with Demo as co-author. The key proxy counted every call of both, and each task's spend shows its four kinds of token.
4. **No credential.** The real key's value appears in no log, event or file of the task (searched by value, never printed). The agent's launch environment is exactly OpenCode's allowlist, with the placeholder key and the proxy's address, and nothing of the runner's own environment (the suite's environment case, ticket 03, on the release candidate).
5. **Stepping in.** On a third ticket on the OpenCode profile, with plan first on for the run: the plan arrives as a needs-you item; Demo approves it. The agent asks to run `npm install`: the approval card shows it; Demo denies it with a reason, and the turn is re-prompted with the reason, since OpenCode declares no `rejectAndContinue`, and the card says so. Mid-turn, Demo sends "also add a trailing newline": it steers the running turn. Demo stops the task, then reopens it a minute later with "carry on": it resumes on the same worktree from OpenCode's own session; then Demo reopens it on a fresh worktree, and it resumes from the archive. An approval answered "Allow for this task" during the run holds for the rest of the task, and nothing of it reaches the commit.
6. **Memory, review and the read-only kinds, on the release candidate.** `test1`'s Review profile (milestone 6) reviews the PR of step 3's first ticket: one `COMMENT` review on GitHub, findings on their lines. A refine task on a fourth ticket reads the code, pushes nothing, and hands in a draft through `submit_draft`. Step 3's second task, reopened with "remember that `CONTRIBUTORS` lines are sorted", proposes a memory note through `memory_propose`, which appears in `test1`'s proposals.
7. **The keyboard, the theme and the phone.** In one browser, with the keyboard only: Ctrl+K (⌘K on a Mac), "needs you", Enter, the approval from step 5's next rule, approved with its shortcut; Ctrl+K, "reopen", the stopped task, a message, sent. `?` shows the shortcut sheet. Account, Appearance: "Light"; the panel repaints and stays light after a reload, with no dark flash; "Match my system" follows the browser's emulated scheme. At 390 px, the same approval and a reopen are done by touch.
8. **The docs, as published.** `docs.yml`'s dry run builds the site; the built site's install guide, configuration reference, runner guide and adapter guide are each opened, and the configuration reference lists every setting `packages/domain`'s settings test knows. With the maintainer's go (ticket 33) it's the live site instead.

### Part B: on Linux, from the images

**Before:** the maintainer's Linux machine with Docker, the release candidate's images built by `pnpm images:build`, the test workspaces' env files copied by the maintainer into `~/.config/ostra-dev/` there (ticket 34, step 6). The docs site's install guide, open in a browser.

9. **`docker compose up`, by the guide.** Every step the guide gives, and nothing else: the compose file, the required settings, the first sign-in with its forced password change, the checklist. The server, Postgres and the pool runner on `docker` come up.
10. *Withdrawn 2026-11-19 with F-018: Claude Code's agent image.*
11. **A task in a box.** Step 3's first ticket again, in its own box on the pool: the agent container's environment holds only the placeholder and the sidecar's address, and the PR opens on `test1`.

**The checks after the run** (ticket 32 scripts what it can, in `e2e/m7-launch/`):
- **Nothing leaked.** The model key, the GitHub tokens, the task tokens and the MCP bearers appear in no log line, event, worktree or process command line (searched by value, never printed).
- **Parity holds.** The parity test (ticket 03) passes: every capability is declared by OpenCode and by each scripted fake, and every feature of section 6 has its case on each, or its declared capability and the fallback ostra takes.
- **The agent suite passes** on OpenCode, on the stub model, and on the live endpoint.
- **Keyboard and contrast.** Ticket 17's walk passes on every route in both themes.
- **Clean-up:** the demo's tickets archived in `OST`, its PRs closed, branches and hidden refs deleted, in `test1` and `test2` only.

---

## 4. How it fits together in milestone 7

```
 browser ──▶ apps/web: the palette's actions, the shortcut sheet, Appearance, the light theme
                │
                ▼
             packages/api ──▶ Postgres: a member's theme; setup.timeline from the audit entries
                │
 apps/core and the runner: as milestone 6 left them, on protocol minor 5
   └─ the task: OpenCode ──ACP stdio──▶ ostra's driver ──▶ TaskEvents, as in milestones 1 to 6
 docs: apps/docs ──static export──▶ GitHub Pages (docs.yml, by hand and on a release)
 release: release.yml (by hand) ──▶ npm (trusted publishing) · images by digest · GitHub release
```

**The flows** (a Claude Code task's launch, preparing an agent on a runner, choosing a runner by its agents, and Claude Code's subagents wait with F-018; the first version of this spec has them):
- **The theme.** A member's choice is saved on their account and set in a cookie; the root layout reads the cookie on the server and sets `data-theme` before first paint (`system` sets none and lets the CSS media query decide). The tokens for `light` are the brand's.
- **The palette's actions.** The palette's sources are the destinations (milestone 1), search (milestone 4), and, new, actions: each a typed command with an ID, its words, its shortcut, the condition under which it's offered (the page, the member's role, the item in focus) and the tRPC call it makes. The same registry drives the shortcuts and the `?` sheet, so a shortcut can't exist without its sheet line.
- **Setup's timeline.** `setup.timeline` (instance admin only) reads the audit entries of the setup steps and the first PR's event for the first organization and returns each step's time; `pnpm measure:setup` prints them against the time the person wrote down for the first command.
- **The docs.** `apps/docs` reads `docs/configuration.md` and the other `docs/` pages at build time, and its own MDX pages; `next build` with `output: "export"` writes the static site; `docs.yml` uploads it to GitHub Pages.
- **The release.** `release.yml` (by hand): every check, the images built, checked and pushed by digest, the npm packages published through trusted publishing with provenance, the GitHub release, then `docs.yml`. With `dry-run: true` it pushes to a `registry:2` inside the job and runs `npm publish --dry-run`.

---

## 5. The contracts

Every contract change in milestone 7 is **additive**: a new optional field, a new union member, a new endpoint, a new table, column or enum value. Nothing is renamed or dropped (`AGENTS.md`). Each lands as one small commit that names the contract and updates every caller in the same commit. Tickets 03, 04 and 36 make them first, each with the fakes its callers test against; everything else builds on them.

### 5.1 `packages/protocol`: none in milestone 7 (ticket 01, `wontfix`)

Minor 6 existed for Claude Code: a runner's agents and their `agent.*` events, the `agent.prepare` command, the `agent-missing` decline, `parentToolCallId` for subagents, and an agent's options in the task spec. It waits with F-018 (2026-11-19), so milestone 7 changes no wire shape and runners stay on milestone 6's minor. Q264, what a runner one minor older gets, waits with it.

### 5.2 `packages/adapter-sdk` (ticket 03)

**`AgentAdapter`** gains nothing in milestone 7. Options, requirements, installs, the plan operations in the shared mapping, the subagent parent, and the fakes for them (ticket 02) were Claude Code's, and wait with F-018.

**The suites and parity** (ticket 03):
- **The agent contract suite runs on every shipped adapter by name:** `runAgentSuite(adapter, { model: "stub" | "live" })`, so the same cases run on OpenCode and on the scripted fakes, and a second agent later runs them by passing its adapter. A case an adapter's capability rules out runs its declared fallback instead and checks that.
- **New cases:** an unknown notification after `initialize` is tolerated (a fake that sends one, added here); a turn's every model call reaches the key proxy and nothing else (the stub endpoint counts them); the proxy's count equals the agent's own reported usage for the calls it closed (F-089's "within 2%"); the environment of the launch is exactly the adapter's allowlist; a repo's agent config files named in `repoConfigPaths` are hidden for the task and restored byte for byte (on a fake that declares no `projectConfigOverride`); "allow for this task" holds for the rest of the task and nothing of it reaches the commit; a ticket whose text starts with `/` is never run as a slash command (ostra's prompt never starts with ticket text); the binary's checksum mismatch refuses the launch.
- **The parity test** (`src/testing/parity.test.ts`): for every shipped agent adapter and each scripted fake, every key of `AgentCapabilities` is declared (the type already forces it) and every feature of section 6's table names the case that proves it on that adapter, or the capability it's declared under and the fallback case. A new feature that touches agents adds its row there, and a new agent its entry.

### 5.3 `packages/db`: the milestone 7 migration (ticket 04)

One new migration, after milestone 6's, additive only.

| Change | What |
|---|---|
| The account (better-auth's user row, ostra's columns) | + `theme` (`ThemePreference`: `dark`, `light`, `system`; default `dark`) |
| Enums | New `ThemePreference`. The audit actions gain `account.theme_changed` |

The migration backfills nothing: every member's theme starts dark. `AgentProfile.agentOptions`, `AgentImage`, `Runner.agents`, `AgentImageState` and the audit actions `agent.prepared` and `agent.prepare_failed` were Claude Code's, and wait with F-018 (2026-11-19).

### 5.4 `packages/domain` (ticket 36)

- **The agent catalog, a profile's format check, the lifecycles of an agent on a runner and of an agent image, and admission by agent** (ticket 05) were Claude Code's, and wait with F-018 (2026-11-19).
- **The palette's actions and shortcuts** (ticket 36, with setup's timeline and the theme): the registry's type (`PaletteAction`: ID, message key, shortcut or none, scope, role, the procedure it calls), so the API checks the same conditions the panel offers.
- **Setup's timeline:** `setupTimeline(organizationId)`, pure over the audit entries and the first PR's event.
- **Use-case signatures:** `setTheme`, `setupTimeline`.
- **Settings, new,** each with a working default and its line in `docs/configuration.md` (the four runner settings for preparing agents, `OSTRA_AGENTS_DIR`, `OSTRA_NPM_REGISTRY`, `OSTRA_AGENT_PREPARE` and `OSTRA_AGENT_IMAGE_CLAUDE_CODE`, wait with F-018):

| Setting | Default |
|---|---|
| `OSTRA_DOCS_URL` (server) | the docs site's address, which the panel's help links use |
| `OSTRA_PSEUDO_LOCALE` (web, development and test only) | unset: English; `1` builds the pseudo-locale (ticket 20). Ignored in production |

---

## 6. Adapter parity: every agent-touching feature, through the interface

`AGENTS.md`: a feature that touches agents works through the shared interface for every shipped adapter, or the interface declares it an optional capability and each adapter states whether it has it. At launch the one shipped adapter is OpenCode, so this is every such feature of milestones 1 to 6, what OpenCode does for it, and the agent suite's case that proves it (ticket 03). The scripted fakes declare what OpenCode lacks, so each fallback is tested too. The table's Claude Code column waits with F-018 (2026-11-19); it's in the first version of this spec and in ADR 0062's table, and comes back when a second agent does.

| Feature (milestone) | What it asks of the agent | OpenCode | Proved by |
|---|---|---|---|
| F-023 Live activity (1) | ACP updates mapped to ostra's events: text, thinking, tool calls with raw input and output, plans, usage | yes | the suite's mapping cases |
| F-025 Stop (1) | `session/cancel` ends the turn `cancelled` | yes | the stop case |
| F-089 Key proxy (1) | a base URL and a placeholder key (`modelBaseUrlAndPlaceholderKey`); a count within 2% of the agent's own usage | yes | the every-call-at-the-proxy case; the usage-match case |
| F-090 Git proxy (1) | the agent's own `git` through the proxy | yes | the push-and-refuse cases |
| F-016, F-098 Workspace, several repos (1, 4) | the agent at the workspace root, repos side by side | yes | the two-repo case |
| F-030 Open the PR (1) | ostra's MCP tool `set_pull_request_text` | yes | the MCP tools case |
| F-078 Repo conventions (1) | the repo's `AGENTS.md` read natively | yes | the instructions case |
| F-064 Ticket context (2) | the ticket's files in the config folder, images as files | yes | the context-files case |
| F-032, F-033, F-096 Reopen anywhere, after every turn (2) | `sessionLoad` in place; `sessionArchive` to a fresh box | yes, yes | the load and archive cases; the rebuild template as the fallback |
| F-047 Agent crashes (2) | a killed agent's session marked crashed, resumable | yes | the kill case |
| F-021 Agent profiles (3) | instructions beside the repo's, `skills`, `mcp`, `permissionRules`, `projectConfigOverride` | instructions, skills, MCP, rules native, override as milestone 3 left them | the profile cases; the repo-config case (on a fake without `projectConfigOverride`) |
| F-024 Steer (3) | `steerMidTurn` | yes | the steer probe on every bump |
| F-026 Approvals (3) | permission requests; `rejectAndContinue`; "allow for this task" | yes; no (re-prompt); task-scoped | the approval and deny cases; the allow-for-this-task case |
| F-063 Plan first (3) | `planMode`, `nativePlan` | as milestone 3 left it; todo list mapped | the plan-turn cases |
| Questions (3, F-062) | `elicitationForm` | yes | the question case |
| F-084, F-037 Usage, budgets (3, 4) | the key proxy counts; every call on the profile's model | — | the every-call case |
| F-070, F-053, F-054, F-035, F-105 Update branch, `@ostra`, checks before the PR, failing CI, changes requested (3, 6) | a new turn with a prompt | yes | the turn case |
| F-068 Runaway protection (2) | agent events to reset the stall clock; the spend cap at the key proxy | yes | the stall and cap cases |
| F-110, F-111 Memory (4) | `memory`; the agent's own memory off | `mcp`; has none | the memory cases |
| F-014, F-015, F-093 Runners, pools, `kubernetes` (5) | the agent present on the runner or in the box, behaving as in a box | bundled, in the base image | the runner's tests; the Linux and kind jobs |
| F-039 Three images (5) | the base image pins every v1 agent | yes | `pnpm check:images` |
| F-116 Egress baseline (5) | no traffic of the agent's own beyond the proxies | yes | the network case in the Linux job |
| F-099, F-100 Refine, review (6) | read-only: the git proxy's mode, the profile's rules, the kind's tools only | yes (milestone 6's ticket 09 maps them to OpenCode's config) | the read-only and tools cases |
| F-012 Start from Linear (6) | the task's events as Linear agent activities | yes | the agent-mode case |
| F-101 Automatic turns (6) | `elicitation`: a question answered with the neutral reply | yes | the automatic-turn case |
| F-113 Onboarding (6) | `propose_environment`; `commitPaths` | yes | the proposal and commit cases |

**What OpenCode lacks** stays as milestones 1 to 6 declared it, and the scripted fakes that declare those capabilities keep both paths tested. F-033's "with another agent" has no row: it needs a second agent, and waits with F-018. No feature works only on OpenCode without its capability declared.

---

## 7. Packages, licenses and owners

| Package | License | New in M7 | Built by |
|---|---|---|---|
| `packages/adapter-sdk` | Apache-2.0 | the suite by adapter; the new cases; the parity test; one new fake | adapters (03) |
| `packages/adapters/adapter-opencode` | Apache-2.0 | its suite called by name | adapters (03) |
| `packages/db` | Sustainable Use | the M7 migration | core (04) |
| `packages/domain` | Sustainable Use | the palette's type, setup's timeline, the theme, `OSTRA_DOCS_URL` | core (36) |
| `packages/api` | Sustainable Use | the theme, `setup.timeline` | api (11, 24) |
| `apps/web` | Sustainable Use | the M7 screens and the final checks | web (13, 16 to 20) |
| `apps/docs` (new) | Apache-2.0 | the docs site | web (21), with core and adapters writing pages (22, 23) |
| `e2e/m7-launch`, `e2e/load` | Sustainable Use | the demo; the gate's run | core (26, 32) |
| `deploy/`, `packages/deploy-checks` | as milestone 5 left them | third-party notices | runner (29) |

`packages/protocol`'s minor 6, `packages/adapters/adapter-claude-code`, the runner's agent installs, the executors' agent images, core's agent preparation and `packages/task-view`'s nested subagent calls wait with F-018 (2026-11-19).

The license line holds (ADR 0045, ADR 0048): no Apache-2.0 package depends on a Sustainable Use one. `apps/docs` reads `docs/configuration.md` as a file. `pnpm check:licenses` runs on every commit.

---

## 8. The builders and their tickets

Five builders, as before: **core**, **runner**, **web**, **api** and **adapters**. Core and adapters make the contracts first (03, 04 and 36), each with the fakes its callers need. Ticket 27's review is written by a session that built none of the box (ADR 0064). Tickets 25, 33 and 34 need the maintainer or people the maintainer picks. The tickets marked `wontfix` existed only for Claude Code and wait for F-018 after v1 (2026-11-19); their files stay as written.

| # | Ticket | Builder | Blocked by |
|---|---|---|---|
| 01 | Protocol: minor 6 (`wontfix`: F-018) | core | — |
| 02 | Adapter SDK: options, requirements, installs and the subagent parent (`wontfix`: F-018) | adapters | — |
| 03 | Adapter SDK: the suite by adapter, the new cases, and the parity test | adapters | none |
| 04 | DB: the milestone 7 migration | core | none |
| 05 | Domain: the agent catalog, profiles and admission by agent (`wontfix`: F-018) | core | — |
| 06 | Claude Code adapter: the package, its pins, its launch and its environment (`wontfix`: F-018) | adapters | — |
| 07 | Claude Code adapter: the agent suite on the real Claude Code (`wontfix`: F-018) | adapters | — |
| 08 | Runner: installing agents on `host` and reporting them (`wontfix`: F-018) | runner | — |
| 09 | Core: preparing agents, agent images and choosing a runner by agent (`wontfix`: F-018) | core | — |
| 10 | Runner: Claude Code's calls at the key proxy (`wontfix`: F-018) | runner | — |
| 11 | API: the theme | api | 36 |
| 12 | Milestone 7 screen targets | web | none |
| 13 | Web: the palette's actions and the shortcut sheet | web | 12, 36 |
| 14 | Web: Claude Code in agent profiles, models and runners (`wontfix`: F-018) | web | — |
| 15 | Web: nested subagent calls on the task page (`wontfix`: F-018) | web | — |
| 16 | Web: keyboard paths for the core actions | web | 13 |
| 17 | Web: the keyboard walk and the contrast check on every screen | web | 16, 18 |
| 18 | Web: the light theme and Appearance | web | 11, 12 |
| 19 | Web: the phone sweep | web | 12 |
| 20 | Web: the message-file check and the pseudo-locale | web | none |
| 21 | Docs: the site, its build and `docs.yml` | web | 12, ticket 34's yes or the fallback |
| 22 | Docs: install, setup and runners, with checked commands | core | 21 |
| 23 | Docs: agents, using ostra, security, reference and the adapter guide | adapters | 21 |
| 24 | Setup in the panel: the last pieces and its timeline | api | 36 |
| 25 | The 30-minute measure | core (lead), with two newcomers | 22, 24, 29 |
| 26 | The load test as the gate | core | none (milestone 5's harness, on the release candidate) |
| 27 | Security review: the threat model, the checklist and the findings | an independent session (core assigns) | 28, 29 |
| 28 | Security review: the adversarial run | runner | none |
| 29 | Images: third-party notices | runner | none |
| 30 | Release: versions, `release.yml` and its dry run, `SECURITY.md`, `CONTRIBUTING.md` | core | 29, ticket 34's yes or the fallback |
| 31 | Proof jobs: Claude Code on Linux, kind and macOS (`wontfix`: F-018) | runner | — |
| 32 | The end-to-end demo and the ledger | core (lead) | 03, 04, 11, 13, 16 to 24, 36 |
| 33 | The launch: the release run, after the go | maintainer, with core | 25 to 30, 32, 36, ticket 34's names and go |
| 34 | The maintainer's steps outside the code | maintainer | none for the decisions |
| 35 | Runner: agent images on `docker` and `kubernetes` (`wontfix`: F-018) | runner | — |
| 36 | Domain: the palette's actions, setup's timeline, the theme and the docs' address | core | 04 |
| 37 | Reopening a task on another agent (F-033) (`wontfix`: F-018) | core | — |
| 38 | Claude Code adapter: its config files, the task kinds, the repo's config and sessions (`wontfix`: F-018) | adapters | — |

**Who starts when.** core takes 04 at once, then 36; adapters take 03 at once; runner takes 29 and 28 at once. web takes 12 and 20 at once; its screen tickets wait for the targets' approval (section 13), which ticket 12 recorded on 2026-11-19. The docs (21 to 23) start once 12's docs targets are approved; their words can be drafted before. The gates (25 to 28) start once their parts are in. Milestones 2 to 6's tickets come first wherever both touch a file: a milestone 7 ticket that meets an earlier milestone's ticket still open on the same package waits for it, and says so in its `## Comments`.

---

## 9. Test seams

Agreed here so builders don't each invent one.

- **Postgres:** milestone 1's helper, a database per test file.
- **The model:** milestone 1's stub model endpoint, scripted per request, counting every call by path so the suite can assert where every call went. The live cases run against the `OSTRA_DEV_MODEL_*` provider, only when loaded.
- **The browser:** Playwright, as milestone 1's e2e stack: the keyboard walk and the contrast check on the production build, in both themes, at 1440 px and 390 px; the browser's emulated `prefers-color-scheme` for "match my system".
- **The hostile repo:** a fixture repo in the fake git upstream (ticket 28) with an `opencode.json` command, a `package.json` `postinstall`, and a `.claude/` folder (a `settings.json` hook, an agent and a skill) that OpenCode must not pick up (its Claude Code compatibility is off: `OPENCODE_DISABLE_CLAUDE_CODE`, ADR 0032), each of which would write a marker or call a canary address if it ran.
- **Text that is data:** every prompt test feeds ticket text holding shell syntax and instructions, and asserts none reaches a log line, a shell command or a process's argument list.

The seams for Claude Code itself, the fake npm registry and the agent image's builds wait with F-018 (2026-11-19).

---

## 10. Every ticket's checks and commit

As milestones 1 to 6 (`../m1-first-pr/spec.md`, section 9). In short:
- `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for the touched packages, and `pnpm check:licenses` passes.
- Tickets that touch auth, credentials, the schema, the runner protocol or anything that runs agent output (03, 04, 28, 29, 30, 32) run all the checks for the whole repo.
- Every new setting has a working default and its line in `docs/configuration.md`. A fresh install with only the required settings still works: the theme is dark, and every task behaves as in milestone 6.
- **Proof** (`AGENTS.md`; *changed 2026-11-21, the maintainer: "keep tests, drop extras"*): each condition of a row's "done when" has a test named with its key (`it("F-nnn/c1: ...")`) that exercises it through the real code path, and CI runs it. No break-it pass, no proof file. A condition only a live run shows (Linux, macOS, kind, the e2e workflow) waits for the launch-gate Proof run.
- No secret in the commit. Logs carry IDs and fields, never tokens, prompts, ticket text, an agent's environment or a path outside ostra's data folders.
- A `package.json` change goes with its `pnpm-lock.yaml`. Nothing new is added without an ADR 0007 line: the two entries of its "Milestone 7" section (Fumadocs and Changesets) were confirmed on 2026-11-19 under the maintainer's permission for that session, and each ticket that needs one adds it then. The third, Claude Code's ACP adapter, was withdrawn on 2026-11-19 with F-018. If the maintainer withdraws one, its ticket builds the fallback.
- Stage only the ticket's own paths, a gitmoji message of at most 50 characters, no AI attribution, `git pull --rebase origin main`, `git push origin main`, retrying on a rejected push.
- The ticket file gets its `Status:` updated and a line under `## Comments` with the commit's hash.

### 10.1 How each row gets proved

Each condition of a row's "done when" gets a test named with its key. This is where those tests are expected to come from; the building tickets write them, and ticket 32 checks every one. "Needs" names hardware or people this machine lacks; such a condition keeps its row `building` until it has run, with a dated note in the ledger, never a pass the run didn't show.

| F-ID | Proved by tests (kind, ticket) | Live evidence | Needs |
|---|---|---|---|
| F-058 | The configuration reference rendered from `docs/configuration.md` holds every setting the settings test knows; the four parts the row names exist as pages; the guide's `run` blocks parse (21, 22, 23) | `docs.yml`'s run log and the site's address; the proof job's run of the guide's commands | The maintainer's yes for Fumadocs (or the fallback), and Pages enabled on the repo (ticket 34) |
| F-081 | The palette's actions for "needs you", approve, answer, take over and reopen, each run from the keyboard in Playwright; every shortcut on the sheet and every sheet line a shortcut (one registry); the keyboard walk on every route and on every dialog, sheet and menu a route opens (every control reached, a visible focus, no trap, Escape closes); the contrast check on the same, in both themes, at 4.5:1 for text and 3:1 for large text and controls (13, 16, 17) | Part A step 7 | none |
| F-075 | Every route at 390 px with no horizontal scroll; approve, answer and reopen done by touch at 390 px, end to end (19) | Part A step 7 | none |
| F-082 | Dark for a new member; light and "match my system" saved per member and applied before first paint after a reload; the emulated scheme followed; the tokens' light set from `brand/files/tokens/` (18) | Part A step 7, with screenshots of both themes | none |
| F-083 | No JSX text, `aria-label`, `title`, `placeholder` or `alt` outside `t` (an AST check over `apps/web/src` and `packages/task-view`); every key in `en.json` used; an API refusal the panel shows arrives as a code the panel words through `t`; the pseudo-locale build shows no visible string that isn't pseudo on every route, error states included (20) | none | none |
| F-076 | The checklist's order and each step's tick (milestone 1's tests, kept); the Linear step skippable and ticked when connected; `setup.timeline`'s times from the audit entries (24) | Ticket 25's two measured runs, each a timeline under 30 minutes with its notes; F-076's first condition's "after `docker compose up`" from the same runs, and from milestone 1's `02-setup` and `03-first-run` specs run against `docker compose up` in the Linux proof job (ticket 22), as F-076's note asks | Linux with Docker, and two people new to ostra |
| F-117 | Milestone 5's harness tests, kept (26) | This machine's ramp on the release candidate; the Linux run at 1,000 tasks | A Linux machine of at least 16 vCPUs and 32 GB (the maintainer's) |
| F-039 (finished) | `pnpm check:images`: the pins, no secret, the notices (29) | `release.yml`'s run: each image's digest in the registry; one `docker run` of the published runner image with a join token, joining a pool on the maintainer's Linux machine (33) | The maintainer's names and go; Linux with Docker |

The rows for F-018 and F-033's "with another agent" wait with F-018 (2026-11-19).

---

## 11. What each ticket ports

Nothing, since 2026-11-19. Every row of this table was for Claude Code (tickets 06, 07, 08 and 29's agent image) or for a second agent's rates in the load test's mix (26), and waits with F-018; the first version of this spec has the table.

**Dependencies.** Two entries are confirmed for this milestone (ADR 0007, "Milestone 7", 2026-11-19, under the maintainer's permission for that session, pending their review): Fumadocs for the docs site and Changesets for versions. Each has a fallback if withdrawn. The third, Claude Code's ACP adapter, was withdrawn on 2026-11-19 with F-018. Nothing else is added: the docs' fallback renders plain Markdown with the panel's renderer and has no search (so the pages are written as Markdown that both paths render); the third-party notices come from `pnpm licenses list --json`. A ticket that finds it needs another package stops and asks, with its ADR 0007 line drafted. The keyboard walk, the contrast check, the message-file check, the pseudo-locale and the measure's script are ostra's own code on Playwright, the TypeScript compiler API and Node, already installed. `@axe-core/playwright` (MPL-2.0) was considered for the contrast check and isn't added: the check is a small computation over computed styles, and the walk covers what this milestone's row asks.

---

## 12. Choices this spec makes

The maintainer delegated every decision of this spec on 2026-11-19. Each choice below is the recommendation applied, recorded in `context/open-questions.md` under its number and, where it's hard to reverse, in an ADR. If the maintainer disagrees with one, it moves back to the open list and the ticket that holds it changes. **None of them answers Q109 or Q110**, which were settled the same day in ADR 0048. **Postponed 2026-11-19 with F-018:** choices 1 to 4 and 15 to 17 (Q250 to Q253, Q264, Q265 and Q267) were Claude Code's, and so was Q266 (whether ostra's public images may include Claude Code), which this spec opened; choices 8 and 9 lose their Claude Code halves. Their text stays for when F-018 is built.

1. *Postponed with F-018.* **How ostra runs Claude Code** (Q250, ADR 0062). `@agentclientprotocol/claude-agent-acp` 0.108.1 through ostra's own driver, launched with the runner's own Node and `--hide-claude-auth`, its binary's SHA-256 checked, `CLAUDE_CODE_EXECUTABLE` never set; `ANTHROPIC_BASE_URL` at the key proxy, the placeholder in `ANTHROPIC_API_KEY`, the profile's model in all five model variables with `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`, auto memory, telemetry, error reports, updates, nonessential traffic and prompt suggestions off; on Windows, Git Bash's path from the runner's `git`.
2. *Postponed with F-018.* **What Claude Code declares, and its repo config** (Q251, ADR 0062). Every capability but `projectConfigOverride`, each as the suite proves it; its config in the task's `CLAUDE_CONFIG_DIR`; the repo's `.claude/settings.json`, `.claude/settings.local.json` and `.mcp.json` hidden for the task; the repo's `CLAUDE.md`, `AGENTS.md` and `.claude/` skills, commands and agents left visible, with hooks, inline shell and bypass mode off in ostra's `settings.json`.
3. *Postponed with F-018.* **Where its binary comes from** (Q252, ADR 0062, ADR 0046 amended). No published image holds it until the maintainer records that the terms allow it; `host` runners install it on first need; `docker` and `kubernetes` runners build an agent image from the base image's digest, once per version. The redistribution question itself is the maintainer's.
4. *Postponed with F-018.* **The demo's endpoint** (Q253, section 3). The existing provider tested in Anthropic's format first; else a second endpoint the maintainer adds; else the stub, and F-018 stays `building`.
5. **The docs' generator and host** (Q254, ADR 0063). Fumadocs on Next.js 16, pending the maintainer's yes, with a plain-Next.js fallback; a static export on GitHub Pages; `docs.yml` by hand and on a release; Apache-2.0.
6. **What the docs hold, and one source for the reference** (Q255, ADR 0063). Eight sections, the configuration reference rendered from the tested `docs/configuration.md`, every `run` command block checked in the proof job.
7. **The 30-minute measure** (Q256, ADR 0064). Two people new to ostra, on Linux with Docker, the docs only; the clock from the guide's first command to the PR; ostra's own audit entries as the timeline; both under 30 minutes.
8. **The load test as the gate** (Q257, ADR 0064, ADR 0061 amended). The run that counts on the release candidate; launch waits for it. Claude Code's recorded rates in the mix wait with F-018.
9. **The security review of the box** (Q258, ADR 0064). Ten areas; a threat model, a checklist with evidence, and an adversarial run with a hostile repo and ticket on OpenCode (on both agents as first written; the second waits with F-018); written by a session that built none of it and signed by the maintainer; an outside test is the maintainer's choice; no open critical or high finding at launch.
10. **Publishing** (Q259, ADR 0064, ADR 0045 amended). One manual `release.yml` with a dry run; npm trusted publishing with provenance; images by digest; `1.0.0`; waiting for the legal items, the names and the maintainer's go.
11. **The palette's actions and the shortcuts** (Q260, F-081). Actions: go to "needs you", approve, deny, answer, take over, reopen, stop, steer ("message the agent"), new task, new project, toggle theme (*changed 2026-11-19: "switch organization" waits for several organizations, F-134, after v1*). Shortcuts, never with a modifier but ⌘K or Ctrl+K: `g` then `n` ("needs you"), `g` then `h` (Home), `g` then `t` (tasks), `c` (new task), `/` (search), `?` (the sheet); on a focused needs-you item `a` (approve), `d` (deny), `r` (reply or answer); on a task `o` (reopen), `t` (take over), `s` (stop, which asks to confirm). None fires while typing in a field. One registry drives the palette, the shortcuts and the sheet.
12. **How keyboard use and contrast are checked** (Q261, F-081). ostra's own Playwright walk and contrast computation on every route, both themes, two widths; no new dependency.
13. **The theme** (Q262, F-082). Account, "Appearance": dark (the default), light, match my system; saved on the account and in a cookie, applied on the server before first paint; the light tokens from the brand's files.
14. **The message-file check** (Q263, F-083). An AST check that no text or user-facing attribute bypasses `t`, every key used, and a pseudo-locale build checked on every route; next-intl stays unneeded while one language ships (ADR 0007's line is left as is until a second language comes).
15. *Postponed with F-018.* **What a runner one minor older gets** (Q264, section 5.1). OpenCode tasks only; it reports no agents.
16. *Postponed with F-018.* **How subagents show** (Q265, section 4). An optional `parentToolCallId` on `tool.called`, `agent.message`, `agent.thought` and `plan.updated`, read by an adapter that knows its agent's stamp; nested and collapsed on the task page; a subagent's plan never replaces the task's; flat for an agent that doesn't say.
17. *Postponed with F-018.* **Claude Code on a `host` machine with a managed policy** (Q267, ADR 0062). Such a policy outranks every setting ostra writes, so the runner reports Claude Code `failed: unsupported` there, with the reason, and never runs it differently from a box. Raised by the spec's review.

---

## 13. Screens that need a design target

`build-order.md`: a milestone's screens are designed first, image first. The maintainer requires the `ui-taste` skill and Higgsfield targets, approved before building, against `context/brand/brief.md` and `context/brand/app-design.md`. **This spec names them; ticket 12 makes them,** in the form milestones 1 to 6's approved targets have (`context/brand/app-targets/m1/README.md`: a picture, a build spec and a prompt per screen). Until they're approved (recorded in ticket 12's `## Comments`), tickets 13 to 19 and 21 don't start their UI; their logic and tests can go ahead.

**New targets**, for what's new in milestone 7. Targets 7, 8 and 9 were Claude Code's and are **postponed with F-018** (2026-11-19); their files stay in `app-targets/m7/` for then.

| # | Target | Screen | Feature | Starts from |
|---|---|---|---|---|
| 1 | `docs-home` | The docs site's landing: what ostra is (source-available, self-hosted), the 30-minute path as three steps, "Before you start", the sections as a grid, the version, search, the header with the logo and GitHub link, dark and light | F-058 | `app-targets/m1/home` |
| 2 | `docs-guide` | A guide page (the install guide): the left navigation by section, the page's steps with numbered headings, code blocks with copy and a "run" marker, callouts (note, warning, "not isolated"), "on this page", previous and next, "edit on GitHub", at desktop and phone width | F-058, F-076 | `app-targets/m1/environment` |
| 3 | `docs-reference` | The configuration reference: settings grouped as `docs/configuration.md` groups them, each with its name, default, what it does and where it's read (server or runner), a filter box, anchors to copy | F-058 | `app-targets/m4/audit-log` |
| 4 | `docs-search` | The docs' search dialog: results by page and heading, the keyboard hints, the empty state | F-058 | `app-targets/m4/search-palette` |
| 5 | `command-palette` | ⌘K with actions: the groups (actions for this page, go to, search results), each action with its shortcut, an action that needs a choice (approve which item, reopen with a message) as a second step, the role-hidden state, at phone width as a sheet | F-081 | `app-targets/m4/search-palette` |
| 6 | `shortcut-sheet` | The `?` sheet: every shortcut by scope (anywhere, a needs-you item, a task), the two-key sequences shown as such, a link to the palette, closed with Escape | F-081 | `app-targets/m4/search-palette` |
| 7 | `agent-profile-claude-code` | *Postponed with F-018.* The agent profile editor with Claude Code chosen: the agent picker with both agents, the model list filtered to Anthropic-format providers with the others listed apart and why, what Claude Code declares (and the one difference, "the repo's own Claude settings are set aside for each task"), its options ("strip pre-release API features" with when to use it), and on which runners it's ready | F-018 | `app-targets/m3/agent-profile` |
| 8 | `runner-agents` | *Postponed with F-018.* A runner's page, its agents section: each agent with its version and state (ready, preparing with its progress line, failed with the reason and "Try again", available with "Prepare now"), the agent image's digest on `docker` and `kubernetes`, the license note for Claude Code ("downloaded from npm under Anthropic's terms") | F-018 | `app-targets/m5/runner` |
| 9 | `task-subagent` | *Postponed with F-018.* The task page with a Claude Code session: a subagent's calls nested under the call that started it, collapsed with a count and expandable, the agent's badge in the header, a "Preparing Claude Code on this runner" waiting state | F-018, F-023 | `app-targets/m1/task` |
| 10 | `account-appearance` | Account, "Appearance": dark, light and match my system as three previews, the current one selected, the keyboard shortcuts' link | F-082, F-081 | `app-targets/m3/account` |
| 11 | `light-home` | Home in the light theme: the brand's light tokens on milestone 3's Home, the needs-you rows, the sidebar | F-082 | `app-targets/m1/home` |
| 12 | `light-task` | The task page in the light theme: the thread, tool calls, the diff's colors, an approval card | F-082 | `app-targets/m1/task` |

**Screens that only grow**, built against their existing targets with the changes listed in the ticket that builds them:
- *Postponed with F-018:* `app-targets/m3/agent-profiles`: the agent column, with Claude Code's mark; a profile whose model's provider isn't in Anthropic's format marked as needing a change.
- *Postponed with F-018:* `app-targets/m1/models`: each provider's format shown, and "Claude Code can use this provider" on an Anthropic-format one.
- *Postponed with F-018:* `app-targets/m1/task-new` and `app-targets/m2/inbox`: the profile picker shows each profile's agent.
- *Postponed with F-018:* `app-targets/m5/runner` and `app-targets/m1/runners`: an agent count per runner and "Preparing" in the list (the section itself is `runner-agents`).
- `app-targets/m2/home-first-run`: the checklist's links to the docs' matching pages, and Linear's step skippable.
- `app-targets/m4/instance-settings`: the version, the license line ("source-available"), and the docs' address.
- `app-targets/m3/needs-you` and `app-targets/m3/phone-approval`: each item's shortcut hint at desktop width, none on a phone.
- The sidebar (`app-targets/m1/README.md`'s shell): "Docs" in the help menu, the theme's quick toggle, and `?` for the sheet.
- Every screen of milestones 1 to 6 in the light theme follows `light-home` and `light-task`'s rules and gets no picture of its own; ticket 18 lists any screen whose light rendering needs a decision the two targets don't settle, and adds a target for it before building it.
