# Milestone 8: Previews and the library

**Status:** spec, 2026-11-21. Tickets in `issues/`, one file each (`docs/agents/issue-tracker.md`).
**Milestone:** 8 (`context/build-order.md`). It lands before milestone 7's held launch gate, so the gate's load test, security review, measure and demo run once, on a product that already has it.
**Features:** F-121 (seeing the running app: screenshots and recordings, moved into v1), F-140 (app processes), F-141 (the live preview), F-142 (sharing a preview), F-143 (`ostra preview`), F-144 (the preview domain), F-145 (the skills and MCP library), F-146 (the marketplace browser) and F-147 (the double sidebar). Its demo signs in as milestone 1's default first admin, and Sam arrives by milestone 4's invitation.
**Approved by the maintainer on 2026-11-21** ("yes" to each of the three features, to land before the launch gate):
- screenshots and recordings in the task's timeline, moved earlier;
- live previews of the app being built;
- a skills and MCP library.

Before that, on 2026-11-20 and 2026-11-21, the maintainer answered three questions: the preview domain stays optional; who can open a preview is configurable; a frontend plus its API are app processes the environment declares, with the dev-server proxy pattern. The lead's five preview recommendations got a "yes" as a group (section 12). The double sidebar is the maintainer's request: Multica's "double sidebar is nice".
**Decisions it builds on:** ADR 0021 (no telemetry; one outbound fetch), 0025 (everything is an adapter), 0026 (organizations, projects, access), 0029 (executors, boxes and the allowed differences), 0030 (no credential in the agent's container), 0031 (the safety minimum), 0034 (the runner protocol), 0035 (the event log and the browser stream), 0038 (environments, snapshots, services, the onboarding task), 0039 (idle boxes, hidden refs, archives), 0040 (the GitHub App), 0043 (blobs), 0049 (profiles, skills, MCP servers), 0054 (the audit log), 0065 (several GitHub installations), 0067 (subagents, protocol minor 6). **New for this spec:** ADR 0068 (seeing the running app: app processes, screenshots and previews through core) and ADR 0069 (the skills and MCP library). Between them they amend ADRs 0021, 0025, 0029, 0034, 0035, 0038, 0039, 0043 and 0049.
**Research it rests on:** `research/live-previews.md` (sections 1 to 8, section 8 on apps of several services) and `research/skills-and-mcp-marketplaces.md`. Two spikes (tickets 07 and 08) measure what the research couldn't, and gate the live designs' numbers (ADR 0068, "If a spike fails").
**Builds on milestones 1 to 7** as they were built, not only as they were specified. Where their code ends up different from their specs, this spec follows the code, and the ticket that meets the difference says so in its `## Comments`. **Being built beside it:** repo skills loading by default, and which skill wins when a profile's and a repo's share a name (`research/skills-and-mcp-marketplaces.md` §1.4 and §7.2, in the `repo-skills` worktree). This spec doesn't spec it again; ticket 28 follows the rule it sets.

Terms follow `context/GLOSSARY.md`. Lifecycles follow `context/domain-model.md`, which ticket 05 grows.

---

## 1. What milestone 8 ends with

A reviewer sees the app, not only the diff. A team installs skills and MCP servers the way they install packages. And the panel's navigation is a rail and a second sidebar.

In more words. A project's environment declares the app's processes, a Vite frontend and an API say, with the frontend marked as the primary preview; onboarding proposes them from the repo's files and tests them. The agent takes screenshots and short recordings of the app in its box with ostra's tools, and after each turn ostra takes the environment's routes by itself. They land in the task's thread and stay there after the box is gone, and the PR links to them. Beside the thread, a preview pane shows the app live: with no setting, the box's own browser streamed as pictures, which a member clicks and types into; with `ostra preview`, any of the task's ports on the member's own `localhost`; and, where an admin set a preview domain, the app itself in the member's browser. A box stays warm while someone watches, up to an hour, and a stopped task's app starts again without an agent turn. A member shares one preview with named people, an expiring link, or a public link where an admin allows it, watch-only unless the link allows input. An organization admin installs a skill from a GitHub repo or a well-known URL, or an MCP server from GitHub's registry, pinned and hashed, attaches it to profiles or to every profile, sees each update's diff before accepting it, and searches skills.sh and the registries from the panel. Members suggest what to install.

### What milestones 1 to 7 leave that milestone 8 starts from

Read from the code on `main` on 2026-11-21, so builders don't rebuild what exists:

- **The protocol is at minor 6** (`packages/protocol/src/runner/version.ts`, F-138's subagents). Milestone 8 takes minor 7, and the window keeps a minor-6 runner working.
- **The environment** holds a base image, a setup script, services (an image, a port, variables and a health check, `taskSpecServiceSchema`), checks, and each repo's variables, secrets and files (`packages/db/prisma/schema.prisma`, `Environment`, `Service`). Nothing declares the app's own processes. Detection reads `devcontainer.json` and compose files and takes the compose services' ports (`packages/domain/src/environment/detect.ts`), but not `forwardPorts` or `portsAttributes`. The onboarding task's `propose_environment` takes services (milestone 6), and since 2026-11-21 its agent may write only `AGENTS.md` (ADR 0038, amended).
- **The base image has no browser.** `deploy/Dockerfile.base` installs tini, bash, git, git-lfs, ca-certificates, curl, ripgrep, python3, build-essential and procps, with OpenCode pinned beside them.
- **The box:** on `docker` the agent's container sits on an `internal` network with no route out, and its init starts every process over a bridge from the sidecar (`packages/adapters/adapter-executor-docker/src/boxes.ts`, `bridge/`, `init/`). On `kubernetes` the containers share the pod's `localhost`. On `host` the runner runs the task in a worktree inside a containment unit.
- **The sidecar** runs the key proxy, the git proxy, the MCP proxy and ostra's MCP server (`apps/runner/src/sidecar/`), whose tools are `set_pull_request_text`, the memory tools, `submit_draft`, `submit_review` and `propose_environment` (`packages/protocol/src/mcp/tools.ts`).
- **Blobs** go up on the bulk path, off the session (ADR 0043). `Blob.purpose` is a word, and the panel's own purposes are `skill-file` and `draft-image` (`packages/domain/src/panel-blob-token.ts`). The panel writes through core's `POST /panel/v1/blobs` with a signed token.
- **The panel can't frame anything and can't be framed:** `apps/web/src/proxy.ts` sends `default-src 'self'`, `img-src 'self' blob: data:` and `frame-ancestors 'none'`, with no `frame-src`, and `next.config.ts` sends `X-Frame-Options: DENY`.
- **The browser stream** is one tRPC subscription over SSE per tab (ADR 0035). Route handlers can't upgrade to a WebSocket.
- **The CLI** has `ostra login` and `ostra checkout`, which call the web app at `/api/cli/v1` (`packages/protocol/src/cli/http.ts`) with a CLI session (F-103).
- **Profiles' skills** are rows (`AgentProfileSkill`: a name, the `SKILL.md` text, files as blob IDs), with no source, version or hash. MCP servers are a JSON column of `http` (a URL and `headerSecretRefs`) and `stdio` entries. The limits are 50 skills, 20 MCP servers, and 20 files of 1 MiB each a skill (`packages/protocol/src/runner/limits.ts`). Dispatch copies each skill into the task's blobs with its digest (`apps/core/src/dispatch/profile-spec.ts`), and the runner writes them into the task's own folder (`apps/runner/src/task-host/skills.ts`).
- **Core's replicas** route commands through Postgres, with `RunnerPresence` saying which replica holds which runner (ADR 0034). No replica talks to another.
- **The idle timer** is `OSTRA_BOX_IDLE_MINUTES` (15), and a reopen starts a fresh box from the snapshot, the branches, the hidden ref and the archive (ADR 0039).
- **The panel's shell** is one 234 px sidebar (`brand/app-design.md`, "Layout"; `apps/web/src/components/shell/sidebar.tsx`, `project-nav.tsx`, `destinations.ts`), with milestone 7's palette actions, shortcuts and `?` sheet, both themes, and the phone width.
- **The launch gate is held:** milestone 7's tickets 25 to 28, 32 and 33 wait for the maintainer's word (`build-order.md`). Milestone 8's own demo joins it.

### What is in, and what is not

**In:**
- app processes in the environment, with detection, onboarding's proposals, the agent's `show_preview` and "Keep it";
- the box's browser on every executor;
- `take_screenshot`, `record_app` and `start_app` for the agent, and the after-turn screenshots;
- attachments in the thread, on the PR, in a refine draft and on a finding;
- the preview pane with the browser view and its expanded view;
- the preview connection on both carriers, with replicas forwarding;
- warm while watched, and "Start the app";
- the four access levels, links, the viewer page and their audit;
- `ostra preview`;
- the native preview on an optional preview domain, with its handshake, proxy and CSP;
- the skills and MCP library: install by reference, pins and hashes, the allowlist, MCP secrets in the store, the test call, attaching and every profile, delivery, updates with diffs, suggestions;
- the marketplace browser;
- the double-sidebar shell;
- the docs for all of it.

**Not in** (and when it comes):
- detected listening ports: later (Q313). Previews reach declared and announced ports
- cross-host CORS between a task's previews under the native preview: later, if a project can't keep one origin (Q310)
- MP4 or WebM recordings: frame reels only (Q312)
- an ostra entry point for webhooks into the app being built: never planned. (Webhook automations, F-139, start tasks from a request and are a different thing.) Forwarders that dial out run on `kubernetes` and `host`, and on `docker` after network allowlists (F-052, later)
- a third-party tunnel, built in or as an adapter: not planned (Q303)
- OAuth sign-in for MCP servers, stdio MCP servers in their own container, and a hash of a server's tools in the MCP proxy: later, each with its own ADR (ADR 0069)
- third-party audit verdicts for skills: later (Q319)
- repo skills loading by default, and name clashes between a profile's and a repo's skills: being built beside this milestone (the `repo-skills` work)
- a preview for a native mobile app: out of a private preview's reach. Expo's web target is an ordinary preview, and screenshots work (`research/live-previews.md` §8.3)
- Claude Code, Codex and other agents: after v1 (F-018, F-038). Every agent-facing piece is proved on OpenCode and the scripted fakes

### On this machine

The same adjustment as milestones 1 to 7: the demo's scripted part runs here on the `host` executor, where a "box" is a worktree. Here the box's browser is Edge, which every Windows machine has. The browser view, screenshots, recordings, `ostra preview`, the native preview on `preview.localhost`, two core replicas and the library all run here. What needs more than that:
- **Linux with Docker:** Chromium in the base image, the init's browser pipe and forwarder, and the box's network keeping public fonts out of a screenshot. In the `live-docker` job of `proof.yml` (ADR 0061), which runs once, at the launch gate. Until then F-121 and F-141 stay `building` for `docker`, proved against the fake engine.
- **Kubernetes:** the same in the `live-kind` job, with the pod's shared `localhost`.
- **macOS:** Safari's partitioned cookie in the pane's frame (F-144), and a `host` runner on a Mac finding Chrome or downloading its headless shell. The maintainer's Mac, or the macOS proof job.
- **People:** the maintainer's review of the targets (tickets 09 and 10), and the `test-web` repo in `ostra-test` (ticket 34).

---

## 2. The features, and where each one lives

"At M8's end" is the ledger status ticket 33 sets at the launch gate, if and only if every condition in the row's "done when" holds.

| F-ID | What milestone 8 builds | Packages | Tickets | At M8's end |
|---|---|---|---|---|
| F-121 Seeing the running app | The box's browser on every executor; `take_screenshot` and `record_app`; the after-turn screenshots; attachments as task blobs in the thread, with a lightbox and a frame-reel player; the PR's line; "Add to draft"; a finding's attachments (ADR 0068) | `packages/protocol`, `adapter-sdk`, the three executors, `apps/runner`, `adapter-opencode`, `packages/db`, `packages/domain`, `apps/core`, `packages/api`, `apps/web`, `deploy/` | 01, 03, 04, 05, 11, 13, 14, 15, 16, 17 | done, once the `live-docker` and `live-kind` jobs have run; otherwise `building` with `host` and the fakes proved |
| F-140 App processes | The environment's app processes and a service's preview flag; the runner starting, checking, logging and stopping them; the in-box addresses; detection; onboarding's proposals; `show_preview` and "Keep it"; the one-origin convention (ADR 0068) | `packages/protocol`, `adapter-sdk`, the three executors, `apps/runner`, `adapter-opencode`, `packages/db`, `packages/domain`, `apps/core`, `packages/api`, `apps/web` | 01, 03, 04, 05, 12, 14, 15, 16, 17 | done, with the same caveat as F-121 |
| F-141 Live preview | The pane and its expanded view; the browser view over the preview connection on both carriers; one shared page; warm while watched; "Start the app"; replicas forwarding (ADR 0068) | `packages/protocol`, `apps/runner`, `packages/db`, `packages/domain`, `apps/core`, `packages/api`, `apps/web` | 01, 04, 05, 07, 18, 19, 20, 21 | done, with the same caveat |
| F-142 Sharing a preview | The four levels, named people, expiring and public links, watch-only by default, the viewer page, failing closed, the audit (ADR 0068) | `packages/db`, `packages/domain`, `apps/core`, `packages/api`, `apps/web` | 04, 05, 19, 20, 21 | done |
| F-143 `ostra preview` | The tunnel mode on the preview connection; the `docker` forwarder; core's CLI tunnel; the CLI command (ADR 0068) | `packages/protocol`, `adapter-sdk`, the executors, `apps/runner`, `apps/core`, `apps/web` | 01, 03, 08, 22, 23, 24 | done, with `docker`'s forwarder proved live in the Linux job; otherwise `building` |
| F-144 Preview domain | Preview hosts on core; the handshake and its cookie; the proxy's rewrites and framing; the CSP; the settings page's DNS and certificate check (ADR 0068) | `apps/core`, `packages/domain`, `packages/api`, `apps/web` | 08, 23, 25, 26 | done, if Safari's partitioned cookie is checked on a Mac; otherwise `building` with Chrome and Firefox proved |
| F-145 Skills and MCP library | Install by reference, pins and hashes, the checks, the allowlist, MCP remotes with secrets in the store and the test call, attaching and every profile, delivery, updates with diffs, suggestions, the audit (ADR 0069) | `adapter-sdk`, `adapter-github`, `adapter-opencode`, `packages/db`, `packages/domain`, `apps/core`, `packages/api`, `apps/web` | 02, 04, 06, 14, 27, 28, 30, 31 | done |
| F-146 Marketplace browser | Search of skills.sh and the registries through core; install from a result; the switch (ADR 0069) | `packages/domain`, `apps/core`, `packages/api`, `apps/web` | 06, 29, 30, 31 | done |
| F-147 Double sidebar | The rail and the context sidebar, built to `app-targets/m8/`'s approved targets, every route reachable, the keyboard walk and contrast check, the phone sheet | `apps/web`, `context/brand/` | 10 | done, once its targets are approved |

**Rows this milestone touches without finishing:**
- **F-113 (onboarding)** proposes app processes and screenshots the primary. Its status stays as milestone 6 left it, waiting on Docker.
- **F-112 (detection)** reads more files. It needs no new status.
- **F-021 (agent profiles)** gains attached and inherited library items. It stays `building`, as its own Playwright cases leave it.
- **F-099 (refine)** and **F-100 (AI review)** gain an attachment in a draft and on a finding, with no new status.
- **F-103 (`ostra checkout`)**: the CLI session also opens a tunnel, so its glossary line changes. Its status doesn't.

**Built in from the first milestone** (`build-order.md`), checked again by ticket 33:
- **Organization-scoped data:** every new row carries `organizationId`, and every project record carries `projectId` with the composite key (04). Milestone 4's generated isolation test gets a fixture for each new model, and fails until each has one.
- **The event log and the durable queue:** an attachment, a process's state, a preview's list, a view's opening, a link's use, a library install, an update found and a suggestion are each saved before they're acted on (12, 15, 19, 20, 27, 28).
- **No credential in the agent's container:** the box's browser holds no cookie or token of ostra's; a library server's secret headers stay in the sidecar; a preview link's token and a preview cookie never reach the box (13, 18, 25, 28).
- **ACP as the only way to talk to an agent:** the app tools are MCP tools on ostra's server, as the PR text is.
- **Strict typing, dark first, responsive, English text in message files:** as milestones 1 to 7, and the double sidebar keeps milestone 7's keyboard walk and contrast check passing (10).

---

## 3. The end-to-end demo

Ticket 33 runs it **at the launch gate**, with milestone 7's ticket 32, and records the result under its `## Comments` and in `demo.md` next to this spec (`build-order.md`, "Milestone demos move to the launch gate too"). Everything runs against the Linear workspace `ostra-test` (team `OST`) and the GitHub org `ostra-test`: repos `test1`, `test2` and `test-web`, which ticket 34 makes from `e2e/m8-previews-and-library/fixtures/test-web/`. `test-web` is a Vite and React frontend whose `server.proxy` sends `/api` to a small Node API on port 3001, and a docs page on port 4000. Secrets come from `~/.config/ostra-dev/` with `set -a; . ~/.config/ostra-dev/<file>; set +a`, and are never printed, logged or committed.

**Two runs.** The scripted run (`pnpm e2e:m8`) runs every step it can without a person, on the `host` executor here, with `OSTRA_BOX_IDLE_MINUTES=2` and `OSTRA_PREVIEW_WARM_MINUTES=4` so the waits are short. Its library steps use the fake code host's public repos, a fake MCP registry on the registry's `v0.1` API, a stub MCP server and a fake skills search. The manual run, once, in real browsers, adds real GitHub sources, GitHub's MCP registry, skills.sh's search, a second browser for the signed-out viewer, and a Mac's Safari if one is at hand.

**Before:** a fresh clone, `pnpm install`, `pnpm dev:reset`, `pnpm dev`, and milestones 1 to 7's helpers: a model provider from `model.env`, the test App installed on `test-web`, the Linear connection, a project `test-web` (repo `test-web`, board `OST`) with its detected draft environment, a personal runner on `host`, and the maintainer's GitHub user linked to Demo. The panel signs in as `demo@demo.com` / `demo`, with `OSTRA_ALLOW_DEFAULT_PASSWORD=true` in the scripted run. Sam joins by invitation as a member of `test1` only, not `test-web`.

1. **The double sidebar.** The panel opens on the rail and its second sidebar. Demo moves Home → `test-web` → its Environment → the organization's Library through the rail and the second sidebar only, then with the keyboard only, then at 390 px through the sheet. Every page of milestones 1 to 7 is one rail item and one second-sidebar row away.
2. **Onboarding proposes the app's processes.** `test-web`'s environment shows "Detected: web (5173, primary), api (3001), docs (4000)" from `package.json` and `vite.config.ts`. Demo presses "Test this environment". The onboarding task starts each process, checks each ready check, and its thread shows a screenshot of `/`. Its proposal lists the three processes, the frontend as primary with `/api` behind its proxy, and Demo accepts it.
3. **Screenshots after a turn.** Demo starts a prompt task in `test-web`: "Add a footer that shows the API's version from `/api/version`." The agent calls `start_app` and `take_screenshot`. When the turn ends, ostra takes `/` at desktop and phone width by itself. The thread shows the agent's screenshot with its caption and ostra's two, each naming Edge and its version. The footer shows the version, so the frontend reached the API through its own origin. The PR's body has "Screenshots: 3 in ostra", linking to the task.
4. **A recording.** Demo messages: "Record clicking the counter three times." The agent calls `record_app` with a `goto` and three `click` steps. The thread shows a recording of about 4 seconds, which plays in the panel with its steps beside it.
5. **The live preview.** The pane shows "Web" live: the browser view. Demo clicks the counter in the pane and it counts; types into a field; picks the phone width; presses "Expand", and the same pane widens with no reload. "API" and "Docs" are listed under it. Sam can't see the task (not a member of `test-web`).
6. **A port the agent announced.** Demo messages: "Start the docs server on 4100 and show it to me." The agent runs it and calls `show_preview`. The pane lists "Docs (4100), announced". Demo presses "Keep it", and `test-web`'s environment shows a proposal adding it.
7. **Warm while watched, then "Start the app".** The turn ends. With the pane open, the box outlives `OSTRA_BOX_IDLE_MINUTES` and stops at the warm cap. Demo closes the pane and reopens the task later: the pane shows the last screenshot and "Start the app". Demo presses it. A box starts from the task's branch and hidden ref, the setup runs, the processes start, and the pane goes live. No agent session starts, and the key proxy counts no call for it. Demo sends "Make the footer bold": a turn starts in that same box.
8. **Sharing.** On "Web", Demo picks "Named people: Sam". Sam opens the link from the notification: Sam sees that preview alone, not the thread or the diff. Demo makes an expiring link, 1 hour, watch-only. In a signed-out browser context the viewer page shows the stream, and clicks do nothing. A second link with "Allow input" lets the signed-out viewer click the counter. "Public" is greyed out: the organization hasn't allowed public links. Demo revokes the first link, and it shows "This link was revoked". The audit log lists the level change, both links, their first uses and the revoke.
9. **`ostra preview`.** On this machine: `ostra login`, then `ostra preview <task>`. It prints `http://localhost:5173`. The app opens in a tab, its `/api` answers, and when Demo asks the agent to change the footer's text, the tab updates by HMR without a reload. `ostra preview <task> 22` is refused: "port 22 isn't one of this task's previews".
10. **The native preview** (`OSTRA_PREVIEW_DOMAIN=preview.localhost`). The settings page shows the preview domain and its check passing. The pane now shows "In your browser": the app in a frame on `5173-<id>.preview.localhost`, with devtools working on it. "Open in a new tab" opens it top-level after its own handshake. A request from that origin to the panel's tRPC endpoint is refused, and the panel's cookie isn't sent to it.
11. **The library: a skill by reference.** Demo opens Organization → Library and installs `ostra-test-skills/demo-skills@release-notes` (the fake code host's public repo; the manual run uses a real public repo). The dialog says the source isn't allowed yet, and Demo allows `github.com/ostra-test-skills`. The install shows the commit, the files and the hash, which equals the `skills` CLI's documented hash of the same folder (ticket 06's vector). Demo attaches it to `test-web`'s default profile. A task's agent lists `release-notes` among its skills.
12. **An MCP server from a registry.** Demo installs `io.example/notes` from the fake registry (the manual run: a server of the maintainer's choice from GitHub's registry). The remote's `Authorization` header is marked secret, so the dialog asks for it, and it's stored in the secret store. The test call lists the server's two tools. Demo marks it "Every profile". The Refine profile shows it as inherited. A task's agent calls one of its tools through the MCP proxy, and the agent's config holds the proxy's path and no header. An entry with only an npm package shows "Not installable yet: it needs its own container".
13. **An update and its diff.** The script pushes a commit to the skill's repo. "Check for updates" shows an update: one file changed, with its diff. Before Demo accepts it, a new task still gets the old content. Demo accepts it, and the next session of that task gets the new one.
14. **A suggestion and the marketplace.** Sam, an ordinary member, suggests `ostra-test-skills/demo-skills@changelog` with a note. Demo's Library shows "1 suggestion". Demo installs it from there. Demo turns on marketplace search, searches skills for "release" and MCP servers for "notes", and installs a result. With `OSTRA_MARKETPLACE_SEARCH=false` on a restart, the switch is off and says why.

**The checks after the run** (ticket 33 scripts what it can, in `e2e/m8-previews-and-library/`):
- **Nothing leaked.** The MCP server's secret header, the preview cookies, the links' tokens, the one-time codes and the CLI's tickets appear in no log line, no event, no worktree and no process's command line (searched by value, never printed). No caption, recording step or app log line is in a log line.
- **What a preview reaches.** A view or a tunnel to the key proxy's, the git proxy's, the MCP proxy's or OpenCode's port is refused, on `host` here and on the fake engine and the fake cluster (F-141, F-143).
- **Fail closed.** A minor-6 runner gets no app tools, no processes and no previews, and the pane says it needs upgrading. An expired link and a level the organization forbids each give no view (F-141, F-142).
- **Replicas.** With two core processes on one database, a view opened through one while the box's preview connection sits on the other streams frames, a tunnel carries HMR, and a forwarded request with a wrong signature is refused (F-141).
- **Parity.** The executor suite's browser, process and forward cases pass on `docker` and `kubernetes` against their fakes, and on `host` live. The `live-docker` and `live-kind` jobs run them live when they run.
- **Library parity.** A library skill reaches the task the same way a profile's own skill does on `host` and on the `docker` fake (the blobs and their digests).
- **Clean-up:** the demo's tickets archived in `OST`, its PRs closed, branches and hidden refs deleted, its links revoked and its library items removed, in `test1`, `test2` and `test-web` only.

---

## 4. How it fits together in milestone 8

```
 browser ──▶ apps/web: the rail and context sidebar, the environment's app processes, attachments
   │                    in the thread, the preview pane, the share dialog, the viewer page, the
   │                    library, the profile's attachments, the marketplace browser
   │     ├─ tRPC over SSE (ADR 0035), as before
   │     ├─ GET /api/previews/<viewId>/stream ─▶ core GET /panel/v1/previews/<viewId>/stream   (frames)
   │     └─ POST /api/previews/<viewId>/input ─▶ core POST /panel/v1/previews/<viewId>/input  (input)
   ├──▶ https://<port>-<previewId>.<preview domain> ──▶ core's preview proxy        (native preview)
   └──▶ http://localhost:<port> ◀── ostra preview ──wss──▶ core /cli/v1/tunnel      (on a member's machine)

 core ──▶ Postgres: app processes, attachments, previews, views (presence), links, codes,
                    library items, versions, attachments to profiles, sources, suggestions
 core ⇄ core: a forwarded view, signed, to the replica that holds the box's preview connection
 core ──▶ GitHub (the App or anonymous), well-known hosts, MCP registries, skills.sh search

 runner/sidecar ──session WS──▶ core: app.process, attachment.added, preview.list; commands
                                     preview.open, preview.close, app.start, screenshot.take
 runner/sidecar ──preview WS──▶ core: /runner/v1/preview?view=…  stream | tunnel (HTTP/2)
   └─ the box: the app's processes and Chromium in the agent's container (the init), driven
      over the bridge; on docker the init's forwarder; on host, both are the runner's
```

**The flows:**
- **An app process.** Dispatch puts the environment's app processes, their screenshot settings and the `app` tools into the task spec (minor 7). The runner starts nothing until something asks: the agent's `start_app`, the after-turn screenshots, a preview opened, or `app.start`. It then starts the processes in the list's order through the init (on `host`, in the containment unit), with the repo's variables and secrets and the in-box addresses, waits for each one's ready check, and sends `app.process` for each state. A process that exits sends `exited` or `failed` with its log's tail as a blob. The processes stop with the box.
- **A screenshot.** The sidecar opens a page of its own in the box's browser over the DevTools pipe, loads `http://localhost:<port><path>` at the size asked, waits for the network to go quiet (at most 15 s *(working value)*), captures a PNG, uploads it on the bulk path, and sends `attachment.added`. Core stores a `TaskAttachment` and the thread shows it. A recording runs its steps in the same kind of page, with a screencast at 10 frames a second, into one frame-reel blob.
- **After a turn.** When the turn changed a repo and the environment has a primary with screenshots on, the runner, after the commit and the push (ADR 0039), starts what isn't running, waits for the primary, and takes each route at each width with the source `after-turn`. A primary that doesn't get ready sends `app.process failed` and the turn's end isn't held.
- **Opening a view.** The pane calls `previews.open`. Core checks the member's access (or the link), writes a `PreviewView` in one transaction with the audit entry, and sends `preview.open` to the box's runner (minor 7, carrier-aware). The sidecar opens `wss://<core>/runner/v1/preview?view=…` in the mode asked. The replica that accepts it writes the view's presence (its `OSTRA_CORE_REPLICA_URL`). The panel's stream request reaches any replica. One that doesn't hold the view forwards it, signed, to the one that does, which relays the frames.
- **The browser view.** The sidecar keeps one page per preview, shared by the views of it. It starts a screencast when the first view opens and stops it when the last closes, acks each frame as core takes it, and passes input from core onto the page.
- **Warm while watched.** The pane's heartbeat (`previews.heartbeat`) updates `Box.previewWatchedAt`. The idle sweep (ADR 0039) skips a box whose heartbeat is under 2 minutes old and whose last turn ended or app started under `OSTRA_PREVIEW_WARM_MINUTES` ago.
- **"Start the app".** `previews.startApp` admits a lease with the purpose `app` on the task (ADR 0059's admission), and the runner gets a dispatch with `purpose: "app"`: the box starts as for a reopen, runs the setup, restores the hidden ref, starts the app processes, and launches no agent. A member's message on the task becomes a turn on that lease, which launches the agent and restores its session from the archive.
- **A tunnel.** For `ostra preview`, the CLI gets a ticket from `/api/cli/v1/tasks/:ref/previews/tunnel`, then opens `wss://<core>/cli/v1/tunnel?ticket=…`. Core opens a view in `tunnel` mode, and bridges each of the CLI's streams to a `CONNECT` stream on the box's HTTP/2 connection. For the native preview, core's preview proxy turns each request on a preview host into an HTTP/2 request on that connection, with its rewrites, and each WebSocket upgrade into an extended CONNECT.
- **A share.** `previews.setLevel` and `previews.createLink` write the level or the link, with the audit entry, in one transaction. A link's viewer page calls the same stream and input routes with the link's token instead of a session. The first use of each link writes its audit entry once.
- **A library install.** `library.resolve` reads the reference and returns what it would install: the skills found, the commit, the files and their hash, or the registry entry with its remotes and inputs. `library.install` checks the allowlist, fetches again at the same commit, writes the blobs, the `LibraryItem` and its first `LibraryItemVersion` with the audit entry, and stores secret inputs through the secret store. For a server, `library.testServer` makes the test call.
- **Delivery.** `profileSpec` (dispatch) gathers a profile's own skills and servers, its attached items and the every-profile items at their current versions. It copies each library skill's files into the task's blobs as for an own skill, and adds each library server as an HTTP server on the MCP proxy, its URL and secret header references in the task's credentials.
- **Updates.** `library.check-updates` runs once a day per organization, and on demand per item. It writes an `available` version with its diff when the pin moved and the content changed, and a quiet count shows it to admins. `library.acceptUpdate` makes it current, with the audit entry. The next dispatch of every attached profile's tasks uses it.
- **The marketplace.** `library.search` (admin, behind the organization's switch and the instance's) calls skills.sh's search or each listed registry's `servers?search=` from core, tolerant of unknown fields, and returns results with whether each source is allowed.

---

## 5. The contracts

Every contract change in milestone 8 is **additive**: a new optional field, a new union member, a new endpoint, a new table, column or enum value. Nothing is renamed or dropped (`AGENTS.md`). Each lands as one small commit that names the contract and updates every caller in the same commit. Tickets 01 to 06 make them first, each with the fakes its callers test against; everything else builds on them.

### 5.1 `packages/protocol`: minor 7 (ticket 01)

- **The version.** Minor 7, negotiated in `hello` and `welcome`, with minor 6's codecs kept. A minor-6 peer is never sent anything below, and core never gives it app processes, the `app` tools, a dispatch with the purpose `app` or a view (`isTaskOfferable` and a new `isPreviewable`, each with the reason the panel shows). A minor-5 peer is outside the window.
- **The task spec, new optional fields:**
  - `environment.appProcesses`: at most 10, each `{ name, repoId, folder, command, port, ready, label, primary, hostRewrite }`. `ready` is `{ kind: "http", path }`, `{ kind: "command", command }` or `{ kind: "port" }`. At most one is `primary`, and names and ports are unique. A strict object.
  - `environment.services[].preview`: `{ label } | null`.
  - `environment.screenshots`: `{ afterTurn, routes (at most 5 paths), widths ("desktop" | "phone", at most 2) }`.
  - `tools` gains `"app"`: the sidecar serves `start_app`, `show_preview`, `take_screenshot` and `record_app`.
- **Commands:**
  - `dispatch.purpose`: `"turn"` (when absent) or `"app"` (start the app; launch no agent).
  - `app.start { names | null }`: start these processes, or all.
  - `app.stop { names | null }`.
  - `screenshot.take { requestId, key, path, width }`: a member's screenshot from the pane.
  - `preview.open { viewId, key, mode: "stream" | "tunnel", viewport }`.
  - `preview.close { viewId }`.
  - `preview.input { viewId, events }`, sent only on the HTTP carrier.
- **Events (the runner's):**
  - `app.process { name, state: "starting" | "ready" | "exited" | "failed" | "stopped", port, exitCode, reason, logBlobId }`.
  - `app.browser { available: true, name, version } | { available: false, reason }`, once per box.
  - `attachment.added { attachmentId, kind: "screenshot" | "recording", blobId, source: "agent" | "after-turn" | "member", target, path, width, height, durationMs, frameCount, caption, browser, memberId }`. `target` is `{ process }`, `{ port }` or `{ service }`, and `memberId` is set for a member's screenshot. The caption is never logged.
  - `preview.list { previews: [{ key, target, port, label, primary, path, source: "declared" | "announced" }] }`, sent at box start and whenever it changes.
- **Server-only kinds,** added to `serverOnlyKinds`: `preview.opened { viewId, mode, by }`, `preview.closed { viewId }`, `preview.level_changed { key, level }`, `preview.link_created { linkId, key, kind, allowInput, expiresAt }`, `preview.link_revoked { linkId }`, `app.started_by { memberId }`.
- **The preview connection** (`src/runner/preview.ts`): `GET /runner/v1/preview?view=<viewId>` upgrades to a binary WebSocket, authenticated as the task (a box's task token) or the runner (on `host`), with the lease epoch.
  - **In `stream` mode,** each message is a 1-byte type and its payload: `frame` (a JSON header, Zod, with the size, the timestamp and the frame's sequence, then the JPEG), `control` (JSON: `viewport`, `navigate`, `reload`, `input` batches), `ack` and `close`.
  - **In `tunnel` mode,** the messages are an HTTP/2 connection's bytes, with core as the client.
  - Both modes' JSON parts are strict objects, since ostra owns the format.
- **The HTTP carrier:** `POST /runner/v1/preview/frames { viewId, frames: [{ seq, at, jpeg }] }`, with the JPEG as bytes in a multipart body, at most 2 frames a second for a view. `preview.input` comes down the long poll.
- **`hello` and `status`:** `preview: { stream: boolean, tunnel: boolean }`, where `tunnel` is false on the HTTP carrier. A `host` runner adds `browser: { name, version } | null`.
- **The MCP tools** in `src/mcp/tools.ts`, Zod first, shared by the sidecar and core:
  - `start_app { names? }`, which returns each process's state, address and log path;
  - `show_preview { port, label, path?, primary? }`;
  - `take_screenshot { target, path?, width?, size?, fullPage?, caption? }`;
  - `record_app { target, steps, seconds?, caption? }`, with `steps` from the closed list `goto`, `click`, `fill`, `press`, `scroll` and `wait`.

  Each has its description for the agent: what it's for, the limits, that one origin is the convention, that a member reads what it hands in. Each refusal has its result text.
- **`propose_environment`** gains `appProcesses` and the services' `preview`, additively. **A finding** (`submit_review`) gains `attachmentIds`, at most 5.
- **CLI HTTP** (`src/cli/http.ts`): `POST /api/cli/v1/tasks/:ref/previews/tunnel { port | null }` → `{ coreUrl, ticket, port }`, or `{ code: "not-found" | "port-not-allowed" | "runner-cannot-tunnel" | "no-box" }`. Core's `GET /cli/v1/tunnel?ticket=…` upgrades to a WebSocket whose messages are an HTTP/2 connection with the CLI as the client.
- **Limits,** in `limits.ts`, as named working values:
  - **App processes:** 10 a project, 5 routes and 2 widths, 120 s for a ready check.
  - **Attachments:** a screenshot 8 MiB and 10,000 px high; a recording 30 s, 10 frames a second, 32 MiB and 20 steps; 20 attachments a turn; a caption 1 KiB.
  - **Previews:** 10 announced a task; 4 open pages a box.
  - **The browser view:** 15 frames a second at 1440×900, quality 60; 2 frames a second on the HTTP carrier.
  - **Ports:** below 1024 refused, and the sidecar's and the agent's own ports refused, by name.
- **The fixed words** in `src/agent/prompts.ts`: the app's block in the agent's instructions, naming each process with its address and its label, and the one-origin convention ("keep the browser on the primary's origin; put the API behind the frontend's dev-server proxy").
- **Never logged:** a caption, a recording's steps, an app's log, a process's command, a link's token, a code and a ticket. Each schema's description says so.

### 5.2 `packages/adapter-sdk` (tickets 02 and 03)

**`CodeHostAdapter`** (ticket 02), implemented by GitHub (ticket 27 calls it), the fake code host and the tiny adapters in the same commit:
- **Capability, new:** `readTree`, which GitHub declares and the tiny adapter doesn't.
- `resolveRef(access | null, repo, ref)` → `{ commit }`, or `null` when the ref doesn't exist. `access` is `null` for a public repo read anonymously.
- `readTree(access | null, repo, commit, path, { maxFiles, maxBytes })` → `{ files: [{ path, size, mode, bytes }], truncated }`. For GitHub, the commit's tarball, filtered to the path inside the adapter, with the caps applied while reading.
- **The fake code host** gains public repos, a private repo behind an installation, commits that move, and a skill tree. **The contract suite** gains: a ref resolved and a missing one; a tree read at a commit, capped and truncated; a private repo refused without access; the capability's absence declared.

**`ExecutorAdapter` and the box** (ticket 03). The init's bridge protocol, shared by `docker` and `kubernetes`, and the `host` executor's process host gain:
- **A process with a log:** start a long-running process in a folder with variables, its output to a file, report when it exits, and stop it. The init already starts processes (`bridge-processes.ts`); this adds the log file and the exit report.
- **The browser:** start Chromium with `--remote-debugging-pipe` and a fresh profile in a temporary folder, and give the caller the pipe as a channel of its own on the bridge. Report `{ name, version }`, or that there's none.
- **A forward** (`docker` only, from the init): listen on the box network at a port the init picks, accept only the sidecar's address, and dial `127.0.0.1:<port>`. `kubernetes` and `host` declare that they reach the app at `127.0.0.1` directly.
- **Capabilities, new:** `boxBrowser: "image" | "machine"` (`docker` and `kubernetes` take it from the image; `host` from the machine or its download) and `appReach: "forwarder" | "loopback"`.
- **The executor contract suite** gains, on each executor (its fake for `docker` and `kubernetes`, live on `host`, and live in the Linux jobs):
  - a process started, ready, logged and stopped with the box;
  - a crashed process reported with its exit code;
  - the browser's pipe opened, a page loaded at the app's `localhost`, and a screenshot taken;
  - a forward to an app's port, and one to a reserved port refused;
  - no cookie or file of the browser left after the box ends.

**The agent contract suite and the parity test** (ticket 03):
- The `app` tools are listed for a task whose spec has `"app"`, and absent otherwise.
- On the scripted fake that calls `take_screenshot`, the tool's result reaches the agent.
- **Parity rows:** F-121 and F-140 through ostra's MCP server (`mcp`). An agent without `mcp` gets the after-turn screenshots and the pane, and a scripted fake without `mcp` proves the fallback.

### 5.3 `packages/db`: the milestone 8 migration (ticket 04)

One new migration, after milestone 7's, additive only. Every row carries `organizationId`, and every project record carries `projectId` with the composite key to the project.

| Change | What |
|---|---|
| New `AppProcess` | `environmentId`, `name`, `repoId`, `folder`, `command` (never logged), `port`, `readyKind` (`http`, `command`, `port`), `readyValue`, `label`, `primary`, `hostRewrite` (default true), `position`. Unique `(environmentId, name)` and `(environmentId, port)`; a partial unique index on `(environmentId)` where `primary` |
| `Service` | + `previewLabel` (null: not a preview) |
| `Environment` | + `screenshotsAfterTurn` (default true; it acts only with a primary), `screenshotRoutes` (JSON, default `["/"]`), `screenshotWidths` (JSON, default `["desktop"]`) |
| `Task` | + `previewId` (unique, 26 characters, set at the task's first preview) |
| New `TaskAttachment` | `taskId`, `attachmentId` (the runner's, unique per task), `kind` (`screenshot`, `recording`), `blobId`, `source` (`agent`, `after_turn`, `member`), `targetKind` (`process`, `port`, `service`), `targetName`, `port`, `path`, `width`, `height`, `durationMs`, `frameCount`, `caption` (never logged), `browserName`, `browserVersion`, `turnId`, `memberId`, `draftImageId`, `createdAt` |
| New `TaskPreview` | the announced ones: `taskId`, `key`, `port`, `label`, `path`, `primary`, `announcedInTurnId`, `keptProposalId` |
| New `PreviewAccess` | `taskId`, `key`, `level` (`members`, `named`), `setByMemberId`, `updatedAt`; unique `(taskId, key)`. With no row, the level is `members` |
| New `PreviewAccessMember` | `previewAccessId`, `memberId`; unique per pair |
| New `PreviewLink` | `taskId`, `key`, `kind` (`expiring`, `public`), `tokenHash` (unique), `allowInput`, `expiresAt` (null for `public`), `createdByMemberId`, `revokedAt`, `revokedByMemberId`, `firstUsedAt`, `lastUsedAt` |
| New `PreviewView` | `taskId`, `key`, `mode` (`stream`, `tunnel`, `native`, `cli`), `openedByMemberId`, `linkId`, `leaseId`, `leaseEpoch`, `replicaUrl` (its presence, set by the replica holding the box's connection), `state` (`opening`, `open`, `closed`), `openedAt`, `lastHeartbeatAt`, `closedAt`. Index `(state, lastHeartbeatAt)` |
| New `PreviewCode` | the one-time codes and the CLI's tickets: `kind` (`enter`, `cli_ticket`), `codeHash` (unique), `taskId`, `key`, `port`, `memberId`, `linkId`, `leaseEpoch`, `expiresAt`, `usedAt` |
| `Box` | + `previewWatchedAt` |
| `Lease` | + `purpose` (`LeasePurpose`: `turn`, `app`; default `turn`), `appStartedByMemberId` |
| `OrganizationSetting` | + `publicPreviewLinks` (default false), `marketplaceSearch` (default false) |
| New `LibraryItem` | `kind` (`skill`, `mcp_server`), `name` (unique per organization and kind), `sourceKind` (`github`, `well_known`, `registry`), `source` (JSON, parsed by the domain's `librarySourceSchema`), `everyProfile` (default false), `readOnly` (default false), `currentVersionId`, `installedByMemberId`, `installedAt`, `removedAt`, `removedByMemberId` |
| New `LibraryItemVersion` | `itemId`, `number`, `state` (`current`, `available`, `superseded`, `dismissed`), `ref`, `commitSha`, `computedHash`, `files` (JSON: `[{ path, blobId, size, sha256, executable }]`), `registryVersion`, `serverEntry` (JSON: the remote's URL template and the headers asked for, never a secret's value), `serverInputs` (JSON: plain values, and secret references), `toolNames` (JSON), `needsOAuth` (default false), `diff` (JSON, computed against the current version), `fetchedAt`, `decidedByMemberId`, `decidedAt`. Unique `(itemId, number)` |
| New `AgentProfileLibraryItem` | `profileId`, `itemId`, `attachedByMemberId`, `attachedAt`; unique `(profileId, itemId)` |
| New `LibrarySource` | `kind` (`github_owner`, `github_repo`, `well_known_host`, `registry`), `value`, `namespace` (a registry's, nullable), `addedByMemberId`, `createdAt`; unique `(organizationId, kind, value, namespace)` |
| New `LibrarySuggestion` | `memberId`, `reference`, `note` (never logged), `state` (`open`, `installed`, `dismissed`), `decidedByMemberId`, `decidedAt`, `itemId` |
| Enums | New `AppReadyKind`, `AttachmentKind`, `AttachmentSource`, `PreviewTargetKind`, `PreviewLevel`, `PreviewLinkKind`, `PreviewViewMode`, `PreviewViewState`, `PreviewCodeKind`, `LeasePurpose`, `LibraryItemKind`, `LibrarySourceKind`, `LibraryVersionState`, `LibrarySuggestionState` |

**What the migration seeds:** nothing in the tables. Ticket 06's `library.seed-sources` job, run when an organization is seeded and once for each existing one, adds the registry source `https://api.mcp.github.com` to every organization's list (Q324).

**Blob purposes, new words:** `app-screenshot`, `app-recording`, `app-log` and `library-file`. Audit actions are domain words in the `action` string column, as milestone 7 found, so they need no enum.

### 5.4 `packages/domain` (tickets 05 and 06)

**Ticket 05: app processes, attachments, previews and sharing.**
- **Schemas:** `appProcessSchema` (the environment's form and the proposal's), the ready check, the screenshot settings, and the rules (one primary, names and ports unique, no port below 1024, no reserved port).
- **Lifecycles,** each a discriminated union with exhaustive tests, and drawn in `domain-model.md`:
  - an app process in a box: `stopped` → `starting` → `ready` | `failed`, `ready` → `exited` | `stopped`;
  - a view: `opening` → `open` → `closed`;
  - a link: `active` → `expired` | `revoked`;
  - a box's lease with the purpose `app`, which a message turns into a turn.
- **Pure rules:**
  - `previewTargets(environment, announced)`: the task's previews in order, primary first;
  - `mayReach(port, targets, reserved)`;
  - `previewAccess(member | link, task, project, level, organizationSettings)` → `allowed { input }` | `refused { reason }`, which fails closed;
  - `warmHold(box, now, settings)` → `hold` | `idle`;
  - `previewHost(port, previewId, domain)` and its parser, which never trusts a host's text without a matching row;
  - `rewriteRequest` and `rewriteResponse` for the native preview's headers (pure, over header maps);
  - `appAddresses(processes, services, executor)` → the `OSTRA_APP_*_URL` and `OSTRA_SERVICE_*_URL` variables;
  - the detection readers for `forwardPorts`, `portsAttributes`, `.gitpod.yml`, `.replit`, `package.json` scripts and a Vite config's `server.port` and `server.proxy`, read as text and never run.
- **Tokens:** the link's token (32 random bytes, stored as a SHA-256), the one-time code and the CLI ticket (single use, 60 s, bound to their fields), and the panel's preview token to core (like `panel-blob-token.ts`: an HMAC under the secrets key for one view, one member or link, and a minute).
- **The replica signature:** an HMAC over the forwarded request's method, path, view and time, under the secrets key, refused after 30 s.
- **Use-case signatures:** `saveAppProcesses`, `proposeAppProcess` ("Keep it"), `recordAttachment`, `addAttachmentToDraft`, `listPreviews`, `openView`, `closeView`, `heartbeatView`, `startApp`, `setPreviewLevel`, `createPreviewLink`, `revokePreviewLink`, `usePreviewLink`, `enterNativePreview`, `issueCliTicket`, `redeemCode`.
- **Jobs, new names** (IDs only in payloads, ADR 0037): `preview.views-sweep`, once a minute, which closes views with no heartbeat for 2 minutes; `preview.codes-sweep`, a daily removal of used and expired codes.
- **The audit actions** of section 5.3's list for previews and apps.

**Ticket 06: the library.**
- **Schemas:**
  - `libraryReferenceSchema`, which parses `owner/repo`, `owner/repo@skill`, `owner/repo/path`, GitHub tree URLs, `#ref`, well-known URLs and `registry:<name>`, with the `skills` CLI's parser as the reference (research §2.2);
  - `librarySourceSchema`;
  - the registry's `server.json` subset, tolerant of unknown fields;
  - skills.sh's search result, tolerant of unknown fields;
  - the well-known index v0.2.0, tolerant of unknown fields.
- **`computedHash(files)`**, the `skills` CLI's documented algorithm. Its test vector: one `SKILL.md` holding `# hi\n` gives `93c36952…2f55`, written out in full from the CLI's README by ticket 06.
- **`checkSkill(files)`:** the Agent Skills front matter rules and ostra's limits, with each refusal's words.
- **`allowed(reference, sources)`:** matched by owner, repo, host or registry and namespace, never by name.
- **`skillDiff(old, new)`** (files added, removed and changed, with each text file's line diff, capped) and **`serverDiff(old, new)`**.
- **`profileItems(profile, attached, everyProfile)`:** the profile's skills and servers at their pins, within the limits, refusing a name clash.
- **The lifecycles,** each a discriminated union with exhaustive tests:
  - a version: `available` → `current` | `dismissed`, `current` → `superseded`;
  - a suggestion: `open` → `installed` | `dismissed`;
  - an item: `installed` → `removed`.
- **Use-case signatures:** `resolveReference`, `installItem`, `testServer`, `attachItem`, `detachItem`, `setEveryProfile`, `removeItem`, `checkUpdates`, `acceptUpdate`, `dismissUpdate`, `suggestItem`, `decideSuggestion`, `addSource`, `removeSource`, `searchMarketplace`, `setMarketplaceSearch`.
- **Jobs:** `library.check-updates` (key: organization and day; and item on demand), `library.seed-sources` (key: organization).
- **The audit actions** of section 5.3's list for the library.

**Settings, new** (tickets 05 and 06), each with a working default and its line in `docs/configuration.md`:

| Setting | Default |
|---|---|
| `OSTRA_PREVIEW_DOMAIN` (server) | unset: no native preview. Set, previews serve on `<port>-<previewId>.<domain>` |
| `OSTRA_PREVIEW_WARM_MINUTES` (server) | `60` |
| `OSTRA_PREVIEW_LINK_MAX_DAYS` (server) | `7` |
| `OSTRA_CORE_REPLICA_URL` (server) | this replica's first non-loopback address and `OSTRA_CORE_PORT`, over `http`; the Helm chart sets the pod's IP |
| `OSTRA_RUNNER_BROWSER` (runner) | unset: the runner finds Chrome, Chromium or Edge, else downloads its pinned headless shell |
| `OSTRA_RUNNER_BROWSER_DOWNLOAD` (runner) | `true`; `false` never downloads, and the runner reports no browser |
| `OSTRA_LIBRARY_UPDATE_HOURS` (server) | `24` |
| `OSTRA_MARKETPLACE_SEARCH` (server) | `true`: organizations may turn search on. `false` keeps it off on the install |
| `OSTRA_SKILLS_SEARCH_URL` (server) | `https://skills.sh/api/search` |

---

## 6. Parity

### Adapter parity

| Feature | What it asks | OpenCode | GitHub | The fakes |
|---|---|---|---|---|
| F-121, F-140: the app tools | ostra's MCP server (`mcp`) | yes, in its MCP list (ticket 14) | — | a fake with `mcp` calls them; a fake without it gets only the after-turn screenshots |
| F-140: the app's block in the instructions | the instructions beside `AGENTS.md` | yes | — | the instructions case |
| F-145: library skills | `skills` | yes, as profile skills | — | the profile cases, unchanged |
| F-145: library MCP servers | `mcp`, with remotes behind the proxy and no sign-in | yes, `oauth: false` (ticket 14) | — | the MCP tools case |
| F-145: a skill from a repo | `CodeHostAdapter.readTree` | — | yes (ticket 02) | the fake code host declares it; the tiny adapter doesn't, and its install is refused with the reason |

The parity test (milestone 7's `parity.test.ts`) gains a row for each line above.

### Runner parity

| | `docker` | `kubernetes` | `host` |
|---|---|---|---|
| The box's browser | Chromium in the agent's container, from the image | the same | the machine's Chromium-family browser, or the pinned headless shell |
| Reaching an app's port | the init's forwarder | the pod's `127.0.0.1` | `127.0.0.1` |
| A service as a preview | by its name | at `localhost` | none: `host` runs no services (ADR 0029, difference 1) |
| What the browser can load | the box's network only | public hosts too (ADR 0029, difference 4) | what the machine reaches |
| Webhook forwarders | after F-052 | yes | yes |

None of these is a new allowed difference (ADR 0068). The task does the same thing on each: the same tools, events, blobs and view. A service on `host` and the browser's reach follow from differences ADR 0029 already records. A picture taken on `host` names its browser.

**By carrier** (not an executor difference, ADR 0068): over the HTTP fallback, the browser view at 2 frames a second and no tunnel, so no `ostra preview` and no native preview. The pane and the CLI say so.

---

## 7. Packages, licenses and owners

| Package | License | New in M8 | Built by |
|---|---|---|---|
| `packages/protocol` | Apache-2.0 | minor 7, the preview connection's frames, the app tools, the CLI tunnel | core (01) |
| `packages/adapter-sdk` | Apache-2.0 | `readTree`; the box's processes, browser and forward; the suites' cases and fakes | adapters (02, 03) |
| `packages/adapters/adapter-github` | Apache-2.0 | `resolveRef`, `readTree` | adapters (02) |
| `packages/adapters/adapter-executor-docker`, `-kubernetes`, `-host` | Apache-2.0 | the init's and the process host's processes, browser and forward | adapters (03), runner (11, 12) |
| `packages/adapters/adapter-opencode` | Apache-2.0 | the app tools in its MCP list, the app's block, `oauth: false` | adapters (14) |
| `apps/runner` | Apache-2.0 | the processes, the browser, the tools, the after-turn screenshots, the browser view, the tunnel, `ostra preview` | runner (11, 12, 13, 18, 22, 24) |
| `deploy/` | as milestone 5 left them | Chromium in the base image, and its notices | runner (11) |
| `packages/db` | Sustainable Use | the M8 migration, the isolation fixtures | core (04) |
| `packages/domain` | Sustainable Use | schemas, lifecycles, rules, tokens, the hash, the diffs, use cases, jobs, settings | core (05, 06) |
| `apps/core` | Sustainable Use | app processes and attachments, views and replicas, warm boxes, the app-only dispatch, tunnels, the preview domain, the library, the marketplace | core (15, 19, 23, 25, 27, 28, 29) |
| `packages/api` | Sustainable Use | app processes and attachments, previews and sharing, the native preview's entry, the library | api (16, 20, 30), web (26) |
| `apps/web` | Sustainable Use | the shell, the M8 screens, the preview stream's route handlers, the viewer page | web (10, 17, 21, 26, 31), api (20) |
| `apps/docs` | Apache-2.0 | the pages of section 13's ticket 32 | core (32) |
| `e2e/m8-previews-and-library` (new) | Sustainable Use | the demo, the `test-web` fixture, the fake registry, the stub MCP server, the fake skills search | core (33) |
| `spikes/box-browser-stream`, `spikes/preview-through-core` (new) | throwaway | the two spikes | runner (07, 08) |

The license line holds (ADR 0045, ADR 0048): no Apache-2.0 package depends on a Sustainable Use one. The sidecar's tools reach core over HTTP and the preview connection, and import only `packages/protocol`. `pnpm check:licenses` runs on every commit.

---

## 8. The builders and their tickets

Five builders, as before: **core**, **runner**, **web**, **api** and **adapters**. Core and adapters make the contracts first (01 to 06), each with the fakes its callers need. The runner runs the two spikes at once (07, 08), since the live designs' numbers wait on them. Web makes the screen targets (09) as soon as the double sidebar's own targets are approved, since every new screen is drawn in the new shell. Ticket 34 is the maintainer's.

| # | Ticket | Builder | Blocked by |
|---|---|---|---|
| 01 | Protocol: minor 7 | core | none |
| 02 | Adapter SDK: reading a repo at a commit | adapters | none |
| 03 | Adapter SDK: the box's processes, browser and forward, and the suites' cases | adapters | 01 |
| 04 | DB: the milestone 8 migration | core | none |
| 05 | Domain: app processes, attachments, previews and sharing | core | 01, 04 |
| 06 | Domain: the library | core | 04 |
| 07 | Spike: the box's browser, streamed | runner | none |
| 08 | Spike: a dev server through core over HTTP/2 | runner | none |
| 09 | Milestone 8 screen targets | web | the double sidebar's targets approved (ticket 10) |
| 10 | Web: the double-sidebar app shell | web | its targets in `app-targets/m8/` approved |
| 11 | Images and runner: the box's browser | runner | 03 |
| 12 | Runner: app processes | runner | 01, 03 |
| 13 | Runner: screenshots, recordings and the app tools | runner | 11, 12 |
| 14 | OpenCode adapter: the app tools, the app's block, and servers without sign-in | adapters | 01 |
| 15 | Core: app processes, detection, onboarding and attachments | core | 03, 05 |
| 16 | API: app processes, attachments and screenshot settings | api | 15 |
| 17 | Web: app processes and attachments in the thread | web | 09, 16 |
| 18 | Runner: the browser view on both carriers | runner | 07, 13 |
| 19 | Core: views, replicas, warm boxes and starting the app | core | 05, 07 |
| 20 | API: previews, sharing and the viewer's stream | api | 19 |
| 21 | Web: the preview pane, sharing and the viewer page | web | 09, 20 |
| 22 | Runner: the tunnel and the `docker` forwarder | runner | 08, 12 |
| 23 | Core: tunnels through core, and `ostra preview`'s endpoint | core | 08, 19 |
| 24 | CLI: `ostra preview` | runner | 22, 23 |
| 25 | Core: the preview domain | core | 22, 23 |
| 26 | API and web: the native preview and its settings | web | 09, 21, 25 |
| 27 | Core: the library: install by reference, pins, sources and secrets | core | 02, 06 |
| 28 | Core: attaching, every profile, delivery, updates and suggestions | core | 14, 27 |
| 29 | Core: the marketplace search | core | 27 |
| 30 | API: the library and the marketplace | api | 27, 28, 29 |
| 31 | Web: the library, the profile's items and the marketplace browser | web | 09, 30 |
| 32 | Docs: the running app, previews, the preview domain and the library | core | 17, 21, 24, 26, 31 |
| 33 | The end-to-end demo and the ledger (at the launch gate) | core (lead) | 10 to 32; the maintainer's word for the launch gate |
| 34 | The maintainer's steps outside the code | maintainer | none for the decisions; 33 for the review of the run |

**Who starts when.**
- **core** takes 01 and 04 at once, then 05 and 06; then 15, 19 and 27 as their blockers land.
- **adapters** take 02 at once, 03 after 01, and 14 after 01.
- **runner** takes 07 and 08 at once, then 11 and 12 after 03.
- **api** starts each router once its core ticket is in.
- **web** takes 10 the moment its targets are approved, and 09 right after, since the feature targets are drawn in the new shell. Its screen tickets (17, 21, 26 and 31) wait for 09's approval; their data and tests can go ahead.

Milestone 7's tickets come first wherever both touch a file: a milestone 8 ticket that meets one of milestone 7's still open on the same package waits for it, and says so in its `## Comments`. The launch gate's tickets (milestone 7's 25 to 28, 32 and 33) stay held, and run after milestone 8.

---

## 9. Test seams

Agreed here so builders don't each invent one.

- **Postgres:** milestone 1's helper, a database per test file. Every test that reads data also checks that another organization's rows and a restricted project's rows stay invisible. Milestone 4's generated isolation test gets a fixture for each new model.
- **The browser in tests:** on this machine, Edge through the same pipe client the runner uses. In CI, the Chromium that the Linux job's base image carries. A `FakeBrowser` in `apps/runner/src/testing/` answers the pipe's few DevTools calls with fixed frames, for the unit tests that don't need pixels.
- **The app:** `e2e/m8-previews-and-library/fixtures/test-web/`, which ticket 03 writes, is the demo's app and the tests' app: a Vite and React frontend with `server.proxy` to an API on 3001, a docs page on 4000, a page that sets `X-Frame-Options: DENY`, a page that builds a URL from `Host`, and a WebSocket echo. The runner's tests start it from the fixture, with no network.
- **Executors:** the fake Docker engine and the fake Kubernetes API (milestone 5), grown with the init's process, browser and forward requests. Live on `host` here. The `live-docker` and `live-kind` jobs of `proof.yml` run the executor suite's new cases at the launch gate.
- **Replicas:** two `apps/core` processes on one database, from milestone 6's helper that starts and kills a core by name, with `OSTRA_CORE_REPLICA_URL` pointing at each.
- **Time:** the warm rule, the views' sweep, a link's expiry, the codes' 60 s and the update check read the `Clock` port.
- **The library's sources:** the fake code host (ticket 02) with public repos and a private one behind an installation; a fake well-known host; a fake MCP registry speaking `v0.1` with active, deprecated and deleted entries, a remote with a secret header, a remote that answers with an OAuth challenge, and a packages-only entry; a stub MCP server that answers `tools/list` and one tool; a fake skills search. The live cases run against GitHub's registry and skills.sh only when the run says so, and never in CI.
- **Browsers for the native preview:** Playwright's Chromium and Firefox here. Safari only on a Mac, by hand (ticket 34).
- **Text that is data:** every test of a caption, a recording's steps, an app's log, a skill's files, a server's tool names and a suggestion's note holds shell syntax and prompt-like text, and asserts none reaches a log line, a shell command or a process's argument list. A process's own `command` runs through the init's argument array, never a shell string ostra built from it.

---

## 10. Every ticket's checks and commit

As milestones 1 to 7 (`../m1-first-pr/spec.md`, section 9), and the lead's rules of 2026-11-20 (`C:/Users/santi/ow/_lead/AGENT-RULES.md`). In short:
- **Checks once, then push.** `pnpm typecheck`, `pnpm lint` and `pnpm test` for the touched packages (and their direct consumers when a shared type changes), with `--cache-dir=C:/Users/santi/ow/.turbo-cache`, once before each push. `pnpm check:licenses` passes. GitHub CI runs the rest; a failure from the change is fixed forward.
- **The whole-repo checks** run for tickets that touch auth, credentials, the schema, the runner protocol, webhooks or anything that runs agent output: 01, 03, 04, 11, 12, 13, 18, 19, 22, 23, 25, 27 and 28.
- **Browser suites run once,** at the milestone's end (ticket 33). A fix that needs browser proof runs only its own spec file.
- **A ticket's "(break-it: ...)"** names what its test must catch, and nothing more: no break-it pass runs (*changed 2026-11-21, the maintainer: "keep tests, drop extras"*).
- **Every new setting** has a working default and its line in `docs/configuration.md`. A fresh install with only the required settings still works: no preview domain, no library items, search off, and every task behaves as in milestone 7, with screenshots after a turn only once an environment declares a primary.
- **Proof** (`AGENTS.md`; *changed 2026-11-21, the maintainer: "keep tests, drop extras"*): each condition of a row's "done when" has a test named with its key (`it("F-nnn/c1: ...")`) that exercises it through the real code path, and CI runs it. No break-it pass, no proof file. A condition only a live run shows (Linux, macOS, kind, the e2e workflow) waits for the launch-gate Proof run.
- **No secret in the commit.** Logs carry IDs and fields, never tokens, codes, tickets, captions, steps, app logs, skill files, a server's headers or a suggestion's note.
- **No new dependency without the maintainer's yes** (section 11). A `package.json` change goes with its `pnpm-lock.yaml`.
- **Stage only the ticket's own paths,** no `git add -A`, no stash. A gitmoji message of at most 50 characters, no AI attribution. Rebase onto `origin/main`, then push to `origin main`.
- **Work in a worktree** under `C:/Users/santi/ow/<name>` from `origin/main`, never in `c:/Users/santi/ostra`. Kill every process started with its whole tree, and remove the worktree at the end.
- The ticket file gets its `Status:` updated and a line under `## Comments` with the commit's hash.

### 10.1 How each row gets proved

Each condition of a row's "done when" gets a test named with its key. The building tickets write them, and ticket 33 checks every one. "Needs" names hardware or people this machine lacks. Such a condition keeps its row `building` until it has run (the launch-gate Proof run, or the person), with a dated note in the ledger, never a pass the run didn't show.

| F-ID | Proved by tests (ticket) | Live evidence (step of section 3) | Needs |
|---|---|---|---|
| F-121 | The tools' schemas and refusals; a screenshot taken by the agent, after a turn and by a member, each a blob of the task with its event; a recording as a frame reel within its limits; an attachment still shown after the box stops and after a reopen on a fresh box; the PR's line linking to ostra; "Add to draft"; a finding's attachment; the caption in no log line; the browser named on each; the executor suite's browser case on all three (03, 11, 13, 15, 16, 17) | Steps 3, 4, with the thread's screenshots kept | the Linux jobs, for `docker` and `kubernetes` live |
| F-140 | The environment's rules (one primary, unique names and ports, no reserved port); processes started in order, ready, logged, reported when they fail, stopped with the box; the in-box addresses on each executor; detection over each file kind, with near misses; onboarding's proposal with processes and its screenshot; `show_preview` and "Keep it"; the app's block in the instructions; a Vite `/api` proxy answering under screenshots, the browser view, `ostra preview` and the native preview (05, 12, 13, 14, 15, 16, 17, 22, 25) | Steps 2, 3, 5, 6, 9, 10 | the Linux jobs, for `docker` and `kubernetes` live |
| F-141 | The pane's parts; one shared page per preview; input reaching the page; the reach rule against every reserved port; the warm hold and its cap, with HMR not counting; "Start the app" with no agent session and no model call, and a message then starting a turn in its box; a minor-6 runner refused with the reason; the HTTP carrier at 2 frames a second; two replicas forwarding, and a bad signature refused (05, 07, 18, 19, 20, 21) | Steps 5, 7, and the replicas' check | the Linux jobs, for `docker` and `kubernetes` live |
| F-142 | Each level and its refusals; named people seeing only the preview; a link's expiry, its cap and its revoke; watch-only unless the link allows input; public links only where allowed; the viewer page showing nothing else of the task; failing closed; the audit entries; the token never logged (05, 19, 20, 21) | Step 8 | none |
| F-143 | The ticket single use and 60 s; a port outside the previews refused; HMR, a WebSocket and `/api` through the tunnel; the HTTP carrier refused with the reason; the forwarder taking only the sidecar's address (08, 22, 23, 24) | Step 9 | the Linux job, for the `docker` forwarder live |
| F-144 | The host's parser against a host with no row; the code's binding and single use; the cookie's attributes in both site layouts; the proxy's strips, `Origin` check, rewrites, `hostRewrite` off, the kept `Origin` for outside links, and the framing header; the CSP only with the domain; the panel's cookie host-only and its cross-origin refusal; Vite and Next.js 16 with HMR through it (08, 25, 26) | Step 10 | a Mac, for Safari's partitioned cookie |
| F-145 | The reference parser over the CLI's forms; the hash against the CLI's vector; the skill checks; a private repo through the App and refused without it; the allowlist by source and never by name; a registry entry's remotes only, secrets in the store, the test call and the OAuth mark; attach and every profile within the limits, and a clash refused; delivery as blobs with digests and as proxy paths with `oauth: false`; an update's diff, held until accepted, and the next session getting it; suggestions; the audit (02, 06, 14, 27, 28, 30, 31) | Steps 11 to 14 | none |
| F-146 | Search through core only, behind the organization's switch and the instance's setting; results with their source and whether it's allowed; a result installed through the same flow; a failed search saying so (06, 29, 30, 31) | Step 14 | none |
| F-147 | Every route reachable through the rail and the second sidebar; the collapsed state kept; milestone 7's keyboard walk and contrast check passing on the shell in both themes; the phone sheet at 390 px; ⌘K and the shortcuts unchanged (10) | Step 1, with screenshots of both themes | its targets' approval |

---

## 11. What each ticket ports, and dependencies

**From the spikes** (tickets 07 and 08, new in this milestone):

| From | What | To (ticket) |
|---|---|---|
| `spikes/box-browser-stream/` | the DevTools pipe client, the screencast with acks, the input mapping, the measured frame rate and size defaults | 11, 13, 18 |
| `spikes/preview-through-core/` | HTTP/2 over a `ws` duplex, extended CONNECT for WebSockets, the `Host` and `Origin` rewrite, the `docker` forwarder, the partitioned cookie's attributes | 22, 23, 25 |

Product code never imports `spikes/`. A builder copies the code into the product's package and adapts it, with a one-line provenance comment (`// Ported from spikes/<spike>/<path>.`).

**Dependencies.** None new in npm. ostra's own DevTools client over the pipe, Node's `http2`, `ws` (already in the runner and core), and ostra's own hash, parsers and diffs carry everything. `playwright-core`, `yamux-js` and the `skills` CLI were considered and aren't added (ADR 0068, ADR 0069). If a spike fails, `yamux-js` is the named fallback, and asks the maintainer first with its ADR 0007 line drafted.

**In the base image:** Debian's `chromium` package at a pinned version, with its notices. It's the browser the maintainer's F-121 asked for, and adds no npm package. Ticket 11 records its size; ticket 34 asks the maintainer to look at it.

**On `host`:** the runner downloads Chrome for Testing's `chrome-headless-shell` only when the machine has no Chromium-family browser, pinned by version and SHA-256 in the runner's release. It's a public download carrying no usage data, and the maintainer can turn it into "use the machine's browser only" (Q311, ticket 34).

---

## 12. Choices this spec makes

Each is recorded in `context/open-questions.md` under its number and in ADR 0068 or ADR 0069. Q296 to Q298 are the maintainer's own answers. Q299 to Q303 are the lead's recommendations, which the maintainer said "yes" to as a group on 2026-11-21. Q304 to Q324 are the lead's call on the research's recommendations, which the maintainer can still change: such a change moves the question back to the open list, and the ticket that holds it changes.

**The maintainer's answers:**
1. **The preview domain is optional** (Q296, ADR 0068). Welcome, never required. Unset, the browser view, `ostra preview` and screenshots carry everything.
2. **Who can open a preview is configurable** (Q297, ADR 0068). The project's members by default, named people, an expiring link, or public where an admin allows it.
3. **A frontend plus its API** (Q298, ADR 0068). App processes declared in the environment, with the dev-server proxy pattern.

**The lead's recommendations, which the maintainer said "yes" to as a group:**

4. **Warm while watched** (Q299, ADR 0068, ADR 0039 amended). Up to 60 minutes after the last turn or app start, by the panel's heartbeat, never the app's HMR socket.
5. **Start the app without an agent turn** (Q300, ADR 0068). A lease with the purpose `app`, from the branches and the hidden ref, launching no agent.
6. **Links for people outside the project are watch-only unless the link allows input** (Q301, ADR 0068).
7. **Webhooks come in through forwarders that dial out,** not an ostra entry point (Q302, ADR 0068).
8. **No third-party tunnel is built in** (Q303, ADR 0068).

**The lead's call on the previews research** (`research/live-previews.md`'s open questions):

9. **The `Host` and `Origin` rewrite** (Q304, research question 6). On by default; off per app process for an app that builds URLs from its host; the browser's `Origin` kept on WebSocket upgrades for links for outside people.
10. **Several core replicas** (Q305, research question 4). Forward a view to the replica that holds the box's preview connection, signed under the secrets key; a one-machine install never forwards.
11. **The HTTP fallback carrier** (Q306, research question 5). The browser view at 2 frames a second; no tunnel, so no `ostra preview` and no native preview, recorded as a limit by network.
12. **A domain of its own, or a subdomain** (Q307, research question 1). Both allowed; the docs recommend a registrable domain of its own and warn on a subdomain of the panel's.
13. **Where F-121 goes** (Q308, research question 7). Into v1, in milestone 8, the maintainer having agreed to move it earlier.
14. **App processes beside services** (Q309, research question 8). A second list, and a service can be marked a preview.
15. **One origin** (Q310, research question 9). The agent's instructions and onboarding propose it; no cross-host CORS under the native preview yet.
16. **The box's browser** (Q311). Chromium: Debian's in the images; on `host` the machine's, else a pinned, checksummed download, which `OSTRA_RUNNER_BROWSER_DOWNLOAD=false` turns off.
17. **Recordings** (Q312). Frame reels the panel plays; no video encoder in the box.
18. **Detected ports** (Q313). Later; previews reach declared and announced ports, the same on every executor.
19. **The browser view's pages** (Q314, research question 11's neighbour). One page per preview, shared by everyone watching; any member who can open the project may give input.

**The lead's call on the library research** (`research/skills-and-mcp-marketplaces.md` §7.6):

20. **Scope** (Q315, question 1). An organization library attached to profiles, with "every profile"; projects pick profiles; nothing per task.
21. **Outbound calls** (Q316, question 4). Installs and update checks are calls the organization sets up; marketplace search is off by default, an organization admin's switch, and `OSTRA_MARKETPLACE_SEARCH=false` disables it on the install. ADR 0021 amended.
22. **The skills search** (Q317, question 5). skills.sh's CLI search endpoint through core, documented as undocumented; installing by reference never depends on it.
23. **Our own code** (Q318, question 6). The fetch, the discovery and the CLI's documented hash, with no `skills` CLI.
24. **Audits** (Q319, question 7). None shown in this milestone.
25. **stdio servers with a secret** (Q320, question 8). Later, in their own container; remote servers only now.
26. **OAuth MCP servers** (Q321, question 9). Later; a server that asks for it is marked and can't be attached.
27. **Who installs, and the allowlist** (Q322, question 10). Org admins install; members suggest; sources matched by owner, repo, host or registry and namespace.
28. **Updates** (Q323, question 11). A diff that waits for an admin; running tasks get it at their next session.
29. **Registries** (Q324, question 12). GitHub's curated registry on every organization's list, plus any registry URL an admin names.

Questions 2 and 3 of the library research (repo skills by default, and name clashes) aren't settled here: the `repo-skills` work settles them.

---

## 13. Screens that need a design target

`build-order.md`: a milestone's screens are designed first, image first. The maintainer requires the `ui-taste` skill and Higgsfield targets, approved before building, against `context/brand/brief.md` and `context/brand/app-design.md`. **This spec names them; ticket 09 makes them,** in the form milestones 1 to 7's approved targets have (`context/brand/app-targets/m1/README.md`: a picture, a build spec and a prompt per screen), in `context/brand/app-targets/m8/`. Every one is drawn in the double-sidebar shell, so ticket 09 starts once the shell's own targets are approved. Until 09's are approved (recorded in its `## Comments`), tickets 17, 21, 26 and 31 don't start their UI; their routers and tests can go ahead.

**The double sidebar's targets are being made now,** by a design agent working in the `m8-targets` worktree, and land in `context/brand/app-targets/m8/` with their README. Ticket 10 builds them once the maintainer approves them, and records the approval.

**New targets** for ticket 09:

| # | Target | Screen | Feature | Starts from |
|---|---|---|---|---|
| 1 | `task-preview-pane` | The task page with the pane beside the thread: the previews primary first, each with its label and source, the path field, reload, the width preset, "Expand", "Take a screenshot", "Share", the watchers' count, the view's line ("Live: the box's browser"), the box's state | F-141 | `app-targets/m1/task` |
| 2 | `task-preview-expanded` | The same pane at the page's width, the thread hidden behind a floating steer bar (approved 2026-11-21, in place of a strip) | F-141 | `task-preview-pane` |
| 3 | `task-preview-stopped` | The pane on a stopped task: the last screenshot, "Start the app", the starting progress (setup, processes, ready), and the states a runner below minor 7 or on the HTTP carrier shows | F-141 | `task-preview-pane` |
| 4 | `task-attachments` | Screenshots and a recording in the thread at their place in the turn, with captions and the browser; the lightbox; the recording's player with its steps; "Add to draft"; the PR's line | F-121 | `app-targets/m1/task` |
| 5 | `environment-app-processes` | The environment's app processes: the list (label, repo and folder, command, port, ready check, primary), the editor sheet, `hostRewrite`, "Screenshots after each turn" with routes and widths, a service's "has a web UI", detected and proposed processes, and a process the agent announced waiting as a proposal | F-140 | `app-targets/m1/environment` |
| 6 | `preview-share` | The share dialog: the four levels, the named-people picker, a link's expiry and "Allow input", public greyed with why, the existing links with their first use and revoke | F-142 | `app-targets/m4/member-invite` |
| 7 | `preview-viewer` | The page a signed-out person opens from a link: the stream alone, the preview's label, "watch only" or input, the expiry, and the expired and revoked states | F-142 | `task-preview-pane` |
| 8 | `preview-native` | The pane with the native preview: the app in a frame, "In your browser", "Open in a new tab", the note that the framing headers were replaced | F-144 | `task-preview-pane` |
| 9 | `instance-preview-domain` | The instance's settings for the preview domain: the domain, the one DNS record and the certificate to add, the check with its result, and the organization's "Allow public preview links" | F-144, F-142 | `app-targets/m4/instance-settings` |
| 10 | `library` | Organization → Library: skills and MCP servers, each with its source, pin, hash, "Every profile", the profiles it's on, an update waiting, a source no longer allowed; the suggestions' count; the empty state | F-145 | `app-targets/m3/agent-profiles` |
| 11 | `library-install` | Install by reference: the reference field, the skills found in a repo to pick from, the commit, the files with their sizes and the scripts pointed out, the hash, "Allow this source"; for a server, its remote, the inputs with the secret ones, the test call's tools, and the OAuth and packages-only refusals | F-145 | `app-targets/m3/agent-profile` |
| 12 | `library-update` | An update: a skill's changed files with their diff, or a server's changed fields and tools, and "Accept" and "Dismiss" | F-145 | `app-targets/m3/task-changes` |
| 13 | `library-suggestions` | A member's "Suggest" form, and the admins' list with "Install" and "Dismiss" | F-145 | `app-targets/m4/memory-proposals` |
| 14 | `library-browse` | The marketplace browser: the search, the skills and servers tabs, results with source, installs or version and whether the source is allowed, the off state with the switch, and "search unavailable" | F-146 | `app-targets/m4/search-palette` |
| 15 | `agent-profile-library` | The profile editor's skills and MCP servers: the profile's own, the attached library items with their pins, the inherited every-profile ones, the attach picker, and the limit's refusal | F-145 | `app-targets/m3/agent-profile` |

**Screens that only grow**, built against their existing targets with the changes listed in the ticket that builds them:
- `app-targets/m6/environment-proposal`: the app processes in the proposal's diff, and the onboarding task's screenshot.
- `app-targets/m6/refine-draft`: an attachment among the draft's images.
- `app-targets/m6/review-screen`: a finding's attachments beside it.
- `app-targets/m4/audit-log`: the new actions' words.
- `app-targets/m3/account`: the CLI session's line says it can open previews.
- Organization settings: "Allow public preview links" and "Marketplace search", each with its words on what it sends where.
