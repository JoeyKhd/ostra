# 04: Adapter SDK: code host, agent, executor and blob additions

Status: ready-for-agent
Builder: adapters (contracts)
Blocked by: 02
Features: F-055, F-060, F-031, F-079 (code host); F-096, F-033 (agent, executor); F-114 (the blob suite)
Packages: `packages/adapter-sdk` (`code-host/`, `agent/`, `executor/`, `blob-store/`, `testing/`), the tiny adapters, and stubs in each adapter that extends a changed class
Spec: `../spec.md`, section 5.2

## What to build

- **`CodeHostAdapter`:** `readBranchRules`, `getPullRequest`, `parseWebhook` for `pull_request` events (loose, after `verifyWebhook`) and `deleteRef`; the capability `branchRules`. The code host suite gains a case for each, and milestone 1's fake code host gains branch protection, rulesets with `required_signatures`, signed `pull_request` deliveries, merge, close and ref deletion.
- **`AgentAdapter`:** the capability `sessionArchive`; the launch helpers `exportSession` and `importSession` (a binary and an argument array, never a shell string; `importSession` takes the box's workspace directory); the ACP driver marks the updates that `session/load` replays, and the base class hands them over as replay, not as new events. The scripted fake ACP agent gains `session/load` with a replay, an export and an import of its own archive format, a stall and a long turn. The agent suite gains: export, import in a fresh directory, then load, and the agent answers about earlier turns; replayed updates are marked; an import into another directory binds to it; `session/resume` after an import is tried and its result recorded.
- **`ExecutorAdapter`:** `saveWorkInProgress` (each repo's working tree to `refs/ostra/wip/<taskId>`, a forced push through the git proxy, `--no-verify`, `GIT_CEILING_DIRECTORIES` set) and `restoreWorkInProgress` (onto the saved commit, then the branch's new commits merged in; on a conflict, the branch's head checked out and `conflict` returned); `release` takes a reason. The executor suite gains: untracked, staged, unstaged and deleted files come back; ignored files don't; a moved branch merges or reports a conflict; a second save replaces the first.
- **`BlobStoreAdapter`:** the full contract suite of spec section 5.2. The operations don't change.
- Each adapter package that extends a changed class gets stubs answering `unsupported` in the same commit, so every caller compiles. Tickets 09, 10, 22 and 24 replace them.

## Port from

`spikes/can-a-session-move-to-a-fresh-box/src/lib/hidden-ref.ts` and its tests; `session-archive.ts` for the fake agent's archive.

## Done when

- [ ] Every suite passes against its fakes, and the existing adapters still pass their suites with the stubs.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add code host, agent and executor additions`.

## Comments
