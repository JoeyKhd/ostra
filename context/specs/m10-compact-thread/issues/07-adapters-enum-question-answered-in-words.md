# 07: Adapters: an enum question answered in words

Status: ready-for-agent
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

- [ ] Tests named for `F-151/c5`: the driver sends a select field's words outside its options as they are, in `accept`'s content; the scripted fake with the capability receives them and continues its turn; OpenCode's live contract case, against the pinned binary, shows the words reach the model's tool result (or records the refusal, and the declaration is `false`) (break-it: map the words to the first option, and the driver's test fails).
- [ ] The parity test passes with the new row.
- [ ] Checks for the whole repo pass (spec section 10: what a runner answers an agent).
- [ ] Committed as `✨ let an agent take words for an enum field`.

## Comments
