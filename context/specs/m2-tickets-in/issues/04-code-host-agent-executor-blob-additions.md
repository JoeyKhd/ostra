# 04: Adapter SDK: code host, agent, executor and blob additions

Status: done
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

- [x] Every suite passes against its fakes, and the existing adapters still pass their suites with the stubs.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add code host, agent and executor additions`.

## Comments
- 2026-11-19, core (contracts): done in `✨ add code host, agent and executor additions`. For tickets 09, 10, 11, 12, 22 and 24:
  - **Additive, as milestone 1's `listTree` was:** each new operation is a base-class method that answers `unsupported` until an adapter overrides it, and each kind declares its new capability, so adapter parity is visible and the fakes other builders own still compile. No adapter needed a separate stub.
  - **`CodeHostAdapter`:** `readBranchRules(access, branch)` → `{ protected, requiresSignedCommits, reasons }` (each `boolean | "unknown"`), `getPullRequest(access, number)` → `PullRequestDetails` (`merged`, `headSha`, `updatedAt`, `mergedAt`, `closedAt`), `parseWebhook(input)` → `CodeHostWebhookEvent` (`pull_request` with the repo's host ID, number, state, head and `changedAt`, or `other`), `deleteRef(access, ref)` → `{ deleted }` (a second delete isn't an error). Capability `branchRules` (GitHub `false` until 09). The tiny code host has all four, with branch rules per branch, refs, and `finishPullRequest` to merge or close one; the code host suite's new cases take optional fixture fields (`branchRules`, `pullRequestWebhook`, `deletableRef`), skipped when absent, so ticket 09 adds them for GitHub, and its fake GitHub server gains rulesets with `required_signatures` there.
  - **`ExecutorAdapter`:** `saveWorkInProgress({ box, turnOrdinal })` → per repo `{ repoId, sha, baseSha }`, `restoreWorkInProgress({ box, refs })` → per repo `applied | none | conflict`, and `release(box, reason)` with the protocol's `BoxReleaseReason` (the runner passes `requested` for milestone 1's one-turn release). The shared steps, ported from spike 2's `hidden-ref.ts`, are `saveWorkInProgressIn` and `restoreWorkInProgressIn` (`src/executor/work-in-progress.ts`), behind a `WipGit` and `WipFiles` port so the docker executor can run git in its container; `localWipGit` and `localWipFiles` serve the host one. They add ADR 0039's moved-branch rule: the work restored onto its own commit, then the branch's new commits merged in (it comes back unstaged), and on a conflict nothing restored and the branch's head checked out. Their real-git tests cover untracked, staged, unstaged, deleted and ignored files, a second save, no ref, a moved branch and a conflict. The executor suite's two new cases need the fixture's `workInProgress` hook (a checkout's files and two tracked files), skipped without it; ticket 22 adds it for `host`.
  - **`AgentAdapter`:** capability `sessionArchive`; `exportSession(input)` and `importSession(input)` answer an `AgentCommand` (a binary, an argument array, an allowlisted environment and a folder) that runs beside the agent; the import takes the fresh box's workspace. The ACP driver now hands what `session/load` replays to `onReplay` instead of dropping it, and the base class counts it on `AgentSession.replayedUpdates` (for `session.restored`), never as events. The fake ACP agent keeps sessions in `FAKE_AGENT_DATA`, has `export` and `import --directory` subcommands of its own archive format (a session loads only in the directory it was imported to), and the scripts `remember`, `recall` and `long` (the existing `silent` is the stall). The agent suite's new case exports, imports into fresh folders, loads with the replay counted and none of it stored, and recalls an earlier turn's fact; it passes on both fake profiles. Not covered here: trying `session/resume` after an import (ticket 10 records it for OpenCode).
  - **Blob store:** `defineBlobStoreContractSuite` is the full set (put and get, another organization's key `not-found`, delete, the cap, chunked uploads resumed after a drop, a gap and a changed resend refused, a short or wrong finish refused, a bad digest), with a `{ maxBytes }` fixture; `defineBlobStoreFirstCases` is the old one. The built-in store passes it on in-memory rows.
