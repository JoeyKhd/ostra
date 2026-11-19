import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk/unstable";
import { approvalRulesSchema, firstMatchingRule, mcpSubjectValue, readMarkedBlocks } from "@ostra/protocol";
import type { ApprovalRequestSubject, ApprovalRule } from "@ostra/protocol";
import { z } from "zod";

import { loadFakeSession, saveFakeSession } from "./archive.ts";

// A scripted fake ACP agent (ADR 0032, ticket 10): a program that speaks ACP over stdio and plays
// a script named by a marker in the prompt, `[[fake:<script> <args>]]`. It exists so the driver and
// every agent contract suite run without a model and without OpenCode. It runs as a child process
// (`main.ts`), or in-process over a pair of streams, for tests that need no process.
//
// Two profiles, so both composer paths stay tested (ADR 0032):
// - `rich` declares what OpenCode lacks, native plan updates and reject-and-continue, and
//   advertises mid-turn steering.
// - `plain` declares none of them: no native plan, a deny ends the turn, no steering.
//
// Milestone 3 (ADR 0049) adds the profile's side, with the same split:
// - `rich` writes the rules into its own settings and asks only for what a rule covers
//   (`native`), has session modes (`session/set_mode`), reads skills from a folder, speaks MCP
//   over HTTP and stdio, and its task config wins over the repo's.
// - `plain` asks for every request and leaves the rules to the runner (`runner-only`), changes
//   mode only by a relaunch, takes skills as instructions, speaks MCP over HTTP only, and obeys
//   a repo's own config, so the runner must hide it.

export type FakeAgentProfile = "rich" | "plain";

export type FakeAgentCapabilities = {
  readonly steerMidTurn: boolean;
  readonly sessionLoad: boolean;
  readonly nativePlan: boolean;
  readonly rejectAndContinue: boolean;
  // Milestone 3.
  readonly permissionRules: "native" | "runner-only";
  readonly planMode: "session-mode" | "relaunch";
  readonly skills: boolean;
  readonly mcp: { readonly http: boolean; readonly stdio: boolean };
  readonly projectConfigOverride: boolean;
};

export const fakeAgentCapabilities: Readonly<Record<FakeAgentProfile, FakeAgentCapabilities>> = {
  rich: {
    steerMidTurn: true,
    sessionLoad: true,
    nativePlan: true,
    rejectAndContinue: true,
    permissionRules: "native",
    planMode: "session-mode",
    skills: true,
    mcp: { http: true, stdio: true },
    projectConfigOverride: true,
  },
  plain: {
    steerMidTurn: false,
    sessionLoad: true,
    nativePlan: false,
    rejectAndContinue: false,
    permissionRules: "runner-only",
    planMode: "relaunch",
    skills: false,
    mcp: { http: true, stdio: false },
    projectConfigOverride: false,
  },
};

/** The task config the fake adapter writes (`FAKE_AGENT_CONFIG`): the profile's side, read at each session. */
export const fakeAgentConfigSchema = z.looseObject({
  mode: z.enum(["plan", "build"]).optional(),
  approvalRules: z.unknown().optional(),
  skills: z.array(z.looseObject({ name: z.string(), dir: z.string() })).optional(),
  instructions: z.string().nullish(),
  mcpServers: z.array(z.looseObject({ name: z.string(), transport: z.enum(["http", "stdio"]), readOnly: z.boolean() })).optional(),
  /** Milestone 4: ostra's own MCP server, for the memory tools; absent for an agent without them. */
  ostraMcp: z.looseObject({ url: z.string(), bearer: z.string().optional() }).optional(),
});
export type FakeAgentConfig = z.infer<typeof fakeAgentConfigSchema>;

/** The file a repo's own config for the fake lives in; `{ "permission": "allow" }` allows everything. */
export const FAKE_AGENT_REPO_CONFIG = ".fake-agent.json";

/** A permission request's answer, read loosely: the client's shape, as the agent sees it. */
const permissionAnswerSchema = z.looseObject({
  outcome: z.looseObject({ outcome: z.string(), optionId: z.string().optional() }),
});

