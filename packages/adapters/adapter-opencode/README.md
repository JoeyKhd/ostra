# @ostra/adapter-opencode

The OpenCode agent adapter (ADR 0032, F-019): OpenCode's V2 line (`@opencode/cli`), pinned and checked against a SHA-256 per platform, driven over ostra's ACP driver with a per-task config and an allowlisted environment.

Pinned version: **OpenCode 2.3.2** (`OPENCODE_VERSION` in `src/binary.ts`). Everything below was checked against that binary, on Windows 11, with the stub model of `@ostra/adapter-sdk/testing`, on 2026-11-19. A version bump runs the agent contract suite again, the steer probe included (ADR 0032), and re-checks each point.

## Milestone 3: the profile (ADR 0049, ticket 08)

| Capability | Declared | How OpenCode 2.3.2 does it |
|---|---|---|
| `permissionRules` | `native` | The profile's rules are written into the task's `opencode.json` as `permissions`, each as `ask` (`src/permissions.ts`). |
| `planMode` | `session-mode` | OpenCode's own `plan` agent, switched with `session/set_mode`, made read-only by the config. |
| `skills` | `true` | The config's `skills` names each repo's own `.agents/skills`, `.claude/skills` and `.opencode/skills` (unless the project keeps them off), then the folders the runner wrote in the task's agent folder, last, so the profile's win. |
| `mcp` | `{ http: true, stdio: true }` | `mcp.servers`: an HTTP server as `remote` at the sidecar's URL with no header and (milestone 8) `oauth: false`, a stdio server as `local` with its variables. |
| `projectConfigOverride` | `true` | `OPENCODE_DISABLE_PROJECT_CONFIG=1`, with the repo's `AGENTS.md` and skill folders named in the config. |

### Permissions

OpenCode's V2 permissions are an ordered list of `{ action, resource, effect }`, and the last rule that matches wins. On 2.3.2:

- `edit` covers the `edit`, `write` and `patch` tools. Its resource is the path relative to the workspace, and `*` matches any characters, `/` included (`src/*` matched `src/a/b.txt`).
- `shell` is checked once per simple command of a line: with `node *` allowed, `node -e 1 && echo hi` still asked. Its resource is the command's text.
- `webfetch` has the URL as its resource. An MCP tool's action is `<server>_<tool>`, and its request comes as ACP kind `other`, titled `<server>_<tool>`.

The task's list is: allow everything, then each rule as `ask`, then deny `external_directory`, so nothing a rule adds reaches outside the workspace, and last allow `external_directory` for the task's own folders. A path glob becomes a resource that matches at least the glob (`**/package.json` is `*package.json`). A command prefix becomes its words with `*` around and between them (`pnpm add` is `*pnpm*add*`). A command outside an allowlist is `shell` `*` as `ask`, then an `allow` per allowlist entry that every such rule allows. When any rule watches commands, a line with a substitution, a backtick, an escape or a quote asks too. The runner checks every request it gets against the same rules with the protocol's matcher (`apps/runner/src/task-host/permission-decision.ts`): a request whose subject it reads and no rule covers goes on, so an ask that covers more than its rule costs a round trip, never a person. Only a request it can't read asks a person. "For this task" rules aren't written as `allow`: the runner answers them, and records `approval.auto_answered`, which it can only do for a request that reaches it. A task rule only answers what a profile rule asks about, so it adds no ask of its own.

### The task's own folders outside the project (2026-11-21)

OpenCode's project is the session's folder and its git checkout: with one repo, the repo's checkout. Any other path asks `external_directory`, with the path's folder as the resource (`<folder>/*`). Its shell asks it for a command's working folder and for each folder a `cd` names, so `python --version` run in a temp folder was refused on a live task (2026-11-21), though it names no path. OpenCode tells the model to prefer `<TMPDIR>/opencode` ("approved for external access"), and only its default `allow *` approves it; the deny overrode that. Read from 2.3.2's source at tag v2.3.2: `packages/core/src/file-access.ts`, `tool/plugin/shell.ts`, `instructions/builtins.ts`, `permission.ts` and `util/wildcard.ts`.

So the config allows `external_directory`, after the deny, for four folders (`ownFolders` in `config.ts`): the workspace's root, which holds the repos (F-098); the agent's temp folder (`TMPDIR`, `TEMP`); and OpenCode's two output folders, `<XDG_DATA_HOME>/opencode/tool-output` and `.../opencode/shell`, whose files it names to the model to read. Each is written as given and as the file system spells it (`ownFolderSpellings`): OpenCode spells its temp folder with links and Windows short names resolved. The task's explore subagent gets the same allows after its own deny. Everything else outside the workspace stays denied, the agent's home and config folders included, with no person asked: an `ask` would reach the runner, which lets a request through when no profile rule covers it. On `docker` and `kubernetes` the box is the boundary; on `host` this guards the file tools, not the shell (ADR 0031).

