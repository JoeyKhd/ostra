import { spawn } from "node:child_process";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk/unstable";
import { approvalRulesSchema, firstMatchingRule, mcpSubjectValue, readMarkedBlocks } from "@ostra/protocol";
import type { ApprovalRequestSubject, ApprovalRule } from "@ostra/protocol";
import { z } from "zod";

import { pushRefusalReason } from "../../executor/work-in-progress.ts";
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
//
// Subagents (2026-11-20): both run a subagent the way OpenCode 2.3.2 does (`[[fake:subagent-bg]]`),
// in the background past the prompt's answer, its states sent as `opencode/session/child_update`
// to a client that asks for them. `rich` declares `subagents: "background"`, `plain` declares `none`.

//
// Milestone 9 (ADR 0070, F-148): `rich` advertises `promptCapabilities.image` and declares
// `promptImages`, `plain` neither. A turn that calls its model (`[[fake:model-turn]]`,
// `[[fake:model-steerable]]`) sends its prompt's images, and a steer's, on to the model as the
// format's image part, when its config says the model takes images.
//
// Milestone 10 (F-151): `rich` declares `questionFreeText` and takes a member's own words for an
// enum field of its `[[fake:elicit]]` form; `plain` doesn't, and refuses an answer outside the
// field's options, saying so, as an agent that checks its enum would.

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
  // Subagents (2026-11-20).
  readonly subagents: "background" | "none";
  // Milestone 9 (F-148).
  readonly promptImages: boolean;
  // Milestone 10 (F-151).
  readonly questionFreeText: boolean;
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
    subagents: "background",
    promptImages: true,
    questionFreeText: true,
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
    subagents: "none",
    promptImages: false,
    questionFreeText: false,
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
  /**
   * Milestone 4 (F-137): the values the agent's `thought_level` option advertises, `default` aside,
   * for a `session-option` fake. Absent or empty: the agent advertises no such option.
   */
  effortValues: z.array(z.string()).optional(),
  /**
   * Milestone 9 (F-148): the model the turn's calls go to, in its API format, and the inputs it
   * takes, as OpenCode's catalog file carries them. Absent: the OpenAI-compatible format, text only.
   */
  model: z
    .looseObject({
      apiFormat: z.enum(["openai-compatible", "anthropic-messages"]),
      endpointModelId: z.string(),
      inputModalities: z.array(z.string()),
    })
    .optional(),
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
  // Milestone 4 (F-137).
  /** Says the session's reasoning level and every value set on it, as `effort: <current> set: <a,b>`. */
  "effort",
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
  // Milestone 7 (ticket 03).
  /** A title call and then the number given of calls that offer tools, to its base URL; the turn reports its own usage. */
  "model-calls",
  /** What a prompt that starts with `/` runs: says `Ran the slash command /<name>.` */
  "slash",
  // Milestone 6 (ticket 04).
  /**
   * Asks a question as an ACP elicitation in its turn, and carries on with whatever answer comes,
   * saying `carried on with: <answer>`; declined or cancelled, it ends the turn `cancelled`, as
   * OpenCode's question tool did in spike 10.
   */
  "ask-and-continue",
  /** The drafting fake: calls `submit_draft` with the draft its args hold (`fakeToolArgs`), and says the tool's answer. */
  "submit-draft",
  /** The reviewing fake: calls `submit_review` with its args' summary and findings, and says the answer. */
  "submit-review",
  /** The proposing fake: calls `propose_environment` with its args' proposal, and says the answer. */
  "propose-environment",
  // Milestone 8 (ticket 03).
  /** Calls `take_screenshot` with its args' input, and says the answer. */
  "take-screenshot",
  // Milestone 8 (ticket 12).
  /** Calls `start_app` with its args' input (`{}` for all), and says the answer. */
  "start-app",
  /** Calls `show_preview` with its args' input, and says the answer. */
  "show-preview",
  // Milestone 8 (ticket 13).
  /** Calls `record_app` with its args' input, and says the answer. */
  "record-app",
  /**
   * Writes the files its args name (`write`, session-relative, as `write` does), then calls each of
   * ostra's tools its args list (`calls`, `{ tool, arguments }`) in order, saying each answer as a
   * message of its own: `fakeAppCalls` makes its args.
   */
  "app-calls",
  /** Runs `git push origin HEAD:refs/heads/<branch>` (or `HEAD:<ref>` for a full ref name) in the repo folder given, and says `pushed` or `push refused`. */
  "git-push",
  /** Says each git repo's HEAD under the session's folder, one `<folder> <sha>` line each. */
  "heads",
  // Milestone 6 (ticket 23).
  /**
   * Writes the files given (session-relative) and commits them itself in the repo the session opened
   * on, as `git add` and `git commit` would, naming itself with `git -c user.name`. At a workspace's
   * root, which holds several repos, each file goes in the repo of its first folder, one commit each.
   * With `--push=<branch or ref>`, it pushes the first repo's commit there, and says `pushed` or
   * `push refused: <git's reason>` (F-113).
   */
  "commit",
  // Subagents (2026-11-20).
  /**
   * Starts a subagent and ends its turn, as OpenCode does: the subagent works for the ms given
   * (default 1000; `hang` never ends), reads a file and answers, and its report wakes the agent,
   * which then says `the final answer, after the subagent`, with no prompt in flight. With `silent`
   * too, a stopped child never reports its end (F-138).
   */
  "subagent-bg",
  /**
   * F-138: three subagents, one nested, within the turn, as OpenCode plays them with
   * `experimental.subagent_depth` 2 (`research/opencode-subagents.md`, run F): `explore` "Find the
   * version source" reads and searches, and answers; `general` "Write version row test" reads,
   * starts its own `explore` "Find test helpers" (which searches and answers), edits, and answers.
   * Each child's updates and states come as `opencode/session/child_update` to a client that asked,
   * and projected on the session with their `_meta` to one that didn't. Args: `fail` (the general
   * one fails with an error), `ask` (the general one's command asks for an approval, naming it).
   */
  "subagent-tree",
  // Milestone 9 (F-148).
  /** Calls its model once with the prompt's text and images, as the config's format sends them, and says how many images went. */
  "model-turn",
  /** Calls its model with the prompt, waits for a steer, then calls it again with the steer's text and images, and says `Steered: <text>`. */
  "model-steerable",
  /** Reads the absolute path given with a `read` tool call, as an agent's own read tool does, and says `Read: <its first line>`. */
  "read-file",
  /** Says each image its prompt carried, as `images: <type>:<base64> …`, or `images: none`. */
  "say-images",
] as const;
export type FakeScript = (typeof fakeScripts)[number];

