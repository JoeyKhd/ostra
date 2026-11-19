import { conversationText } from "@ostra/adapter-sdk/testing";
import type { Scenario } from "@ostra/adapter-sdk/testing";

// The scripts the stub model plays for OpenCode in this package's tests. Ported from
// spikes/how-should-the-runner-drive-opencode/src/harness/scenarios.ts. A shell command here is
// `node -e`, so it runs the same under PowerShell (OpenCode's shell on Windows) and bash.

/** The marker a prompt carries to pick its script (`stubMarker` in the testing exports). */
export const sleepCommand = (ms: number): string => `node -e "setTimeout(()=>{},Number(process.argv[1]))" ${String(ms)} ostra-test-sleep`;

export const scenarios: Readonly<Record<string, Scenario>> = {
  hello: ({ step }) => (step === 0 ? { text: "hello from the stub" } : undefined),

  /** A turn that states nothing itself: the member put the fact in the prompt (the archive case). */
  remember: ({ step }) => (step === 0 ? { text: "Noted." } : undefined),

  /**
   * The question about an earlier turn. The stub keeps nothing: it reads the answer out of the
   * messages OpenCode sent it in this very request, so a right answer proves the fact is in the
   * model's context after a session moved to another box.
   */
  recall: ({ step, request }) => {
    if (step !== 0) {
      return undefined;
    }
    const earlier = conversationText(request.messages.slice(0, -1));
    const fact = /(osprey[0-9a-f]{6})/.exec(earlier)?.[1];
    return { text: fact === undefined ? "I do not remember any codename." : `The codename is ${fact}.` };
  },

  /** A model that never answers: the turn runs until it's cancelled. */
  long: ({ step }) => (step === 0 ? { text: "never sent", delayMs: 120_000, keepalive: false } : undefined),

  /** A read, an edit, a shell command, a read that fails, then text. */
  tools: ({ step }) => {
    switch (step) {
      case 0:
        return { toolCalls: [{ name: "read", arguments: { path: "README.md" } }] };
      case 1:
        return { toolCalls: [{ name: "edit", arguments: { path: "README.md", oldString: "hello", newString: "hello, tools" } }] };
      case 2:
        return { toolCalls: [{ name: "shell", arguments: { command: `node -e "console.log('shell-ok')"`, description: "say ok" } }] };
      case 3:
        return { toolCalls: [{ name: "read", arguments: { path: "does-not-exist.txt" } }] };
      case 4:
        return { text: "tools done" };
      default:
        return undefined;
    }
  },

  /** A todo list, then text. */
  todo: ({ step }) => {
    if (step === 0) {
      return {
        toolCalls: [
          {
            name: "todowrite",
            arguments: {
              todos: [
                { content: "Read README.md", status: "in_progress" },
                { content: "Edit README.md", status: "pending" },
              ],
            },
          },
        ],
      };
    }
    return step === 1 ? { text: "todo written" } : undefined;
  },

  /** A long tool step, then a reply that says whether the steer text arrived (ADR 0032's probe). */
  steer: ({ step, since }) => {
    if (step === 0) {
      return { toolCalls: [{ name: "shell", arguments: { command: sleepCommand(8000), timeout: 120_000, description: "wait" } }] };
    }
    if (step === 1) {
      return { text: conversationText(since).includes("STEER-TOKEN") ? "steer seen mid-turn" : "no steer seen" };
    }
    return undefined;
  },
};
