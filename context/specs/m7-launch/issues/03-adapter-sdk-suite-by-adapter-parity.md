# 03: Adapter SDK: the suite by adapter, the new cases, and the parity test

Status: ready-for-agent
Builder: adapters
Blocked by: none (it was 02, which is `wontfix` since 2026-11-19)
Features: F-019 (adapter parity)
Packages: `packages/adapter-sdk` (`src/testing/agent-suite.ts`, `src/testing/parity.ts` (new), `src/testing/fake-acp-agent/`), `packages/adapters/adapter-opencode` (its suite call)
Spec: `../spec.md`, sections 5.2, 6 and 9
Note: changed 2026-11-19. Claude Code (F-018) moved after v1, so this ticket keeps only what holds for OpenCode and the scripted fakes. The stub model in Anthropic's format and the cases that were Claude Code's (the frontmatter case, the subagent's parent and model, no stored subscription credential, a model of a format the adapter doesn't take, a file the agent creates at a hidden path) wait with F-018; they're in this file's history.

## What to build

- **`runAgentSuite(adapter, { model: "stub" | "live" })`:** every case of milestones 1 to 6, run on a named adapter, so a second agent after v1 runs the same cases by passing its adapter. A case a capability rules out runs its declared fallback case instead (a re-prompt for no `rejectAndContinue`, the rebuild template for no `sessionArchive`, hidden files for no `projectConfigOverride`), and checks that.
- **New cases** (spec section 5.2, each a named case the parity table can cite): the unknown notification (a scripted fake that sends one after `initialize`, added here); every model call at the key proxy and nowhere else (the stub endpoint counts them); the usage-match case (the proxy's count equals the agent's own reported usage for the calls it closed, F-089); the launch's environment equals the adapter's allowlist, and no variable outside it reaches the process; a file in `repoConfigPaths` hidden for the task and restored byte for byte, including a hook that would write a marker (on a fake that declares no `projectConfigOverride`); the allow-for-this-task case (the rule holds for the rest of the task and nothing of it reaches the commit); a ticket whose text starts with `/` isn't run as a slash command; a checksum mismatch refuses the launch.
- **The parity test** (`src/testing/parity.ts`, run by `parity.test.ts`): a table, one row per feature of spec section 6, naming for each shipped agent adapter and each scripted fake the suite case that proves it, or the capability it's declared under and its fallback case. It fails when an adapter or a fake has no entry for a row, when a named case doesn't exist, or when a capability an adapter declares `true` has no passing case on it.
- OpenCode's contract test calls `runAgentSuite(new OpenCodeAdapter(...), { model: "stub" })`.

## Done when

- [ ] The suite runs on OpenCode and on the scripted fakes with every new case, and each case's control fails as it should (break-it: the allowlist check skipped; the hidden file not restored).
- [ ] The parity test passes for OpenCode and the fakes, and fails when a row is deleted from an adapter's entry (break-it, recorded in `context/proof/F-019.md`).
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✅ run the agent suite on every adapter`.

## Comments
