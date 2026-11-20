import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";

import { z } from "zod";

// F-138: OpenCode 2.3.2's real child-session updates, replayed. The probe of
// `research/opencode-subagents.md` recorded every ACP message the pinned binary sent
// (`packages/adapters/adapter-opencode/evidence/opencode-subagents-acp.txt`); this reads a run of
// that log back into JSON-RPC messages, and plays them to ostra's driver over a pair of streams, as
// the agent did: `initialize`, `session/new`, then each update in order once the prompt comes, the
// prompt's answer where the log has it, and what came after it. A permission request waits for its
// answer. The log is the cleaned one: a child's tool calls carry no kind or input there, so they
// read as calls of kind `other`, as OpenCode's would without them.

const EVIDENCE = new URL("../../../adapters/adapter-opencode/evidence/opencode-subagents-acp.txt", import.meta.url);

type Json = z.infer<ReturnType<typeof z.json>>;

/** One message of a run, in the order the agent sent it. */
export type RecordedMessage =
  | { readonly kind: "notify"; readonly method: string; readonly params: Record<string, Json> }
  | { readonly kind: "permission"; readonly params: Record<string, Json> }
  | { readonly kind: "answer"; readonly stopReason: string };

export type RecordedRun = {
  /** The run's letter in the log: `B`, `D`, `I` and so on. */
  readonly name: string;
  /** The main agent's session, as the agent named it. */
  readonly rootSessionId: string;
  readonly messages: readonly RecordedMessage[];
};

const jsonSchema = z.json();

/** A field read as words: a JSON string as it is, any other value as its JSON. */
const wordOf = (value: Json | undefined, otherwise = ""): string => (value === undefined ? otherwise : typeof value === "string" ? value : JSON.stringify(value));

