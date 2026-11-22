# 03: Task view: a turn's items, the live step and relative paths

Status: ready-for-agent
Builder: web
Blocked by: 01, 02
Features: F-151
Packages: `packages/task-view` (new `src/thread/items.ts`, `src/thread/steps.ts`, `src/thread/recovered.ts`, `src/thread/live-step.ts`, `src/thread/workspace-path.ts`, `src/index.ts`)
Spec: `../spec.md`, section 5.3; the targets' `parts.md` parts 4 to 8; the README's choices 3, 4, 9 and 13, and content fixes 1, 6, 7, 8, 9, 14

## What to build

Pure functions over one `TaskUIMessage`, so the panel renders items and never groups parts itself, and every test and viewer sees the same grouping.

- **`turnItemsOf(message, { taskId, checkoutDirs, mcpServers })`** → `TurnItem[]` as the spec's section 5.3 lists: `run`, `prose`, `captures`, `failure`, `notice`, `result`, `needs`, in the turn's order. A result or an open needs-you part ends the run before it; prose closes a run; the turn's first run is `firstInTurn` (the line that carries the time).
- **`RunStep`** for every part a run holds, discriminated by kind with exhaustive `switch`es: every read of a run as one step with its distinct paths; an edit's lines added and removed from its diff; a command's line, exit (`killed` as its own value) and duration from `meta.stepTimes`; a thought's first sentence (120 characters at most); a search's query, folder and matches; a fetch's host, path and status; a capture with its route from the attachment's `target.path` (never `/` by default) and its preview's label and port; a subagent's node; the setup script; the PR's text; ostra's own tools by `ostraToolOf`, with their outcome (a repeat review's `already submitted, kept as it was`); any other tool by its name and its MCP server (a title starting with one of `mcpServers` and `_`), never the kind `other`.
- **Counts and the tail:** a run's counts by kind in the order each kind's first step happened; its total; its recovered and unrecovered failures; its approvals' answers (approved by whom, denied by whom and whether with a reason); its subagents' counts.
- **Recovered** (`recovered.ts`): a failed step is recovered when a later step in the same turn, of the same kind and the same subject (command line, path, URL), succeeded; a cancelled step isn't a failure. An unrecovered failure is also its own `failure` item right after its run. A failed turn, a crashed session and a lost box are `failure` items; a limit, a budget hold and an approval that expired are `notice` items.
- **`liveStepOf(message)`:** what the agent does now from the running part, the turn's finished steps, its failures not yet recovered, the plan step in progress (`data-plan`'s `in_progress` entry, its index and the plan's length), the turn's start; a pending approval's step as `waiting`, which stands in the live step's place, with the approval's block as a `needs` item after it.
- **`workspacePath(raw, context)`, `workspaceCommand(line, context)`:** the spec's section 5.3 rule for `host` (`…/tasks/{taskId}/agent/`, either separator), `docker` and `kubernetes` (`/workspace/`), a one-repo task's checkout folder, and the home folder as `~/`; a step keeps its full value for `title`.
- Exported from the package's index for the panel; no React, no words (ticket 04 words them).

## Done when

- [ ] Tests named for `F-151/c2`: S1's second run counts `edited 2, ran 2, took a screenshot` in that order with one recovered failure; a failing `pnpm test a` then a passing `pnpm test b` is unrecovered and is its own `failure` item; a cancelled command is no failure; an approved and a denied step count in the tail (break-it: match a later success of any subject, and the `pnpm test a` case fails).
- [ ] Tests named for `F-151/c3`: S3's turn 2 is one run of 23 steps with every read on one step; each command step has its exit and duration; `workspacePath` over a Windows `host` path, a POSIX `host` path, `/workspace/calculator-web/src/x.ts`, a two-repo task, a home folder and a path that only looks like one (`/workspaces/…`) (break-it: drop the separator check, and the Windows case fails).
- [ ] Tests named for `F-151/c4`: `liveStepOf` over S1-working gives `running` `pnpm test history`, 8 done, 1 failed; over S5's build turn, plan step 1 of 6; over a pending approval, `waiting` with its step; `null` for an ended turn.
- [ ] Tests named for `F-151/c8`: a generic tool's step has its name and its MCP server, and `other` appears nowhere; `ostra_submit_review` is an `ostra` step; a capture's route is its attachment's own.
- [ ] Tests named for `F-151/c1`: a turn's items hold its prose as `prose` items in order, and no item for a bookkeeping event.
- [ ] Checks for `packages/task-view` pass.
- [ ] Committed as `✨ fold a turn's steps into runs`.

## Comments