/** The tool `[[fake:plan-turn]]` calls on each MCP server. */
export const FAKE_AGENT_MCP_TOOL = "list";

export type FakeAgentOptions = {
  readonly profile: FakeAgentProfile;
  /** The agent's own environment: what the `env` and `endpoint` scripts report. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** What the `crash` script does: a process exits, an in-process agent drops its streams. */
  readonly crash: () => void;
  /**
   * Milestone 2: where the agent keeps its sessions (`FAKE_AGENT_DATA`), so they can be exported,
   * imported into another box, and loaded there. Absent: in memory only.
   */
  readonly dataDir?: string;
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
  // Milestone 2.
  /** Says it will remember the word given, which a session that moved must still know. */
  "remember",
  /** Says everything it said before in the session, oldest first. */
  "recall",
  /** A long turn: a thought every 100 ms for the seconds given (default 2), then a message. */
  "long",
  /** Ticket 44: moves a file inside the session's folder. */
  "move",
  // Milestone 3 (ADR 0049).
  /** Asks to edit the path given, and writes it when allowed. */
  "ask-path",
  /** Asks to run the command given, and says it ran when allowed. */
  "ask-command",
  /** Asks to edit `pair-a.txt` and `pair-b.txt` at once. */
  "ask-pair",
  /** Asks to run each of the commands given, separated by `;`, at once, and says which ran. */
  "ask-commands",
  /** A plan: plan entries, a write attempted, a tool called on each MCP server, and a message. */
  "plan-turn",
  /** Says the session's mode. */
  "mode",
  /** Says the skills it was given, with each `SKILL.md`'s first line. */
  "skills",
  /** Says the MCP servers it was given. */
  "mcp",
  /** Says each marked block of the prompt: what the runner's prompts reach it as. */
  "read-blocks",
  // Milestone 4 (ticket 02).
  /** Says the instructions its config gave it, as `instructions: <text>`. */
  "instructions",
  /** Lists the tools ostra's MCP server offers, as `memory tools: a, b`, or `none` without one. */
  "memory-tools",
  /** Calls `memory_search` with the query given, and says what came back. */
  "memory-search",
  /** Calls `memory_read` with the note ID given, and says what came back. */
  "memory-read",
  /** Calls `memory_propose` with the title given, and says what came back. */
  "memory-propose",
  /** ADR 0035's canary: a shell call (`cat`) that reads the absolute path given, with its full input. */
  "shell-read",
] as const;
export type FakeScript = (typeof fakeScripts)[number];

export const fakeMarker = (script: FakeScript, args = ""): string => `[[fake:${script}${args === "" ? "" : ` ${args}`}]]`;

const MARKER = /\[\[fake:([a-z-]+)(?:\s+([^\]]*))?\]\]/;

const parsePrompt = (text: string): { readonly script: string; readonly args: string } => {
  const match = MARKER.exec(text);
  if (match === null && readMarkedBlocks(text).length > 0) {
    // A runner's own prompt (a deny's re-prompt, an approved plan): say what reached the agent.
    return { script: "read-blocks", args: "" };
  }
  return { script: match?.[1] ?? "say", args: (match?.[2] ?? "").trim() };
};

const promptText = (blocks: readonly { readonly type: string; readonly text?: string | undefined }[]): string =>
  blocks.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n");

