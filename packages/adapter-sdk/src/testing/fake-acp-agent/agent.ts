import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk/unstable";
import { z } from "zod";

// A scripted fake ACP agent (ADR 0032, ticket 10): a program that speaks ACP over stdio and plays
// a script named by a marker in the prompt, `[[fake:<script> <args>]]`. It exists so the driver and
// every agent contract suite run without a model and without OpenCode. It runs as a child process
// (`main.ts`), or in-process over a pair of streams, for tests that need no process.
//
// Two profiles, so both composer paths stay tested (ADR 0032):
// - `rich` declares what OpenCode lacks, native plan updates and reject-and-continue, and
//   advertises mid-turn steering.
// - `plain` declares none of them: no native plan, a deny ends the turn, no steering.

export type FakeAgentProfile = "rich" | "plain";

export type FakeAgentCapabilities = {
  readonly steerMidTurn: boolean;
  readonly sessionLoad: boolean;
  readonly nativePlan: boolean;
  readonly rejectAndContinue: boolean;
};

export const fakeAgentCapabilities: Readonly<Record<FakeAgentProfile, FakeAgentCapabilities>> = {
  rich: { steerMidTurn: true, sessionLoad: true, nativePlan: true, rejectAndContinue: true },
  plain: { steerMidTurn: false, sessionLoad: true, nativePlan: false, rejectAndContinue: false },
};

export type FakeAgentOptions = {
  readonly profile: FakeAgentProfile;
  /** The agent's own environment: what the `env` and `endpoint` scripts report. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** What the `crash` script does: a process exits, an in-process agent drops its streams. */
  readonly crash: () => void;
};

/** The scripts a prompt can name. `[[fake:say]]` is the default for a prompt with no marker. */
export const fakeScripts = [
  "say",
  "tools",
  "plan",
  "permission",
  "elicit",
  "silent",
  "silent-deaf",
  "steerable",
  "spawn",
  "crash",
  "env",
  "endpoint",
  "unknown",
  "config",
  "usage",
  "compaction",
  "content",
  "write",
] as const;
export type FakeScript = (typeof fakeScripts)[number];

export const fakeMarker = (script: FakeScript, args = ""): string => `[[fake:${script}${args === "" ? "" : ` ${args}`}]]`;

const MARKER = /\[\[fake:([a-z-]+)(?:\s+([^\]]*))?\]\]/;

const parsePrompt = (text: string): { readonly script: string; readonly args: string } => {
  const match = MARKER.exec(text);
  return { script: match?.[1] ?? "say", args: (match?.[2] ?? "").trim() };
};

const promptText = (blocks: readonly { readonly type: string; readonly text?: string | undefined }[]): string =>
  blocks.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n");

type Session = {
  readonly id: string;
  /** The session's folder, from `session/new`: where the `write` script writes. */
  readonly cwd: string | null;
  /** What the agent said, so `session/load` can replay it. */
  readonly history: string[];
  cancel: AbortController;
  /** Set while a `steerable` turn waits for a steer. */
  steer: ((text: string) => void) | undefined;
  running: boolean;
};

const sleep = async (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

const waitForAbort = async (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => {
      resolve();
    }, { once: true });
  });

