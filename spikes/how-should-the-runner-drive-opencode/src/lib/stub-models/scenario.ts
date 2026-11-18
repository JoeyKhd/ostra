// A scripted brain for the stub model servers. A prompt names its script with
// a marker, `[[stub:<name> <args>]]`. Each model call in that turn is one step
// of the script: step N is the number of assistant messages since the marked
// user message. When the script returns undefined, the turn ends with text.
// Calls without tools (title and summary calls) get a short plain answer.

import type { NormalizedMessage, StubBrain, StubReply, StubRequest } from "./types.ts";

export type ScenarioContext = {
  readonly request: StubRequest;
  readonly step: number;
  /** Text after the scenario name in the marker. */
  readonly args: string;
  /** Messages after the marked user message. */
  readonly since: readonly NormalizedMessage[];
  /** Tool results since the last assistant message. */
  readonly lastToolResults: readonly NormalizedMessage[];
};

export type Scenario = (context: ScenarioContext) => StubReply | undefined;

const MARKER = /\[\[stub:([a-z0-9-]+)(?:\s+([^\]]*))?\]\]/;

export const stubMarker = (name: string, args = ""): string => `[[stub:${name}${args === "" ? "" : ` ${args}`}]]`;

/** All the text the model was shown, for recall checks. */
export const conversationText = (messages: readonly NormalizedMessage[]): string =>
  messages.map((message) => message.text + message.toolCalls.map((call) => JSON.stringify(call.arguments)).join("")).join("\n");

export type BrainHooks = {
  /** Calls without tools: titles and summaries. */
  readonly auxiliary?: (request: StubRequest) => StubReply;
  /** Runs first; an answer here wins over the scripts (e.g. an agent's own compaction call). */
  readonly intercept?: (request: StubRequest) => StubReply | undefined;
};

export const createScenarioBrain = (scenarios: Readonly<Record<string, Scenario>>, hooks: BrainHooks = {}): StubBrain => {
  const { auxiliary, intercept } = hooks;
  return (request) => {
    const intercepted = intercept?.(request);
    if (intercepted !== undefined) return intercepted;
    if (request.toolNames.length === 0) {
      return auxiliary?.(request) ?? { text: "Stub summary." };
    }
    let markerIndex = -1;
    let name = "";
    let args = "";
    for (let i = request.messages.length - 1; i >= 0; i -= 1) {
      const message = request.messages[i];
      if (message?.role !== "user") continue;
      const match = MARKER.exec(message.text);
      if (match !== null) {
        markerIndex = i;
        name = match[1] ?? "";
        args = (match[2] ?? "").trim();
        break;
      }
    }
    const scenario = scenarios[name];
    if (markerIndex === -1 || scenario === undefined) return { text: `stub: no scenario (${name === "" ? "none" : name})` };
    const since = request.messages.slice(markerIndex + 1);
    const step = since.filter((message) => message.role === "assistant").length;
    let lastAssistant = -1;
    for (let i = since.length - 1; i >= 0; i -= 1) {
      if (since[i]?.role === "assistant") {
        lastAssistant = i;
        break;
      }
    }
    const lastToolResults = since.slice(lastAssistant + 1).filter((message) => message.role === "tool");
    return scenario({ request, step, args, since, lastToolResults }) ?? { text: `done: ${name}` };
  };
};
