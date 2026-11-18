// The scripted model for the dry-run. It plays a ticket's solution through
// OpenCode's own tools (read, edit, write), runs the test suite once with the
// shell tool as a developer would, and ends with the summary. Each model call
// is one step: step N is the number of assistant messages the agent has sent
// back so far. Calls without tools (OpenCode's title call) get a short title.
//
// The prompt carries no marker: the script is chosen by which run this stub
// serves, so the prompt OpenCode sends is exactly what a real run would send.

import type { StubBrain, StubReply, StubRequest } from "../lib/stub-models/types.ts";
import type { Solution, Step } from "../tickets/schema.ts";

export const TEST_COMMAND = 'node --test "test/**/*.test.ts"';

const callFor = (step: Step): NonNullable<StubReply["toolCalls"]>[number] => {
  switch (step.tool) {
    case "read":
      return { name: "read", arguments: { path: step.path } };
    case "shell":
      return { name: "shell", arguments: { command: step.command, timeout: 120_000, description: "Run a command" } };
    case "question":
      return {
        name: "question",
        arguments: {
          questions: [{ question: step.question, header: "Question", options: step.options.map((label) => ({ label, description: label })) }],
        },
      };
    case "edit":
      return { name: "edit", arguments: { path: step.path, oldString: step.oldString, newString: step.newString } };
    case "write":
      return { name: "write", arguments: { path: step.path, content: step.content } };
    default:
      return step satisfies never;
  }
};

export type SolveBrainOptions = {
  /** Each model call takes this long before its first byte: makes a run last, for the cap and timeout checks. */
  readonly stepDelayMs?: number;
};

export const createSolveBrain = (solution: Solution, options: SolveBrainOptions = {}): StubBrain => {
  const delay = options.stepDelayMs === undefined ? {} : { delayMs: options.stepDelayMs };
  return (request: StubRequest): StubReply => {
    if (request.toolNames.length === 0) return { text: "Calc ticket" };
    const step = request.messages.filter((message) => message.role === "assistant").length;
    const next = solution.steps[step];
    if (next !== undefined) return { toolCalls: [callFor(next)], ...delay };
    if (step === solution.steps.length) {
      return { toolCalls: [{ name: "shell", arguments: { command: TEST_COMMAND, timeout: 120_000, description: "Run the tests" } }], ...delay };
    }
    return { text: solution.summary, ...delay };
  };
};
