# 09: OpenCode adapter: read-only kinds, the new tools and automatic turns

Status: done
Builder: adapters
Blocked by: 04
Features: F-099, F-100, F-101, F-113
Packages: `packages/adapters/adapter-opencode`
Spec: `../spec.md`, sections 5.2 and 8

## What to build

- **The built-in Refine and Review profiles' permissions** map to OpenCode's own settings: edits denied for review; edits allowed inside the workspace for a refine profile that allows prototyping and denied for the built-in one; shell allowed (the box contains it, ADR 0031); `external_directory` denied as milestone 1's mapping does.
- **ostra's MCP server** in OpenCode's MCP list carries the tools the spec's `tools` names, and nothing else, so a code task never sees `submit_review`.
- **The question tool in an automatic turn:** OpenCode's `question` tool reaches the runner as an ACP elicitation; the adapter declares it does (capability `elicitation: true`), so the runner's fixed reply (ticket 23) answers it. Spike 10's case, through the agent suite (ticket 04), on the real OpenCode with the stub model.
- **`commitPaths`:** nothing in the adapter; the agent suite's case runs on OpenCode to show its own commits don't escape the runner's filter.

## Done when

- [x] Ticket 04's new agent suite cases pass on OpenCode, with the stub model scripted for each.
- [x] A test shows a code task's MCP list has no `submit_draft`, `submit_review` or `propose_environment`, and a review task's has `submit_review` only of the three.
- [x] Break-it: the tool filter dropped fails its test; recorded in `context/proof/F-100.md`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ give OpenCode the read-only kinds`.

## Comments
- 2026-11-20 (from ticket 04): OpenCode's suite fixture (`opencode-adapter.contract.test.ts`) runs the new cases once it passes a `team` probe set (`AgentTeamProbes` in `packages/adapter-sdk/src/testing/agent-team-cases.ts`; the fakes' are in `fake-agent.test.ts`'s `teamProbes`). Then switch OpenCode's three milestone 6 rows in `packages/adapter-sdk/src/testing/parity.ts` (`milestone6Waits`) from `waits` to the cases, as `milestone6WithTools` names them for the fakes. The capability the spec calls `elicitation` is the existing `elicitationForm`.
- 2026-11-20 (ticket 09, commit `✨ give OpenCode the read-only kinds`, after `✨ name a launch's kind and tool sets` in `@ostra/adapter-sdk`; tickets 07 and 08 landed as b6d6f9dc and 8efdfd5b). Built in `packages/adapters/adapter-opencode`:
  - **The launch's new fields.** `PrepareLaunchInput` gains `kind`, `allowPrototyping` and `tools`, all optional (additive, in their own commit), for the runner to pass from the spec (tickets 22 and 23).
  - **Permissions.** `buildPermissions` denies edits for a review task, and for a refine task whose profile doesn't allow prototyping, after every ask. The shell stays allowed, and `external_directory` stays denied last.
  - **The tool filter.** Each of `submit_draft`, `submit_review` and `propose_environment` the task's sets don't name is denied (`ostra_<tool>`). On the pinned 2.3.2, a denied tool leaves the model's tool list, so a code task never sees `submit_review` even when a server lists it. Without `tools` (a runner before milestone 6) nothing is filtered, since the sidecar serves the defaults; that keeps milestone 1 to 5's configs as they were.
  - **The question tool.** `elicitationForm` was already `true` and maps OpenCode's question to an ACP elicitation, so no second `elicitation` capability (ticket 04's note).
  - **New:** OpenCode reports a shell command that exits non-zero as `completed`, with the exit in `rawOutput.metadata.exit`. The adapter's `mapUpdate` now turns it into `failed`, so a refused push shows in the event log as a failed shell call, as ticket 04's case expects. Seen on the binary: the push's tool update ended "Exit code: 1" with `exitCode: 0` before.
  - **The suite.** Ticket 04's team cases now pass the task kind's `tools` in the launch, as the runner's would. The fakes ignore the field.
  - **Proof.** All nine team cases pass on OpenCode on both stub formats (the fixture's `team` probes, with new stub scenarios). OpenCode-specific cases: the tool filter, review and refine edits, the failed shell call, and the neutral reply. The parity table's three rows for OpenCode now name the cases. Break-its: dropping the tool filter, allowing every kind's edits, turning `failedShell` off, and blanking the driver's answers; each made its cases fail, and each was restored. Rows are in `context/proof/F-099.md`, `F-100.md` and `F-101.md`, with a note in `F-113.md`.
