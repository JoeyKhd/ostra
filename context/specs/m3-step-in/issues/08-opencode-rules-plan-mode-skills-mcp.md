# 08: OpenCode adapter: rules, plan mode, skills, MCP and the config that wins

Status: done
Builder: adapters
Blocked by: 02
Features: F-021, F-024, F-026, F-063
Packages: `packages/adapters/adapter-opencode`
Spec: `../spec.md`, sections 4 ("A task starts with its profile", "Plan first") and 5.2; ADR 0049, ADR 0032

## What to build

- **Permissions from the profile.** `permissionRules` in `config.ts` stops being the fixed "allow everything but `external_directory`". It's built from the profile's rules and the task rules, in OpenCode's V2 order (the last match wins): allow everything, deny `external_directory`, then each rule as `ask` on its action and resource (`edit` on a path glob, `bash` on a command pattern, `webfetch`, an MCP tool), then each task rule as `allow`. A "command outside an allowlist" rule is `bash` `ask` on `*` followed by an `allow` per allowlist prefix. Declare `permissionRules: "native"`.
- **The subject.** `describePermission` maps OpenCode's permission request (its tool, `rawInput`, locations) to ostra's subject, tested on the requests spike 1 recorded.
- **Plan mode.** Read whether OpenCode's ACP `initialize` advertises session modes with a read-only one. If it does, declare `planMode: "session-mode"` and use `session/set_mode`; if not, declare `relaunch`, and the plan launch writes a config whose permissions deny `edit`, `bash` (but a read-only allowlist: `ls`, `cat`, `rg`, `git log`, `git diff`, `git show`, `git status`), `webfetch` and every MCP tool that isn't read-only. Record which one in the adapter's README with the OpenCode version.
- **Skills.** Write each skill to the folder OpenCode reads skills from inside the task's own config folder (`taskDirs`), never in the repo, and check with a contract case that the agent lists it. If the installed OpenCode reads no skills folder, append the skills to the instructions file as sections and declare `skills: false`.
- **MCP servers.** Each HTTP server goes into the config's `mcp.servers` as a remote server at the sidecar URL the runner gives, with no header; each stdio server as a local command with its non-secret variables. Declare `mcp: { http: true, stdio: true }`.
- **The config that wins.** Find, against the pinned OpenCode version, how the task's config can take precedence over a repo's `opencode.json` and `.opencode/` folder for `permissions` and `mcp` (an explicit config path or content variable, or a switch that disables project config). Use it, declare `projectConfigOverride: true`, and add the contract case: a repo config that allows everything and adds an MCP server changes neither. If nothing works, declare `false`, and the runner hides those files (ticket 29).
- **The steer probe** runs in the suite on every version bump (ADR 0032); the steer on the real model is ticket 31's.

## Done when

- [x] Tests: the agent contract suite (ticket 02) passes against OpenCode on the stub models, every new case included; gated on `model.env`, a plan turn on the real model changes no file and yields a plan.
- [x] The adapter's README says which plan-mode path and which config precedence the pinned version uses.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add profile rules and plan mode to OpenCode`.

## Comments

- 2026-11-19: done in `✨ add profile rules and plan mode to OpenCode`, after `✨ add repoDirs and live MCP probes to the SDK` and `🐛 let the runner's matcher decide a native ask`. Checked against OpenCode 2.3.2 and written up in `packages/adapters/adapter-opencode/README.md`.
  - **Permissions** (`permissionRules: "native"`, `src/permissions.ts`): allow everything, then each profile rule as `ask` on what it covers (an `edit` path glob, a `shell` command pattern, `webfetch` and `websearch`, an MCP server's `<server>_*`), then `external_directory` denied last. A command outside an allowlist is `shell *` as `ask` plus an `allow` per prefix every allowlist holds. OpenCode's wildcards can't say every rule exactly, so each ask is a superset of its rule.
  - **Task rules aren't written as `allow`**, unlike the ticket says. The runner answers them itself and records `approval.auto_answered`, which it can do only for a request that reaches it. A task rule only answers what a profile rule already asks about, so it adds no ask either. `taskPermissionRules` (ticket 30's interim name) keeps its signature and now returns these permissions.
  - **Runner change:** ticket 30's runner asked a person for every `native` ask that no rule covered. With supersets, that would page a person for, say, any quoted command whenever a command rule exists. Now the runner's matcher decides each request whose subject it can read (ADR 0049: "the runner checks every permission request against the same rules anyway"), and only a request it can't read still asks a person.
  - **The subject:** `describePermission` reads the standard kinds and, for ACP kind `other`, an MCP tool as `<server>_<tool>`, longest server name first.
  - **Plan mode** (`session-mode`): `initialize` advertises no modes, but `session/new` offers `build` and `plan` as the config option `mode`. A plan-first task starts as OpenCode's `plan` agent (`default_agent`). The config gives that agent its own denies: edits; shell except `PLAN_MODE_READ_ONLY_COMMANDS`; redirections and substitutions; `webfetch`, `websearch` and `subagent`; and every MCP server that isn't read-only. `setMode` sends `session/set_mode`.
  - **Skills** (`true`): the config's `skills` names the profile's folders in the agent folder, and the instructions file names their IDs, because OpenCode lists only a skill whose front matter has a `description`.
  - **MCP** (`{ http: true, stdio: true }`): an HTTP server is `remote` at the sidecar URL with no header; a stdio server is `local` with its variables. A name that is ostra's own, given twice or not plain is refused.
  - **The config that wins** (`projectConfigOverride: true`): `OPENCODE_DISABLE_PROJECT_CONFIG=1`. With the config given only as `OPENCODE_CONFIG_CONTENT`, the repo's MCP servers were still added. With the project config off, OpenCode reads neither the repo's `AGENTS.md` nor its skills. The config names them instead: `<workspace>/AGENTS.md`, `<workspace>/*/AGENTS.md`, and each repo's `.opencode/skills`. For those skill folders, `PrepareLaunchInput` gained an optional `repoDirs`, which the runner fills from the spec's `checkoutDir`s. So F-021's "beside the repo's own AGENTS.md and skills" holds.
  - **The suite:** the agent contract suite passes on both stub formats, every profile case included. Its fixture gained `mcpUrl` and `mcpStdio` probes, because a real agent connects to its MCP servers before it lists their tools (`src/test-mcp-servers.ts`). There are four OpenCode-specific cases (own permissions, repo config, `AGENTS.md` and skills, the plan agent) and unit tests in `src/permissions.test.ts`. The `told` stub scenario matched its own prompt, so it could not fail; it now looks for the files' `MARKER:` text, and its case caught the break.
  - **Break-its, each caught:** project config back on; the rules' asks dropped; only the base returned; the deny moved before the asks; every task in build with no plan denies; the skill folders, the stdio servers and the repos' skill folders dropped; the `AGENTS.md` globs dropped; no MCP subject; the base set to `ask`; the runner's native ask restored.
  - **Live:** on the real model (`model.env`), a plan turn changed no file and yielded a plan, twice (`packages/adapters/adapter-opencode/evidence/f-063-plan-turn-live.txt`).
  - **Not here:** the steer on the real model is ticket 31's. F-019's case keeps the steer probe in the suite. Proofs: `context/proof/F-021.md`, `F-026.md`, `F-063.md`.