### Plan first

`session/new` advertises the modes as the config option `mode`, with `build` and `plan` (the plan agent's description: "Read-only agent for exploring the codebase and planning work before implementation"). `initialize` advertises no modes. The plan agent itself denies only edits: shell commands, `webfetch` and MCP tools stay as the task's permissions allow them. So the adapter adds the plan agent's own permissions in the config (`agents.plan.permissions`, checked after the task's): deny `edit`, deny `shell` but for the read-only list (`PLAN_MODE_READ_ONLY_COMMANDS`), deny a redirection or a substitution, `webfetch`, `websearch`, `subagent`, and every tool of an MCP server that isn't read-only. A denied tool is taken off the model's list for the turn, and the turn goes on (`end_turn`). A plan-first task starts with `default_agent: "plan"`, and `setMode` sends `session/set_mode` with ostra's own mode names, which are OpenCode's.

### Skills

OpenCode reads skills from the folders the config's `skills` names, and from `$XDG_CONFIG_HOME/opencode/skills`. A folder may be the skill's own (holding `SKILL.md`). It lists a skill to the model only when `SKILL.md` has a `description` in its front matter, and loads one without it when asked by its ID, so the profile's skills are also named in the instructions file. A `skills` entry with a wildcard (`<workspace>/*/.opencode/skills`) finds nothing, and one for a folder that isn't there is passed over.

A repo's own skills (2026-11-21, ADR 0049 amended): with the project config off, OpenCode walks none of the project's folders, and `OPENCODE_DISABLE_CLAUDE_CODE` drops `.claude` as well. So the config names `.agents/skills` (where `npx skills add -a opencode` installs), `.claude/skills` and `.opencode/skills`, at `<workspace>` and at `<workspace>/<repo>` for each repo the runner names (`repoDirs`), in that order, and the profile's folders after them. OpenCode keys a skill by its folder's name, finds skills up to six folders down and passes over folders whose names start with `.`, and a later entry replaces an earlier skill of the same name: so a profile's skill wins over a repo's, and the runner logs the repo's by its name. With the project's repo skills off (`repoSkills: false`), the config names the profile's folders alone. Each was checked on 2.3.2 in the contract tests (`F-021/c5,c8`, `F-021/c9`). OpenCode also lists its own built-in skills (`OpenCode`, `Report`) whatever the config says.

### The config that wins

Without a switch, a repo's `opencode.json` that allows everything wins over the task's permissions, and its MCP servers are added. With the task's config given as `OPENCODE_CONFIG_CONTENT`, the task's permissions win, but the repo's MCP servers are still added, and its agents and plugins still load. `OPENCODE_DISABLE_PROJECT_CONFIG=1` reads none of the repo's `opencode.json`, `opencode.jsonc` or `.opencode/`. It also stops OpenCode reading the repo's `AGENTS.md` (without the config's names, none of it reaches the model), so the config names `<workspace>/AGENTS.md` and `<workspace>/*/AGENTS.md` in `instructions`, where a wildcard does work, and each repo's `.agents/skills`, `.claude/skills` and `.opencode/skills` in `skills` (above). The repo's agents, plugins and commands under `.opencode/` stay unread; the runner's hiding of `.opencode/` (ticket 29), for an agent that can't keep its project config out, drops them too.

## Subagents (2026-11-20, ADR 0067)

OpenCode's `subagent` tool always runs its subagent in the background: the call ends at once with the child's session ID, the agent is told to end its turn, and the subagent's report wakes the agent later (`context/research/opencode-subagents.md`). The adapter declares `subagents: "background"`, so the driver asks for `opencode/child-session-updates` and a turn waits for its subagents and the turns their reports wake, up to `OSTRA_RUNNER_SUBAGENT_WAIT_MINUTES`. A cancel closes each running child session (`session/close` interrupts it), then the session's own follower, and resumes the session.

OpenCode's built-in subagents are `general` and `explore`. `general` keeps the task's permissions, the profile's asks included. `explore` is read-only in OpenCode's own rules, which the task's `allow *` would override, so the config writes them as `agents.explore.permissions` (`explorePermissions`), after the task's:
- deny everything;
- then allow `grep`, `glob`, `read` (asking for `.env` files), `webfetch` and `websearch`;
- deny `subagent`;
- allow the plan agent's read-only command list and no other command, where OpenCode allows explore any command and asks it in words to stay read-only;
- deny `external_directory`, then allow it for the task's own folders, as for the task.

With a profile rule on commands or the network, those commands and fetches ask instead. Explore isn't offered `edit` or `write`.

## Milestone 8: the running app and servers without sign-in (ADR 0068, ADR 0069, ticket 14)

