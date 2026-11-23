# 02: Adapter SDK: the workflow, the move's route and the declared words

Status: ready-for-agent
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

- [ ] Tests named for `F-008/c5`: the workflow cases pass for the in-memory Jira fake (and `adapter-jira` when present): the workflow read, `readable: false`, a two-step move's `via`, a move with no route `conflict` and the ticket unmoved, a repeat move writing nothing (break-it: let the fake write the target status directly, and the "never a status write" case fails).
- [ ] Tests named for `F-152/c3`: the two-site case passes for Linear and the in-memory Jira fake: a delivery signed for one is refused by the other, and neither reads the other's ticket or file.
- [ ] `routeTo` and `reachability` have their unit tests; the parity test has the new rows.
- [ ] The adapter guide (`apps/docs/content/contributing/adapters.mdx` and `adapter-guide-samples.test.ts`) names the three capabilities and `readWorkflow`.
- [ ] Checks for `packages/adapter-sdk` and every tracker adapter pass (spec section 10).
- [ ] Committed as `✨ add the workflow read to the tracker contract`.

## Comments
