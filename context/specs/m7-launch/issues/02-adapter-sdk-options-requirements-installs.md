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
- **The tool-call parent:** the shared mapping passes through a `parentToolCallId` an adapter's `mapUpdate` sets on a tool call; the base class doesn't interpret it.
- **The scripted fake agents** grow: a subagent fake (tool calls marked with a parent in their `_meta`, as the Claude Code adapter will read them), a fake that sends an unknown notification after `initialize`, a fake that advertises `promptQueueing`, and a fake whose `requires` is `["anthropic-messages"]`.
- **OpenCode** declares `install: { kind: "bundled" }`, `requires: ["openai-compatible", "anthropic-messages"]` and no options, in the same commit.

## Done when

- [ ] Tests: the options schema parses and refuses; `acceptsModel` for both formats; `verifyAgentBinary` accepts the pinned hash and refuses a changed byte and a platform without a pin; `imageInstall`'s lines hold only the constants; a fake's parent reaches the mapped event; the unknown notification is tolerated by the driver.
- [ ] OpenCode's adapter compiles and its suite still passes.
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✨ add agent options, requirements and installs`.

## Comments
