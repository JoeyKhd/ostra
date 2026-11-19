# 03: Adapter SDK: the suite by adapter, the new cases, and the parity test

Status: ready-for-agent
Builder: adapters
Blocked by: 02
Features: F-018, F-019 (adapter parity)
Packages: `packages/adapter-sdk` (`src/testing/agent-suite.ts`, `src/testing/parity.ts` (new), `src/testing/stub-model/`), `packages/adapters/adapter-opencode` (its suite call)
Spec: `../spec.md`, sections 5.2, 6 and 9

## What to build

- **`runAgentSuite(adapter, { model: "stub" | "live" })`:** every case of milestones 1 to 6, run on a named adapter. A case a capability rules out runs its declared fallback case instead (a re-prompt for no `rejectAndContinue`, the rebuild template for no `sessionArchive`, hidden files for no `projectConfigOverride`), and checks that.
- **The stub model in Anthropic's format** counts each call by path (`/v1/messages`, `/v1/messages/count_tokens`, `/v1/models`) and answers `count_tokens` and `models`, so a case can assert where every call went.
- **New cases** (spec section 5.2): the unknown notification; every model call at the key proxy and nowhere else; the launch's environment equals the adapter's allowlist, and no variable outside it reaches the process; a file in `repoConfigPaths` hidden for the task and restored byte for byte, including a hook that would write a marker; a subagent's calls carry their parent; a model of a format the adapter doesn't take refused before launch; a checksum mismatch refuses the launch.
- **The parity test** (`src/testing/parity.ts`, run by `parity.test.ts`): a table, one row per feature of spec section 6, naming for each shipped agent adapter the suite case that proves it, or the capability it's declared under and its fallback case. It fails when a shipped adapter has no entry for a row, when a named case doesn't exist, or when a capability an adapter declares `true` has no passing case on it.
- OpenCode's contract test calls `runAgentSuite(new OpenCodeAdapter(...), { model: "stub" })`.

## Done when

- [ ] The suite runs on OpenCode and on the scripted fakes with every new case, and each case's control fails as it should (break-it: the allowlist check skipped; the hidden file not restored).
- [ ] The parity test passes for OpenCode and the fakes, and fails when a row is deleted from an adapter's entry (break-it, recorded in `context/proof/F-018.md`).
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✅ run the agent suite on every adapter`.

## Comments