/** F-138: the three subagents `[[fake:subagent-tree]]` plays, by their place in the tree. */
export const FAKE_SUBAGENT_TREE = {
  explore: { type: "explore", description: "Find the version source", prompt: "Find where the app version is read at build time.", answer: "The version comes from package.json, read in src/lib/build-info.ts." },
  general: { type: "general", description: "Write version row test", prompt: "Add a test for the version row in src/settings/version-row.test.tsx. Run pnpm test settings and report what fails.", answer: "Added the version row test; it passes." },
  nested: { type: "explore", description: "Find test helpers", prompt: "Find the render helpers the settings tests use.", answer: "renderWithProviders, in test/render.tsx." },
  error: "the model endpoint returned 500",
  command: "pnpm test settings",
  mainAnswer: "The subagents are done: the version row has a test.",
} as const;

/** A turn's own usage, as ACP's prompt answer carries it (milestone 7, ticket 03). */
export type FakeTurnUsage = { inputTokens: number; outputTokens: number; totalTokens: number; cachedReadTokens: number };

/**
 * Milestone 7 (ticket 03): the variable that makes the fake send a notification no one knows
 * after `initialize`, as a newer agent might.
 */
export const FAKE_AGENT_UNKNOWN_NOTIFICATION_ENV = "FAKE_AGENT_UNKNOWN_NOTIFICATION";

/** The method of that notification. */
export const FAKE_AGENT_UNKNOWN_NOTIFICATION = "_future/announcement";

/** Subagents (2026-11-20): OpenCode's client capability for its child sessions, and their notification. */
const FAKE_CHILD_SESSION_UPDATES = "opencode/child-session-updates";
const FAKE_CHILD_UPDATE_METHOD = "opencode/session/child_update";

export const fakeMarker = (script: FakeScript, args = ""): string => `[[fake:${script}${args === "" ? "" : ` ${args}`}]]`;

/** Milestone 6: a tool's JSON arguments as one marker argument (base64url, so no `]` ends the marker early). */
export const fakeToolArgs = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const readToolArgs = (args: string): unknown => {
  try {
    return JSON.parse(Buffer.from(args, "base64url").toString("utf8"));
  } catch {
    return {};
  }
};

/** Ticket 13: one of `app-calls`' calls: an ostra tool by its name, and its arguments. */
export type FakeAppCall = { readonly tool: string; readonly arguments: unknown };

/** Ticket 13: `[[fake:app-calls]]`'s args: the files to write first, then the calls in order. */
export const fakeAppCalls = (calls: readonly FakeAppCall[], write: readonly string[] = []): string => fakeToolArgs({ calls, write });

const appCallsSchema = z.looseObject({
  calls: z.array(z.looseObject({ tool: z.string().min(1), arguments: z.unknown() })),
  write: z.array(z.string().min(1)).optional(),
});

/** Milestone 6: the field the asking fake's question has, which an answer fills. */
export const FAKE_AGENT_QUESTION_FIELD = "approach";

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

/** Milestone 9: an image a prompt or a steer carried, as ACP's `image` block holds it. */
export type FakePromptImage = { readonly mimeType: string; readonly data: string };

const imageBlockSchema = z.looseObject({ type: z.literal("image"), mimeType: z.string(), data: z.string().min(1) });