export const createFakeAgent = (options: FakeAgentOptions): acp.AgentApp => {
  const capabilities = fakeAgentCapabilities[options.profile];
  const sessions = new Map<string, Session>();
  let counter = 0;

  const sessionOf = (id: string): Session => {
    const found = sessions.get(id);
    if (found === undefined) {
      throw acp.RequestError.invalidParams(undefined, "unknown session");
    }
    return found;
  };

  const app = acp
    .agent()
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: "ostra-fake-agent", title: "ostra fake agent", version: "0.0.0" },
      agentCapabilities: { loadSession: capabilities.sessionLoad, promptCapabilities: {} },
      ...(capabilities.steerMidTurn ? { _meta: { steering: { supported: true } } } : {}),
    }))
    .onRequest(acp.methods.agent.session.new, (ctx) => {
      counter += 1;
      const id = `fake-session-${String(counter)}`;
      const cwd: unknown = Reflect.get(Object(ctx.params), "cwd");
      sessions.set(id, { id, cwd: typeof cwd === "string" ? cwd : null, history: [], cancel: new AbortController(), steer: undefined, running: false });
      return { sessionId: id };
    })
    .onRequest(acp.methods.agent.session.load, async (ctx) => {
      const id = ctx.params.sessionId;
      const cwd: unknown = Reflect.get(Object(ctx.params), "cwd");
      const session = sessions.get(id) ?? { id, cwd: typeof cwd === "string" ? cwd : null, history: ["(an earlier turn)"], cancel: new AbortController(), steer: undefined, running: false };
      sessions.set(id, session);
      // A real agent replays the session's history as updates, before it answers.
      for (const line of session.history) {
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: id,
          update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "a replayed prompt" } },
        });
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: id,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: line } },
        });
      }
      return {};
    })
    .onNotification(acp.methods.agent.session.cancel, (ctx) => {
      sessions.get(ctx.params.sessionId)?.cancel.abort();
    });

  if (capabilities.steerMidTurn) {
    app.onRequest(
      "_session/steering",
      z.looseObject({ sessionId: z.string(), prompt: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })) }),
      (ctx) => {
        const session = sessions.get(ctx.params.sessionId);
        if (session?.steer === undefined) {
          return { outcome: "not_running" };
        }
        session.steer(promptText(ctx.params.prompt));
        return { outcome: "injected" };
      },
    );
  }

  app.onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const session = sessionOf(ctx.params.sessionId);
    const { script, args } = parsePrompt(promptText(ctx.params.prompt));
    session.cancel = new AbortController();
    session.running = true;
    const { signal } = session.cancel;
    const say = async (text: string): Promise<void> => {
      session.history.push(text);
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: session.id,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });
    };
    const update = async (body: Record<string, unknown>): Promise<void> => {
      // Untyped on purpose: the fake also sends updates the SDK's own types don't know.
      await ctx.client.notify<{ readonly sessionId: string; readonly update: Record<string, unknown> }>(
        acp.methods.client.session.update,
        { sessionId: session.id, update: body },
      );
    };
    try {
      return { stopReason: await play(script, args, { say, update, signal, session, ctx }) };
    } finally {
      session.running = false;
      session.steer = undefined;
    }
  });

  type Play = {
    readonly say: (text: string) => Promise<void>;
    readonly update: (body: Record<string, unknown>) => Promise<void>;
    readonly signal: AbortSignal;
    readonly session: Session;
    readonly ctx: { readonly client: acp.AgentContext };
  };

  const play = async (script: string, args: string, io: Play): Promise<acp.StopReason> => {
    const { say, update, signal, session } = io;
    switch (script) {
      case "say":
        await say("Hello from the fake agent. ");
        await say("The work is done.");
        return "end_turn";

      case "tools":
        await say("Looking around, then changing things. ");
        await tools(update);
        await say("All tools ran.");
        return "end_turn";

      case "plan":
        if (capabilities.nativePlan) {
          await update({
            sessionUpdate: "plan",
            entries: [
              { content: "Read the code", priority: "high", status: "completed" },
              { content: "Write the fix", priority: "medium", status: "in_progress" },
              { content: "Add a test", priority: "low", status: "pending" },
            ],
          });
        }
        await say("Planned.");
        return "end_turn";

      case "permission": {
        await update({
          sessionUpdate: "tool_call",
          toolCallId: "perm-1",
          title: "Edit notes.txt",
          kind: "edit",
          status: "pending",
          rawInput: { filePath: "notes.txt" },
          locations: [{ path: "notes.txt" }],
        });
        const answer = await io.ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId: session.id,
          toolCall: { toolCallId: "perm-1", title: "Edit notes.txt", kind: "edit", status: "pending" },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "allow-always", name: "Allow for this task", kind: "allow_always" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        });
        if (answer.outcome.outcome === "selected" && answer.outcome.optionId.startsWith("allow")) {
          await update({ sessionUpdate: "tool_call_update", toolCallId: "perm-1", status: "completed" });
          await say("The edit was applied.");
          return "end_turn";
        }
        await update({ sessionUpdate: "tool_call_update", toolCallId: "perm-1", status: "failed", content: [{ type: "content", content: { type: "text", text: "rejected" } }] });
        if (capabilities.rejectAndContinue) {
          await say("The edit was rejected, so I tried another way.");
          return "end_turn";
        }
        // Without reject-and-continue a deny ends the turn: the runner re-prompts (ADR 0032).
        return "cancelled";
      }

      case "elicit": {
        const answer = await io.ctx.client.request(acp.methods.client.elicitation.create, {
          sessionId: session.id,
          mode: "form",
          message: "Which database should the service use?",
          requestedSchema: {
            type: "object",
            properties: {
              name: { type: "string", title: "Database name" },
              engine: { type: "string", title: "Engine", enum: ["postgres", "mysql"] },
              replicas: { type: "integer", title: "Replicas" },
            },
          },
        });
        await say(answer.action === "accept" ? `answered: ${JSON.stringify(answer.content ?? {})}` : `no answer: ${answer.action}`);
        return "end_turn";
      }

      case "silent":
        await say("Starting a long step. ");
        await waitForAbort(signal);
        return "cancelled";

      case "silent-deaf":
        // An agent that ignores a cancel: the driver must end the turn itself.
        await say("Starting a long step that ignores a cancel. ");
        await sleep(Number(args) > 0 ? Number(args) : 60_000);
        return "end_turn";

      case "steerable": {
        await say("Working, open to a steer. ");
        // A tool call closes the open message, so the text reaches the event stream now.
        await update({ sessionUpdate: "tool_call", toolCallId: "t-wait", title: "Wait for guidance", kind: "other", status: "in_progress" });
        const steered = await new Promise<string | undefined>((resolve) => {
          session.steer = (text) => {
            resolve(text);
          };
          signal.addEventListener("abort", () => {
            resolve(undefined);
          }, { once: true });
        });
        if (steered === undefined) {
          return "cancelled";
        }
        await say(`Steered: ${steered}`);
        return "end_turn";
      }

      case "spawn": {
        // A tool that leaves a process behind, and an agent that doesn't clean it up.
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
        child.unref();
        await say(`spawned ${String(child.pid)}`);
        await update({ sessionUpdate: "tool_call", toolCallId: "t-spawn", title: "Run a tool", kind: "execute", status: "in_progress", rawInput: { command: "sleep" } });
        await waitForAbort(signal);
        return "cancelled";
      }

      case "crash":
        await say("About to crash. ");
        options.crash();
        await sleep(60_000);
        return "end_turn";

      case "env":
        await say(`env: ${JSON.stringify(Object.keys(options.env).sort())}`);
        return "end_turn";

      case "endpoint":
        await say(`endpoint: ${options.env["FAKE_AGENT_BASE_URL"] ?? ""} ${options.env["FAKE_AGENT_API_KEY"] ?? ""}`);
        return "end_turn";

      case "unknown":
        await say("Before the unknown update. ");
        await update({ sessionUpdate: "future_feature", detail: { anything: [1, 2, 3] } });
        await say("After the unknown update.");
        return "end_turn";

      case "config":
        await update({ sessionUpdate: "current_mode_update", currentModeId: "build" });
        await update({
          sessionUpdate: "config_option_update",
          configOptions: [{ id: "model", name: "Model", type: "select", currentValue: "fake/model-b", options: [] }],
        });
        await say("Configured.");
        return "end_turn";

      case "usage":
        await update({ sessionUpdate: "usage_update", used: 1200, size: 128_000 });
        await say("Counted. ");
        await update({ sessionUpdate: "usage_update", used: 2400, size: 128_000 });
        return "end_turn";

      case "compaction":
        await update({ sessionUpdate: "compaction_update", compactionId: "c-1", status: "running" });
        await update({ sessionUpdate: "compaction_summary_chunk", compactionId: "c-1", content: { type: "text", text: "The summary." } });
        await update({ sessionUpdate: "compaction_update", compactionId: "c-1", status: "completed" });
        return "end_turn";

      case "write": {
        // An edit the agent really makes: a file in the session's folder, as `[[fake:write <path>]]`
        // names it (default `fake-change.txt`), so a runner test gets a branch with a change.
        const relative = args === "" ? "fake-change.txt" : args;
        const root = session.cwd;
        if (root === null) {
          await say("No folder to write in.");
          return "end_turn";
        }
        const target = path.resolve(root, relative);
        if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) {
          await say("That path leaves the session's folder.");
          return "end_turn";
        }
        await update({ sessionUpdate: "tool_call", toolCallId: "t-write", title: `Write ${relative}`, kind: "edit", status: "in_progress", rawInput: { filePath: relative }, locations: [{ path: relative }] });
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, "Written by the fake agent.\n");
        await update({ sessionUpdate: "tool_call_update", toolCallId: "t-write", status: "completed" });
        await say(`Wrote ${relative}.`);
        return "end_turn";
      }

      case "content":
        await update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "resource_link", uri: "https://example.com/doc", name: "A doc" },
        });
        await update({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: "aGk=", mimeType: "image/png" } });
        return "end_turn";

      default:
        await say(`The fake agent has no script ${script}.`);
        return "end_turn";
    }
  };

  return app;
};

