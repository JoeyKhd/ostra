# Agent profiles, approval rules and plan first

**Status:** accepted (2026-11-19, on the maintainer's delegation for milestone 3's spec: "continue working on everything throughout the night"). Settles Q166 to Q171. Covers F-021, F-026 and F-063, and builds on ADR 0031 (explicit permissions and approvals), ADR 0032 (OpenCode's steering, plan and deny) and ADR 0036 (the approval card and its race).

An agent profile is the organization's named setup of an agent: the agent, a model, instructions, skills, MCP servers, approval rules, plan first, and who may use it (F-021). Milestone 1 built the row and a built-in OpenCode profile. Milestone 3 gives it the rest, and this ADR fixes the parts that are hard to change once tasks depend on them.

## Approval rules

- **A rule names a tool and a match.** The tool is one of `edit`, `execute`, `fetch` or `mcp`. The match is a path glob, a list of command prefixes, "a command outside this allowlist", or anything. A rule's effect is always "ask a person": a profile has no "deny" rules, because the agent's reach is the box's job (ADR 0031), and a deny the agent can't see would only end its turns.
- **Four presets,** each editable and each a plain rule underneath:
  - "Adding a dependency": `edit` on the dependency manifests and lockfiles (`**/package.json`, `**/pnpm-lock.yaml`, `**/package-lock.json`, `**/yarn.lock`, `**/requirements*.txt`, `**/pyproject.toml`, `**/poetry.lock`, `**/go.mod`, `**/go.sum`, `**/Cargo.toml`, `**/Cargo.lock`, `**/Gemfile*`), and `execute` on the install commands (`npm install`, `npm i`, `pnpm add`, `yarn add`, `pip install`, `poetry add`, `go get`, `cargo add`, `bundle add`).
  - "Writing a migration": `edit` on `**/migrations/**`, `**/migrate/**`, `**/*.sql` and `**/prisma/schema.prisma`.
  - "Commands outside an allowlist": `execute`, outside a list the admin edits, which starts with read-only and test commands.
  - "Reaching the network": `fetch`, and `mcp` on any server not marked read-only.
- **ostra maps rules to the agent's own permission settings,** where the agent can say "ask" for a path or a command (`permissionRules: "native"`; OpenCode can), and the runner checks every permission request against the same rules anyway. An agent whose settings can't express a rule declares `runner-only`, and then every request the agent makes reaches the runner's check. ostra never relies on an agent's defaults (ADR 0031).
- **A rule is a person in the loop, not a wall.** OpenCode's `external_directory` deny bounds its file tools and not its shell (ADR 0031), and the same holds here: a shell command can write a file an `edit` rule watches. The panel's rule editor and the docs say so in one line. The box is what contains the agent.

## "Approve for this task"

- **A task rule is the request's tool and its subject, narrowed to a pattern** (Q167): the exact path for a file; the program and its first argument for a command (`pnpm add`, so any package), the host for a URL, the tool's name for an MCP call. The card shows the pattern before the member presses the button, so nobody approves more than they read.
- The agent is always answered "once" (ADR 0036). Later requests that match a task rule are answered by the runner and recorded as `approval.auto_answered`.
- Task rules live on the task and travel in the task spec, so a reopen on a fresh box keeps them.

## Who answers what

- **Approvals: any member who can open the project** (F-026, ADR 0031). The first answer wins by a compare-and-set, and each is an audit entry (milestone 1 built it).
- **A deny may carry a reason,** which the runner sends as the re-prompt's text, inside a marked block (ADR 0032). The audit entry records the deny, never the reason's text, which may quote code.
- **Questions: the driver only** (Q168). An answer to a question is the same act as a message: it changes what the agent does next, and two people answering at once is the race ADR 0036 closes for messages. A watcher sees the question and "Take over to answer". Approvals stay any member's because they are a yes or no on one action, and the first answer wins.

## Plan first

- **Only the task's first turn,** and only when the task's profile has plan first on (Q169). A reopen doesn't plan again: the plan was approved for the task. An admin who wants a plan for a reopen asks for one in the message.
- **Plan mode reads and never writes.** The agent may read files, search and run a short list of read-only commands; it may not edit, run other commands, fetch, or call an MCP tool that isn't read-only. The adapter makes the mode in one of two ways it declares: an ACP session mode (`session/set_mode`) where the agent advertises a read-only one, or a relaunch with a read-only permission set and `session/load` to continue in the build mode. A plan turn that leaves a change in the working tree is a failure of the mode, reported and never committed.
- **The plan** is the agent's plan entries (an ACP plan, or OpenCode's `todowrite` mapped by its adapter, ADR 0032) plus the turn's last agent message, shown together.
- **Three answers, the driver's:** "Approve plan", "Edit and approve" (the edited list and message become the plan the build turn starts from), and "Ask for changes" (another plan turn with the driver's request). An answer after the box idled out reopens the task in the right mode.