/** The prompt's `image` blocks with data, in order. */
const promptImagesOf = (blocks: readonly unknown[]): readonly FakePromptImage[] =>
  blocks.flatMap((block) => {
    const image = imageBlockSchema.safeParse(block);
    return image.success ? [{ mimeType: image.data.mimeType, data: image.data.data }] : [];
  });

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
  /** A prompt has arrived and its handler hasn't run yet: `cancel` is already that prompt's turn's. */
  armed: boolean;
  /** Set while a `steerable` turn waits for a steer; milestone 9: with the steer's images. */
  steer: ((text: string, images: readonly FakePromptImage[]) => void) | undefined;
  running: boolean;
  /** Milestone 4 (F-137): the values its `thought_level` option advertises, `default` aside. */
  readonly effortValues: readonly string[];
  /** The option's current value. */
  effort: string;
  /** Every value `session/set_config_option` set on it, in order. */
  readonly effortsSet: string[];
  /** Subagents (2026-11-20): its running subagents, by their child session's ID. */
  readonly children: Map<string, AbortController>;
  /** The agent is at work on a subagent's report, with no prompt in flight. */
  waking: boolean;
  /** Stops that work: `session/close` on the session. */
  wakeAbort: AbortController;
  /** The client is attached: OpenCode's follower sends what the session does past a turn's answer. */
  following: boolean;
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
    // Streamable HTTP answers as JSON or as an event stream (the sidecar's MCP server, ticket 20):
    // the reply is the stream's `data:` line that holds a result.
    const text = await answer.text();
    const bodies = (answer.headers.get("content-type") ?? "").includes("text/event-stream")
      ? text.split(/\r?\n/).flatMap((line) => (line.startsWith("data:") ? [line.slice("data:".length).trim()] : []))
      : [text];
    for (const body of bodies) {
      let value: unknown;
      try {
        value = JSON.parse(body);
      } catch {
        continue;
      }
      const parsed = z.looseObject({ result: z.unknown() }).safeParse(value);
      if (parsed.success) {
        return parsed.data.result;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
};

export type FakeAgent = {
  readonly app: acp.AgentApp;
  /** The transport read a `session/prompt` for this session, before the SDK dispatched it (`serveFakeAgent`). */
  readonly promptArrived: (sessionId: string) => void;
};

export const createFakeAgent = (options: FakeAgentOptions): FakeAgent => {
  const capabilities = fakeAgentCapabilities[options.profile];
  const sessions = new Map<string, Session>();
  let counter = 0;
  /** The client asked for its subagents' updates and states (`opencode/child-session-updates`), as OpenCode reads it. */
  let childUpdates = false;

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
      const parsed = z
        .looseObject({ permission: z.string().optional(), hook: z.string().optional() })
        .safeParse(JSON.parse(await readFile(path.join(cwd, FAKE_AGENT_REPO_CONFIG), "utf8")));
      // Milestone 7 (ticket 03): a hook in the repo's config runs when the session starts, as a
      // real agent's would: it writes its marker where it says. The runner's hiding is what stops it.
      if (parsed.success && parsed.data.hook !== undefined) {
        await writeFile(parsed.data.hook, "the repo's hook ran\n");
      }
      return parsed.success && parsed.data.permission === "allow";
    } catch {
      return false;
    }
  };

  const newSession = async (id: string, cwd: string | null, mcp: readonly string[], history: string[], effort = "default"): Promise<Session> => {
    const config = await readConfig();
    return {
      effortValues: config.effortValues ?? [],
      effort,
      effortsSet: [],
      id,
      cwd,
      mode: config.mode ?? "build",
      repoAllowsAll: await repoAllowsAll(cwd),
      sessionMcp: mcp,
      history,
      cancel: new AbortController(),
      armed: false,
      steer: undefined,
      running: false,
      children: new Map(),
      waking: false,
      wakeAbort: new AbortController(),
      following: true,
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

  /** Milestone 4 (F-137): the session's config options, as `session/new`, `session/load` and a set answer them. */
  const EFFORT_OPTION = "reasoning";
  const configOptionsOf = (session: Session) =>
    session.effortValues.length === 0
      ? []
      : [
          {
            // Found by its category, not its ID: the ID is the fake's own (OpenCode's is `effort`).
            id: EFFORT_OPTION,
            name: "Reasoning",
            category: "thought_level",
            type: "select" as const,
            currentValue: session.effort,
            options: [...session.effortValues, "default"].map((value) => ({ value, name: value })),
          },
        ];

  const keep = async (session: Session): Promise<void> => {
    if (options.dataDir !== undefined) {
      await saveFakeSession(options.dataDir, { id: session.id, cwd: session.cwd, history: [...session.history], effort: session.effort });
    }
  };

  const sessionOf = (id: string): Session => {
    const found = sessions.get(id);
    if (found === undefined) {
      throw acp.RequestError.invalidParams(undefined, "unknown session");
    }
    return found;
  };

  // As OpenCode registers a prompt's turn as it reads it, so a cancel sent right behind the prompt
  // still reaches that turn. The SDK runs a message's handler only after a walk of the handlers
  // registered before it, so the cancel's handler can run before the prompt's: the turn's
  // controller is made when the prompt arrives, not when its handler starts.
  const promptArrived = (sessionId: string): void => {
    const session = sessions.get(sessionId);
    if (session !== undefined) {
      session.cancel = new AbortController();
      session.armed = true;
    }
  };

  const app = acp
    .agent()
    .onRequest(acp.methods.agent.initialize, (ctx) => {
      const meta: unknown = Reflect.get(Object(Reflect.get(Object(ctx.params), "clientCapabilities")), "_meta");
      childUpdates = Reflect.get(Object(meta), FAKE_CHILD_SESSION_UPDATES) === true;
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentInfo: { name: "ostra-fake-agent", title: "ostra fake agent", version: "0.0.0" },
        // As OpenCode: it always offers its subagents' updates; a client takes them by asking.
        // Milestone 9: `rich` takes images in its prompt, as OpenCode advertises it does.
        agentCapabilities: {
          loadSession: capabilities.sessionLoad,
          promptCapabilities: capabilities.promptImages ? { image: true } : {},
          _meta: { [FAKE_CHILD_SESSION_UPDATES]: true },
        },
        ...(capabilities.steerMidTurn ? { _meta: { steering: { supported: true } } } : {}),
      };
    })
    .onRequest(acp.methods.agent.session.new, async (ctx) => {
      // Milestone 7 (ticket 03): a notification of a method no client knows, after `initialize`.
      if (options.env[FAKE_AGENT_UNKNOWN_NOTIFICATION_ENV] === "1") {
        await ctx.client.notify<{ readonly detail: string }>(FAKE_AGENT_UNKNOWN_NOTIFICATION, { detail: "something a newer agent says" });
      }
      counter += 1;
      const id = `fake-session-${String(counter)}`;
      const cwd: unknown = Reflect.get(Object(ctx.params), "cwd");
      const session = await newSession(id, typeof cwd === "string" ? cwd : null, mcpNamesOf(ctx.params), []);
      sessions.set(id, session);
      const configOptions = configOptionsOf(session);
      // Only an agent with session modes says it has them (ADR 0049).
      return {
        sessionId: id,
        ...(capabilities.planMode === "session-mode" ? { modes: modes(session.mode) } : {}),
        ...(configOptions.length === 0 ? {} : { configOptions }),
      };
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
        sessions.get(id) ??
        (await newSession(id, kept?.cwd ?? cwd, mcpNamesOf(ctx.params), kept === undefined ? ["(an earlier turn)"] : [...kept.history], kept?.effort));
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
      const configOptions = configOptionsOf(session);
      return configOptions.length === 0 ? {} : { configOptions };
    })
    // Milestone 4 (F-137): the reasoning level, by the option of category `thought_level`. A value
    // the option doesn't advertise is refused, as OpenCode refuses it (`-32602`).
    .onRequest(acp.methods.agent.session.setConfigOption, async (ctx) => {
      const session = sessionOf(ctx.params.sessionId);
      const value: unknown = Reflect.get(Object(ctx.params), "value");
      if (ctx.params.configId !== EFFORT_OPTION || session.effortValues.length === 0 || typeof value !== "string" || ![...session.effortValues, "default"].includes(value)) {
        throw acp.RequestError.invalidParams(undefined, "no such option or value");
      }
      session.effort = value;
      session.effortsSet.push(value);
      await keep(session);
      return { configOptions: configOptionsOf(session) };
    })
    .onNotification(acp.methods.agent.session.cancel, (ctx) => {
      // As OpenCode's: it reaches the prompt in flight alone, never a subagent or a report's turn.
      sessions.get(ctx.params.sessionId)?.cancel.abort();
    })
    // Subagents (2026-11-20), as OpenCode 2.3.2 closes a session: a child session's close interrupts
    // that subagent; the session's own stops its turn and its follower, so nothing more is sent.
    .onRequest(acp.methods.agent.session.close, (ctx) => {
      const id = ctx.params.sessionId;
      for (const session of sessions.values()) {
        session.children.get(id)?.abort();
      }
      const session = sessions.get(id);
      if (session !== undefined) {
        session.following = false;
        session.cancel.abort();
        session.wakeAbort.abort();
      }
      return {};
    })
    .onRequest(acp.methods.agent.session.resume, (ctx) => {
      const session = sessionOf(ctx.params.sessionId);
      session.following = true;
      session.wakeAbort = new AbortController();
      return {};
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
        // As OpenCode's: a running turn is checked first, then the prompt, so an image with neither
        // data nor URI is refused only by a session at work, and an idle one answers `promptRequired`.
        if (ctx.params.prompt.some((block) => block.type === "image" && block["data"] === "" && block["uri"] === undefined)) {
          if (session !== undefined && (session.running || session.waking)) {
            throw acp.RequestError.invalidParams({ field: "prompt" }, "image content has no data or uri");
          }
          return { outcome: "promptRequired" };
        }
        if (session?.steer === undefined) {
          return { outcome: "not_running" };
        }
        session.steer(promptText(ctx.params.prompt), promptImagesOf(ctx.params.prompt));
        return { outcome: "injected" };
      },
    );
  }

  app.onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const session = sessionOf(ctx.params.sessionId);
    const text = promptText(ctx.params.prompt);
    // Milestone 7 (ticket 03): a prompt that starts with `/` is a slash command, as a real agent
    // reads it; ostra's own prompts never start with a ticket's text, so a ticket can't name one.
    const { script, args } = text.startsWith("/") ? { script: "slash", args: /^\/(\S*)/.exec(text)?.[1] ?? "" } : parsePrompt(text);
    // Made when the prompt arrived (`promptArrived`), so a cancel right behind it is already in it.
    if (!session.armed) {
      session.cancel = new AbortController();
    }
    session.armed = false;
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
    const usage: { value: FakeTurnUsage | undefined } = { value: undefined };
    try {
      const stopReason = await play(script, args, { say, update, signal, session, ctx, text, images: promptImagesOf(ctx.params.prompt), usage });
      // A cancelled turn ends `cancelled`, whatever the script was doing (ACP), but for the agent
      // that ignores a cancel on purpose. A turn that called the model reports its own usage, as
      // OpenCode's prompt answer does (milestone 7, ticket 03).
      return {
        stopReason: signal.aborted && script !== "silent-deaf" ? "cancelled" : stopReason,
        ...(usage.value === undefined ? {} : { usage: usage.value }),
      };
    } finally {
      session.running = false;
      session.steer = undefined;
      await keep(session);
    }
  });

  type Play = {
    readonly say: (text: string) => Promise<void>;
    readonly update: (body: Record<string, unknown>) => Promise<void>;
    readonly signal: AbortSignal;
    readonly session: Session;
    readonly ctx: { readonly client: acp.AgentContext };
    /** Milestone 9: the prompt's images, in order. */
    readonly images: readonly FakePromptImage[];
    /** The turn's whole prompt text. */
    readonly text: string;
    /** Milestone 7: the turn's own usage, set by a script that calls the model. */
    readonly usage: { value: FakeTurnUsage | undefined };
  };

  const promptTextOf = (io: Play): string => io.text;

  /**
   * Milestone 9 (F-148): one call to the model with a message's text and images, in the config's
   * API format, to the base URL with the task's key and nowhere else: an OpenAI `image_url` with a
   * data URL, or an Anthropic `image` block with base64 data. As OpenCode, an image goes only to a
   * model whose inputs take one. Whether the model answered.
   */
  const callModelWith = async (text: string, images: readonly FakePromptImage[], signal: AbortSignal): Promise<boolean> => {
    const config = await readConfig();
    const model = config.model ?? { apiFormat: "openai-compatible" as const, endpointModelId: "stub-model", inputModalities: ["text"] };
    const sent = model.inputModalities.includes("image") ? images : [];
    const baseUrl = (options.env["FAKE_AGENT_BASE_URL"] ?? "").replace(/[/]+$/, "");
    const key = options.env["FAKE_AGENT_API_KEY"] ?? "";
    try {
      const answer =
        model.apiFormat === "anthropic-messages"
          ? await fetch(`${baseUrl}/messages`, {
              method: "POST",
              headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
              body: JSON.stringify({
                model: model.endpointModelId,
                max_tokens: 256,
                messages: [
                  {
                    role: "user",
                    content: [{ type: "text", text }, ...sent.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } }))],
                  },
                ],
              }),
              signal,
            })
          : await fetch(`${baseUrl}/chat/completions`, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
              body: JSON.stringify({
                model: model.endpointModelId,
                stream: false,
                messages: [
                  {
                    role: "user",
                    content: [{ type: "text", text }, ...sent.map((image) => ({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } }))],
                  },
                ],
              }),
              signal,
            });
      await answer.text();
      return answer.ok;
    } catch {
      return false;
    }
  };

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

  /**
   * Subagents (2026-11-20): `[[fake:subagent-bg]]`, as OpenCode 2.3.2 plays a background subagent
   * (`research/opencode-subagents.md`): the `subagent` call ends at once with the child's session ID,
   * the agent ends its turn, and the child's work goes on. A client that asked for the child's
   * updates gets them, and its states, as `opencode/session/child_update`; one that didn't gets none
   * once the turn is answered. The child's report then wakes the agent, whose words come as the
   * session's own updates either way, while OpenCode follows the session.
   */
  const subagentInBackground = async (io: Play, args: string): Promise<acp.StopReason> => {
    const { session, update, say } = io;
    const client = io.ctx.client;
    const [first = "", second = ""] = args.split(/\s+/);
    const hangs = first === "hang";
    // F-138: `silent`, a child whose end is never reported, as once OpenCode no longer follows the session.
    const silent = args.split(/\s+/).includes("silent");
    const ms = Number.parseInt(hangs ? second : first, 10);
    const workMs = Number.isFinite(ms) && ms > 0 ? ms : 1000;
    counter += 1;
    const childId = `fake-child-${String(counter)}`;
    const title = "slow child";
    const notifyChild = async (event: Record<string, unknown>): Promise<void> => {
      if (!childUpdates || !session.following) {
        return;
      }
      await client
        .notify<Record<string, unknown>>(FAKE_CHILD_UPDATE_METHOD, { rootSessionId: session.id, childSessionId: childId, parentSessionId: session.id, depth: 1, title, ...event })
        .catch(() => undefined);
    };
    const child = new AbortController();
    session.children.set(childId, child);
    await update({ sessionUpdate: "tool_call", toolCallId: "subagent-1", title: "subagent", kind: "think", status: "pending" });
    await update({ sessionUpdate: "tool_call_update", toolCallId: "subagent-1", status: "in_progress", rawInput: { agent: "general", description: title, prompt: "read the README" } });
    await notifyChild({ type: "status", status: "created" });
    await update({ sessionUpdate: "tool_call_update", toolCallId: "subagent-1", status: "completed", rawOutput: { metadata: { sessionID: childId, status: "running", truncated: false } } });
    await notifyChild({ type: "status", status: "running" });
    await say("launched a subagent, ending my turn");
    // The child's work and the agent's wake, past the answer: never awaited by the prompt.
    void (async () => {
      const meta = { "opencode/child-session": { id: childId, parentID: session.id, depth: 1, title } };
      if (hangs) {
        // One that never ends says so now and then, so a stop that misses it shows.
        for (let tick = 1; !child.signal.aborted; tick += 1) {
          const tickId = `${childId}:tick-${String(tick)}`;
          await notifyChild({ type: "update", update: { sessionUpdate: "tool_call", toolCallId: tickId, title: `${title}: wait`, kind: "execute", status: "pending", rawInput: { command: "sleep 0.2" }, _meta: meta } });
          await sleep(200, child.signal);
          await notifyChild({ type: "update", update: { sessionUpdate: "tool_call_update", toolCallId: tickId, status: "completed", _meta: meta } });
        }
      } else {
        await sleep(workMs, child.signal);
      }
      session.children.delete(childId);
      const toolCallId = `${childId}:read-1`;
      if (child.signal.aborted) {
        if (!silent) {
          await notifyChild({ type: "status", status: "interrupted" });
        }
      } else {
        await notifyChild({ type: "update", update: { sessionUpdate: "tool_call", toolCallId, title: `${title}: read`, kind: "read", status: "pending", rawInput: { path: "README.md" }, _meta: meta } });
        await notifyChild({ type: "update", update: { sessionUpdate: "tool_call_update", toolCallId, status: "completed", _meta: meta } });
        await notifyChild({ type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "child answer: the README says hello" }, _meta: meta } });
        await notifyChild({ type: "status", status: "completed" });
      }
      // The report wakes the agent: a turn of its own, seen by a client OpenCode still follows.
      const wakeSignal = session.wakeAbort.signal;
      session.waking = true;
      try {
        await sleep(300, wakeSignal);
        if (!wakeSignal.aborted && session.following) {
          const text = child.signal.aborted ? "the subagent was stopped" : "the final answer, after the subagent";
          session.history.push(text);
          await client
            .notify(acp.methods.client.session.update, { sessionId: session.id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } })
            .catch(() => undefined);
          await sleep(200, wakeSignal);
        }
      } finally {
        session.waking = false;
      }
    })();
    return "end_turn";
  };

  /** F-138: `[[fake:subagent-tree]]` (`fakeScripts`, `FAKE_SUBAGENT_TREE`). */
  const subagentTree = async (io: Play, args: string): Promise<acp.StopReason> => {
    const { session, update, say } = io;
    const client = io.ctx.client;
    const flags = new Set(args.split(/\s+/));
    const tree = FAKE_SUBAGENT_TREE;
    counter += 1;
    type Child = { readonly id: string; readonly parent: string; readonly depth: number; readonly title: string };
    const explore: Child = { id: `fake-child-${String(counter)}-explore`, parent: session.id, depth: 1, title: tree.explore.description };
    const general: Child = { id: `fake-child-${String(counter)}-general`, parent: session.id, depth: 1, title: tree.general.description };
    const nested: Child = { id: `fake-child-${String(counter)}-nested`, parent: general.id, depth: 2, title: tree.nested.description };
    const metaOf = (child: Child): Record<string, unknown> => ({ "opencode/child-session": { id: child.id, parentID: child.parent, depth: child.depth, title: child.title } });
    const envelope = (child: Child): Record<string, unknown> => ({
      rootSessionId: session.id,
      childSessionId: child.id,
      parentSessionId: child.parent,
      depth: child.depth,
      title: child.title,
    });
    /** A child's update: its own notification to a client that asked, else on the session with its `_meta`, as OpenCode projects it. */
    const childSays = async (child: Child, body: Record<string, unknown>): Promise<void> => {
      const withMeta = { ...body, _meta: metaOf(child) };
      if (childUpdates) {
        await client.notify<Record<string, unknown>>(FAKE_CHILD_UPDATE_METHOD, { ...envelope(child), type: "update", update: withMeta }).catch(() => undefined);
      } else {
        await update(withMeta);
      }
    };
    /** A child's state: only to a client that asked (OpenCode sends none otherwise). */
    const childState = async (child: Child, status: string, error?: Record<string, unknown>): Promise<void> => {
      if (childUpdates) {
        await client.notify<Record<string, unknown>>(FAKE_CHILD_UPDATE_METHOD, { ...envelope(child), type: "status", status, ...(error === undefined ? {} : { error }) }).catch(() => undefined);
      }
    };
    /** The `subagent` call, of the main agent (`owner` null) or of a child: it ends at once, naming the child's session. */
    const start = async (callId: string, owner: Child | null, child: Child, input: { readonly type: string; readonly description: string; readonly prompt: string }): Promise<void> => {
      const send = owner === null ? update : (body: Record<string, unknown>) => childSays(owner, body);
      const id = owner === null ? callId : `${owner.id}:${callId}`;
      await send({ sessionUpdate: "tool_call", toolCallId: id, title: owner === null ? "subagent" : `${owner.title}: subagent`, kind: "think", status: "pending" });
      await send({ sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress", rawInput: { agent: input.type, description: input.description, prompt: input.prompt } });
      await childState(child, "created");
      await send({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", rawOutput: { metadata: { sessionID: child.id, status: "running", truncated: false } } });
      await childState(child, "running");
    };
    let calls = 0;
    const tool = async (child: Child, kind: string, title: string, rawInput: Record<string, unknown>, content: readonly Record<string, unknown>[] = []): Promise<void> => {
      calls += 1;
      const id = `${child.id}:call-${String(calls)}`;
      await childSays(child, { sessionUpdate: "tool_call", toolCallId: id, title: `${child.title}: ${title}`, kind, status: "pending", rawInput });
      await childSays(child, { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", ...(content.length === 0 ? {} : { content }) });
    };
    const answer = async (child: Child, text: string): Promise<void> => {
      await childSays(child, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    };

    await say("I'll have subagents find the version source and write the test, then add the row.");
    await start("subagent-explore", null, explore, tree.explore);
    await start("subagent-general", null, general, tree.general);
    await tool(explore, "read", "read", { path: "src/settings/page.tsx" }, [{ type: "content", content: { type: "text", text: "export const Page = () => null;" } }]);
    await tool(explore, "search", "grep", { pattern: "version" });
    await answer(explore, tree.explore.answer);
    await childState(explore, "completed");
    await tool(general, "read", "read", { path: "test/render.tsx" }, [{ type: "content", content: { type: "text", text: "export const renderWithProviders = () => null;" } }]);
    await start("subagent-nested", general, nested, tree.nested);
    await tool(nested, "search", "grep", { pattern: "renderWithProviders" });
    await answer(nested, tree.nested.answer);
    await childState(nested, "completed");
    if (flags.has("ask")) {
      calls += 1;
      const id = `${general.id}:call-${String(calls)}`;
      const rawInput = { command: tree.command };
      await childSays(general, { sessionUpdate: "tool_call", toolCallId: id, title: `${general.title}: shell`, kind: "execute", status: "pending", rawInput });
      const asked = await client.request(acp.methods.client.session.requestPermission, {
        sessionId: session.id,
        toolCall: { toolCallId: id, title: tree.command, kind: "execute", status: "pending", rawInput, _meta: metaOf(general) },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      });
      const read = permissionAnswerSchema.safeParse(asked);
      const allowed = read.success && read.data.outcome.outcome === "selected" && (read.data.outcome.optionId ?? "").startsWith("allow");
      await childSays(
        general,
        allowed
          ? { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", content: [{ type: "content", content: { type: "text", text: "1 passed" } }] }
          : { sessionUpdate: "tool_call_update", toolCallId: id, status: "failed", content: [{ type: "content", content: { type: "text", text: "rejected" } }] },
      );
    }
    if (flags.has("fail")) {
      await childState(general, "failed", { name: "APIError", message: tree.error });
    } else {
      await tool(general, "edit", "edit", { filePath: "src/settings/version-row.test.tsx" }, [
        { type: "diff", path: "src/settings/version-row.test.tsx", oldText: null, newText: "it('shows the version', () => {});" },
      ]);
      await answer(general, tree.general.answer);
      await childState(general, "completed");
    }
    await say(tree.mainAnswer);
    return "end_turn";
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

      case "effort":
        await say(`effort: ${session.effort} set: ${session.effortsSet.join(",")}`);
        return "end_turn";

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
        const engines: readonly string[] = ["postgres", "mysql"];
        const answer = await io.ctx.client.request(acp.methods.client.elicitation.create, {
          sessionId: session.id,
          mode: "form",
          message: "Which database should the service use?",
          requestedSchema: {
            type: "object",
            properties: {
              name: { type: "string", title: "Database name" },
              engine: { type: "string", title: "Engine", enum: [...engines] },
              replicas: { type: "integer", title: "Replicas" },
            },
          },
        });
        if (answer.action !== "accept") {
          await say(`no answer: ${answer.action}`);
          return "end_turn";
        }
        // Milestone 10 (F-151): without `questionFreeText`, an engine outside the enum is refused.
        const content = z.record(z.string(), z.unknown()).safeParse(answer.content ?? {});
        const engine = content.success ? content.data["engine"] : undefined;
        if (!capabilities.questionFreeText && typeof engine === "string" && !engines.includes(engine)) {
          await say("refused: the engine is not one of the choices");
          return "end_turn";
        }
        await say(`answered: ${JSON.stringify(answer.content ?? {})}`);
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

      // ---- milestone 6 (ticket 04): the asking, drafting, reviewing and proposing fakes ----
      case "ask-and-continue": {
        const answer = await io.ctx.client.request(acp.methods.client.elicitation.create, {
          sessionId: session.id,
          mode: "form",
          message: "Should I keep the old banner's markup, or replace it?",
          requestedSchema: { type: "object", properties: { [FAKE_AGENT_QUESTION_FIELD]: { type: "string", title: "Approach" } } },
        });
        if (answer.action !== "accept") {
          // Spike 10: OpenCode's question tool ends the turn when the question is declined.
          return "cancelled";
        }
        const content = z.record(z.string(), z.unknown()).safeParse(answer.content);
        const given = content.success ? content.data[FAKE_AGENT_QUESTION_FIELD] : undefined;
        await say(`carried on with: ${typeof given === "string" ? given : JSON.stringify(answer.content ?? {})}`);
        return "end_turn";
      }

      case "submit-draft":
      case "submit-review":
      case "propose-environment":
      case "take-screenshot":
      case "start-app":
      case "show-preview":
      case "record-app":
      case "app-calls": {
        const config = await readConfig();
        const ostraMcp = config.ostraMcp;
        /** One call of ostra's tool, reported as the agent's tool call, and its answer said. */
        const callTool = async (tool: string, toolArgs: unknown, toolCallId: string): Promise<void> => {
          if (ostraMcp === undefined) {
            await say(`${tool}: no such tool`);
            return;
          }
          await update({ sessionUpdate: "tool_call", toolCallId, title: `ostra/${tool}`, kind: "other", status: "in_progress", rawInput: { mcpServer: "ostra", tool } });
          const result = z
            .looseObject({ content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })), isError: z.boolean().optional() })
            .safeParse(await mcpCall(ostraMcp, "tools/call", { name: tool, arguments: toolArgs }));
          const text = result.success ? result.data.content.map((part) => part.text ?? "").join("") : "no such tool";
          const failed = !result.success || result.data.isError === true;
          await update({ sessionUpdate: "tool_call_update", toolCallId, status: failed ? "failed" : "completed", content: [{ type: "content", content: { type: "text", text } }] });
          await say(`${tool}: ${text}`);
        };
        if (script === "app-calls") {
          // Ticket 13: files written first (a turn that changed a repo), then each call in order.
          const plan = appCallsSchema.safeParse(readToolArgs(args));
          const calls = plan.success ? plan.data.calls : [];
          const root = session.cwd;
          for (const relative of plan.success ? (plan.data.write ?? []) : []) {
            const target = root === null ? null : path.resolve(root, relative);
            if (root !== null && target?.startsWith(`${path.resolve(root)}${path.sep}`) === true) {
              await mkdir(path.dirname(target), { recursive: true });
              await writeFile(target, "Written by the fake agent.\n");
            }
          }
          for (const [index, call] of calls.entries()) {
            await callTool(call.tool, call.arguments, `t-app-call-${String(index + 1)}`);
          }
          return "end_turn";
        }
        const tools = {
          "submit-draft": "submit_draft",
          "submit-review": "submit_review",
          "propose-environment": "propose_environment",
          "take-screenshot": "take_screenshot",
          "start-app": "start_app",
          "show-preview": "show_preview",
          "record-app": "record_app",
        } as const;
        await callTool(tools[script], readToolArgs(args), `t-${script}`);
        return "end_turn";
      }

      case "git-push": {
        const root = session.cwd;
        const [repo = ".", branch = "ostra/fake-push"] = args.split(/\s+/).filter((each) => each !== "");
        if (root === null) {
          await say("No folder to push from.");
          return "end_turn";
        }
        const cwd = path.resolve(root, repo);
        // Milestone 6 (ticket 22): a full ref name (`refs/ostra/wip/<task>`) is pushed as it is.
        const target = branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
        const command = `git push origin HEAD:${target}`;
        const toolCallId = "t-git-push";
        await update({ sessionUpdate: "tool_call", toolCallId, title: command, kind: "execute", status: "in_progress", rawInput: { command, cwd } });
        const code = await new Promise<number | null>((resolve) => {
          const child = spawn("git", ["push", "origin", `HEAD:${target}`], { cwd, stdio: "ignore", windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
          child.on("error", () => {
            resolve(null);
          });
          child.on("exit", (exitCode) => {
            resolve(exitCode);
          });
        });
        await update({ sessionUpdate: "tool_call_update", toolCallId, status: code === 0 ? "completed" : "failed" });
        await say(code === 0 ? "pushed" : "push refused");
        return "end_turn";
      }

      case "commit": {
        // `[[fake:commit <path> ...]]`: the agent's own commit of the files given, in the repo its
        // session opened on, so a runner test sees a branch the agent changed itself (ticket 23).
        // With `--push=<branch or ref>` it pushes the commit there too, and says git's refusal (F-113).
        const root = session.cwd;
        const words = args.split(/\s+/).filter((each) => each !== "");
        const pushTo = words.find((word) => word.startsWith("--push="))?.slice("--push=".length);
        const relatives = words.filter((word) => !word.startsWith("--push="));
        if (root === null || relatives.length === 0) {
          await say("Nothing to commit.");
          return "end_turn";
        }
        for (const relative of relatives) {
          const target = path.resolve(root, relative);
          if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) {
            await say("That path leaves the session's folder.");
            return "end_turn";
          }
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, "Committed by the fake agent.\n");
        }
        const gitIn = (cwd: string, gitArgs: readonly string[]): Promise<number | null> =>
          new Promise((resolve) => {
            const child = spawn("git", ["-c", "user.name=Fake Agent", "-c", "user.email=fake-agent@example.test", ...gitArgs], { cwd, stdio: "ignore", windowsHide: true });
            child.on("error", () => {
              resolve(null);
            });
            child.on("exit", (code) => {
              resolve(code);
            });
          });
        // The repo each file is in: the session's folder when it is one, else the file's first folder.
        const rootIsRepo = await stat(path.join(root, ".git")).then(
          () => true,
          () => false,
        );
        const byRepo = new Map<string, string[]>();
        for (const relative of relatives) {
          const [first = ""] = relative.split(/[\\/]/);
          const repo = rootIsRepo ? root : path.join(root, first);
          byRepo.set(repo, [...(byRepo.get(repo) ?? []), path.relative(repo, path.resolve(root, relative))]);
        }
        const toolCallId = "t-commit";
        await update({ sessionUpdate: "tool_call", toolCallId, title: "git commit", kind: "execute", status: "in_progress", rawInput: { command: "git commit" } });
        let committed: number | null = 0;
        for (const [repo, files] of byRepo) {
          const added = await gitIn(repo, ["add", "--", ...files]);
          committed = added === 0 ? await gitIn(repo, ["commit", "--quiet", "--no-verify", "-m", "The fake agent's own commit"]) : added;
          if (committed !== 0) {
            break;
          }
        }
        await update({ sessionUpdate: "tool_call_update", toolCallId, status: committed === 0 ? "completed" : "failed" });
        await say(committed === 0 ? `Committed ${relatives.join(", ")}.` : "The commit failed.");
        const [pushFrom] = byRepo.keys();
        if (committed !== 0 || pushTo === undefined || pushFrom === undefined) {
          return "end_turn";
        }
        const target = pushTo.startsWith("refs/") ? pushTo : `refs/heads/${pushTo}`;
        const pushed = await new Promise<{ readonly code: number | null; readonly stderr: string }>((resolve) => {
          const child = spawn("git", ["push", "origin", `HEAD:${target}`], { cwd: pushFrom, stdio: ["ignore", "ignore", "pipe"], windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
          let stderr = "";
          child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
          });
          child.on("error", () => {
            resolve({ code: null, stderr });
          });
          child.on("close", (code) => {
            resolve({ code, stderr });
          });
        });
        // What the agent reads of a refusal: git's reason only, never the proxy's address.
        await say(pushed.code === 0 ? "pushed" : `push refused: ${pushRefusalReason(pushed.stderr) ?? "no reason given"}`);
        return "end_turn";
      }

      case "heads": {
        const root = session.cwd;
        if (root === null) {
          await say("No folder.");
          return "end_turn";
        }
        const names = args.split(/\s+/).filter((each) => each !== "");
        const lines: string[] = [];
        for (const name of names) {
          const head = await new Promise<string>((resolve) => {
            let out = "";
            const child = spawn("git", ["rev-parse", "HEAD"], { cwd: path.resolve(root, name), windowsHide: true });
            child.stdout.on("data", (chunk: Buffer) => {
              out += chunk.toString("utf8");
            });
            child.on("error", () => {
              resolve("none");
            });
            child.on("exit", () => {
              resolve(out.trim() === "" ? "none" : out.trim());
            });
          });
          lines.push(`${name} ${head}`);
        }
        await say(lines.join("\n"));
        return "end_turn";
      }

      // Milestone 7 (ticket 03).
      // Milestone 9 (F-148).
      case "model-turn": {
        const answered = await callModelWith(io.text, io.images, signal);
        await say(answered ? `Asked the model, with ${String(io.images.length)} images.` : "The model didn't answer.");
        return "end_turn";
      }

      case "model-steerable": {
        await callModelWith(io.text, io.images, signal);
        await say("Asked the model, open to a steer. ");
        // A tool call closes the open message, as `steerable`'s does.
        await update({ sessionUpdate: "tool_call", toolCallId: "t-wait-steer", title: "Wait for guidance", kind: "other", status: "in_progress" });
        const steered = await new Promise<{ readonly text: string; readonly images: readonly FakePromptImage[] } | undefined>((resolve) => {
          session.steer = (steerText, steerImages) => {
            resolve({ text: steerText, images: steerImages });
          };
          signal.addEventListener("abort", () => {
            resolve(undefined);
          }, { once: true });
        });
        if (steered === undefined) {
          return "cancelled";
        }
        await update({ sessionUpdate: "tool_call_update", toolCallId: "t-wait-steer", status: "completed" });
        await callModelWith(steered.text, steered.images, signal);
        await say(`Steered: ${steered.text}`);
        return "end_turn";
      }

      case "say-images":
        await say(`images: ${io.images.length === 0 ? "none" : io.images.map((image) => `${image.mimeType}:${image.data}`).join(" ")}`);
        return "end_turn";

      case "read-file": {
        // The agent's own read tool, on the absolute path given: what a message's files are read with.
        const target = args;
        const toolCallId = "t-read-file";
        await update({ sessionUpdate: "tool_call", toolCallId, title: `Read ${target}`, kind: "read", status: "in_progress", rawInput: { filePath: target }, locations: [{ path: target }] });
        let content: string;
        try {
          content = await readFile(target, "utf8");
        } catch {
          await update({ sessionUpdate: "tool_call_update", toolCallId, status: "failed", content: [{ type: "content", content: { type: "text", text: "no such file" } }] });
          await say("Couldn't read it.");
          return "end_turn";
        }
        await update({ sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: [{ type: "content", content: { type: "text", text: content } }] });
        await say(`Read: ${content.split(/\r?\n/)[0] ?? ""}`);
        return "end_turn";
      }

      case "slash":
        await say(`Ran the slash command /${args}.`);
        return "end_turn";

      case "model-calls": {
        // As a real agent's turn: a title call with no tools, then the turn's calls that offer
        // tools, each to the base URL it was given with the task's key, and nowhere else. The
        // turn's own usage counts the tool calls only, as OpenCode's does.
        const count = Math.max(1, Math.min(5, Number.parseInt(args, 10) || 2));
        const baseUrl = (options.env["FAKE_AGENT_BASE_URL"] ?? "").replace(/\/+$/, "");
        const key = options.env["FAKE_AGENT_API_KEY"] ?? "";
        const call = async (withTools: boolean, n: number): Promise<FakeTurnUsage | null> => {
          try {
            const answer = await fetch(`${baseUrl}/chat/completions`, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
              body: JSON.stringify({
                model: "stub-model",
                stream: false,
                messages: [{ role: "user", content: `${withTools ? "step" : "title"} ${String(n)}: ${"word ".repeat(40 * n)}` }],
                ...(withTools ? { tools: [{ type: "function", function: { name: "read", description: "Reads a file", parameters: { type: "object", properties: {} } } }] } : {}),
              }),
              signal,
            });
            const parsed = z
              .looseObject({ usage: z.looseObject({ prompt_tokens: z.number(), completion_tokens: z.number(), prompt_tokens_details: z.looseObject({ cached_tokens: z.number() }).optional() }) })
              .safeParse(await answer.json());
            if (!parsed.success) return null;
            const cached = parsed.data.usage.prompt_tokens_details?.cached_tokens ?? 0;
            const input = parsed.data.usage.prompt_tokens - cached;
            const output = parsed.data.usage.completion_tokens;
            return { inputTokens: input, outputTokens: output, totalTokens: input + output + cached, cachedReadTokens: cached };
          } catch {
            return null;
          }
        };
        await call(false, 0);
        const turnUsage: FakeTurnUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedReadTokens: 0 };
        for (let n = 1; n <= count; n += 1) {
          const used = await call(true, n);
          if (used !== null) {
            turnUsage.inputTokens += used.inputTokens;
            turnUsage.outputTokens += used.outputTokens;
            turnUsage.totalTokens += used.totalTokens;
            turnUsage.cachedReadTokens += used.cachedReadTokens;
          }
        }
        io.usage.value = turnUsage;
        await say(`Called the model ${String(count)} times.`);
        return "end_turn";
      }

      case "subagent-bg":
        return subagentInBackground(io, args);

      case "subagent-tree":
        return subagentTree(io, args);

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

  return { app, promptArrived };
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

/** A `session/prompt` request as it arrives on the wire: the client's, so unknown fields are tolerated. */
const promptRequestSchema = z.looseObject({
  method: z.literal(acp.methods.agent.session.prompt),
  id: z.union([z.string(), z.number()]),
  params: z.looseObject({ sessionId: z.string() }),
});

/** Serves the fake over a pair of node streams. Resolves when the client goes away. */
export const serveFakeAgent = async (input: Readable, output: Writable, options: Omit<FakeAgentOptions, "crash"> & { readonly crash?: () => void }): Promise<void> => {
  const fake = createFakeAgent({
    ...options,
    crash:
      options.crash ??
      (() => {
        output.destroy();
        input.destroy();
      }),
  });
  const stream = acp.ndJsonStream(writableToWeb(output), readableToWeb(input));
  // Each message in the order it arrived, before the SDK dispatches it: a prompt's turn exists from then on.
  const readable = stream.readable.pipeThrough(
    new TransformStream<acp.AnyMessage, acp.AnyMessage>({
      transform: (message, controller) => {
        const prompt = promptRequestSchema.safeParse(message);
        if (prompt.success) {
          fake.promptArrived(prompt.data.params.sessionId);
        }
        controller.enqueue(message);
      },
    }),
  );
  const connection = fake.app.connect({ readable, writable: stream.writable });
  await connection.closed;
};
