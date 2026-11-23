# 02: Adapter SDK: the workflow, the move's route and the declared words

Status: done
Builder: adapters
Blocked by: none
Features: F-008, F-152
Packages: `packages/adapter-sdk` (`src/tracker/base.ts`, `capabilities.ts`, new `workflow.ts`, `testing/jira-fake.ts`, `testing/tracker-suite.ts`, new `testing/tracker-workflow-cases.ts`, `testing/parity.test.ts`, the tiny tracker), `packages/adapters/adapter-linear`, and `packages/adapters/adapter-jira` if ticket 03 has landed
Spec: `../spec.md`, sections 5.2 and 6; ADR 0071, ADR 0047

## What to build

- **Capabilities:** `magicWords`, `richText` (`"markdown" | "adf"`) and `jqlFilter`, declared by every tracker adapter in the same commit: Linear `true`, `"markdown"`, `false`; the in-memory Jira fake `false`, `"adf"`, `true`; the tiny tracker `false`, `"markdown"`, `false`.
- **`readWorkflow(board)`** and the types `TrackerWorkflow`, `WorkflowTransition` (section 5.2), `unsupported` in the base class without `statusGraph`. The in-memory Jira fake implements it from its site's graph, with a switch that makes it `readable: false` (a credential without workflow access).
- **`routeTo` and `reachability`** in `tracker/workflow.ts`, pure, exported from the package's index, with unit tests over a workflow with a global transition, a dead-end status, a two-step route and a loop.
- **`MoveResult.via`:** the transitions performed, in order; `[]` when nothing moved and for Linear. The in-memory fake's walk uses `routeTo` and answers its steps. A move with no route stays `conflict`, writing nothing.
- **The suite's cases** (section 5.2), in `tracker-workflow-cases.ts`, run for every subject that declares `statusGraph`, and the two-site isolation case for every subject (its fixture gains a `second` subject on another site or workspace: the fake Linear's second workspace, the in-memory fake's second site).
- **The parity rows** for the three capabilities and `readWorkflow`.
- **If ticket 03 has landed:** `adapter-jira` declares the three capabilities, answers `via`, and its `readWorkflow` answers `unsupported` until ticket 04; otherwise ticket 03 picks them up when it rebases, and this ticket's `## Comments` says so.

## Done when

- [x] Tests named for `F-008/c5`: the workflow cases pass for the in-memory Jira fake (and `adapter-jira` when present): the workflow read, `readable: false`, a two-step move's `via`, a move with no route `conflict` and the ticket unmoved, a repeat move writing nothing (break-it: let the fake write the target status directly, and the "never a status write" case fails).
- [x] Tests named for `F-152/c3`: the two-site case passes for Linear and the in-memory Jira fake: a delivery signed for one is refused by the other, and neither reads the other's ticket or file.
- [x] `routeTo` and `reachability` have their unit tests; the parity test has the new rows.
- [x] The adapter guide (`apps/docs/content/contributing/adapters.mdx` and `adapter-guide-samples.test.ts`) names the three capabilities and `readWorkflow`.
- [x] Checks for `packages/adapter-sdk` and every tracker adapter pass (spec section 10).
- [x] Committed as `✨ add the workflow read to the tracker contract`.

## Comments

- 2026-11-23, adapters: built as `✨ add the workflow read to the tracker contract`, after ticket 03 landed (`b6f4da75`, then `f448de83`), so `adapter-jira` is wired here too. Readings and differences:
  - **The SDK:** `tracker/workflow.ts` holds `TrackerWorkflow`, `WorkflowTransition`, `TransitionTaken`, `MAX_ROUTE_STEPS` (3), `routeTo`, `reachability` (per status `here`, `route` with its first transition and length, or `unreachable`), `mergeWorkflows` (the union per `(from, to, name)`) and `transitionsTaken`, all exported from the package's index. `routeTo` also never passes through a done or cancelled status on its way, the rule `adapter-jira`'s `findTransitionPath` already had: without it a global "Won't do" then "Reopen" reaches almost anything, and a move would close a ticket and reopen it. The target itself may be done or cancelled. `TrackerAdapter.readWorkflow` answers `unsupported` by default; `MoveResult.via` is required.
  - **The capabilities:** Linear `magicWords: true`, `richText: "markdown"`, `jqlFilter: false`; the in-memory Jira fake and `adapter-jira` `false`, `"adf"`, `true`; the tiny tracker `false`, `"markdown"`, `false`. Linear's `statusGraph` is `false`, so it reads no workflow (`unsupported`) and its moves answer `via: []`. The tiny tracker declares `statusGraph: true` but answers `unsupported` here, as it does for every operation of its; the parity table records that.
  - **The in-memory fake:** `readWorkflow` from its site's graph (`JiraFakeAdapterOptions.workflowAccess: false` reads the statuses alone), moves by `routeTo` and answers `via`, and its site gains `setStatus`. Its walk is now at most three transitions: no test of any package needed more.
  - **The suite:** `testing/tracker-workflow-cases.ts` holds the three `F-008/c5` cases and the `F-152/c3` two-site case, run by `defineTrackerContractSuite`. The fixture gains `workflow` (`setStatus`, `twoSteps`, `noRoute`, `globalTransition`, `withoutWorkflowAccess`) and `second` (`secondSubjectOf(adapter, fixture)`). The workflow cases run for an adapter with `statusGraph` or `transitions`; one with neither checks `readWorkflow` is `unsupported`, and the move cases skip (Linear). The existing move case checks `via` too: non-empty on a transitions tracker, `[]` otherwise, and `[]` on a repeat.
  - **The fake Linear's second workspace** is a second `createFakeLinear()`, with its own app, token and secret: each fake Linear is one workspace, as each Linear organization is, so the two-site case runs on two of them in one test. Both of Linear's suites (the app's token, the development API key) run it.
  - **The parity rows** are tracker rows of their own (`testing/tracker-parity.ts`: `trackerParityTable`, `checkTrackerParity`), since `parity.ts`'s table is the agents': `parity.test.ts` checks the in-memory fake and the tiny tracker, and Linear's and Jira's packages check their own entries.
  - **`adapter-jira`** (as `f448de83` aligned it with the spec) declares the three capabilities; its `readWorkflow`, already the `TrackerWorkflow` shape (the project's statuses and its issue types' transitions in one), now overrides the contract's, and `JiraBoardWorkflow` is `TrackerWorkflow`. So it reads its workflow now rather than answering `unsupported` until ticket 04. `moveTicket` answers `via` from the transitions it posted (a transition a screen refused isn't one). Its suite gains the workflow hooks (To Do two steps from In Review, Won't Do four from Done, a token without `read:workflow:jira`) and a second fake Jira site. **For ticket 04:** its `findTransitionPath` is the same rule as the SDK's `routeTo` (at most three, never through a done or cancelled status), and can give way to it; it reads workflows through `workflowscheme/project` and `workflow/search`, where the spec names `/workflows/search` (S-12 on the live site decides).
