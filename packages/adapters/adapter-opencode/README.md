# @ostra/adapter-opencode

The OpenCode agent adapter (ADR 0032, F-019): OpenCode's V2 line (`@opencode/cli`), pinned and checked against a SHA-256 per platform, driven over ostra's ACP driver with a per-task config and an allowlisted environment.

Pinned version: **OpenCode 2.3.2** (`OPENCODE_VERSION` in `src/binary.ts`). Everything below was checked against that binary, on Windows 11, with the stub model of `@ostra/adapter-sdk/testing`, on 2026-11-19. A version bump runs the agent contract suite again, the steer probe included (ADR 0032), and re-checks each point.

## Milestone 3: the profile (ADR 0049, ticket 08)

| Capability | Declared | How OpenCode 2.3.2 does it |
|---|---|---|
| `permissionRules` | `native` | The profile's rules are written into the task's `opencode.json` as `permissions`, each as `ask` (`src/permissions.ts`). |
| `planMode` | `session-mode` | OpenCode's own `plan` agent, switched with `session/set_mode`, made read-only by the config. |
| `skills` | `true` | The config's `skills` names each repo's own `.agents/skills`, `.claude/skills` and `.opencode/skills` (unless the project keeps them off), then the folders the runner wrote in the task's agent folder, last, so the profile's win. |
| `mcp` | `{ http: true, stdio: true }` | `mcp.servers`: an HTTP server as `remote` at the sidecar's URL with no header, a stdio server as `local` with its variables. |
| `projectConfigOverride` | `true` | `OPENCODE_DISABLE_PROJECT_CONFIG=1`, with the repo's `AGENTS.md` and skill folders named in the config. |

### Permissions

OpenCode's V2 permissions are an ordered list of `{ action, resource, effect }`, and the last rule that matches wins. On 2.3.2:

- `edit` covers the `edit`, `write` and `patch` tools. Its resource is the path relative to the workspace, and `*` matches any characters, `/` included (`src/*` matched `src/a/b.txt`).
- `shell` is checked once per simple command of a line: with `node *` allowed, `node -e 1 && echo hi` still asked. Its resource is the command's text.
- `webfetch` has the URL as its resource. An MCP tool's action is `<server>_<tool>`, and its request comes as ACP kind `other`, titled `<server>_<tool>`.

The task's list is: allow everything, then each rule as `ask`, then deny `external_directory` last, so nothing a rule adds reaches outside the workspace. A path glob becomes a resource that matches at least the glob (`**/package.json` is `*package.json`). A command prefix becomes its words with `*` around and between them (`pnpm add` is `*pnpm*add*`). A command outside an allowlist is `shell` `*` as `ask`, then an `allow` per allowlist entry that every such rule allows. When any rule watches commands, a line with a substitution, a backtick, an escape or a quote asks too. The runner checks every request it gets against the same rules with the protocol's matcher (`apps/runner/src/task-host/permission-decision.ts`): a request whose subject it reads and no rule covers goes on, so an ask that covers more than its rule costs a round trip, never a person. Only a request it can't read asks a person. "For this task" rules aren't written as `allow`: the runner answers them, and records `approval.auto_answered`, which it can only do for a request that reaches it. A task rule only answers what a profile rule asks about, so it adds no ask of its own.

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
- deny `external_directory` last.

With a profile rule on commands or the network, those commands and fetches ask instead. Explore isn't offered `edit` or `write`.