- **The app tools.** `start_app`, `show_preview`, `take_screenshot` and `record_app` are tools of ostra's own server (`ostra_<tool>`), offered for a task whose tool sets hold `app`. Without it, the config denies each one (`toolFilterPermissions`, as for milestone 6's tools), so OpenCode lists none of them even from a server that lists them. They're under no approval rule: "Reaching the network" and a rule on MCP tools ask before none of them, since they reach only the box, and the plan agent's denies leave them alone.
- **The app's block.** For a task whose environment has app processes, the launch's `app` adds the protocol's block (`appInstructionsBlock`) to the task's instructions file, after the profile's instructions and the memory block, and before the repos' own `AGENTS.md`: each process by its label, name and in-box address, the services with their addresses, the one-origin rule, and where the logs are. It names the app tools only when the task has them. A task with no app process gets no block.
- **No sign-in.** OpenCode 2.3.2 signs in to a remote MCP server with OAuth by default: its `Mcp.RemoteConfig` takes `oauth` as an OAuth config or `false`, and for a remote server whose `oauth` isn't `false` it registers an OAuth integration, so `opencode mcp auth <server>` (which the agent's own shell could run) would start a sign-in, with a callback listener on `127.0.0.1:19876`. The config writes `oauth: false` on every remote server: a profile's, a library's (both at the sidecar's MCP proxy, with no header) and ostra's own (with the task's bearer). Read from 2.3.2's source; on the binary, a server that answers every call with an OAuth challenge gets one call and nothing else (no metadata, no client registration), its tools aren't listed, and the turn runs (`F-145/c12`).
- `opencode mcp list` and `opencode mcp auth` start OpenCode's managed service on a fixed port (28894) and leave it running, so the contract tests never run them.

## Milestone 9: what the model sees (ADR 0070, ticket 09)

| Capability | Declared | How OpenCode 2.3.2 does it |
|---|---|---|
| The model's inputs | always written | The catalog file's entry gets `modalities: { input, output: ["text"] }` and the config's model `capabilities.input`, the same list (`modelInputModalities`): `text` first, then whichever of `image`, `pdf`, `audio` and `video` the launch's `model.inputModalities` names. Absent, text only. OpenCode's own image limits (`media.image`) stay at its defaults. |

Read in 2.3.2's source at tag v2.3.2 (`context/research/attachments-for-agents.md` §1 to §3; paths under `packages/`):

- Before each request, a media part whose kind (`image`, `audio`, `video`, `pdf`) the model's `capabilities.input` doesn't name is replaced with `ERROR: Cannot read "<name>" (this model does not support image input). Inform the user.`, in a message and in a tool's result alike (`core/src/session/model-request.ts:139-164`, `183-191`).
- A catalog entry without `modalities` is `{ input: ["text"], output: ["text"] }` (`core/src/models-dev/v1.ts:135`), and the config's `capabilities.input` wins over the catalog's (`mergeCapabilities`, `core/src/model.ts:32-41`, applied in `core/src/config/plugin/provider.ts`). ostra's catalog entry had no `modalities`, so every model it ran was text only to OpenCode, and F-064's ticket images, read since milestone 2, reached no model as pictures.
- The read tool answers `Image read successfully` with a PNG, JPEG, GIF, WebP or PDF as a data-URL part (`core/src/tool/plugin/read.ts:349-363`), and goes through `external_directory`, which the config allows for the workspace's root.
- Anthropic Messages sends an image as an `image` block with a base64 `source`, and OpenAI Chat as an `image_url` with a data URL, a tool's image in a following user message (`ai/src/protocols/anthropic-messages.ts:704-718`; `ai/src/protocols/openai-chat.ts:466-482`, `618-619`).

What the binary showed (2026-11-21, Windows 11, the stub model in both API formats, `src/opencode-images.contract.test.ts`):

- **Before this change** (the catalog entry and config with no inputs, as since milestone 2): a PNG the agent opened with its read tool reached the model as the error line above, naming the file's path, and no image part, in both formats.
- **A model written as taking images:** the same read reached the Anthropic stub as an `image` block (`image/png`, in the tool's result) and the OpenAI-compatible stub as an `image_url` with a PNG data URL. The file was under `<workspace root>/.ostra/attachments/1/`, outside the repo the session started in, and the read asked no one (`F-148/c4,c5`).
- **A model written as text only, or with nothing said of it:** the error line and no image part, as before (`F-148/c5`).
- **Through the runner** (`apps/runner/src/task-host/ticket-images.opencode.test.ts`, the host executor and the real key proxy): a task spec whose `agent.inputModalities` holds `image` gets its ticket screenshot, written by the runner under `.ostra/ticket/` as F-064 writes it, to the model as a picture in both formats; a spec that says nothing gets the error line, as every ticket image did before.
- **Still to check** once the agent contract suite's files cases land (milestone 9's ticket 02): an image sent in `session/prompt`, and one in `_session/steering`, reaching each stub as an image.