## MCP servers and skills

- **No MCP credential enters the agent's container** (Q170, ADR 0030). An HTTP MCP server is reached through the sidecar's MCP proxy, which adds the server's headers from the secret store; the agent's config names the sidecar's address. A stdio MCP server runs a command already in the box's image, with variables that hold no secret; one that needs a secret has to be an HTTP server behind the proxy. The proxy passes MCP traffic through and logs names, statuses and sizes only.
- **A skill is a name, its `SKILL.md` text and up to 20 files** of at most 1 MiB *(working values)*, stored as blobs. The adapter writes them where the agent reads skills, inside the task's own config folder, never in the repo, so they sit beside the repo's own skills and never replace them (F-021). An agent that reads no skills folder gets them appended to its instructions, and declares `skills: false`.

## The profile wins over the repo

- **On permissions and MCP servers, the profile's settings win over a repo's own agent config** (Q171, F-021). A repo is untrusted input; its `opencode.json` could otherwise allow everything or add a server that leaks the workspace. The adapter launches the agent so its task config takes precedence, and the agent contract suite proves it with a repo config that allows everything. An agent that can't guarantee that declares `projectConfigOverride: false`, and the runner hides the repo's agent config files from the agent for the task and puts them back before the commit.
- Instructions and skills are added, never replacing the repo's `AGENTS.md` and skills.

## Who may use a profile

- A profile is open to every member, or to listed members. Organization admins can use and edit every profile. A project's default for a kind must be open to every member of the project. Intake rules and schedules (milestone 6) choose from profiles open to the members they act for.

## Considered options

- **Rules with "deny" and "allow" as well as "ask".** Rejected: "allow" is the default inside the box, and "deny" belongs to the box and the git proxy, which hold whatever the agent tries. A deny in the agent's own settings would end turns without a person seeing why.
- **"For this task" as "switch off the rule that asked".** Rejected: approving one `pnpm db:migrate` would then approve every command an allowlist rule watches. The pattern keeps it narrow, and the card shows it.
- **Any member answers questions.** Rejected for the race, as above. Revisit if teams find that a question waits too often on an absent driver: the answer then may be "any member, and the answer makes them the driver".
- **Plan first on every reopen.** Rejected: a reopen is a member's own message, which already says what to do next.
- **MCP servers with their secrets in the agent's config.** Rejected by ADR 0030.
- **Skills committed into the workspace.** Rejected: they'd show in the diff and could reach the PR.

## Consequences

- Protocol minor 2 carries the rules, the task rules, the skills, the MCP servers, plan mode, `plan.proposed`, `plan.answered`, `question-answer` and `plan-answer` (milestone 3's spec, section 5.1). A runner at minor 1 can't run a task whose profile needs them, and isn't offered one.
- The agent interface gains `permissionRules`, `planMode`, `skills`, `mcp` and `projectConfigOverride` as declared capabilities, so Claude Code in milestone 7 states each one (adapter parity, `AGENTS.md`).
- The sidecar grows an MCP proxy beside the key proxy and the git proxy. Milestone 7's security review of the box covers it.
- `domain-model.md`'s approval lifecycle is unchanged; "for this task" writes a task rule, as it already said.
