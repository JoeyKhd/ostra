import { conversationText } from "@ostra/adapter-sdk/testing";
import type { NormalizedMessage, Scenario } from "@ostra/adapter-sdk/testing";

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

  // ---- milestone 3: the profile cases (ADR 0049). Each says what OpenCode itself let happen. ----

  /** Writes the file named in the marker, and says whether it could. */
  "ask-path": ({ step, args, lastToolResults }) => {
    if (step === 0) {
      return { toolCalls: [{ name: "write", arguments: { path: args, content: "written by the stub\n" } }] };
    }
    return step === 1 ? { text: refused(lastToolResults) ? `Could not write ${args}.` : `Wrote ${args}.` } : undefined;
  },

  /** Runs the command named in the marker, and says whether it could. */
  "ask-command": ({ step, args, lastToolResults }) => {
    if (step === 0) {
      return { toolCalls: [{ name: "shell", arguments: { command: args, description: "the command the case asks for" } }] };
    }
    return step === 1 ? { text: refused(lastToolResults) ? `Could not run ${args}.` : `Ran ${args}.` } : undefined;
  },

  /** Two writes in one step, so two requests are pending in OpenCode at once: it sends them to ostra one at a time. */
  "ask-pair": ({ step }) => {
    if (step === 0) {
      return {
        toolCalls: [
          { name: "write", arguments: { path: "pair-a.txt", content: "a\n" } },
          { name: "write", arguments: { path: "pair-b.txt", content: "b\n" } },
        ],
      };
    }
    return step === 1 ? { text: "pair done" } : undefined;
  },

  /** A plan turn: a write, then the marker's tool on each MCP server, then what each one did. */
  "plan-turn": ({ step, args, since }) => {
    switch (step) {
      case 0:
        return { toolCalls: [{ name: "write", arguments: { path: "plan-attempt.txt", content: "should never land\n" } }] };
      case 1:
        return { toolCalls: [{ name: `docs_${args}`, arguments: {} }] };
      case 2:
        return { toolCalls: [{ name: `files_${args}`, arguments: {} }] };
      case 3: {
        const results = resultsByTool(since);
        const outcome = (name: string, ran: string): string => (results.get(name)?.includes(ran) === true ? "allowed" : "refused");
        const write = results.get("write");
        const wrote = write !== undefined && !refusedText(write);
        return { text: `Plan: read the code, then change it. write=${wrote ? "allowed" : "refused"} docs:${outcome(`docs_${args}`, "docs ran")} files:${outcome(`files_${args}`, "files ran")}` };
      }
      default:
        return undefined;
    }
  },

  /** Says the mode OpenCode put the turn in: its plan agent tells the model it is in Plan mode. */
  mode: ({ step, request }) => {
    if (step !== 0) {
      return undefined;
    }
    const all = request.messages.map((message) => message.text).join("\n");
    return { text: `mode: ${all.lastIndexOf("You are in Plan mode") > all.lastIndexOf("NO LONGER in Plan mode") ? "plan" : "build"}` };
  },

  /** Loads every skill OpenCode lists, and names each with its first heading. */
  skills: ({ step, request, lastToolResults }) => {
    if (step === 0) {
      const listed = request.messages.map((message) => message.text).join("\n");
      // OpenCode's own list of skills, and the profile's, which its instructions name.
      const fromList = [...listed.matchAll(/<id>([^<]+)<\/id>/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1].trim()]));
      const fromInstructions = [...listed.matchAll(/`skill` tool, by its ID\): ([^\n]+)/g)].flatMap((match) => [...(match[1] ?? "").matchAll(/`([^`]+)`/g)].flatMap((id) => (id[1] === undefined ? [] : [id[1]])));
      const ids = [...new Set([...fromList, ...fromInstructions])];
      return ids.length === 0 ? { text: "no skills listed" } : { toolCalls: ids.map((id) => ({ name: "skill", arguments: { id } })) };
    }
    if (step === 1) {
      const loaded = lastToolResults.flatMap((result) => {
        const name = /<skill_content name="([^"]+)">/.exec(result.text)?.[1];
        const heading = result.text.split("\n").find((line) => line.startsWith("# ") && !line.startsWith("# Skill:"));
        return name === undefined ? [] : [`${name} (${heading?.trim() ?? "no heading"})`];
      });
      return { text: `skills: ${loaded.join(", ")}` };
    }
    return undefined;
  },

  /** Calls the MCP tool the marker names (`<server>_<tool>`), and says what it answered. */
  "mcp-call": ({ step, args, lastToolResults }) => {
    if (step === 0) {
      return { toolCalls: [{ name: args, arguments: {} }] };
    }
    return step === 1 ? { text: `${args} answered: ${lastToolResults.map((result) => result.text).join(" | ")}` } : undefined;
  },

  /** Names each server of the marker (`<name>=<transport>,...`) whose tools OpenCode offers the model. */
  "mcp-list": ({ step, args, request }) => {
    if (step !== 0) {
      return undefined;
    }
    const offered = args.split(",").flatMap((pair) => {
      const [name, transport] = pair.split("=");
      return name !== undefined && transport !== undefined && request.toolNames.some((tool) => tool.startsWith(`${name}_`)) ? [`${name}/${transport}`] : [];
    });
    return { text: `servers: ${offered.length === 0 ? "none" : offered.join(" ")}` };
  },

  /**
   * Whether each marker of the marker's list reached the model, in its instructions or anywhere
   * else, as a file writes it (`<marker>:`): the prompt names the markers bare, so it never counts.
   */
  told: ({ step, args, request }) => {
    if (step !== 0) {
      return undefined;
    }
    const all = request.messages.map((message) => message.text).join("\n");
    return { text: args.split(",").map((marker) => `${marker}=${String(all.includes(`${marker}:`))}`).join(" ") };
  },
};

/** A tool result OpenCode refused: no such tool in this mode, or a permission it denied. */
const refusedText = (text: string): boolean => /no tool named|permission denied|denied|rejected|not allowed/i.test(text);

const refused = (results: readonly NormalizedMessage[]): boolean => results.length === 0 || results.some((result) => result.isError || refusedText(result.text));

/** Each tool call's result text since the marker, by the tool's name. */
const resultsByTool = (since: readonly NormalizedMessage[]): ReadonlyMap<string, string> => {
  const names = new Map<string, string>();
  for (const message of since) {
    for (const call of message.toolCalls) {
      names.set(call.id, call.name);
    }
  }
  const results = new Map<string, string>();
  for (const message of since) {
    const name = message.toolCallId === undefined ? undefined : names.get(message.toolCallId);
    if (message.role === "tool" && name !== undefined) {
      results.set(name, message.isError ? `error: ${message.text}` : message.text);
    }
  }
  return results;
};