/** A tool call of every ACP kind, then one that fails. */
const tools = async (update: (body: Record<string, unknown>) => Promise<void>): Promise<void> => {
  const text = (value: string) => [{ type: "content" as const, content: { type: "text" as const, text: value } }];
  await update({ sessionUpdate: "tool_call", toolCallId: "t-read", title: "Read src/a.ts", kind: "read", status: "pending", rawInput: { filePath: "src/a.ts" }, locations: [{ path: "src/a.ts" }] });
  await update({ sessionUpdate: "tool_call_update", toolCallId: "t-read", status: "completed", content: text("line 1\nline 2\nline 3") });
  await update({ sessionUpdate: "tool_call", toolCallId: "t-edit", title: "Edit src/a.ts", kind: "edit", status: "pending", rawInput: { filePath: "src/a.ts" }, locations: [{ path: "src/a.ts" }] });
  await update({
    sessionUpdate: "tool_call_update",
    toolCallId: "t-edit",
    status: "completed",
    content: [{ type: "diff", path: "src/a.ts", oldText: "old line", newText: "new line\nanother line" }],
  });
  await update({ sessionUpdate: "tool_call", toolCallId: "t-exec", title: "npm test", kind: "execute", status: "pending", rawInput: { command: "npm test" } });
  await update({ sessionUpdate: "tool_call_update", toolCallId: "t-exec", status: "in_progress", content: text("running tests...") });
  await update({ sessionUpdate: "tool_call_update", toolCallId: "t-exec", status: "completed", content: text("12 passed") });
  for (const kind of ["delete", "move", "search", "think", "fetch", "switch_mode", "other"] as const) {
    await update({ sessionUpdate: "tool_call", toolCallId: `t-${kind}`, title: `A ${kind} call`, kind, status: "pending", rawInput: { what: kind } });
    await update({ sessionUpdate: "tool_call_update", toolCallId: `t-${kind}`, status: "completed", rawOutput: { done: kind } });
  }
  await update({ sessionUpdate: "tool_call", toolCallId: "t-fail", title: "Read missing.ts", kind: "read", status: "pending", rawInput: { filePath: "missing.ts" } });
  await update({ sessionUpdate: "tool_call_update", toolCallId: "t-fail", status: "failed", content: text("no such file") });
};

// ---------- serving ----------

const readableToWeb = (stream: Readable): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start: (controller) => {
      stream.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      });
      stream.on("end", () => {
        controller.close();
      });
      stream.on("error", (error) => {
        controller.error(error);
      });
    },
  });

const writableToWeb = (stream: Writable): WritableStream<Uint8Array> =>
  new WritableStream<Uint8Array>({
    write: (chunk) =>
      new Promise<void>((resolve, reject) => {
        stream.write(chunk, (error) => {
          if (error === null || error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      }),
    close: () => {
      stream.end();
    },
  });

/** Serves the fake over a pair of node streams. Resolves when the client goes away. */
export const serveFakeAgent = async (input: Readable, output: Writable, options: Omit<FakeAgentOptions, "crash"> & { readonly crash?: () => void }): Promise<void> => {
  const app = createFakeAgent({
    ...options,
    crash:
      options.crash ??
      (() => {
        output.destroy();
        input.destroy();
      }),
  });
  const connection = app.connect(acp.ndJsonStream(writableToWeb(output), readableToWeb(input)));
  await connection.closed;
};
