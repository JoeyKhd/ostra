import { conversationText, stubMarker } from "@ostra/adapter-sdk/testing";
import type { NormalizedMessage, Scenario } from "@ostra/adapter-sdk/testing";

// The scripts the stub model plays for OpenCode in this package's tests. Ported from
// spikes/how-should-the-runner-drive-opencode/src/harness/scenarios.ts. A shell command here is
// `node -e`, so it runs the same under PowerShell (OpenCode's shell on Windows) and bash.

/** The marker a prompt carries to pick its script (`stubMarker` in the testing exports). */
export const sleepCommand = (ms: number): string => `node -e "setTimeout(()=>{},Number(process.argv[1]))" ${String(ms)} ostra-test-sleep`;

/** A subagent's model calls, told apart by the first message OpenCode gives every subagent. */
export const isSubagentCall = (messages: readonly NormalizedMessage[]): boolean =>
  messages.some((message) => message.role === "user" && message.text.includes("You are a subagent spawned by another session."));

export const scenarios: Readonly<Record<string, Scenario>> = {
  hello: ({ step }) => (step === 0 ? { text: "hello from the stub" } : undefined),

  // ---- subagents (2026-11-20): OpenCode runs each in the background, past the prompt's answer ----

  /**
   * Starts a subagent that works for the ms given (default 3000), and ends its turn as OpenCode
   * tells it to; the subagent's report wakes it, and it answers. `hang` starts one that never ends.
   */
  "subagent-bg": ({ step, args }) => {
    switch (step) {
      case 0: {
        const child = args === "hang" ? stubMarker("subagent-loop") : stubMarker("subagent-slow", args === "" ? "3000" : args);
        return { toolCalls: [{ name: "subagent", arguments: { agent: "general", description: "slow child", prompt: `${child} read the README` } }] };
      }
      case 1:
        return { text: "launched a subagent, ending my turn" };
      case 2:
        return { text: "the final answer, after the subagent" };
      default:
        return undefined;
    }
  },

  /** A subagent's work: a wait of the ms given, then its answer. */
  "subagent-slow": ({ step, args }) => {
    if (step === 0) {
      const ms = Number.parseInt(args, 10);
      return { toolCalls: [{ name: "shell", arguments: { command: sleepCommand(Number.isFinite(ms) && ms > 0 ? ms : 3000), timeout: 120_000, description: "work" } }] };
    }
    return step === 1 ? { text: "child answer: the README says hello" } : undefined;
  },

  /** A subagent that never ends: a short wait at every step, each one a model call. */
  "subagent-loop": ({ step }) => ({ toolCalls: [{ name: "shell", arguments: { command: sleepCommand(1500), timeout: 120_000, description: `wait ${String(step)}` } }] }),

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

  // ---- milestone 4: project memory (ADR 0044, F-110). Each says what OpenCode gave the model. ----

  /** Says the instructions OpenCode put in its system prompt. */
  instructions: ({ step, request }) => {
    if (step !== 0) {
      return undefined;
    }
    const system = request.messages.flatMap((message) => (message.role === "system" ? [message.text] : [])).join("\n");
    return { text: `instructions: ${system}` };
  },

  /** Names the memory tools ostra's MCP server offers, as OpenCode lists them (`ostra_<tool>`). */
  "memory-tools": ({ step, request }) => {
    if (step !== 0) {
      return undefined;
    }
    const names = request.toolNames.filter((name) => name.includes("memory_"));
    return { text: `memory tools: ${names.length === 0 ? "none" : names.join(", ")}` };
  },

  /** Searches memory for the marker's query, and says what came back. */
  "memory-search": ({ step, args, lastToolResults }) => memoryCall(step, "ostra_memory_search", { query: args, limit: 5 }, lastToolResults),

  /** Reads the note the marker names, and says what came back. */
  "memory-read": ({ step, args, lastToolResults }) => memoryCall(step, "ostra_memory_read", { noteId: args }, lastToolResults),

  /** Proposes a note titled by the marker, and says what came back. */
  "memory-propose": ({ step, args, lastToolResults }) =>
    memoryCall(step, "ostra_memory_propose", { title: args, body: "Run pnpm lint before every commit.", kind: "convention", scope: "project" }, lastToolResults),

  /**
   * The order the marker's list of markers sits in the model's prompt (`a<b<c`), each found as a
   * file writes it (`<marker>:`), or the ones missing, so a case can check how OpenCode ordered its instructions.
   */
  order: ({ step, args, request }) => {
    if (step !== 0) {
      return undefined;
    }
    const all = request.messages.map((message) => message.text).join("\n");
    const markers = args.split(",");
    const missing = markers.filter((marker) => !all.includes(`${marker}:`));
    const found = [...markers].sort((a, b) => all.indexOf(`${a}:`) - all.indexOf(`${b}:`));
    return { text: missing.length === 0 ? `order: ${found.join("<")}` : `missing: ${missing.join(",")}` };
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
  // ---- milestone 6: the whole team's task kinds (ticket 09). Each says what OpenCode let happen. ----

  /**
   * OpenCode's question tool, then a line with the answer it got: an automatic turn's question
   * (Q160, spike 10). The question offers no option, so the answer is the text field's.
   */
  "ask-and-continue": ({ step, lastToolResults }) => {
    if (step === 0) {
      return { toolCalls: [{ name: "question", arguments: { questions: [{ question: "Should the banner show the full name?", header: "Banner", options: [] }] } }] };
    }
    return step === 1 ? { text: `carried on with: ${lastToolResults.map((result) => result.text).join(" ").slice(0, 400)}` } : undefined;
  },

  /** Pushes the marker's repo folder to its `origin`, and says whether the push went through. */
  "git-push": ({ step, args, lastToolResults }) => {
    if (step === 0) {
      return { toolCalls: [{ name: "shell", arguments: { command: `git -C ${args} push origin HEAD`, description: "push the change" } }] };
    }
    if (step !== 1) {
      return undefined;
    }
    const text = lastToolResults.map((result) => result.text).join(" ");
    return { text: /error|fatal|rejected|refused|denied|403|failed/i.test(text) ? "push refused" : "push went through" };
  },

  /** Reads each of the marker's repo folders' HEAD, and says them as `<folder> <sha>`. */
  heads: ({ step, args, since }) => {
    const folders = args.split(" ").filter((folder) => folder !== "");
    if (step === 0) {
      return { toolCalls: folders.map((folder) => ({ name: "shell", arguments: { command: `git -C ${folder} rev-parse HEAD`, description: `the HEAD of ${folder}` } })) };
    }
    if (step !== 1) {
      return undefined;
    }
    // Each call's result, in the order the calls were made: one SHA each.
    const shas = since.filter((message) => message.role === "tool").map((message) => /\b[0-9a-f]{40}\b/.exec(message.text)?.[0] ?? "unknown");
    return { text: folders.map((folder, index) => `${folder} ${shas[index] ?? "unknown"}`).join("\n") };
  },

  /** Names every tool ostra's MCP server offers, as OpenCode lists them, without the server's prefix. */
  "ostra-tools": ({ step, request }) => {
    if (step !== 0) {
      return undefined;
    }
    const names = request.toolNames.filter((name) => name.startsWith(OSTRA_PREFIX)).map((name) => name.slice(OSTRA_PREFIX.length));
    return { text: `memory tools: ${names.length === 0 ? "none" : names.join(", ")}` };
  },

  /** Calls ostra's tool the marker names with the marker's JSON (base64url), and says what it answered. */
  "ostra-call": ({ step, args, lastToolResults }) => {
    const [tool = "", encoded = ""] = args.split(" ");
    return memoryCall(step, `${OSTRA_PREFIX}${tool}`, toolArgs(encoded), lastToolResults);
  },

  /**
   * Milestone 9 (F-148): reads the file the marker names with OpenCode's own read tool, then says
   * what the tool answered: `Image read successfully` for a model that sees images, OpenCode's
   * error line for one it takes as text only.
   */
  "read-file": ({ step, args, lastToolResults }) => {
    if (step === 0) {
      return { toolCalls: [{ name: "read", arguments: { path: args } }] };
    }
    return step === 1 ? { text: `read answered: ${lastToolResults.map((result) => (result.isError ? `error: ${result.text}` : result.text)).join(" | ")}` } : undefined;
  },

  /** Writes each workspace-relative file the marker names, then says it did. */
  write: ({ step, args }) => {
    const files = args.split(" ").filter((file) => file !== "");
    if (step === 0) {
      return { toolCalls: files.map((file) => ({ name: "write", arguments: { path: file, content: `written for ${file}\n` } })) };
    }
    return step === 1 ? { text: `wrote ${String(files.length)} files` } : undefined;
  },
};

/** The prefix OpenCode gives each tool of ostra's MCP server. */
const OSTRA_PREFIX = "ostra_";

/** A marker's base64url JSON as a tool's arguments; `{}` when it can't be read. */
const toolArgs = (encoded: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
  } catch {
    return {};
  }
};

/** One call of a memory tool, then a reply with what it answered. */
const memoryCall = (step: number, name: string, args: Record<string, unknown>, results: readonly NormalizedMessage[]): ReturnType<Scenario> => {
  if (step === 0) {
    return { toolCalls: [{ name, arguments: args }] };
  }
  return step === 1 ? { text: `${name} answered: ${results.map((result) => (result.isError ? `error: ${result.text}` : result.text)).join(" | ")}` } : undefined;
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