/** Reads `key=value` pairs; a value is a JSON string, a JSON object, or a bare word. */
const readFields = (text: string): { readonly words: readonly string[]; readonly fields: ReadonlyMap<string, Json> } => {
  const words: string[] = [];
  const fields = new Map<string, Json>();
  let i = 0;
  const skipSpace = (): void => {
    while (i < text.length && /\s/.test(text.charAt(i))) i += 1;
  };
  const readJson = (): Json => {
    const open = text.charAt(i);
    const start = i;
    if (open === '"') {
      i += 1;
      while (i < text.length && text.charAt(i) !== '"') i += text.charAt(i) === "\\" ? 2 : 1;
      i += 1;
      return jsonSchema.parse(JSON.parse(text.slice(start, i)));
    }
    let depth = 0;
    let inString = false;
    for (; i < text.length; i += 1) {
      const char = text.charAt(i);
      if (inString) {
        if (char === "\\") i += 1;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{" || char === "[") depth += 1;
      else if (char === "}" || char === "]") {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          break;
        }
      }
    }
    return jsonSchema.parse(JSON.parse(text.slice(start, i)));
  };
  while (i < text.length) {
    skipSpace();
    const start = i;
    while (i < text.length && !/[\s=]/.test(text.charAt(i))) i += 1;
    const key = text.slice(start, i);
    if (key === "") break;
    if (text.charAt(i) !== "=") {
      words.push(key);
      continue;
    }
    i += 1;
    const next = text.charAt(i);
    if (next === '"' || next === "{" || next === "[") {
      fields.set(key, readJson());
    } else {
      const valueStart = i;
      while (i < text.length && !/\s/.test(text.charAt(i))) i += 1;
      const bare = text.slice(valueStart, i);
      fields.set(key, /^-?\d+(\.\d+)?$/.test(bare) ? Number(bare) : bare);
    }
  }
  return { words, fields };
};

const CHILD_META = '_meta["opencode/child-session"]';

/** An update as the log prints it (`tool_call toolCallId=… status=…`), as the ACP update it was. */
const updateOf = (text: string): Record<string, Json> => {
  const { words, fields } = readFields(text);
  const sessionUpdate = words[0] ?? "";
  const update: Record<string, Json> = { sessionUpdate };
  for (const [key, value] of fields) {
    if (key === "text") {
      update["content"] = { type: "text", text: value };
    } else if (key === "rawOutput.metadata") {
      update["rawOutput"] = { metadata: value };
    } else if (key === CHILD_META) {
      update["_meta"] = { "opencode/child-session": value };
    } else {
      update[key] = value;
    }
  }
  return update;
};

const lineSchema = /^\s*\d+ ms {2}(.*)$/;

/** Reads one run of the recorded log, by its letter. */
export const readRecordedRun = async (name: string): Promise<RecordedRun> => {
  const text = await readFile(EVIDENCE, "utf8");
  const section = text.split(/^## /m).find((part) => part.startsWith(`${name}: `));
  if (section === undefined) throw new Error(`no run ${name} in the recorded log`);
  const messages: RecordedMessage[] = [];
  let rootSessionId: string | undefined;
  for (const raw of section.split("\n")) {
    const body = lineSchema.exec(raw)?.[1];
    if (body === undefined || body.startsWith("-> ")) continue;
    if (body.startsWith("<- session/prompt answered:")) {
      const { fields } = readFields(body.slice("<- session/prompt answered:".length));
      messages.push({ kind: "answer", stopReason: wordOf(fields.get("stopReason"), "end_turn") });
    } else if (body.startsWith("session/update ")) {
      messages.push({ kind: "notify", method: "session/update", params: { update: updateOf(body.slice("session/update ".length)) } });
    } else if (body.startsWith("opencode/session/child_update ")) {
      const rest = body.slice("opencode/session/child_update ".length);
      const at = rest.indexOf(" update: ");
      const { fields } = readFields(at === -1 ? rest : rest.slice(0, at));
      const parent = wordOf(fields.get("parent"));
      const depth = Number(fields.get("depth") ?? 1);
      if (depth === 1) rootSessionId ??= parent;
      const params: Record<string, Json> = {
        childSessionId: wordOf(fields.get("child")),
        parentSessionId: parent,
        depth,
        title: wordOf(fields.get("title")),
        type: wordOf(fields.get("type")),
        ...(fields.has("status") ? { status: wordOf(fields.get("status")) } : {}),
        ...(at === -1 ? {} : { update: updateOf(rest.slice(at + " update: ".length)) }),
      };
      messages.push({ kind: "notify", method: "opencode/session/child_update", params });
    } else if (body.startsWith("session/request_permission ")) {
      const { fields } = readFields(body.slice("session/request_permission ".length));
      rootSessionId ??= wordOf(fields.get("sessionId"));
      const meta = fields.get("toolCall._meta");
      messages.push({
        kind: "permission",
        params: {
          toolCall: { toolCallId: wordOf(fields.get("toolCallId")), title: wordOf(fields.get("title")), ...(meta === undefined ? {} : { _meta: meta }) },
          options: [
            { optionId: "once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        },
      });
    }
  }
  // The child's `_meta` names the main session too, for a run with no child notification.
  for (const message of messages) {
    if (rootSessionId !== undefined) break;
    if (message.kind === "notify" && message.method === "session/update") {
      const parent = z.looseObject({ _meta: z.looseObject({ "opencode/child-session": z.looseObject({ parentID: z.string() }) }) }).safeParse(message.params["update"]);
      if (parent.success) rootSessionId = parent.data._meta["opencode/child-session"].parentID;
    }
  }
  if (rootSessionId === undefined) throw new Error(`run ${name} names no main session`);
  return { name, rootSessionId, messages };
};

const rpcSchema = z.looseObject({ id: z.union([z.number(), z.string()]).optional(), method: z.string().optional() });

/**
 * A scripted OpenCode that plays a recorded run to ostra's driver, over a pair of streams: what
 * `AgentIo` takes. It advertises what OpenCode 2.3.2 does (`opencode/child-session-updates`,
 * steering), answers the driver's idle probe as idle, and plays the run when the prompt comes.
 */
export const replayAgent = (run: RecordedRun): { readonly io: { readonly stdin: PassThrough; readonly stdout: PassThrough; readonly stderr: PassThrough }; readonly close: () => void } => {
  const toAgent = new PassThrough();
  const fromAgent = new PassThrough();
  const answers = new Map<number, () => void>();
  let nextId = 9000;
  let buffer = "";
  const send = (message: Record<string, Json>): void => {
    fromAgent.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  const tick = (): Promise<void> =>
    new Promise((resolve) => {
      setImmediate(resolve);
    });
  const play = async (promptId: number | string): Promise<void> => {
    for (const message of run.messages) {
      await tick();
      switch (message.kind) {
        case "notify":
          send({
            method: message.method,
            params: message.method === "session/update" ? { sessionId: run.rootSessionId, ...message.params } : { rootSessionId: run.rootSessionId, ...message.params },
          });
          break;
        case "permission": {
          nextId += 1;
          const id = nextId;
          const answered = new Promise<void>((resolve) => {
            answers.set(id, resolve);
          });
          send({ id, method: "session/request_permission", params: { sessionId: run.rootSessionId, ...message.params } });
          await answered;
          break;
        }
        case "answer":
          send({ id: promptId, result: { stopReason: message.stopReason } });
          break;
        default:
          message satisfies never;
      }
    }
  };
  toAgent.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let end = buffer.indexOf("\n");
    while (end !== -1) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      end = buffer.indexOf("\n");
      if (line === "") continue;
      const message = rpcSchema.parse(JSON.parse(line));
      const id = message.id;
      if (message.method === undefined) {
        if (typeof id === "number") answers.get(id)?.();
        continue;
      }
      if (id === undefined) continue;
      switch (message.method) {
        case "initialize":
          send({
            id,
            result: {
              protocolVersion: 1,
              agentCapabilities: { loadSession: true, _meta: { "opencode/child-session-updates": true } },
              agentInfo: { name: "opencode", version: "2.3.2" },
              authMethods: [],
              _meta: { steering: { supported: true } },
            },
          });
          break;
        case "session/new":
          send({ id, result: { sessionId: run.rootSessionId } });
          break;
        case "session/prompt":
          void play(id);
          break;
        default:
          // The idle probe (`_session/steering`), a close or a resume: answered, nothing injected.
          send({ id, result: {} });
      }
    }
  });
  return {
    io: { stdin: toAgent, stdout: fromAgent, stderr: new PassThrough() },
    close: () => {
      fromAgent.end();
      toAgent.end();
    },
  };
};
