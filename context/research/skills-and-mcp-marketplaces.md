# Research: installing skills and MCP servers from marketplaces

**Status:** Research v1 · **Checked:** 2026-11-20 (every source below was read on this date unless marked) · **Informs:** F-021 (agent profiles), ADR 0049 (its "MCP servers and skills" section), ADR 0021 (outbound fetches), ADR 0030, ADR 0031, F-052, F-116. Nothing here is a decision. The lead will take it to the maintainer.

**Question.** The maintainer, 2026-11-20: "also skills.sh skills, can those be installed globally and per agent profile? or how does that work? … i know we can add skills. but who adds skills manually in 2026 lol, you just want the skills.sh marketplace or anything that can be installed using npx skills or something. is there a skills.sh equivalent for mcp's as well? how would that work? for now just research so we can discuss."

**How it was read.** Vendors' docs, specs and API references were read through Tavily. These repos were read at fixed points: `vercel-labs/skills` at `57217cf` (v1.9.0, 2026-11-17); `agentskills/agentskills` at `83021e2` (2026-11-04); `anomalyco/opencode` at tag `v2.3.2`, the version ostra pins; and `modelcontextprotocol/registry` at `96f6a24`. The claims ostra's design rests on were read again directly from source for this note: OpenCode's skill discovery, the `skills` CLI's lock, the skills.sh API's auth and the MCP Registry's consumption model. So were a few live API calls ([LIVE]). Every claim cites a source key from [Sources](#sources). **Secondary** marks a news write-up or a third party's summary. **Unverified** marks anything no primary source confirmed. **Inferred** marks a conclusion from reading code, never run.

---

## Summary

1. **skills.sh and `npx skills` are Vercel's, and the CLI is MIT.** `npx skills add <source>` fetches skills (folders holding a `SKILL.md`) from a GitHub repo, any git URL, a local path, a direct download, or a website's `/.well-known/agent-skills/index.json`. It writes them to one canonical folder, `.agents/skills/<name>`, and symlinks each agent's own folder to it. That's project scope by default; `-g` gives global scope, `~/.agents/skills` [SK]. skills.sh has no submission step: it ranks the skills the CLI's install telemetry reports [SKSH-DOCS]. The CLI runs headless (`-y`, `--agent`, `--skill`, `--json`). A prompt with no TTY exits 1, never 0 [SK].
2. **The lock pins content and, since v1.9.0, the commit.** `skills-lock.json` v2 records the source, its `ref`, the `commit` it came from, and a `computedHash`. That hash is a documented SHA-256 over the skill's files. `skills install --frozen-lockfile`, the default in CI, refetches each skill at its commit and fails on any hash mismatch [SK]. This repo's own lock is still v1, with no `commit`. The CLI upgrades it on read [OS-LOCK; SK].
3. **"Per agent profile" doesn't exist in the CLI.** Its scopes are a project's folder or the user's home, per agent [SK]. Comparable products each add a layer the CLI lacks: an organization or enterprise library, a team marketplace, or managed folders (Claude Code, Cursor, Devin, Codex; section 4). For ostra, the profile is that layer, and today a profile's skills are already delivered the right way. Core copies them into task blobs with a digest at each dispatch, and the runner writes them into the task's own folder [OS-DISPATCH; OS-RUNNER]. What's missing is the acquisition step: fetch from a source, pin, update.
4. **The Agent Skills format is a Linux Foundation standard now, and nearly every coding agent reads it.** It started as Anthropic's format and was published as an open standard. Anthropic has since donated it to the Agentic AI Foundation. The announcement counts "more than 70 agent platforms", "1 million skills" published and "nearly 280 million installed" [AAIF-SK]. OpenCode 2.3.2 reads `.opencode/skills`, `.claude/skills` and `.agents/skills` in the project and at home, plus a `skills` config array of folders or HTTP catalogs [OC].
5. **A gap in today's code: a repo's `.agents/skills` and `.claude/skills` never reach the agent** *(inferred from source, not run)*. ostra launches OpenCode with `OPENCODE_DISABLE_PROJECT_CONFIG=1` and `OPENCODE_DISABLE_CLAUDE_CODE=1`. Those two switches turn off OpenCode's whole project walk and its `.claude` skill folders [OC]. ostra then names only `<repo>/.opencode/skills` in `skills` [OS-OC]. Yet `npx skills add -a opencode` installs into `.agents/skills` [SK]. So a repo set up with the CLI loses its skills inside an ostra task, against F-021's "beside the repo's own skills". Separately, OpenCode lets a later `skills` entry win for the same ID [OC]. ostra lists the profile's folders first, so a repo skill with the same ID replaces the profile's.
6. **The MCP equivalent is the official MCP Registry, plus sub-registries.** `registry.modelcontextprotocol.io` is still "in preview", with a frozen `v0.1` API [REG]. It holds `server.json` metadata, not code. The metadata covers npm, PyPI, NuGet, OCI or MCPB packages, and remote streamable-HTTP endpoints, with each input marked `isSecret` [REG; SJ]. Namespaces are proved by GitHub login or by DNS or HTTP. A package proves it belongs to its server name (npm's `mcpName`, an OCI label, a README marker). A remote URL is never verified [REG]. The registry says it "is not intended to be directly consumed by host applications"; hosts should use sub-registries that implement its OpenAPI [REG]. GitHub's registry is one of those (896 servers live today), and so is Docker's catalog (300+ servers as container images; the ones Docker builds, it signs) [GH-MCPREG; DK]. Smithery shut down its connection services on 2026-10-31 [SM]. `add-mcp` is the closest thing to `npx skills` for MCP: it writes about 25 agents' configs, OpenCode's V2 `mcp.servers` among them, and it can search the official registry [ADDMCP].
7. **Neither marketplace is a security review.** The MCP Registry: "consumers should assume minimal-to-no moderation", and it won't remove "servers with security vulnerabilities" [REG]. skills.sh runs automated audits by Gen, Socket and Snyk at first install, hides skills flagged malicious, and its terms say it "cannot guarantee the … safety … or security of any skill" [VC-AUDIT; SKSH-DOCS]. The incidents are real:
   - **Malicious MCP packages:** `postmark-mcp`, which BCC'd every email [KOI-PM], and an npm MCP package that opened a reverse shell [CX-LANYER].
   - **Worms:** npm worms that write rogue MCP servers into Claude, Cursor and Windsurf configs (SANDWORM_MODE, Shai-Hulud) [SOCK-SW; OX-SH]. One Shai-Hulud wave was delivered through an official-registry entry whose linked repo carried the payload [OX-SH].
   - **Skill malware at scale:** 341 of 2,857 ClawHub skills were malicious [ANTIY-CH]. A scan of 3,984 skills from ClawHub and skills.sh found 76 confirmed payloads [SNYK-TS].
   - **Attack classes:** tool poisoning, rug pulls and "toxic agent flows" through a trusted server [INV-TP; INV-GH].
8. **Org policy elsewhere is an allowlist matched by URL or by exact command, never by name.**
   - Claude Code (`allowedMcpServers`, `deniedMcpServers`, `allowManagedMcpServersOnly`, `strictKnownMarketplaces`, `strictPluginOnlyCustomization`) and GitHub Copilot's managed settings use the same entry shapes. Claude Code's docs: a name entry "is not a security control" [CC-MMCP; GH-ALLOW].
   - GitHub now calls its "registry only" policy the weaker option, bypassable by editing a file [GH-ALLOW].
   - Codex matches a server by its name and identity together [CX-MAN].
   - Copilot's cloud agent is the closest analogue to ostra. It reads a repo-level MCP JSON with a required `tools` allowlist, takes secrets only from `COPILOT_MCP_`-prefixed Agents secrets, and supports no OAuth remote servers [GH-CA-MCP].
9. **ostra's box rules decide how anything reaches the agent.**
   - **Egress:** on `docker` the agent's container has no route out except the sidecar's proxies [ADR 0029; OS-DOCKER]. So `npx -y some-mcp-server` or `npx skills add` can't run at box start there. On `kubernetes` they could (direct public egress), and on `host` too. Fetching inside the box would break runner parity.
   - **Skills:** core-cached delivery, as today, is the one path that behaves the same on every executor.
   - **MCP:** an HTTP server goes through the sidecar's MCP proxy with secret headers from the store [OS-MCPPROXY]. That already fits a registry entry's `remotes[]` that take an API key. It doesn't fit OAuth remotes, which are OpenCode's default and the spec's direction [OC; MCP-SPEC]. A stdio server must already be in the image and hold no secret [ADR 0049]. That rules out most registry stdio servers that need a token.
10. **Marketplace calls are new outbound fetches under ADR 0021.**
    - Today the models.dev catalog is the only fetch the server makes on its own [ADR 0021].
    - The `skills` CLI sends telemetry to skills.sh by default, search queries included. `DISABLE_TELEMETRY` or `DO_NOT_TRACK` turns off the telemetry and the audit lookups together [SK].
    - skills.sh's documented v1 API takes only a Vercel OIDC token, so an app has to run on Vercel to use it ([SKSH-API]; [LIVE] got 401 without one). The CLI's own search endpoint answers with no token, but it isn't documented as a public API [LIVE; SK].
11. **Recommendation** *(not a decision)*. Four steps, in order:
    - First, fix the repo-skill gap, and settle what wins when a profile skill and a repo skill share a name.
    - Then add an **organization library** of skills and MCP servers. A skill is installed by reference (`owner/repo@skill`, a git URL, a well-known URL), fetched by core at a pinned commit, and hashed the `skills` CLI's way. Library entries attach to profiles. Delivery stays core's blobs, the same on every executor. An MCP entry comes from a registry name and prefers the entry's `remotes[]` through the MCP proxy, with its `isSecret` inputs kept in the secret store.
    - A **marketplace browser** comes after that: admin-only, opt-in under ADR 0021, searching skills.sh and a registry through core.
    - Last: an OAuth broker in core, stdio MCP servers in their own container, which amends ADR 0049, and tool-list pinning in the MCP proxy.

    Twelve open questions for the maintainer close the note ([section 7.6](#76-open-questions-for-the-maintainer)).

---

## 1. How ostra handles skills and MCP servers today

### 1.1 Stored on the profile

- **A skill is a row of the profile:** its name, its `SKILL.md` text, and up to 20 other files as blobs (`[{ path, blobId }]`), unique per profile [OS-SCHEMA]. The limits are working values: 1 MiB a file, 20 files a skill, 50 skills a profile, 20 MCP servers a profile [OS-LIM].
- **The save checks the shape.** A name is lowercase letters, digits and dashes. File paths must be relative, stay inside the skill, appear once, and never be `SKILL.md` itself [OS-SETUP].
- **There is no source, version or provenance field.** A skill is whatever an admin typed or uploaded [OS-SCHEMA; OS-PANEL].
- **The editor offers two ways in:** a `SKILL.md` text box, and a file picker. The picker uploads each file at once to `/api/agent-profiles/skill-files`, which hands it to the blob service [OS-PANEL].
- **MCP servers are a JSON column** of discriminated entries, written through one schema [OS-SETUP]:
  - **`http`:** a name, a URL, `readOnly`, and `headerSecretRefs`, a map of header name to secret-store reference. A header's value is never stored on the row.
  - **`stdio`:** a name, a command, arguments, environment variables, and `readOnly`.
- Every save is audited by the names of the fields that changed, never their values [OS-SETUP].

### 1.2 How they reach the box

- **Skills.** At each dispatch, core reads the profile's skills as they are then and copies each body and file into the blob store as blobs of the task. The task spec names them by blob ID [OS-DISPATCH].
  - A task stores its profile's ID, not a copy, so an edit to a profile reaches the next session of every task on it *(inferred from [OS-DISPATCH] and `task-profile.ts`)*.
  - The runner downloads each blob, checks it against the digest core sent, and writes the skill to `<agentDir>/skills/<name>/`, never into a repo. A skill that can't be fetched whole is left out, and the log names it [OS-RUNNER].
- **HTTP MCP servers** become a path on the sidecar's MCP proxy (`/mcp/<name>`). The proxy forwards streamable HTTP to the real URL with the headers from the task's credentials, so the agent sees neither the URL nor the headers. It logs the server, the status and the bytes [OS-SPEC; OS-MCPPROXY].
- **stdio MCP servers** travel in the spec as a command, its arguments and its variables, "never a secret: a server that needs one is an HTTP server behind the proxy" [OS-SPEC; ADR 0049].
- **The executors change what a box can reach.**
  - **`docker`:** the agent's container is on an `internal` network, "no route out at all", and its only exit is the sidecar [OS-DOCKER; ADR 0029].
  - **`kubernetes`:** the agent keeps direct public egress, a recorded difference [ADR 0029, ADR 0031].
  - **`host`:** not isolated [ADR 0031].

### 1.3 How OpenCode is configured with them

What ostra writes, as the adapter has it [OS-OC]:

- **`skills`:** the profile's skill folders first, then `<workspace>/.opencode/skills` and `<workspace>/<repo>/.opencode/skills` for each repo. A wildcard entry "finds nothing (checked on 2.3.2)".
- **The instructions file** also names each profile skill by its ID. OpenCode lists a skill to the model only when its front matter has a `description`, and a profile skill may have none.
- **`mcp.servers`:** an HTTP server as `{ type: "remote", url: <sidecar proxy URL>, codemode: false }` with no header, and a stdio server as `{ type: "local", command: [cmd, ...args], environment, codemode: false }`. ostra's own server, `ostra`, is added beside them with a task bearer token.
- **The environment:** `HOME`, `XDG_CONFIG_HOME` and the other home folders point into the task's own folder. `OPENCODE_DISABLE_PROJECT_CONFIG=1` keeps a repo's `opencode.json` and `.opencode/` from widening the profile (ADR 0049, Q171). `OPENCODE_DISABLE_CLAUDE_CODE=1` is set as well.

### 1.4 The gap: the repo's `.agents/skills` and `.claude/skills` *(inferred, not run)*

- **What OpenCode 2.3.2 does with those switches** [OC]:
  - With `OPENCODE_DISABLE_PROJECT_CONFIG` set, it passes `project: false` to config discovery. Discovery then skips the upward walk entirely (`options?.project === false ? [] : fs.up(...)`), and the walk is what finds a project's `.claude`, `.agents` and `.opencode` folders (`packages/core/src/config/discovery.ts`).
  - `OPENCODE_DISABLE_CLAUDE_CODE` also sets `claude: false`, with the comment "Config reads .claude only for skills" (`packages/cli/src/server-process.ts`).
  - The global folders are the task's own empty home, because ostra sets `HOME` [OS-OC].
- **So a repo's skills reach the agent only from `.opencode/skills`,** the one folder ostra names. The `skills` CLI installs a project skill for OpenCode, Codex, Cursor, GitHub Copilot and Gemini CLI into `.agents/skills/`, and for Claude Code into `.claude/skills/` [SK].
- **Precedence.** OpenCode registers sources "from lower to higher precedence", and explicit `skills` entries come last, "in config priority and array order". "If two sources define `git-release`, the source registered later supplies the skill" [OC]. With ostra's order (profile, then repos), a repo's `.opencode/skills/<id>` beats the profile's skill of the same ID.
- **What the spec suggests.** It says "project-level skills override user-level skills" is the universal convention. It also says project skills "may be untrusted" and suggests "gating project-level skill loading on a trust check" [AS-CLIENT].

### 1.5 How this repo installs its own skills (first-hand)

- **The lock.** `skills-lock.json` is `"version": 1` with 47 skills. Each entry has `source` (`owner/repo`, or `uizze.sh`), `sourceType` (`github` or `well-known`), `skillPath`, and `computedHash`. The two well-known entries also carry `sourceUrl` and `wellKnownDigest: "sha256:…"`. No entry has a `commit` [OS-LOCK].
- **On disk.** The installed folders sit in `.agents/skills/<name>/`, and each `.claude/skills/<name>` is a symlink to it. Both folders are git-ignored ("Installed agent skills: third-party, under their own licenses. Reinstall from skills-lock.json") [OS-LOCK].
- **This is the CLI's documented layout:** a canonical copy plus a symlink for each agent [SK].

---

## 2. skills.sh and the `npx skills` CLI

### 2.1 Who, licence, version

- **Vercel makes both.** The CLI's LICENSE reads "MIT License / Copyright (c) 2026 Vercel, Inc.". The npm `latest` is 1.9.0, licence MIT, published 2026-11-16, and it needs Node 22.20 or later [SK; SK-NPM].
- **Launch.** Vercel announced the CLI and skills.sh together [VC-INTRO]. The date was 2026-01-20 per Snyk (**secondary** for the date) [SNYK-VC].
- **Recent changes:**
  - **v1.8.0:** "verifiable, portable computedHash and lock v2", and `skills install` with no source restores from the lock.
  - **v1.9.0:** "pin lock entries to the installed commit" [SK].

### 2.2 Sources it installs from

From `docs/commands.md` and `src/source-parser.ts` [SK]:

- **GitHub:** `owner/repo`, `owner/repo/path`, `owner/repo@skill`, `github:`/`gitlab:` prefixes, full GitHub URLs (with `/tree/<ref>/<path>`), and GitHub Enterprise through `GH_HOST`.
- **Pins:** `#ref` pins a branch or tag. `@v1.2.3` or `@<40-char SHA>` is a checkout pin, not a skill name.
- **Other git hosts and local:** GitLab URLs, Azure Repos URLs, any git URL (`git@…`, `ssh://…`, `https://….git`), and local paths.
- **Direct downloads:** a URL to a `SKILL.md`, or to a `.zip`/`.tar.gz` archive. Limits: 10 MiB downloaded, 25 MiB extracted, 1,000 files. A signed URL (one with a query string or user info) "is not recorded".
- **Well-known:** `https://<site>/.well-known/agent-skills/index.json` (falling back to the legacy `/.well-known/skills/index.json`).
  - v0.2.0 entries carry `type`, `url` and `digest: sha256:…`. A digest mismatch is an error "rather than downgrading to an index or download without integrity verification".
  - The format is Cloudflare's "Agent Skills Discovery via Well-Known URIs" draft v0.2.0, which also says "clients SHALL NOT execute scripts by default" [CF-WK]. A pull request to add it to the Agent Skills spec is still open, so it isn't part of the published spec yet (agentskills/agentskills#254) [AS].
- **Packs and npm:** skills.sh packs (`https://skills.sh/p/<id>`), Notion pages, and skills shipped inside npm dependencies (`experimental_sync`, through a `package.json` `skills` field).
- **Private repos:** git credentials, then `gh repo clone`, then SSH. "It does not execute `gh auth token`."

### 2.3 Commands and headless use

From `docs/commands.md` and `src/cli.ts` [SK]:

| Command | What it does |
|---|---|
| `add <source>` | Installs. `-g` global, `-a <agents…>`, `-s <skills…>` (`'*'` for all), `-l` list only, `--copy` instead of symlinks, `--rename`, `-y`, `--all`, `--json` |
| `remove` | Removes only skills the lock tracks: "Skill folders the lock does not track… are never deleted" |
| `list` | Each project skill's state against the lock: `tracked`, `modified`, `untracked`, `missing`; `--json` |
| `find [query]` | Searches skills.sh; `--owner` |
| `check` | Exits 1 when a skill has an update or local changes, "so it can gate CI" |
| `update` | Moves skills, and their locked `commit`, forward |
| `install` (no source) | Restores from the lock; `--frozen-lockfile` is the default in CI; "Restore never prompts" |
| `init` | Writes a `SKILL.md` template |

- **Headless.** The docs show `npx skills add … --skill X -g -a claude-code -y` as "CI/CD friendly". A prompt with no TTY exits 1 with `SKILLS_PROMPT_REQUIRES_TTY`, because "Exiting 0 there reports success to scripts and CI even though nothing was installed" (`src/add.ts`) [SK].
- **CI detection.** `CI`, `GITHUB_ACTIONS` and similar variables switch frozen-lockfile on (`src/ci.ts`) [SK].

### 2.4 Scopes and per-agent folders

- **The CLI has two scopes, project and global** (`-g`) [SK].
- **The canonical copy** is `<cwd>/.agents/skills/<name>`, or `~/.agents/skills/<name>` for global. Symlinks are the default; `--copy` copies instead [SK].
- **The global lock** is `$XDG_STATE_HOME/skills/.skill-lock.json`, else `~/.agents/.skill-lock.json`. It is version 3 and records a GitHub tree SHA per skill [SK].
- **The CLI knows "OpenCode, Claude Code, Codex, Cursor, and 75 more" agents** [SK]. Its folders for the ones that matter to ostra (`docs/agents.md`):

| Agent | `--agent` | Project | Global |
|---|---|---|---|
| OpenCode | `opencode` | `.agents/skills/` | `~/.config/opencode/skills/` |
| Claude Code | `claude-code` | `.claude/skills/` | `~/.claude/skills/` |
| Codex | `codex` | `.agents/skills/` | `~/.agents/skills/` |
| Cursor | `cursor` | `.agents/skills/` | `~/.cursor/skills/` |
| GitHub Copilot | `github-copilot` | `.agents/skills/` | `~/.copilot/skills/` |
| Devin for Terminal | `devin` | `.devin/skills/` | `~/.config/devin/skills/` |

### 2.5 The lock, pinning and integrity

- **Lock v2 fields:** `source`, `sourceUrl`, `ref`, `commit`, `sourceType`, `skillPath`, `skillName`, `computedHash`, `wellKnownDigest` and `installMode`. It is "timestamp-free to minimize merge conflicts" (`src/local-lock.ts`) [SK].
- **`computedHash`** is documented so "tools that check skills themselves can compute the same" [SK]:
  - collect the skill's files, minus `metadata.json`, `.git`, `__pycache__` and `__pypackages__`, following symlinks that stay inside the skill;
  - turn CRLF into LF in text files;
  - sort by the UTF-8 bytes of each path;
  - feed `path\0<length>\0<content>` for each file into one SHA-256.

  The README gives test vectors. One `SKILL.md` holding `# hi\n` hashes to `93c36952…2f55`.
- **Commit pinning.** "For a Git source, the entry also records the `commit` the skill came from. `skills install` … fetches that commit, not the latest commit on `ref`" [SK].
- **Frozen restores.** "every restored skill must match the content hash … An entry with no hash is an error". Without frozen, changed content is installed and the lock updated [SK].
- **Upgrading a v1 lock.** It happens on read, with no network. A skill still matching its v1 hash gets a new hash; "any other entry gets an empty hash" [SK].
- **The skills.sh fast path.** A GitHub install with no explicit ref downloads file snapshots from `https://skills.sh/api/download/<owner>/<repo>/<slug>`, not from GitHub. The CLI checks each file's git blob SHA against GitHub's Trees API. An explicit ref skips this path (`src/blob.ts`) [SK].

### 2.6 What skills.sh exposes

- **Pages:** a leaderboard (all-time, trending, hot) and a page per skill, showing installs, the repository, GitHub stars, "First Seen" and "Security Audits". There are also `/audits`, `/official` and packs, which are "unlisted, not access-controlled" [SKSH-DOCS].
- **Install counts are telemetry.** "The skills leaderboard ranks skills based on anonymous telemetry data collected from the `skills` CLI" [SKSH-DOCS].
  - The CLI sends a GET to `https://www.skills.sh/tele/t` on install, remove, update, find and sync. It carries the version, a CI flag, the detected agent, the source, the skills and, for `find`, the query (`src/telemetry.ts`).
  - Identifiers of a GitHub repo are sent only when GitHub confirms it is public.
  - `DISABLE_TELEMETRY` or `DO_NOT_TRACK` turns off telemetry and the audit lookups together [SK].
- **Two search APIs:**
  - **The CLI's** `GET https://skills.sh/api/search?q=…` answered with no token today. It returned `searchType: "fuzzy"` and `{id, source, skillId, name, installs}`; `mattpocock/skills/code-review` showed 915,365 installs [LIVE; SK `src/find.ts`].
  - **The documented v1 API** has `/api/v1/skills`, `/search`, `/curated`, `/{source}/{skill}` (with a `hash` and the files) and `/audit/{source}/{skill}` [SKSH-API].
    - Its only auth is a Vercel OIDC token: "If your app is deployed on Vercel, you can authenticate using the project's OIDC token". It allows 600 requests a minute per team and project.
    - Without a token it answered 401 [LIVE].
    - Vercel says the API indexes "more than 600,000 skills" [VC-API].
- **Audits.** "Working with our partners Gen, Socket, and Snyk … audit over 60,000 skills. Skills flagged as malicious are automatically hidden from the leaderboard and search results". From `skills@1.4.0`, `add` shows the results before it installs [VC-AUDIT].
  - The API docs list five partners: Gen Agent Trust Hub, Socket, Snyk, Runlayer and ZeroLeaks. What Runlayer and ZeroLeaks check is **unverified** [SKSH-API].
  - Audits run "automatically after a skill is installed for the first time" [SKSH-API].
  - Socket: "Vercel uploads the skill source code to Socket's APIs", and "skills can become malicious at any point. They're decentralized in Git repositories, not hosted by Vercel" [SOCKET-SK].
- **Terms:** "we cannot guarantee the quality, safety, correctness, or security of any skill", and "We do not own, host, or relicense skill content" [SKSH-DOCS].

### 2.7 The Agent Skills format

- **Origin.** "originally developed by Anthropic, released as an open standard" [AS]. Anthropic has donated the name, the GitHub organization and agentskills.io to the Agentic AI Foundation [AAIF-SK]. The governance file was "Adopted November 4, 2026", and code and specs are Apache-2.0 [AS].
- **`SKILL.md` front matter** [AS-SPEC]:

  | Field | Rule |
  |---|---|
  | `name` | Required. At most 64 characters, lowercase letters, digits and hyphens. Must match the folder's name |
  | `description` | Required. 1 to 1,024 characters, saying what the skill does and when to use it |
  | `license`, `compatibility`, `metadata` | Optional. `compatibility` is at most 500 characters; `metadata` is a string-to-string map |
  | `allowed-tools` | Optional, "Experimental" |

- **Folders.** A skill may have `scripts/`, `references/` and `assets/` folders. Its content loads in stages: about 100 tokens of metadata at startup, the body on activation, and the other files on demand. The guide says to keep `SKILL.md` "under 500 lines" [AS-SPEC].
- **Validator.** `skills-ref` validates a skill, and says it is "intended for demonstration purposes only" [AS].
- **Where clients look.** The client guide: "The `.agents/skills/` paths have emerged as a widely-adopted convention … the specification does not mandate where skill directories live" [AS-CLIENT].
- **Sandboxed agents, which is ostra's case:** "User-level and organization-level skills don't exist in the sandbox. You'll need to provision them from an external source — for example, cloning a configuration repository, accepting skill URLs or packages through your agent's settings, or letting users upload skill directories through a web UI" [AS-CLIENT].
- **Open proposals** include versioning and locking (#46), dependencies (#110), and `mcpServers` in the front matter (#21) [AS].

### 2.8 Where each agent reads skills

| Agent | Project | User / global | Org or admin layer |
|---|---|---|---|
| **OpenCode 2.3.2** | `.opencode/skills`, `.claude/skills`, `.agents/skills`, each from the current folder up to the project root | `~/.config/opencode/skills`, `~/.claude/skills`, `~/.agents/skills` | A `skills` config array of folders and `http(s)` "HTTP catalogs" (`index.json` with `name`, `version`, `files`, no digest); "A connected OpenCode Console workspace can also share skills" [OC] |
| **Claude Code** | `.claude/skills/`, nested `.claude/skills/` | `~/.claude/skills/`; claude.ai skills synced | A managed-settings folder; plugin skills from marketplaces. `.agents/skills` is not listed [CC-SK] |
| **Codex** | `.agents/skills` in the current folder, its parents and the repo root | `$HOME/.agents/skills` | `/etc/codex/skills` (ADMIN); bundled `$skill-installer` [CX-SK] |
| **GitHub Copilot** | `.github/skills`, `.claude/skills`, `.agents/skills` | `~/.copilot/skills`, `~/.agents/skills` | `gh skill install` (public preview), which writes the source, ref and tree SHA into the front matter; "Skills are not verified by GitHub" [GH-SK; GH-SKCLI] |
| **Cursor** | `.agents/skills`, `.cursor/skills` (also `.claude`, `.codex`) | `~/.agents/skills`, `~/.cursor/skills` | A team marketplace, where "Cursor stores a copy in a repository hosted for your team" [CU-SK] |
| **Devin** | `.agents/skills`, `.devin/skills`, `.github/skills`, `.claude/skills` and others, in every connected repo | none listed | "Skills in plugins can be installed at the personal, organization, or enterprise scope" [DV-SK] |

OpenCode's precedence, the skill tool and permissions [OC]:

- **IDs come from paths.** A skill's ID is its file path, and the `name` field is "only a display label". V2 "does not enforce" the spec's name pattern.
- **Listing and loading.** At each step OpenCode lists the permitted skills that have a description, as ID, name and description only. The model loads one with the `skill` tool, `{ "id": … }`.
- **Permissions:** `{ "action": "skill", "resource": "<id or glob>", "effect": "allow" | "ask" | "deny" }`, where the last matching rule wins.

### 2.9 Other skill registries

| Registry | Who runs it | Versions, review, API |
|---|---|---|
| `anthropics/skills` | Anthropic | Also a Claude Code marketplace; "provided for demonstration and educational purposes only" [AS-ANT] |
| `claude-plugins-official` and claude.com/marketplace | Anthropic | Plugins bundle skills and MCP servers. Versions come from `plugin.json` or a git SHA. The directory reviews submissions. "Anthropic does not control what MCP servers, files, or other software are included in plugins" [CC-PLUG; CC-MKT] |
| ClawHub | OpenClaw | Versioned releases, an HTTP API with OpenAPI, VirusTotal and other scans, and opt-out install telemetry [CLAWHUB; OC-VT] |
| SkillsMP | An independent community project | Indexes public GitHub; search API at 50 requests a day anonymous; "does not certify that every skill is safe"; no versions [SKMP] |
| Tessl Registry | Tessl | Versioned "tiles", evals, scanning "powered by Snyk", private workspaces [TESSL] |
| Smithery | Arcade.dev | Lists skills, and installs them "with the upstream installer: `npx skills add`" (**secondary**) [SM] |
| `gh skill` | GitHub | No registry: installs from any repo, with `--pin` and provenance in the front matter [GH-SKCLI] |

---

## 3. The MCP equivalent

### 3.1 The official MCP Registry

- **Status.**
  - "currently in preview. Breaking changes or data resets may occur before general availability". The `v0.1` API has been frozen since 2025-10-24. The live build answered `version 1.8.10` today [REG; LIVE].
  - A Registry Working Group runs it [REG]. MCP itself moved to the Agentic AI Foundation on 2025-12-09 [MCP-AAIF].
  - The code is moving from MIT to Apache-2.0 [REG].
- **Not for self-hosting.** "the official MCP Registry codebase is not designed for self-hosting" [REG-ABOUT].
- **Consumption model.** "The MCP Registry is not intended to be directly consumed by host applications. Instead, host applications should consume other MCP registries, such as downstream marketplaces, via a REST API conforming to the official MCP Registry's OpenAPI spec" [REG-ABOUT].
  - Aggregators should "pull new metadata on a regular but infrequent basis (for example, once per hour)" [REG].
  - It gives "no uptime or data durability guarantees" [REG].
- **The API** [REG]:
  - **Endpoints:** `GET /v0.1/servers` (`search`, a case-insensitive substring of the name, at least 3 characters; plus `cursor`, `limit`, `updated_since`, `version=latest`, `include_deleted`), `GET /v0.1/servers/{name}/versions` and `GET /v0.1/servers/{name}/versions/{version|latest}`.
  - **Entries:** each item is `{ server: <server.json>, _meta: { "io.modelcontextprotocol.registry/official": { status, publishedAt, updatedAt, isLatest } } }`. `status` is `active`, `deprecated` or `deleted`. Deprecation doesn't clear `isLatest`, so clients "must also check" the status.
- **`server.json`** (schema `2025-12-11`) [SJ; REG]:
  - **Top level:** `name` (`namespace/name`, exactly one slash), `description`, `version`, `repository`, `packages[]` and `remotes[]`.
  - **A package:**
    - `registryType`: `npm`, `pypi`, `oci`, `nuget`, `mcpb` or `cargo`;
    - `identifier`, plus an exact `version` ("Version ranges are rejected");
    - `transport`: `stdio`, `streamable-http` or `sse`;
    - `runtimeHint`: `npx`, `uvx`, `docker` or `dnx`;
    - `runtimeArguments`, `packageArguments` and `environmentVariables`;
    - `fileSha256`, required for MCPB.
  - **A remote:** `type` (`streamable-http` or the deprecated `sse`), `url` (URL variables allowed), and `headers`.
  - **Inputs:** every input may be `isRequired` or `isSecret` ("clients should handle the value securely"), with a `format`, a `default` and `choices`.
  - **Immutability:** "Once published, version metadata is immutable".

  The GitHub server's entry today, cut down:

  ```json
  {"name":"io.github.github/github-mcp-server","version":"2.2.0",
   "packages":[{"registryType":"oci","identifier":"ghcr.io/github/github-mcp-server:2.2.0","transport":{"type":"stdio"},
     "runtimeArguments":[{"type":"named","name":"-e","value":"GITHUB_PERSONAL_ACCESS_TOKEN={token}",
       "variables":{"token":{"isSecret":true}}}]}],
   "remotes":[{"type":"streamable-http","url":"https://api.githubcopilot.com/mcp/",
     "headers":[{"name":"Authorization","isSecret":true}]}]}
  ```

  [LIVE]
- **Namespaces** [REG]:
  - `io.github.<user>/*` is proved by GitHub OAuth or Actions OIDC. An org's namespace needs an Owner of the org.
  - A reverse-DNS name such as `com.example/*` is proved by a DNS TXT record or an HTTP file at `/.well-known/mcp-registry-auth`, with an ed25519 or ECDSA P-384 key.
- **Package ownership** [REG]:
  - **npm:** `mcpName` in `package.json`.
  - **PyPI, NuGet and Cargo:** an `mcp-name:` marker in the README.
  - **OCI:** the label `io.modelcontextprotocol.server.name`.
  - **MCPB:** a GitHub or GitLab release URL with a `fileSha256`, which "the MCP Registry does not validate"; clients do.
  - **Remote URLs:** "It does **not** verify that you control the remote URL".
- **Moderation.** "The MCP Registry does not make guarantees about moderation, and consumers should assume minimal-to-no moderation" [REG-MOD].
  - It removes illegal content, malware, spam and broken servers.
  - It won't remove "Servers with security vulnerabilities".
  - Removal sets `status: "deleted"`, and the metadata stays readable.
  - It "delegates security scanning to … Underlying package registries … Downstream aggregators" [REG-ABOUT].

### 3.2 Sub-registries, catalogs and installers

| | Who | What it is | Secrets | Review |
|---|---|---|---|---|
| **GitHub MCP Registry** (github.com/mcp) | GitHub | "a curated selection" since 2025-09-16. The live API `api.mcp.github.com/v0.1/servers` speaks the registry's API, and reported 896 servers [GH-MCPREG; LIVE] | Per client | Curated |
| **Docker MCP Catalog and Toolkit** | Docker | "300+ verified servers packaged as container images". The `docker mcp` CLI (Beta) and the MCP Gateway (MIT) bridge them to clients. Custom catalogs are OCI artifacts and can be built from the community registry [DK] | `config.secrets[]` in each catalog entry; `docker mcp secret`; credentials "stored securely in the Docker Desktop VM"; the gateway's `--block-secrets` is on by default [DK] | Every pull request is reviewed by Docker. Docker-built images get "cryptographic signatures, provenance tracking, SBOMs". The gateway checks signatures for `mcp/` images only; "Network egress is not globally denied by default" [DK] |
| **Smithery** | Arcade.dev | "On October 31, 2026, we're shutting down Smithery's connection management services. Smithery will remain as a public (non-proxied) MCP registry". The CLI and SDKs stopped [SM] | n/a now | Scanned with Invariant's MCP-Scan from 2025-04 [INV-SM]; today **unverified** |
| **Glama** | Glama | An aggregator claiming about 120k servers, with quality and security checks during indexing; its API now needs a key and attribution [GL] | Gateway with managed OAuth | Automated |
| **PulseMCP** | PulseMCP | A partner-only "enriched, curated" sub-registry on the registry's API; the old API is sunset [PM] | n/a | Curated |
| **mcp.so** | community (`chatmcp/mcpso`) | A directory; no public API was found (**unverified**) | n/a | none known |
| **mcp-get** | archived | "Archived: mcp-get is no longer maintained" [MCPGET] | — | — |
| **install-mcp** | Supermemory (MIT) | `npx install-mcp <package, command or URL> --client <client>`; no registry; handles OAuth for remotes [INSTMCP] | Writes the client's config | none |
| **add-mcp** | `neon-solutions/add-mcp` (Apache-2.0, 2.6.1) | `npx add-mcp` writes about 25 agents' configs, OpenCode V2's `mcp.servers` among them. `find` uses its own registry and can point at the official one [ADDMCP] | `--env`, `--header` with `${VAR}` placeholders | none |

### 3.3 How servers are packaged and run

- **Local packages.** npm, PyPI and NuGet packages are run with `npx`, `uvx` or `dnx` over stdio; an OCI image with `docker run`; an MCPB bundle (a zip with `manifest.json`, formerly DXT, signable with `mcpb sign`) by the client [REG; MCPB].
  - Each of these fetches the package at the moment it starts, unless the package is already installed.
- **Remote servers.** They speak streamable HTTP. The latest spec revision, **2026-07-28**, drops the `initialize` handshake and protocol sessions, and deprecates HTTP+SSE [MCP-SPEC].
- **Authorization** is optional and built on OAuth 2.1. Servers MUST publish Protected Resource Metadata (RFC 9728); clients MUST use Resource Indicators (RFC 8707) [MCP-SPEC].
- **Client registration** prefers a pre-registered client, then a Client ID Metadata Document, then dynamic registration. "Dynamic Client Registration is deprecated. New implementations should use Client ID Metadata Documents" [MCP-SPEC].
- **Remote is the trend.** A census found that 78% of new registry servers carry a remote URL (**secondary**) [LC].

### 3.4 How clients take a server, and its secrets

| Client | Where | Scopes | Secrets | From a registry |
|---|---|---|---|---|
| **OpenCode 2.3.2** | `mcp.servers.<name>`: `local` (`command` array, `environment`, `cwd`, `disabled`, `codemode`, `timeout`) or `remote` (`url`, `headers`, `oauth`). "V2 does not place server names directly under `mcp`" | Global or project config; `opencode mcp add [--global]` | `{env:NAME}` substitution. "Remote servers use OAuth by default", unless `oauth` is `false`, and "Credentials are stored outside project configuration" | None documented (**unverified** beyond the docs) [OC] |
| **Claude Code** | `claude mcp add` / `add-json` | `local` (default), `project` (`.mcp.json`, needs approval), `user`, plugin, `managedMcpServers` | `${VAR}` and `${VAR:-default}` expansion; OAuth secrets in the keychain | The Anthropic Directory, not a registry API [CC-MCP] |
| **Cursor** | `.cursor/mcp.json`, `~/.cursor/mcp.json` | Project, global, team marketplace | `${env:NAME}`, `envFile`, a static OAuth `auth` block | "Add to Cursor" deep links (`cursor://…/mcp/install?config=<base64>`) [CU-MCP] |
| **VS Code / Copilot** | `.mcp.json` or `~/.copilot/mcp-config.json`, or the older `.vscode/mcp.json` with `inputs` | Workspace, user | The older format's `promptString` inputs (`password: true`) are "securely stored"; the newer has `${NAME}` and no prompts | The `@mcp` gallery; `vscode:mcp/by-name/<registry-name>` [VS-MCP] |
| **Codex** | `[mcp_servers.<name>]` in `~/.codex/config.toml`, or `.codex/config.toml` "(trusted projects only)" | User, project | `env_vars` to forward by name, `bearer_token_env_var`, `env_http_headers`; OAuth via `codex mcp login` | None [CX-MCP] |
| **Copilot cloud agent** | Repository settings → Copilot → MCP servers, as JSON | Repository (and custom agent profiles) | "Only Agents secrets and variables with names prefixed with `COPILOT_MCP_` will be available"; no OAuth remote servers | None; a `tools` allowlist is required, and the tools run "autonomously, and will not ask for your approval" [GH-CA-MCP] |
| **Devin** | Customize → MCPs: a marketplace plus "Add custom MCP" | Personal, organization, enterprise (an enterprise pushes servers to its orgs) | Devin's Secrets, scoped personal or organization | Its own marketplace; members without the permission "Suggest MCP Integration" [DV-MCP] |

---

## 4. Scope models in comparable products

| Product | Organization | Per agent setup | Project or repo | Per user | Per task |
|---|---|---|---|---|---|
| **Claude Code** | Managed settings and `managed-mcp.json`, which "has exclusive control"; a managed skills folder [CC-MMCP; CC-SK] | Subagents and plugins | `.claude/skills`, `.mcp.json` (approved per user) | `~/.claude/skills`, `user` scope | none |
| **Copilot cloud agent** | Managed allow and deny lists, the firewall, org-level `COPILOT_MCP_` secrets [GH-ALLOW; GH-FW] | Custom agent profiles can define MCP servers, which the managed lists "don't apply to" [GH-CA-MCP] | Repository MCP JSON; `.github/skills` and others | `~/.copilot/skills` | none |
| **Cursor** | Team marketplace (distributes), Enterprise MCP allowlist (only approves: "Allowlisting approves… It does not distribute") [CU-ENT] | none | `.cursor/mcp.json`, `.agents/skills` | `~/.cursor/…`; only `~/.cursor/skills` syncs to cloud agents [CU-SK] | none |
| **Devin** | Org and enterprise MCP installs; plugins with skills at org or enterprise scope [DV-MCP; DV-SK] | Bots | Every connected repo's skill folders, indexed across the org [DV-SK] | Personal MCP servers and secrets | none |
| **Codex** | `requirements.toml`, `/etc/codex/skills` [CX-MAN; CX-SK] | none | `.agents/skills`, a trusted project's `.codex/config.toml` | `~/.agents/skills`, `~/.codex/config.toml` | none |

What they share:

- **Organizations approve or distribute, and repos add.** Distribution is a library or marketplace the organization keeps (Cursor's team marketplace, Devin's org installs, Claude's provisioned skills [CL-ORG]). Approval is a separate allowlist.
- **A repo's own skills combine with the installed ones, and its MCP config is held back.**
  - Every product reads a repo's skill folders beside the user's and organization's [CC-SK; GH-SK; CU-SK; DV-SK; CX-SK].
  - A repo's MCP config needs a trust step. Claude Code approves `.mcp.json` per user; Codex reads a project config only for trusted projects; VS Code ties it to Workspace Trust [CC-MCP; CX-MCP; VS-POL].
  - That's the same split ADR 0049 made: skills added beside the repo's, MCP servers from the profile only.
- **No product scopes to a single task.** None of the products read here attaches a skill or a server to one task.

---

## 5. Security and supply chain

### 5.1 Incidents and research

**MCP servers:**

| When | What | Source |
|---|---|---|
| 2025-04 | Tool poisoning: hidden instructions in a tool's description; rug pulls ("a malicious server can change the tool description after the client has already approved it"); shadowing of a trusted server's tool | Invariant Labs [INV-TP] |
| 2025-05 | A "toxic agent flow": a public GitHub issue makes an agent with the official GitHub MCP server leak private repos through a public PR | Invariant Labs [INV-GH] |
| 2025-06 to 07 | MCP Inspector RCE (CVE-2025-49596, CVSS 9.4); Filesystem server escapes (CVE-2025-53109/53110); `mcp-remote` command injection from a server's `authorization_endpoint` (CVE-2025-6514, CVSS 9.6) | NVD, JFrog [NVD-49596; NVD-53109; NVD-6514; JF-6514] |
| 2025-06 | Smithery's hosting: a path traversal exposed a fly.io token over "more than 3000 apps", most of them hosted MCP servers | GitGuardian [GG-SM] |
| 2025-08 | Cursor "MCPoison" (CVE-2025-54136): an approved MCP config could be swapped "without triggering any warning or re-prompt" | NVD [NVD-54136] |
| 2025-09 | `postmark-mcp` on npm, "the world's first sighting of a real world malicious MCP server", BCC'd every email to an attacker | Koi Security [KOI-PM]; Snyk [SNYK-PM] |
| 2025-10 | `@lanyer640/mcp-runcommand-server`: a reverse shell from a `preinstall` hook, so "installation is sufficient for infection" | Checkmarx [CX-LANYER] |
| 2025-12 | Anthropic's Git MCP server: path and argument injection (CVE-2025-68143/68144/68145) | NVD [NVD-68143] |
| 2026-02 | SANDWORM_MODE npm worm: its `McpInject` module writes a rogue MCP server into Claude Code, Claude Desktop, Cursor, Continue and Windsurf configs, with `<IMPORTANT>` tool descriptions that ask for SSH keys and tokens | Socket [SOCK-SW] |
| 2026-04 | OX "Mother of all AI supply chains": stdio config as command execution; "9 of 11 MCP marketplaces accepted a malicious server with no review; only GitHub's managed registry blocked it" | OX Security [OX-MOAI] |
| 2026-08 | Shai-Hulud reaches the official registry: "the first time we observed a Shai-Hulud payload being delivered directly through the official Model Context Protocol (MCP) Registry". The package was clean; the linked repo held malicious `.vscode/settings.json` and `.claude/settings.json` | OX Security [OX-SH] |
| 2026 | Trojanized forks of MCP servers published to PyPI from compromised accounts (UNC6780) | Google GTIG [GTIG] |
| 2026-09 | OpenCode 1.0.137 to 1.18.32 on Windows/WSL: RCE through an MCP server's OAuth URL, fixed in 1.18.33. The vendor said a "malicious MCP server is outside of their threat model" | Pillar Security [PIL-OC] |

**Skills:**

| When | What | Source |
|---|---|---|
| 2025-12 | A modified Anthropic skill fetched a ransomware helper at runtime: "Claude displayed and approved only the main Skill script". Anthropic: "It is the user's responsibility to only use and execute trusted Skills" | Cato CTRL [CATO] |
| 2026-01 | Of 31,132 skills analysed, "26.1% of skills contain at least one vulnerability", and 5.2% show "high-severity patterns strongly suggesting malicious intent" | arXiv 2601.10338 [ARX-2601] |
| 2026-02 | ClawHavoc: 341 of 2,857 ClawHub skills were malicious, mostly from one campaign, through a "Prerequisites" step that installs a stealer | Antiy, Unit 42 [ANTIY-CH] (Koi's own post not opened) |
| 2026-02 | ToxicSkills: 3,984 skills from ClawHub and skills.sh; 534 (13.4%) with a critical issue, 76 confirmed malicious payloads; skills.sh's top 100 had none | Snyk [SNYK-TS] |
| 2026-02 | 157 behaviourally confirmed malicious skills out of 98,380; "a single actor accounts for 54.1%" | arXiv 2602.06547 [ARX-2602] |

- **No skills.sh incident found.** No primary report names a malicious or typosquatted skill on skills.sh, or a takedown there (**unverified** absence) [SNYK-TS].
- **The academic numbers are upper bounds.** The authors warn the 26.1% means "potentially dangerous patterns warranting review" [ARX-2601].

### 5.2 Who reviews what

- **MCP Registry:** namespace and package ownership only; "minimal-to-no moderation" (section 3.1).
- **skills.sh:** automated partner audits at first install, hiding what's flagged malicious; no guarantee (section 2.6).
- **Docker:** a human reviews every catalog pull request, and Docker builds and signs its own images (section 3.2).
- **GitHub's registry:** curated. It was the only registry of the 11 that OX tested that blocked their server [OX-MOAI].
- **Anthropic's directories:**
  - Connectors: "Anthropic scans it automatically for policy compliance", and a "Verified review" runs a functional test of each tool [ANT-DIR].
  - Plugins aren't controlled: "A Claude Code plugin you install can execute arbitrary code on your machine with your user privileges" [CC-PLUG].
- **Anthropic on skills:** "Use Skills only from trusted sources … Even trustworthy Skills can be compromised if their external dependencies change over time" [ANT-SK].

### 5.3 Organization policy, setting by setting

- **Claude Code** [CC-MMCP; CC-SET]:
  - **`managed-mcp.json`:** exclusive control. `claude mcp add` then fails.
  - **`allowedMcpServers` / `deniedMcpServers`:** each entry is a `serverUrl` (wildcards allowed), an exact `serverCommand` array (whose `env` isn't compared), or a `serverName`, which "is not a security control".
  - **`allowManagedMcpServersOnly: true`:** makes the managed allowlist the only one. Without it, "allowlists from every settings scope merge, including a user's own".
  - **Plugins and skills:** `strictKnownMarketplaces` ("An empty array is a complete lockdown") and `blockedMarketplaces` govern plugins. `strictPluginOnlyCustomization: ["skills"]` stops user and project skills.
- **GitHub Copilot** [GH-ALLOW]:
  - **The managed control:** an enterprise `managed-settings.json` with the same `allowedMcpServers` / `deniedMcpServers` shape. It is the recommended, generally available control; "Deny rules always take precedence".
  - **The registry policy:** the MCP registry URL with "Registry only" is now "Public preview, not prioritized for development". Its "Enforcement is based only on server name/ID matching, which can be bypassed by editing configuration files".
- **Cursor:** an Enterprise MCP allowlist in the dashboard (command or URL entries, tool controls, a network policy), and an MDM-managed `permissions.json` [CU-ENT].
- **VS Code:** device policies `ChatMCP` (`chat.mcp.access`: none, registry, all), `ChatAllowedMcpServers`, `ChatDeniedMcpServers`, `ChatAllowManagedMcpServersOnly`, `McpGalleryServiceUrl` and `ChatStrictPluginOnlyCustomization`. From 1.145, "Registry membership does not grant an exception" to the managed allowlist [VS-POL].
- **Codex:** `requirements.toml` enables a server "only when both its name and identity match" (a command or a URL), and can restrict plugin marketplace sources. No skill-only key was found [CX-MAN].
- **Docker:** organization policy is written in Cedar, "default deny" when enforced. Without an enforced policy, the gateway "permits all MCP activity" [DK].

### 5.4 The spec's own rules

- **Revision.** The MCP security best practices are at revision 2026-07-28 [MCP-SEC]:
  - **Token passthrough:** "explicitly forbidden". Servers "MUST NOT accept any tokens that were not explicitly issued for the MCP server".
  - **Local servers:** a client "MUST … Show the exact command that will be executed, without truncation … Require explicit user approval", and "SHOULD" sandbox the server.
  - **Authorization URLs:** clients "MUST only allow `http://` and `https://` schemes" and "MUST NOT use shell commands … to open URLs". That's the lesson of CVE-2025-6514.
- **OWASP's lists.** The MCP Top 10 lists tool poisoning (MCP03) and supply chain (MCP04). The Agentic Skills Top 10's first entry is malicious skills, and it recommends signed skills [OWASP-MCP; OWASP-AST].

---

## 6. What a marketplace would have to fit in ostra

These are ostra's existing rules, as the ADRs state them. They bound every design in section 7.

1. **No credential in the agent's container** [ADR 0030].
   - A remote server's header secret stays in the sidecar. A stdio server holds no secret [ADR 0049].
   - Registry metadata marks which inputs are secret (`isSecret`) [SJ], so ostra can route each one to the secret store mechanically.
   - A stdio entry that needs a secret, such as the GitHub server's OCI package with `GITHUB_PERSONAL_ACCESS_TOKEN`, can't run under today's rule; its `remotes[]` entry can [LIVE; ADR 0049].
2. **Egress** [ADR 0029; ADR 0031; OS-DOCKER]:
   - **`docker`:** the agent's container has no route out but the sidecar. Nothing can download a skill or an `npx`/`uvx` package at box start.
   - **`kubernetes`:** the agent has public egress, recorded as a difference. A malicious skill or server there can send data to a public host.
   - **`host`:** not isolated.
   - Network allowlists per environment (F-052) are "later".
3. **Runner parity** [AGENTS.md; ADR 0029]. Whatever reaches the box must reach it the same way on every executor. Today's skill path does, because core hands blobs over the runner protocol [OS-DISPATCH; OS-RUNNER].
4. **Approval rules are "a person in the loop, not a wall"** [ADR 0049].
   - The "Reaching the network" preset asks before `fetch`, and before `mcp` on any server not marked read-only.
   - A server imported from a registry has no trustworthy read-only flag: the registry has no such field [SJ]. So it starts as not read-only.
5. **No telemetry, one outbound fetch** [ADR 0021]. Marketplace search and install would be new fetches by the server.
   - The `skills` CLI's defaults would also send usage data to skills.sh: installs, searches, the detected agent [SK].
   - The CLI's fast path downloads GitHub skills from skills.sh, not from GitHub [SK].
6. **ostra never calls a model** (`project.md`, as ADR 0044's research recorded) [PM-RES]. So an audit that needs an LLM can't run inside ostra. ostra could show third-party audit results, or run static checks.
7. **The profile wins over the repo** on permissions and MCP servers, and skills are added beside the repo's [ADR 0049]. Section 1.4's gap and precedence question sit here.

---

## 7. What this means for ostra

### 7.1 The verdict on today's design

- **Delivery is already right for marketplace skills.** Core copies the profile's skills into task blobs at each dispatch, with a digest the runner checks. Nothing in the box fetches anything. That works the same on `docker`, `kubernetes` and `host`, and needs no egress [OS-DISPATCH; OS-RUNNER].
  - The spec's advice for sandboxed agents is the same: provision org skills from outside, "accepting skill URLs or packages through your agent's settings, or letting users upload skill directories through a web UI" [AS-CLIENT].
  - A marketplace only has to fill the profile's skill rows from a source, not by hand.
- **Delivery is half right for marketplace MCP servers.**
  - The MCP proxy with secret-store headers fits a registry entry's `remotes[]` with an API-key header.
  - It doesn't fit OAuth remotes, which OpenCode signs in to by default and the spec's registration rules assume [OC; MCP-SPEC].
  - It doesn't fit stdio packages that need a secret or a download.
- **Missing everywhere:** provenance (source, ref, commit, hash), an update check, one install shared by many profiles, and any admin policy on sources.

### 7.2 Fixes worth making whatever the marketplace answer *(recommendations)*

1. **Read the repo's `.agents/skills` and `.claude/skills` too**, in `repoSkillDirs` [OS-OC]. Add a contract case with a repo that holds one skill in each of the three folders. Section 1.4 says why: `npx skills add` and Claude Code put repo skills there, not in `.opencode/skills` [SK; CC-SK].
2. **Decide which wins when a profile skill and a repo skill share an ID.** Today the repo's wins, by OpenCode's array order [OC; OS-OC]. Profile last would match ADR 0049's "the profile wins" for an org-installed skill. Repo last would match the spec's "project-level skills override user-level skills" [AS-CLIENT]. Either way, the task page could name a shadowed skill, as the spec suggests ("Log a warning when a collision occurs") [AS-CLIENT].
3. **Write `oauth: false` for proxied remote servers** in the OpenCode config *(inferred need, not run)*. OpenCode tries OAuth on a remote server by default [OC], and a server behind the proxy must never start a sign-in inside the box.

### 7.3 Three designs

**Design A: install by reference into the profile (smallest).**

- **Install.** In the profile editor's Skills section, beside "+ Skill", an admin adds "From a source": `owner/repo@skill`, a git URL with `#ref`, or a well-known URL.
- **Fetch and pin.** Core fetches it at a commit: for a public repo, the tarball; for a private one, the organization's GitHub App, which ostra already has (ADR 0040). Core checks the `SKILL.md` against the spec's rules and stores it as today's rows. New columns hold the source, the ref, the commit, and a `computedHash` made the CLI's documented way [SK], so it agrees with a repo's `skills-lock.json`.
- **Updates.** "Check for updates" re-resolves the ref and shows the diff. The admin saves it or doesn't.
- **MCP.** An admin enters a registry name; core reads `GET /v0.1/servers/{name}/versions/latest` from a configured registry; the editor fills the server from `remotes[]`, and puts each `isSecret` header into the secret store.
- No browser, no search, no new vendor. Each profile has its own copy.

**Design B: an organization library, then attach (recommended shape).**

- **The library.** An Organization → Skills and MCP servers page holds the installed items. Each is pinned (commit and hash for a skill; version for a registry server) and carries its source, who installed it and when.
- **Attaching.**
  - A profile attaches library items, so one install serves many profiles.
  - An item can be marked "every profile". That's the organization scope Cursor's, Devin's and Claude's organization layers have [CU-ENT; DV-SK; CL-ORG].
  - Projects don't attach items. They pick profiles, as today [ADR 0049].
  - No product read here attaches per task (section 4), and a task-level attach would let any member widen a task.
- **Updates.** An update is a new pinned version of the item. Attached profiles move to it when an admin accepts the diff, never automatically; skills.sh's own partner warns "skills can become malicious at any point" [SOCKET-SK].
  - Running tasks get it at their next session, as profile edits do today [OS-DISPATCH].
- **Policy.** An admin allowlist of sources: GitHub owners or repos, well-known hosts, and registry namespaces, matched by source, never by display name. It mirrors Claude Code's and Copilot's lesson that a name "is not a security control" [CC-MMCP; GH-ALLOW].
  - Members may "suggest" an item, as Devin's "Suggest MCP Integration" does [DV-MCP]. Only org admins install.
- **Delivery doesn't change for skills.** For MCP, see the decisions below.

**Design C: a marketplace browser on top of B.**

- **Search.** The library page searches skills.sh and an MCP registry through core, never from the browser, matching ADR 0021's "Browsers never call a third party".
- **Results** show installs, the source, the first-seen date, and for skills.sh, the partner audit verdicts.
- **Install** goes into the library (design B). It is admin-only, behind a setting that is off by default, under an ADR 0021 amendment.
- **Problems to settle:**
  - skills.sh's documented API needs a Vercel OIDC token [SKSH-API].
  - The CLI's search endpoint answers without one, but isn't a documented public API [LIVE].
  - Audit results come from the `/audit` API (OIDC) or the CLI's telemetry-gated lookup [SKSH-API; SK].
  - For MCP, the official registry asks host apps to use a sub-registry instead [REG-ABOUT]. GitHub's (`api.mcp.github.com`, curated) or a self-run aggregator are the candidates [LIVE; GH-MCPREG].

### 7.4 The decisions inside each design

**How a skill reaches the box.**

| | Baked into the snapshot | Fetched at box start | Cached by core (today) |
|---|---|---|---|
| Needs egress in the box | At build time only (ADR 0038's build) | Yes; impossible on `docker` [OS-DOCKER] | No |
| Runner parity | Only where a snapshot exists; a box without one starts with full setup [ADR 0038] | Breaks between executors | Holds |
| Update latency | Next snapshot build | Each box | Next session |
| Fits a profile (not a project) | No: snapshots are per project's environment | Yes | Yes |

Cached by core is the only one that fits a profile-level, executor-blind item. **Recommendation:** keep it, and add provenance.

**How an MCP server reaches the box.**

| Registry entry | Fit today | Change needed |
|---|---|---|
| `remotes[]` with API-key headers | Yes, through the MCP proxy | Map `isSecret` headers to secret refs |
| `remotes[]` with OAuth | No | An OAuth broker in core (a Client ID Metadata Document served by the ostra server, the spec's preferred registration [MCP-SPEC]). Tokens are kept in the secret store and refreshed by core. The sidecar adds a short-lived bearer per task. Open question: whose grant (section 7.6) |
| stdio package, no secret | Only if the command is in the image | The environment's setup installs it (ADR 0038). A profile can't count on a project's image, so the profile would have to name what the image must contain |
| stdio package with a secret | No (ADR 0049) | Run the server in **its own container**, beside the box like an environment's services (`svc-<name>`, ADR 0038), with its secret in that container's environment. A stdio-to-HTTP bridge, as Docker's MCP Gateway does [DK], reached through the MCP proxy. The agent's container still holds no secret. Needs egress for the server, which the box network lacks on `docker` [OS-DOCKER]. On `host` it would be one more process, not isolated, as `host` is today [ADR 0031]. Needs an ADR |

**Recommendation:** remotes first. They are most new registry entries (**secondary** [LC]) and need no image change. Leave stdio-with-secret to a later ADR.

**Pinning and drift.**

- **Skills:** a commit and a content hash, as the `skills` CLI does [SK]. Never "latest on a branch".
- **Registry servers:** pin the `server.json` version, which is immutable [REG]. Package versions are exact, never ranges [SJ].
- **Remote servers can't be pinned by version.** Their tools can change at any time: the "rug pull" [INV-TP]. The sidecar's MCP proxy already sees every reply. It could hash a server's `tools/list` answer and report a change as an event and a needs-you item, without logging the content (ostra's log rule).
  - That's a new proxy duty. Whether the proxy can read replies within the 2026-07-28 spec's `server/discover` flow is **unverified**.

**Secrets.** Every one goes through the secret store and the sidecar, never the agent's container [ADR 0030]:

- **Registry metadata:** inputs marked `isSecret` are prompted once by the install form and stored as references [SJ].
- **Copilot's convention:** a secret is exposed only to MCP config and only under a prefix (`COPILOT_MCP_`) [GH-CA-MCP]. In ostra, the reference itself is the scoping.

**Parity across executors.**

- **Skills from core** and **remote servers through the proxy** behave the same on all three executors.
- **A stdio server in its own container** works on `docker` and `kubernetes`, and runs as a plain process on `host`. That would be a new recorded difference in ADR 0029's list.

**Outbound fetches and telemetry.**

- **The recommendation:** ostra fetches skills from their git host itself, never through the `skills` CLI or skills.sh's download path.
- **Why not the CLI:**
  - it would add a dependency (AGENTS.md: ask first);
  - its telemetry is on by default [SK];
  - it writes agent folders on a disk, where ostra stores blobs.
- **Reimplementing is small:** the source parser, the fetch at a commit, `SKILL.md` discovery and the documented hash [SK]. Reading the lock format keeps a repo's `skills-lock.json` interoperable.
- **If the CLI is used anyway,** for example in an environment's setup, set `DISABLE_TELEMETRY=1` and `DO_NOT_TRACK=1` [SK].

### 7.5 Recommendation *(not a decision)*

1. **Now:** section 7.2's fixes. Repo `.agents/skills` and `.claude/skills` reach the agent; the profile-versus-repo precedence is decided and shown; `oauth: false` goes on proxied servers. Small, no vendor, no ADR beyond a line in ADR 0049.
2. **Next:** design B's library with design A's install by reference. GitHub (public, or private through the GitHub App) and well-known URLs for skills; registry names for remote MCP servers. Pinned and hashed, attached to profiles or to every profile, under an admin allowlist of sources. Delivery is unchanged. This answers "who adds skills manually in 2026" without a third-party search dependency.
3. **Then:** design C's browser, if the maintainer accepts the outbound fetches (ADR 0021) and a search source (skills.sh's undocumented search, or its OIDC API, which needs Vercel).
4. **Later, each with its own ADR:** an OAuth broker for remote MCP servers; stdio servers in their own container; tool-list pinning in the MCP proxy; and F-052's egress allowlists, before `kubernetes` boxes run org-installed MCP servers with public egress.

### 7.6 Open questions for the maintainer

1. **Scope.**
   - Is "an organization library, attached to profiles, with an 'every profile' switch" the right model?
   - Should a project be able to attach items, or only pick profiles, as now?
   - Should anything attach to a single task? No comparable product does (section 4).
2. **Repo skills.** Should a task load a repo's `.agents/skills` and `.claude/skills` by default, as Codex, Copilot, Cursor and Devin do? Or only when a project admin marks the repo trusted, as the Agent Skills guide suggests [AS-CLIENT]?
3. **Name clashes.** When a profile skill and a repo skill share a name, which one does the agent get?
4. **Outbound fetches.** May the server call skills.sh, a git host and an MCP registry when an admin searches or installs? Off by default, behind one setting, with ADR 0021 amended?
5. **The search source.** skills.sh's documented API needs a Vercel OIDC token. Build on its unauthenticated CLI search endpoint, do without search (install by reference only), or use another index?
6. **A dependency or our own code.** Should ostra run the `skills` CLI (MIT, Vercel, telemetry on by default), or implement the fetch, the discovery and the CLI's documented hash itself?
7. **Audits.** Should the library show skills.sh's partner audits? They need a call to skills.sh per skill, and ostra can't run an LLM audit itself.
8. **stdio servers with a secret.** Keep ADR 0049's rule (remote only), or add stdio servers in their own container?
9. **OAuth MCP servers.**
   - Is one grant per organization acceptable, given that every task on the profile acts as that account? Or a grant per member, given that a task's agent acts for whoever started it, or for an automation?
   - Should core run the OAuth flows at all?
10. **Who installs, and the allowlist.** Org admins only, with members suggesting? Which sources may be allowed: GitHub owners, hosts, registry namespaces?
11. **Updates.** Should a new upstream version wait for an admin to accept the diff (recommended), or move automatically? Should a running task pick it up at its next session, as profile edits do now?
12. **The MCP registry.** The official one says hosts shouldn't call it directly [REG-ABOUT]. Use GitHub's curated sub-registry, let an admin name any registry URL (as Copilot and VS Code do [GH-REG; VS-POL]), or both?

---

## Sources

**ostra (this repo, at `origin/main` of 2026-11-20):**

| Key | Source |
|---|---|
| [OS-SCHEMA] | `packages/db/prisma/schema.prisma`: `AgentProfile` (`mcpServers`), `AgentProfileSkill` |
| [OS-SETUP] | `packages/domain/src/use-cases/agent-profile-setup.ts`: `profileMcpServerSchema`, `profileLimits`, `saveAgentProfile` |
| [OS-LIM] | `packages/protocol/src/runner/limits.ts`: `skillFilesMax`, `skillFileMaxBytes`, `skillsMax`, `mcpServersMax` |
| [OS-SPEC] | `packages/protocol/src/task/spec.ts`: `taskSpecSkillSchema`, `taskSpecMcpServerSchema` |
| [OS-DISPATCH] | `apps/core/src/dispatch/profile-spec.ts`; `packages/domain/src/use-cases/task-profile.ts` |
| [OS-RUNNER] | `apps/runner/src/task-host/skills.ts` |
| [OS-OC] | `packages/adapters/adapter-opencode/src/config.ts` (`buildOpenCodeConfig`, `repoSkillDirs`, `buildCliEnv`, `taskDirs`), `packages/adapters/adapter-opencode/README.md` |
| [OS-MCPPROXY] | `apps/runner/src/sidecar/mcp-proxy.ts` |
| [OS-DOCKER] | `packages/adapters/adapter-executor-docker/src/boxes.ts` (header comment) |
| [OS-PANEL] | `apps/web/src/components/agent-profiles/skills-section.tsx`, `skill-file-upload.ts`, `mcp-section.tsx` |
| [OS-LOCK] | `skills-lock.json`, `.gitignore`, and the live checkout's `.agents/skills/` and `.claude/skills/` |
| [PM-RES] | `context/research/project-memory.md` (ostra never calls a model) |
| ADRs | `context/decisions/0021`, `0029`, `0030`, `0031`, `0038`, `0040`, `0049`; `context/features.md` F-021, F-052, F-116 |

**Skills:**

| Key | Source |
|---|---|
| [SK] | `vercel-labs/skills` at `57217cf` (v1.9.0) and `main` of 2026-11-20: `LICENSE`, `README.md` ("Lock File Content Hash"), `docs/commands.md`, `docs/agents.md`, `docs/troubleshooting.md`, `src/source-parser.ts`, `src/providers/wellknown.ts`, `src/local-lock.ts`, `src/skill-lock.ts`, `src/update.ts`, `src/add.ts`, `src/ci.ts`, `src/blob.ts`, `src/find.ts`, `src/telemetry.ts`; release notes v1.8.0, v1.9.0. `https://github.com/vercel-labs/skills` |
| [SK-NPM] | `https://registry.npmjs.org/skills/latest` (1.9.0, MIT) |
| [SKSH-DOCS] | `https://skills.sh/docs`, `/docs/cli`, `/docs/packs`, `/audits`, `/terms` |
| [SKSH-API] | `https://www.skills.sh/docs/api` |
| [VC-INTRO] | `https://vercel.com/changelog/introducing-skills-the-open-agent-skills-ecosystem` |
| [VC-AUDIT] | `https://vercel.com/changelog/automated-security-audits-now-available-for-skills-sh` |
| [VC-API] | `https://vercel.com/changelog/the-skills-sh-api-is-now-available` |
| [SOCKET-SK] | `https://socket.dev/blog/socket-brings-supply-chain-security-to-skills` |
| [SNYK-VC] | `https://snyk.io/blog/snyk-vercel-securing-agent-skill-ecosystem` |
| [CF-WK] | `https://github.com/cloudflare/agent-skills-discovery-rfc` (draft v0.2.0) |
| [AS] | `agentskills/agentskills` at `83021e2`: `README.md`, `GOVERNANCE.md`, `MAINTAINERS.md`, `skills-ref/`, `docs/snippets/clients.jsx`; issues #21, #46, #110; PR #254 |
| [AS-SPEC] | `https://agentskills.io/specification` |
| [AS-CLIENT] | `https://agentskills.io/client-implementation/adding-skills-support` ("Trust considerations", "Cloud-hosted and sandboxed agents", "Handling name collisions") |
| [AAIF-SK] | `https://www.anthropic.com/news/donating-agent-skills-to-the-agentic-ai-foundation` |
| [AS-ANT] | `https://github.com/anthropics/skills` (README) |
| [ANT-SK] | `https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview` |
| [CL-ORG] | `https://support.claude.com/en/articles/13119606-provision-and-manage-skills-for-your-organization` |
| [CLAWHUB] | `https://github.com/openclaw/clawhub` (README, `docs/security-audits.md`, `docs/http-api.md`) |
| [OC-VT] | `https://openclaw.ai/blog/virustotal-partnership` |
| [SKMP] | `https://skillsmp.com` |
| [TESSL] | `https://tessl.io/registry`, `https://docs.tessl.io` |

**Agents and clients:**

| Key | Source |
|---|---|
| [OC] | `anomalyco/opencode` at tag `v2.3.2`: `packages/core/src/config/discovery.ts`, `packages/cli/src/server-process.ts`, `services/site/src/docs/content/skills.mdx`, `mcp-servers.mdx`; `https://opencode.ai/docs/skills`, `/docs/mcp-servers`, `/docs/migrate-v1` |
| [CC-SK] | `https://code.claude.com/docs/en/skills` |
| [CC-MCP] | `https://code.claude.com/docs/en/mcp` |
| [CC-MMCP] | `https://code.claude.com/docs/en/managed-mcp` |
| [CC-SET] | `https://code.claude.com/docs/en/settings-reference` |
| [CC-PLUG] | `https://code.claude.com/docs/en/plugins/security` |
| [CC-MKT] | `https://github.com/anthropics/claude-plugins-official`; `https://claude.com/marketplace` |
| [ANT-DIR] | `https://claude.com/docs/connectors/building/review-criteria` |
| [CX-SK] | `https://developers.openai.com/codex/skills` |
| [CX-MCP] | `https://developers.openai.com/codex/mcp` |
| [CX-MAN] | `https://developers.openai.com/codex/enterprise/managed-configuration` |
| [GH-SK] | `https://docs.github.com/en/copilot/concepts/agents/about-agent-skills` |
| [GH-SKCLI] | `https://cli.github.com/manual/gh_skill` |
| [GH-CA-MCP] | `https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/extend-coding-agent-with-mcp` |
| [GH-REG] | `https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-mcp-usage/configure-mcp-registry` |
| [GH-ALLOW] | `https://docs.github.com/en/enterprise-cloud@latest/copilot/how-tos/administer-copilot/manage-mcp-usage/configure-enterprise-allowlist`; `https://docs.github.com/en/copilot/reference/enterprise-administrators/mcp-private-registry-enforcement`; `https://docs.github.com/en/copilot/concepts/enterprise/mcp-management` |
| [GH-FW] | `https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-firewall` |
| [CU-SK] | `https://cursor.com/docs/context/skills` |
| [CU-MCP] | `https://cursor.com/docs/mcp`, `/docs/context/mcp`, `/docs/mcp/install-links` |
| [CU-ENT] | `https://cursor.com/docs/enterprise/model-and-integration-management` |
| [VS-MCP] | `https://code.visualstudio.com/docs/agents/reference/mcp-configuration`; `/docs/agent-customization/mcp-servers`; `/api/extension-guides/ai/mcp` |
| [VS-POL] | `https://code.visualstudio.com/docs/enterprise/policies`; `/docs/enterprise/manage-ai-settings`; `microsoft/vscode-docs` `docs/agents/run/manage-mcp-servers.md` |
| [DV-SK] | `https://docs.devin.ai/product-guides/skills` |
| [DV-MCP] | `https://docs.devin.ai/work-with-devin/mcp`; `/product-guides/secrets`; `/release-notes/overview` |

**MCP registries and the spec:**

| Key | Source |
|---|---|
| [REG] | `modelcontextprotocol/registry` at `96f6a24`: `README.md`, `LICENSE`, `docs/reference/api/official-registry-api.md`, `openapi.yaml`, `CHANGELOG.md`, `docs/modelcontextprotocol-io/{about,authentication,package-types,remote-servers,registry-aggregators,moderation-policy,faq,versioning}.mdx`, `docs/reference/server-json/` |
| [REG-ABOUT] | `https://modelcontextprotocol.io/registry/about` |
| [REG-MOD] | `https://modelcontextprotocol.io/registry/moderation-policy` |
| [SJ] | `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json` |
| [MCP-SPEC] | `modelcontextprotocol/modelcontextprotocol` `docs/specification/2026-07-28/` (`changelog.mdx`, `basic/authorization/index.mdx`, `basic/authorization/client-registration.mdx`) |
| [MCP-SEC] | `https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices` |
| [MCP-AAIF] | `https://blog.modelcontextprotocol.io/posts/2025-12-09-mcp-joins-agentic-ai-foundation` |
| [MCPB] | `https://github.com/modelcontextprotocol/mcpb` (`README.md`, `MANIFEST.md`, `CLI.md`) |
| [GH-MCPREG] | `https://github.blog/changelog/2025-09-16-github-mcp-registry-the-fastest-way-to-discover-ai-tools` |
| [DK] | `https://docs.docker.com/ai/mcp-catalog-and-toolkit/` (`catalog/`, `cli`, `faqs/`); `https://github.com/docker/mcp-gateway` (`README.md`, `docs/security.md`, `docs/catalog.md`); `https://github.com/docker/mcp-registry`; `https://docs.docker.com/ai/governance/organization/policies/mcp` |
| [SM] | `https://www.smithery.ai/future`; `https://www.arcade.dev/blog/smithery-joins-arcade`; `https://github.com/smithery-ai/cli` |
| [INV-SM] | `https://invariantlabs.ai/blog/smithery-mcp-scan` |
| [GL] | `https://glama.ai`, `https://glama.ai/mcp/faq` |
| [PM] | `https://www.pulsemcp.com/api` |
| [MCPGET] | `https://github.com/michaellatman/mcp-get` |
| [INSTMCP] | `https://github.com/supermemoryai/install-mcp` |
| [ADDMCP] | `https://github.com/neon-solutions/add-mcp` |
| [LC] | `https://www.localcan.com/blog/state-of-mcp-server-development` (**secondary**) |
| [LIVE] | Calls made 2026-11-20: `GET https://skills.sh/api/search?q=code-review` (200, no token); `GET https://www.skills.sh/api/v1/skills/search?q=code-review` (401); `GET https://registry.modelcontextprotocol.io/v0.1/servers?search=…&version=latest` and `/v0.1/version`; `GET https://api.mcp.github.com/v0.1/servers` |

**Security:**

| Key | Source |
|---|---|
| [INV-TP] | `https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks` |
| [INV-GH] | `https://invariantlabs.ai/blog/mcp-github-vulnerability` |
| [NVD-49596] | `https://nvd.nist.gov/vuln/detail/CVE-2025-49596` |
| [NVD-53109] | `https://nvd.nist.gov/vuln/detail/CVE-2025-53109`, `-53110` |
| [NVD-6514] | `https://nvd.nist.gov/vuln/detail/CVE-2025-6514` |
| [JF-6514] | `https://jfrog.com/blog/2025-6514-critical-mcp-remote-rce-vulnerability` |
| [GG-SM] | `https://blog.gitguardian.com/breaking-mcp-server-hosting` |
| [NVD-54136] | `https://nvd.nist.gov/vuln/detail/CVE-2025-54136` |
| [KOI-PM] | Koi Security's post, now at `https://www.paloaltonetworks.com/blog/security-operations/first-malicious-mcp-in-the-wild-the-postmark-backdoor-thats-stealing-your-emails` |
| [SNYK-PM] | `https://snyk.io/blog/malicious-mcp-server-on-npm-postmark-mcp-harvests-emails` |
| [CX-LANYER] | `https://checkmarx.com/zero-post/npm-malware-alert-lanyer640-mcp-runcommand-server-with-reverse-shell` |
| [NVD-68143] | `https://nvd.nist.gov/vuln/detail/CVE-2025-68143` (and `-68144`, `-68145`) |
| [SOCK-SW] | `https://socket.dev/blog/sandworm-mode-npm-worm-ai-toolchain-poisoning` |
| [OX-MOAI] | `https://www.ox.security/blog/the-mother-of-all-ai-supply-chains-critical-systemic-vulnerability-at-the-core-of-the-mcp` |
| [OX-SH] | `https://www.ox.security/blog/shai-hulud-outbreak-debrief-the-worm-evolves-into-mcp` |
| [GTIG] | `https://cloud.google.com/blog/topics/threat-intelligence/from-prompting-to-autonomy-the-evolution-of-adversarial-ai` |
| [PIL-OC] | `https://www.pillar.security/blog/open-and-shut-remote-code-execution-in-opencode-via-mcp-oauth` (its date is **unverified**: the page shows 2026-09-28 and 2026-10-19) |
| [CATO] | `https://www.catonetworks.com/blog/cato-ctrl-weaponizing-claude-skills-with-medusalocker` |
| [ANTIY-CH] | `https://www.antiy.net/p/clawhavoc-analysis-of-large-scale-poisoning-campaign-targeting-the-openclaw-skill-market-for-ai-agents`; `https://unit42.paloaltonetworks.com/openclaw-ai-supply-chain-risk` |
| [SNYK-TS] | `https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub` |
| [ARX-2601] | `https://arxiv.org/abs/2601.10338` |
| [ARX-2602] | `https://arxiv.org/abs/2602.06547` |
| [OWASP-MCP] | `https://github.com/OWASP/www-project-mcp-top-10` (2025, MCP03) |
| [OWASP-AST] | `https://owasp.github.io/www-project-agentic-skills-top-10/ast01` |

**Unverified or in conflict, in one place:**

- **The well-known format:** it is not in the published Agent Skills spec yet (PR #254 open), and its schema URL didn't resolve [AS; SK].
- **skills.sh's API:** its docs require OIDC, yet its terms speak of a public API "rate-limited per IP", and the CLI's search endpoint needs nothing [SKSH-API; SKSH-DOCS; LIVE].
- **Runlayer and ZeroLeaks:** what these two audit partners check.
- **Dates:** the Smithery acquisition, and the Agent Skills open-standard and foundation-donation dates. All are **secondary**.
- **OpenCode and registries:** whether OpenCode installs MCP servers from any registry. Its docs show none.
- **VS Code's gallery:** whether its default gallery is GitHub's registry.
- **The size of the official registry:** about 43,000 servers per one census (**secondary**) [LC].
- **ostra's own behaviour:** section 1.4's gap and precedence, and section 7.2's `oauth: false` point, are read from source and docs, and were not run against OpenCode 2.3.2.