type Session = {
  readonly id: string;
  /** The session's folder, from `session/new`: where the `write` script writes. */
  readonly cwd: string | null;
  /** Milestone 3: the session's mode, from the task config, then `session/set_mode`. */
  mode: "plan" | "build";
  /** Milestone 3: the repo's own config allows everything, and this agent obeys it. */
  repoAllowsAll: boolean;
  /** Milestone 3: the MCP servers `session/new` named. */
  readonly sessionMcp: readonly string[];
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

/** One JSON-RPC call to an MCP server over HTTP, as a client of the streamable HTTP transport does. */
const mcpCall = async (server: { readonly url: string; readonly bearer?: string | undefined }, method: string, params: unknown): Promise<unknown> => {
  try {
    const answer = await fetch(server.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(server.bearer === undefined ? {} : { authorization: `Bearer ${server.bearer}` }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
    });
    const parsed = z.looseObject({ result: z.unknown() }).safeParse(await answer.json());
    return parsed.success ? parsed.data.result : undefined;
  } catch {
    return undefined;
  }
};

export const createFakeAgent = (options: FakeAgentOptions): acp.AgentApp => {
  const capabilities = fakeAgentCapabilities[options.profile];
  const sessions = new Map<string, Session>();
  let counter = 0;

  /** The task config, read once per session: the adapter writes it before the launch. */
  const readConfig = async (): Promise<FakeAgentConfig> => {
    const file = options.env["FAKE_AGENT_CONFIG"];
    if (file === undefined) {
      return {};
    }
    try {
      const parsed = fakeAgentConfigSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  };

  /** Whether the repo's own config allows everything, and this agent lets it. */
  const repoAllowsAll = async (cwd: string | null): Promise<boolean> => {
    if (cwd === null || capabilities.projectConfigOverride) {
      return false;
    }
    try {
      const parsed = z.looseObject({ permission: z.string() }).safeParse(JSON.parse(await readFile(path.join(cwd, FAKE_AGENT_REPO_CONFIG), "utf8")));
      return parsed.success && parsed.data.permission === "allow";
    } catch {
      return false;
    }
  };

  const newSession = async (id: string, cwd: string | null, mcp: readonly string[], history: string[]): Promise<Session> => {
    const config = await readConfig();
    return {
      id,
      cwd,
      mode: config.mode ?? "build",
      repoAllowsAll: await repoAllowsAll(cwd),
      sessionMcp: mcp,
      history,
      cancel: new AbortController(),
      steer: undefined,
      running: false,
    };
  };

  const mcpNamesOf = (params: unknown): readonly string[] => {
    const parsed = z.array(z.looseObject({ name: z.string() })).safeParse(Reflect.get(Object(params), "mcpServers"));
    return parsed.success ? parsed.data.map((server) => server.name) : [];
  };

  const modes = (current: "plan" | "build") => ({
    currentModeId: current,
    availableModes: [
      { id: "plan", name: "Plan", description: "Reads and searches; changes nothing" },
      { id: "build", name: "Build", description: "Works" },
    ],
  });

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
    .onRequest(acp.methods.agent.session.new, async (ctx) => {
      counter += 1;
      const id = `fake-session-${String(counter)}`;
      const cwd: unknown = Reflect.get(Object(ctx.params), "cwd");
      const session = await newSession(id, typeof cwd === "string" ? cwd : null, mcpNamesOf(ctx.params), []);
      sessions.set(id, session);
      // Only an agent with session modes says it has them (ADR 0049).
      return capabilities.planMode === "session-mode" ? { sessionId: id, modes: modes(session.mode) } : { sessionId: id };
    })
    .onRequest(acp.methods.agent.session.load, async (ctx) => {
      const id = ctx.params.sessionId;
      const cwdParam: unknown = Reflect.get(Object(ctx.params), "cwd");
      const cwd = typeof cwdParam === "string" ? cwdParam : null;
      // A session kept on disk (an imported one) loads only in the directory it's bound to.
      const kept = sessions.has(id) || options.dataDir === undefined ? undefined : await loadFakeSession(options.dataDir, id);
      const boundTo = kept?.cwd ?? null;
      if (boundTo !== null && cwd !== null && path.resolve(boundTo) !== path.resolve(cwd)) {
        throw acp.RequestError.invalidParams(undefined, "the session belongs to another directory");
      }
      const session =
        sessions.get(id) ?? (await newSession(id, kept?.cwd ?? cwd, mcpNamesOf(ctx.params), kept === undefined ? ["(an earlier turn)"] : [...kept.history]));
      if (capabilities.planMode === "relaunch") {
        // A relaunch carries the new mode in the task config: a loaded session takes it.
        session.mode = (await readConfig()).mode ?? "build";
      }
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

  if (capabilities.planMode === "session-mode") {
    app.onRequest(acp.methods.agent.session.setMode, (ctx) => {
      const session = sessionOf(ctx.params.sessionId);
      if (ctx.params.modeId !== "plan" && ctx.params.modeId !== "build") {
        throw acp.RequestError.invalidParams(undefined, "unknown mode");
      }
      session.mode = ctx.params.modeId;
      return {};
    });
  }

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
    const text = promptText(ctx.params.prompt);
    const { script, args } = parsePrompt(text);
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
      const stopReason = await play(script, args, { say, update, signal, session, ctx, text });
      // A cancelled turn ends `cancelled`, whatever the script was doing (ACP), but for the agent
      // that ignores a cancel on purpose.
      return { stopReason: signal.aborted && script !== "silent-deaf" ? "cancelled" : stopReason };
    } finally {
      session.running = false;
      session.steer = undefined;
      if (options.dataDir !== undefined) {
        await saveFakeSession(options.dataDir, { id: session.id, cwd: session.cwd, history: [...session.history] });
      }
    }
  });

  type Play = {
    readonly say: (text: string) => Promise<void>;
    readonly update: (body: Record<string, unknown>) => Promise<void>;
    readonly signal: AbortSignal;
    readonly session: Session;
    readonly ctx: { readonly client: acp.AgentContext };
    /** The turn's whole prompt text. */
    readonly text: string;
  };

  const promptTextOf = (io: Play): string => io.text;

  type Ask = {
    readonly toolCallId: string;
    readonly title: string;
    readonly kind: "edit" | "execute" | "fetch" | "other";
    readonly rawInput: Record<string, unknown>;
    readonly locations?: readonly string[];
    /** What the request touches, as the fake's own settings read it. */
    readonly subject: ApprovalRequestSubject;
  };

  /** How the agent itself treats a request before asking anyone (ADR 0049). */
  const ask = async (io: Play, request: Ask): Promise<"allowed" | "denied" | "refused"> => {
    const config = await readConfig();
    const mcpServers = (config.mcpServers ?? []).map((server) => ({ name: server.name, readOnly: server.readOnly }));
    const readOnlyMcp =
      request.subject.tool === "mcp" && mcpServers.some((server) => server.readOnly && request.subject.subject.value.startsWith(`${server.name}/`));
    if (io.session.mode === "plan" && capabilities.planMode === "session-mode" && !readOnlyMcp) {
      // A native plan mode refuses a write, a command, a fetch or a writing MCP tool itself.
      return "refused";
    }
    if (io.session.repoAllowsAll) {
      // The repo's own config allows everything, and this agent obeys it: the hole the runner closes.
      return "allowed";
    }
    if (capabilities.permissionRules === "native") {
      const rules: readonly ApprovalRule[] = approvalRulesSchema.catch([]).parse(config.approvalRules ?? []);
      if (firstMatchingRule(rules, request.subject, { mcpServers }) === null) {
        // No rule covers it: a native agent goes on without asking.
        return "allowed";
      }
    }
    const answer = await io.ctx.client.request(acp.methods.client.session.requestPermission, {
      sessionId: io.session.id,
      toolCall: {
        toolCallId: request.toolCallId,
        title: request.title,
        kind: request.kind,
        status: "pending",
        rawInput: request.rawInput,
        ...(request.locations === undefined ? {} : { locations: request.locations.map((location) => ({ path: location })) }),
      },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    const read = permissionAnswerSchema.safeParse(answer);
    return read.success && read.data.outcome.outcome === "selected" && (read.data.outcome.optionId ?? "").startsWith("allow") ? "allowed" : "denied";
  };

  /** A tool call through `ask`, reported as the agent would: completed, or failed with why. */
  const askedTool = async (io: Play, request: Ask, onAllowed: () => Promise<void>): Promise<"allowed" | "denied" | "refused"> => {
    await io.update({
      sessionUpdate: "tool_call",
      toolCallId: request.toolCallId,
      title: request.title,
      kind: request.kind,
      status: "pending",
      rawInput: request.rawInput,
      ...(request.locations === undefined ? {} : { locations: request.locations.map((location) => ({ path: location })) }),
    });
    const outcome = await ask(io, request);
    if (outcome === "allowed") {
      await onAllowed();
      await io.update({ sessionUpdate: "tool_call_update", toolCallId: request.toolCallId, status: "completed" });
    } else {
      const why = outcome === "refused" ? "refused in plan mode" : "rejected";
      await io.update({ sessionUpdate: "tool_call_update", toolCallId: request.toolCallId, status: "failed", content: [{ type: "content", content: { type: "text", text: why } }] });
    }
    return outcome;
  };

  /** Writes a file inside the session's folder; a path that leaves it is refused. */
  const writeInside = async (session: Session, relative: string): Promise<void> => {
    if (session.cwd === null) {
      return;
    }
    const target = path.resolve(session.cwd, relative);
    if (!target.startsWith(`${path.resolve(session.cwd)}${path.sep}`)) {
      return;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "Written by the fake agent.\n");
  };

  const editRequest = (id: string, relative: string): Ask => ({
    toolCallId: id,
    title: `Edit ${relative}`,
    kind: "edit",
    rawInput: { filePath: relative },
    locations: [relative],
    subject: { tool: "edit", subject: { kind: "path", value: relative } },
  });

  /** After a denied request: a turn goes on with reject-and-continue, and ends `cancelled` without it (ADR 0032). */
  const afterDeny = async (io: Play, what: string): Promise<acp.StopReason> => {
    if (capabilities.rejectAndContinue) {
      await io.say(`The ${what} was rejected, so I tried another way.`);
      return "end_turn";
    }
    return "cancelled";
  };

  const play = async (script: string, args: string, io: Play): Promise<acp.StopReason> => {
    const { say, update, signal, session } = io;
    switch (script) {
      case "ask-path": {
        const relative = args === "" ? "notes.txt" : args;
        const outcome = await askedTool(io, editRequest("ask-path-1", relative), () => writeInside(session, relative));
        if (outcome === "allowed") {
          await say(`Wrote ${relative}.`);
          return "end_turn";
        }
        return outcome === "refused" ? (await say(`I can't edit ${relative} while planning.`), "end_turn") : afterDeny(io, "edit");
      }

      case "ask-command": {
        const command = args === "" ? "pnpm add zod" : args;
        const outcome = await askedTool(
          io,
          { toolCallId: "ask-command-1", title: command, kind: "execute", rawInput: { command }, subject: { tool: "execute", subject: { kind: "command", value: command } } },
          () => Promise.resolve(),
        );
        if (outcome === "allowed") {
          await say(`Ran ${command}.`);
          return "end_turn";
        }
        return outcome === "refused" ? (await say("I can't run that while planning."), "end_turn") : afterDeny(io, "command");
      }

      case "ask-pair": {
        const [first, second] = await Promise.all([
          askedTool(io, editRequest("ask-pair-a", "pair-a.txt"), () => writeInside(session, "pair-a.txt")),
          askedTool(io, editRequest("ask-pair-b", "pair-b.txt"), () => writeInside(session, "pair-b.txt")),
        ]);
        await say(`pair: a=${first} b=${second}`);
        return first === "denied" || second === "denied" ? afterDeny(io, "edit") : "end_turn";
      }

      case "ask-commands": {
        const commands = args.split(";").map((each) => each.trim()).filter((each) => each !== "");
        const outcomes = await Promise.all(
          commands.map((command, index) =>
            askedTool(
              io,
              { toolCallId: `ask-commands-${String(index + 1)}`, title: command, kind: "execute", rawInput: { command }, subject: { tool: "execute", subject: { kind: "command", value: command } } },
              () => Promise.resolve(),
            ),
          ),
        );
        await say(`commands: ${commands.map((command, index) => `${command}=${outcomes[index] ?? "denied"}`).join(", ")}`);
        return outcomes.includes("denied") ? afterDeny(io, "command") : "end_turn";
      }

      case "plan-turn": {
        if (capabilities.nativePlan) {
          await update({
            sessionUpdate: "plan",
            entries: [
              { content: "Read the README", priority: "high", status: "pending" },
              { content: "Write CONTRIBUTING.md", priority: "medium", status: "pending" },
            ],
          });
        }
        const write = await askedTool(io, editRequest("plan-write", "plan-attempt.txt"), () => writeInside(session, "plan-attempt.txt"));
        const config = await readConfig();
        const calls: string[] = [];
        for (const [index, server] of (config.mcpServers ?? []).entries()) {
          const value = mcpSubjectValue(server.name, FAKE_AGENT_MCP_TOOL);
          const outcome = await askedTool(
            io,
            {
              toolCallId: `plan-mcp-${String(index)}`,
              title: value,
              kind: "other",
              rawInput: { mcpServer: server.name, tool: FAKE_AGENT_MCP_TOOL },
              subject: { tool: "mcp", subject: { kind: "tool", value } },
            },
            () => Promise.resolve(),
          );
          calls.push(`${server.name}:${outcome}`);
        }
        await say(`plan: write=${write} mcp=${calls.join(",")}. I'll write CONTRIBUTING.md and link it from the README.`);
        return "end_turn";
      }

      case "mode":
        await say(`mode: ${session.mode}`);
        return "end_turn";

      case "skills": {
        const config = await readConfig();
        if (capabilities.skills) {
          const lines: string[] = [];
          for (const skill of config.skills ?? []) {
            let first = "";
            try {
              first = (await readFile(path.join(skill.dir, "SKILL.md"), "utf8")).split("\n")[0] ?? "";
            } catch {
              first = "(unreadable)";
            }
            lines.push(`${skill.name} (${first})`);
          }
          await say(`skills: ${lines.join(", ")}`);
        } else {
          const named = [...(config.instructions ?? "").matchAll(/^Skill ([A-Za-z0-9_-]+):/gm)].map((match) => match[1] ?? "");
          await say(`skills from instructions: ${named.join(", ")}`);
        }
        return "end_turn";
      }

      case "mcp": {
        const config = await readConfig();
        const configured = (config.mcpServers ?? []).map((server) => `${server.name}/${server.transport}`);
        await say(`mcp: ${[...configured, ...session.sessionMcp.map((name) => `${name}/session`)].join(", ")}`);
        return "end_turn";
      }

      case "read-blocks": {
        const blocks = readMarkedBlocks(promptTextOf(io));
        await say(blocks.map((block) => `Read ${block.label}: ${block.text}`).join(" | "));
        return "end_turn";
      }

      case "say":
        await say("Hello from the fake agent. ");
        await say("The work is done.");
        return "end_turn";

      case "remember":
        await say(`I'll remember ${args === "" ? "nothing" : args}.`);
        return "end_turn";

      case "recall": {
        const earlier = session.history.join(" ");
        await say(`Earlier in this session I said: ${earlier === "" ? "nothing" : earlier}`);
        return "end_turn";
      }

      case "long": {
        const seconds = Number.parseFloat(args);
        const until = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 2) * 1000;
        while (Date.now() < until && !signal.aborted) {
          await update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Still working. " } });
          await sleep(100, signal);
        }
        if (signal.aborted) {
          return "cancelled";
        }
        await say("The long step is done.");
        return "end_turn";
      }

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
            // Not an ID: the driver leaves it out before any decider sees it.
            { optionId: "has space", name: "Broken", kind: "allow_once" },
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
        // Edits the agent really makes: files in the session's folder, as `[[fake:write <path> ...]]`
        // names them (default `fake-change.txt`), so a runner test gets a branch with a change. With
        // several repos the folder is the workspace root, so `test1/x.md` lands in a repo and `x.md`
        // beside them (ticket 44).
        const root = session.cwd;
        if (root === null) {
          await say("No folder to write in.");
          return "end_turn";
        }
        const relatives = args === "" ? ["fake-change.txt"] : args.split(/\s+/).filter((each) => each !== "");
        for (const relative of relatives) {
          const target = path.resolve(root, relative);
          if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) {
            await say("That path leaves the session's folder.");
            return "end_turn";
          }
          await update({ sessionUpdate: "tool_call", toolCallId: "t-write", title: `Write ${relative}`, kind: "edit", status: "in_progress", rawInput: { filePath: relative }, locations: [{ path: relative }] });
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, "Written by the fake agent.\n");
          await update({ sessionUpdate: "tool_call_update", toolCallId: "t-write", status: "completed" });
        }
        await say(`Wrote ${relatives.join(", ")}.`);
        return "end_turn";
      }

      case "move": {
        // `[[fake:move <from> <to>]]`: a file moved inside the session's folder, as an agent asked to
        // move a file into a repo would (ticket 44).
        const root = session.cwd;
        const [from, to] = args.split(/\s+/);
        if (root === null || from === undefined || to === undefined) {
          await say("Nothing to move.");
          return "end_turn";
        }
        const source = path.resolve(root, from);
        const target = path.resolve(root, to);
        const inside = (file: string): boolean => file.startsWith(`${path.resolve(root)}${path.sep}`);
        if (!inside(source) || !inside(target)) {
          await say("That path leaves the session's folder.");
          return "end_turn";
        }
        await mkdir(path.dirname(target), { recursive: true });
        await rename(source, target);
        await say(`Moved ${from} to ${to}.`);
        return "end_turn";
      }

      // ---- milestone 4 (ticket 02): memory, and ADR 0035's canary ----
      case "instructions": {
        const config = await readConfig();
        await say(`instructions: ${config.instructions ?? "(none)"}`);
        return "end_turn";
      }

      case "memory-tools": {
        const config = await readConfig();
        if (config.ostraMcp === undefined) {
          await say("memory tools: none");
          return "end_turn";
        }
        await mcpCall(config.ostraMcp, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-acp-agent", version: "0.0.0" } });
        const listed = z.looseObject({ tools: z.array(z.looseObject({ name: z.string() })) }).safeParse(await mcpCall(config.ostraMcp, "tools/list", {}));
        await say(`memory tools: ${listed.success ? listed.data.tools.map((tool) => tool.name).join(", ") : "none"}`);
        return "end_turn";
      }

      case "memory-search":
      case "memory-read":
      case "memory-propose": {
        const config = await readConfig();
        const tool = script.replace("-", "_");
        if (config.ostraMcp === undefined) {
          await say(`${tool}: no such tool`);
          return "end_turn";
        }
        const toolArgs: Record<string, unknown> =
          script === "memory-search"
            ? { query: args, limit: 5 }
            : script === "memory-read"
              ? { noteId: args }
              : { title: args, body: "Proposed by the fake agent.", kind: "convention", scope: "project", relatesTo: null, relation: null };
        const toolCallId = `t-${script}`;
        await update({ sessionUpdate: "tool_call", toolCallId, title: `ostra/${tool}`, kind: "other", status: "in_progress", rawInput: { mcpServer: "ostra", tool, arguments: toolArgs } });
        const result = z
          .looseObject({ content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })) })
          .safeParse(await mcpCall(config.ostraMcp, "tools/call", { name: tool, arguments: toolArgs }));
        const text = result.success ? result.data.content.map((part) => part.text ?? "").join("") : "the tool call failed";
        await update({ sessionUpdate: "tool_call_update", toolCallId, status: result.success ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text } }] });
        await say(`${tool}: ${text}`);
        return "end_turn";
      }

      case "shell-read": {
        // ADR 0035's canary: a shell call that reads the path given, reported with its full input.
        const target = args;
        const toolCallId = "t-shell-read";
        await update({ sessionUpdate: "tool_call", toolCallId, title: `cat ${target}`, kind: "execute", status: "in_progress", rawInput: { command: `cat ${target}`, cwd: session.cwd } });
        let content: string;
        try {
          content = await readFile(target, "utf8");
        } catch {
          await update({ sessionUpdate: "tool_call_update", toolCallId, status: "failed", content: [{ type: "content", content: { type: "text", text: "no such file" } }] });
          await say("Couldn't read it.");
          return "end_turn";
        }
        await update({ sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: [{ type: "content", content: { type: "text", text: content } }] });
        await say(`Read ${String(content.length)} characters.`);
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
