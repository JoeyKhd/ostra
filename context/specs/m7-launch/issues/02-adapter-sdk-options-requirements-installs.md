# 02: Adapter SDK: options, requirements, installs and the subagent parent

Status: ready-for-agent
Builder: adapters
Blocked by: 01
Features: F-018, F-019 (its declarations)
Packages: `packages/adapter-sdk` (`src/agent/base.ts`, `src/agent/install.ts` (new), `src/agent/acp/map.ts`, `src/testing/fake-acp-agent/`)
Spec: `../spec.md`, section 5.2

## What to build

- **`optionsSchema`** on `AgentAdapter`, defaulting to an empty strict object; `prepareLaunch`'s input gains the parsed `options`.
- **`requires: { apiFormats }`** on `AgentAdapter`. A helper `acceptsModel(adapter, apiFormat)`.
- **`install: AgentInstall`**: `{ kind: "bundled" }` or `{ kind: "npm", package, version, binary: { packageByPlatform, path }, sha256ByPlatform }`, and `imageInstall(baseDigest)` returning the Dockerfile lines (an `npm install --ignore-scripts --no-audit --no-fund` at the exact version, then `sha256sum -c` of the binary against the pin) as an array of strings built from constants, never from task data. A shared `verifyAgentBinary(install, platform, file)` that hashes with the async API and refuses a mismatch or a missing pin.
- **Plan operations:** the shared mapping reads `plan_update` and `plan_removed` beside the legacy `plan`, since the driver already advertises `plan` (`driver.ts:388`) and an agent that honors it sends nothing else (`research/claude-code-acp.md`, section 6): an `items` plan to `plan.updated` per `planId`, the session's own as the task's plan, `plan_removed` to an empty one; a `markdown` plan as ticket 38 decides for Claude Code's `plan-mode`, never `agent.unknown`. OpenCode's legacy `plan` path is unchanged.
- **The subagent parent:** `parentToolCallIdOf(update): ToolCallId | undefined` on `AgentAdapter`, default none. The shared mapping calls it for a tool call, a message chunk, a thought chunk and a plan, and copies it onto `tool.called`, `agent.message`, `agent.thought` and `plan.updated`. A plan with a parent never becomes the task's plan.
- **The scripted fake agents** grow: a subagent fake (tool calls and message and thought chunks stamped `_meta.claudeCode.parentToolUseId`, and a `plan_update` with `planId` `plan:<call>`, as the ACP adapter sends them to a client without the draft `subagents` capability: `research/claude-code-acp.md`, section 6), a fake that sends its plans as plan operations, a fake that sends an unknown notification after `initialize`, a fake that advertises `promptQueueing`, and a fake whose `requires` is `["anthropic-messages"]`.
- **OpenCode** declares `install: { kind: "bundled" }`, `requires: ["openai-compatible", "anthropic-messages"]` and no options, in the same commit.

## Done when

- [ ] Tests: the options schema parses and refuses; `acceptsModel` for both formats; `verifyAgentBinary` accepts the pinned hash and refuses a changed byte and a platform without a pin; `imageInstall`'s lines hold only the constants; a plan-operations fake's plans reach `plan.updated` and none lands as `agent.unknown` (break-it: the `plan_update` branch removed); a fake's parent reaches each of the four mapped events, and its subagent plan leaves the task's plan as it was (break-it: the parent dropped from `agent.message`); the unknown notification is tolerated by the driver.
- [ ] OpenCode's adapter compiles and its suite still passes.
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✨ add agent options, requirements and installs`.

## Comments
