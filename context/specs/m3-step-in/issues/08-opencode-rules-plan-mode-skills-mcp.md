# 08: OpenCode adapter: rules, plan mode, skills, MCP and the config that wins

Status: ready-for-agent
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

- [ ] Tests: the agent contract suite (ticket 02) passes against OpenCode on the stub models, every new case included; gated on `model.env`, a plan turn on the real model changes no file and yields a plan.
- [ ] The adapter's README says which plan-mode path and which config precedence the pinned version uses.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add profile rules and plan mode to OpenCode`.

## Comments
