# 07: Adapters: an enum question answered in words

Status: done
Builder: adapters
Blocked by: none
Features: F-151
Packages: `packages/adapter-sdk` (`src/agent/capabilities.ts`, `src/agent/acp/driver.ts`, `src/testing/` the agent contract suite, the scripted fake agents, `parity.test.ts`), `packages/adapters/adapter-opencode`
Spec: `../spec.md`, sections 4 and 6; the targets' README, choice 5

## What to build

`Something else…` gives the agent a member's own words for an enum field of an ACP form. ACP forms carry strings; whether the agent takes a value outside its enum is the agent's, so it's a declared capability, as adapter parity asks (`AGENTS.md`).

- **Capability, new:** `questionFreeText: boolean` in the agent capabilities: the agent takes words for a form's enum field. The scripted fakes come with it and without it; the tiny adapters declare `false`.
- **The driver:** an answer to a select field goes in the form's `accept` content as the string it is, never matched to an option or dropped (`coerceAnswer` leaves a select's words alone; a boolean or a number field is coerced as now).
- **The agent contract suite** gains (`agent-question-cases.ts`, new, or the existing questions cases):
  - with `questionFreeText`, a form with an enum field answered with words outside the enum reaches the agent as those words, and the agent's turn goes on;
  - without it, the suite asserts nothing of free text (the panel offers none).
- **OpenCode:** declares `questionFreeText: true` if its live contract case passes against the pinned binary (its question tool returns the words to the model); if the binary refuses a value outside its enum, it declares `false`, and this ticket's `## Comments` says what the binary did, for ticket 20 (the README's choice 5's alternative is then the maintainer's call).
- **Parity rows:** `questionFreeText` in `parity.test.ts`.

## Done when

- [x] Tests named for `F-151/c5`: the driver sends a select field's words outside its options as they are, in `accept`'s content; the scripted fake with the capability receives them and continues its turn; OpenCode's live contract case, against the pinned binary, shows the words reach the model's tool result (or records the refusal, and the declaration is `false`) (break-it: map the words to the first option, and the driver's test fails).
- [x] The parity test passes with the new row.
- [x] Checks for the whole repo pass (spec section 10: what a runner answers an agent).
- [x] Committed as `✨ let an agent take words for an enum field`.

## Comments

- 2026-11-22, adapters: committed as `✨ let an agent take words for an enum field` (`845c6a55`), on `main` after ticket 01's `28b8cff4` (it touches no file of 01's; the two adapter packages typecheck and lint on it). What it holds:
  - **The capability:** `questionFreeText: boolean` on `AgentCapabilities` (milestone 10's block in `capabilities.ts`). The rich fakes declare it, the plain fakes, the tiny agent and the guide's sample declare `false`, and OpenCode declares `true` (below). The agent suite's common case checks it's a boolean on every agent.
  - **The driver:** `coerceAnswer` returns a select field's answer (a field with an `enum` or a `oneOf` of strings) as the string it is before any type check, so the member's words go back in `accept`'s content untouched; a boolean or a number field without options is coerced as before. The driver keeps no list of what an agent takes: it sends the words to every agent, and the adapter's declaration is what the panel reads.
  - **The fakes:** `fakeAgentCapabilities` gains the field. `[[fake:elicit]]` on `rich` says the content it got (`answered: {…}`); on `plain`, an `engine` outside its enum is refused (`refused: the engine is not one of the choices`), so its `false` is true to what it does. An answer within the enum reads as before on both, so every runner test that answers `elicit` is unchanged.
  - **The suite:** `agent-question-cases.ts` (new, exported from `@ostra/adapter-sdk/testing`), run last by `defineAgentContractSuite`, on a fixture's `questions` probes: `choices` (a prompt that asks one question with a select field and says the answer back) and, for an agent with a model, `modelSaw(since)` (the tool results its model was sent). With `questionFreeText` it answers every select field with `freeTextWords` (shell syntax, `..` and prompt-like text, none of any option) and no other field, then checks one question came with a select field, the turn ended `end_turn`, the agent's words after the question carry the member's, and the model saw them in a tool result. Without the capability it skips, asserting nothing of free text.
  - **OpenCode, on the pinned 2.3.2: it takes the words, so it declares `true`.** Its question tool (`opencode.tool.question`) asks each question as a field `q<n>` with `custom: true`, which its ACP layer turns into a `oneOf` field and a `q<n>_custom` text field (`Colour (other)`, "Type your own answer"). Its reply reads `q<n>_custom` when it holds words and otherwise takes `q<n>`'s value as it is, without checking it against the options, and the tool's result to the model is `User has answered your questions: "<question>"="<words>". …`. The suite's case passes against the binary in both API formats (`opencode-adapter.contract.test.ts`, stub scenario `ask-choices`): the stub model quotes the tool result, and `modelSaw` finds the words in it. Nothing for ticket 20 to decide.
  - **Parity:** the row `F-151 An enum question answered in words`, and `questionFreeText` in `capabilityCases` (`on`: the free-text case; `off`: the suite's F-019 question case, milestone 3's form answered from its options) and in `declares`. OpenCode and the rich fakes name the free-text case; the plain fakes the fallback. `parity.test.ts` checks the row per fake, that the fakes come with it and without it, and that a fake that declares it but names only the fallback fails; the row count is 33.
  - **Docs:** the adapter guide's capabilities sample declares `questionFreeText: false` (the guide's samples are compiled by `adapter-guide-samples.test.ts`), says what an agent without it gets, and a short section says how a select's words travel and what the suite's case and the parity row ask. Ticket 18 writes the thread's own page.
  - **Break-it:** `coerceAnswer` mapping words outside the options to the first option fails the driver's F-151/c5 test and the suite's F-151/c5 case on both rich fakes together; restored.
  - **Checks:** whole-repo `turbo run typecheck lint` (76 tasks), the root `tsc --noEmit` and eslint, and `pnpm check:licenses`; tests of `packages/adapter-sdk` (824 passed) and `packages/adapters/adapter-opencode` (251 passed, the contract suite on the pinned binary in both formats), and the runner's `approvals` and `idle-and-release` tests, which answer the fake's `elicit` form.
  - **For later tickets:**
    - **08 (API):** `capabilities.questionFreeText` reads `adapter.capabilities.questionFreeText` for the task's agent, as `steersMidTurn` is read.
    - **13 (the needs-you block):** OpenCode's own `q<n>_custom` text field still reaches ostra as a text field labelled `{header} (other)` beside the select. With `Something else…` on the select it says the same thing twice; the block could fold a `<id>_custom` text field into its select's `Something else…` (the words in either field reach the model the same way, the custom field's winning when both hold words). Nothing in the protocol marks that field as OpenCode's; it's told only by its ID.
    - **05 (core):** `checkQuestionAnswers` still refuses words outside a select's options; `other` is what lets them through, and it should be accepted only when the task's agent declares `questionFreeText`, so a crafted `other` can't send words to an agent that refuses them.
