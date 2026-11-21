import type { Readable, Writable } from "node:stream";

import { appInstructionsBlock, clampEffort, defaultOstraToolSets, effortLevels as allEffortLevels, noReasoning } from "@ostra/protocol";
import type {
  ApiFormat,
  AppBlockProcess,
  AppBlockService,
  ApprovalRequestSubject,
  ApprovalRule,
  EffortLevel,
  OptionId,
  OstraToolSet,
  QuestionField,
  ReasoningControls,
  SessionId,
  StopReason,
  SubagentId,
  SubagentStatus,
  TaskEvent,
  TaskId,
  TaskKind,
  TaskRule,
  TaskSpecModelLimits,
  ToolCallId,
  TurnId,
  TurnMode,
} from "@ostra/protocol";

import { createPlumbing, defaultAdapterContext } from "../common/context.ts";
import type { AdapterContext, Plumbing } from "../common/context.ts";
import { adapterError, ok } from "../common/result.ts";
import type { AdapterResult, HealthReport } from "../common/result.ts";
import type { AgentCapabilities } from "./capabilities.ts";
import { describeStandardPermission } from "./permission-subject.ts";

// The agent kind (ADR 0025, ADR 0032): OpenCode first, Claude Code before launch. ACP is the only
// way ostra talks to an agent (ADR 0018). The base class composes ostra's ACP driver through a
// `DriverPort` (ticket 09 provides it), so an adapter writes only what's particular to its agent:
// how to launch it, and the quirks of its ACP updates.

// ---------- launching ----------

/** A skill the runner wrote for the task (F-021, ADR 0049): its folder holds `SKILL.md` and its files. */
export type LaunchSkill = {
  readonly name: string;
  /** Absolute, inside the task's agent folder: never in the repo. */
  readonly dir: string;
};

/**
 * An MCP server as the agent reaches it (ADR 0049, Q170): an HTTP server at the sidecar's MCP
 * proxy, whose address holds no credential, or a stdio server, a command already in the image whose
 * variables hold no secret.
 */
export type LaunchMcpServer =
  | { readonly name: string; readonly transport: "http"; readonly url: string; readonly readOnly: boolean }
  | {
      readonly name: string;
      readonly transport: "stdio";
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
      readonly readOnly: boolean;
    };

/**
 * Milestone 4 (ADR 0044, F-110): the task's memory, as the spec carries it. `block` is the text core
 * rendered (the "always" notes, the index and the standing instruction), which the adapter writes
 * with the profile's instructions where the agent reads them, in the task's config folder and
 * never in a repo. `tools` says whether the agent gets ostra's three memory tools, which only an
 * adapter that declares `memory: "mcp"` offers. The block's text is never logged.
 */
export type LaunchMemory = { readonly block: string; readonly tools: boolean };

/**
 * Milestone 8 (ADR 0068, F-140): the task's running app, as the agent's instructions name it: each
 * app process with its label and port, and each service with its address on this executor. The
 * adapter writes the app's block (`appInstructionsBlock`, through `composeLaunchInstructions`)
 * beside the profile's instructions, in the task's config folder and never in a repo. With no
 * process, there's no block.
 */
export type LaunchApp = { readonly processes: readonly AppBlockProcess[]; readonly services: readonly AppBlockService[] };

/** A file the agent needs before it starts, such as its per-task config. */
export type LaunchFile = {
  /** Absolute, inside the task's agent folder or workspace. */
  readonly path: string;
  readonly content: string;
};

/** How to start the agent's process: an argument array, never a shell line. */
export type AgentLaunch = {
  readonly command: string;
  readonly args: readonly string[];
  /** The agent's whole environment: an allowlist, nothing inherited (ADR 0030). */
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly files: readonly LaunchFile[];
};

/**
 * Milestone 4 (F-137, ADR 0066): what an adapter reads to know a model's reasoning levels. The
 * controls are the model's effective ones (an admin's, else the catalog's), and the limits its
 * real context window and output limit, each `null` when unknown.
 */
export type EffortModel = {
  readonly reasoning: ReasoningControls;
  readonly apiFormat: ApiFormat;
  readonly endpointModelId: string;
  readonly limits: TaskSpecModelLimits;
};

/** No limit known: the adapter keeps its fixed ones. */
export const unknownModelLimits: TaskSpecModelLimits = { contextWindow: null, maxOutputTokens: null };

/** The model of a launch as `effortLevels` reads it: no controls means no reasoning (ADR 0066). */
export const effortModelOf = (model: PrepareLaunchInput["model"]): EffortModel => ({
  reasoning: model.reasoning ?? noReasoning,
  apiFormat: model.apiFormat,
  endpointModelId: model.endpointModelId,
  limits: model.limits ?? unknownModelLimits,
});

/**
 * Levels in `effortLevels`' order (low to high, `default` first, each once): what an adapter's
 * `effortLevels` answers from the levels it found.
 */
export const orderedEffortLevels = (levels: readonly EffortLevel[]): readonly EffortLevel[] =>
  allEffortLevels.filter((level) => level === "default" || levels.includes(level));

export type PrepareLaunchInput = {
  readonly taskId: TaskId;
  readonly sessionId: SessionId;
  /** The task's workspace: the repos side by side (F-016). The agent's reach ends here. */
  readonly workspaceDir: string;
  /** A folder of the task's own for the agent's config, data and cache. */
  readonly agentDir: string;
  readonly model: {
    readonly endpointModelId: string;
    readonly apiFormat: ApiFormat;
    /** The key proxy's address, on loopback (or the sidecar's, in a box). */
    readonly baseUrl: string;
    /** The task's fake key: valid for this task, at the key proxy only. */
    readonly placeholderKey: string;
    /**
     * Milestone 4 (F-137, ADR 0066): the model's effective reasoning controls, which the agent's
     * config carries so its levels are the model's own. Absent: `{ supported: false }`, no effort.
     */
    readonly reasoning?: ReasoningControls;
    /** Milestone 4 (F-137): the model's real limits. Absent, or both `null`: the adapter's fixed ones. */
    readonly limits?: TaskSpecModelLimits;
  };
  /** ostra's MCP tools for this task (ticket 20). */
  readonly mcp: {
    readonly url: string;
    /**
     * The task's bearer token for ostra's MCP tools (ticket 20): task-scoped, good at ostra's tool
     * server only. Absent: the server takes no token.
     */
    readonly bearer?: string;
  };
  readonly instructions: string | null;
  /** The variables the environment allows through to the agent (non-secret, per repo). */
  readonly extraEnv: Readonly<Record<string, string>>;

  // ---- milestone 3 (ADR 0049): the profile, the task's rules and the mode ----
  /**
   * The profile's approval rules: what needs a person. A `native` adapter writes them into the
   * agent's own settings as "ask"; a `runner-only` one leaves every request to the runner. Absent: none.
   */
  readonly approvalRules?: readonly ApprovalRule[];
  /** The task's "for this task" rules, which the runner answers itself. Absent: none. */
  readonly taskRules?: readonly TaskRule[];
  /** The profile's skills, as the runner wrote them. Without `skills`, the adapter adds them to the instructions. */
  readonly skills?: readonly LaunchSkill[];
  /** The profile's MCP servers, beside ostra's own (`mcp`). Absent: none. */
  readonly mcpServers?: readonly LaunchMcpServer[];
  /** The mode the agent starts in (F-063). Absent: `build`. */
  readonly mode?: TurnMode;
  /**
   * Each repo's checkout folder, by its name inside `workspaceDir` (the task spec's `checkoutDir`).
   * An adapter that keeps the repo's own config out (`projectConfigOverride`) names the repos'
   * own skills from them, so the profile's sit beside the repo's (F-021). Absent: none named.
   */
  readonly repoDirs?: readonly string[];
  /**
   * 2026-11-21 (F-021, ADR 0049 amended): whether each repo's own skills, its `REPO_SKILL_FOLDERS`
   * (and the workspace root's), reach the agent beside the profile's: the project's setting. An
   * adapter that names them (OpenCode, in its config) names none when this is false, and names the
   * profile's after the repos', so a profile's skill wins over a repo's of the same name. Every
   * adapter honours it, whatever its agent reads on its own. Absent: true.
   */
  readonly repoSkills?: boolean;

  // ---- milestone 4 (ADR 0044) ----
  /** The task's memory. Absent or `null`: the task has none, or its spec came without it. */
  readonly memory?: LaunchMemory | null;

  // ---- milestone 6 (ADR 0028, protocol minor 5) ----
  /**
   * The task's kind (the spec's `kind`). A review task's agent never edits; a refine task's edits
   * only inside its box, and only when its profile allows prototyping. Absent: `code`.
   */
  readonly kind?: TaskKind;
  /** A refine profile's prototyping: edits inside the box (ADR 0028 amended). Read for a refine task only. Absent: `false`. */
  readonly allowPrototyping?: boolean;
  /**
   * The tool sets of ostra's MCP server for the task (the spec's `tools`), so an adapter offers the
   * agent those tools and no other of ostra's. Absent: `defaultOstraToolSets`, a code task's.
   */
  readonly tools?: readonly OstraToolSet[];

  // ---- milestone 8 (ADR 0068, protocol minor 7) ----
  /** The task's running app, for the instructions' app block (F-140). Absent, `null` or with no process: no block. */
  readonly app?: LaunchApp | null;
};

/** Whether a launch offers the agent the app tools: its tool sets hold `app` (the spec's `tools`, F-121). */
export const launchHasAppTools = (input: Pick<PrepareLaunchInput, "tools">): boolean => (input.tools ?? defaultOstraToolSets).includes("app");

/**
 * Milestone 4: the instructions an agent starts with, in one text: the profile's, then, for a task
 * with several repos (F-098), the list of them side by side under the workspace's root, where the
 * agent works, then the memory block (F-110), then, milestone 8, the app's block (F-140). `null`
 * when there's none of them. An adapter writes it where its agent reads instructions, in the task's
 * config folder: never in a repo. `appTools` says whether the block names the app tools: by default
 * when the launch's tool sets hold `app`; an adapter that can't reach ostra's MCP server passes false.
 */
export const composeLaunchInstructions = (input: PrepareLaunchInput, options: { readonly appTools?: boolean } = {}): string | null => {
  const repos = input.repoDirs ?? [];
  const app = input.app ?? null;
  const parts = [
    input.instructions ?? "",
    repos.length > 1
      ? `This task's workspace holds ${String(repos.length)} repos side by side, each in its own folder under the workspace's root, where you work: ${repos.join(", ")}.`
      : "",
    input.memory?.block ?? "",
    app === null ? "" : appInstructionsBlock({ processes: app.processes, services: app.services, tools: options.appTools ?? launchHasAppTools(input) }),
  ].filter((part) => part.trim() !== "");
  return parts.length === 0 ? null : parts.join("\n\n");
};

// ---------- the driver seam (ticket 09) ----------

/** The agent's stdio, from the executor's `startAgent` (spike 3's `AgentHost` seam). */
export type AgentIo = {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /**
   * The agent's PID in the executor's own process namespace, when it has one. With it the driver
   * ends the agent's process tree itself when a cancel goes unanswered, and on close. An executor's
   * `AgentProcess` fits this type as it is.
   */
  readonly pid?: number | null;
  /** The PIDs in the task's containment unit, when the executor can list them (`AgentProcess.unitPids`). */
  readonly unitPids?: () => Promise<readonly number[]>;
};

/** An ACP `session/update`'s update, as the agent sent it: vendor-owned, so loose. */
export type AcpUpdate = { readonly sessionUpdate: string; readonly [field: string]: unknown };

/**
 * F-138: the subagent an update or a request comes from (OpenCode's child session): its ID, the
 * subagent that started it (`null`: the main agent), and its depth from 1. The driver reads it from
 * the agent's own data; an adapter with `subagents: "none"` never gets one, and its calls stay flat.
 */
export type SubagentRef = {
  readonly id: SubagentId;
  readonly parentId: SubagentId | null;
  readonly depth: number;
};

/** F-138: a subagent's state changed, as its agent reported it (or as the driver stopped it). */
export type SubagentNotice = {
  readonly subagent: SubagentRef;
  readonly status: SubagentStatus;
  /** With `failed`: the agent's words for why. Content: never logged. */
  readonly error?: string;
};

/** An ACP permission request, reduced to what ostra uses. */
export type PermissionRequest = {
  readonly toolCallId: ToolCallId;
  readonly title: string;
  readonly options: readonly { readonly optionId: OptionId; readonly name: string; readonly kind: string }[];
  // ---- milestone 3 ----
  /** The tool call's ACP kind, as the agent sent it: vendor data. */
  readonly toolKind?: string;
  /** The tool call's raw input, as the agent sent it: vendor data, may quote the repo, never logged. */
  readonly rawInput?: unknown;
  /** The paths the tool call names, as the agent sent them. */
  readonly locations?: readonly string[];
  /**
   * What the request touches, for the rules and the card (ADR 0049): set by the base class from
   * `describePermission`; `null` when the request names nothing the rules can match.
   */
  readonly subject?: ApprovalRequestSubject | null;
  /** F-138: the subagent whose call asks. Absent: the main agent's own call. */
  readonly subagentId?: SubagentId;
};

export type PermissionAnswer =
  | { readonly outcome: "selected"; readonly optionId: OptionId }
  | { readonly outcome: "cancelled" };

/** An ACP `elicitation.form` request, mapped to ostra's question fields. */
export type QuestionRequest = { readonly message: string; readonly fields: readonly QuestionField[] };

export type QuestionAnswer =
  | { readonly outcome: "answered"; readonly answers: Readonly<Record<string, string>> }
  | { readonly outcome: "declined" }
  | { readonly outcome: "cancelled" };

/** What the driver calls back with. Each callback names the agent's own session ID. */
export type DriverHandlers = {
  /** An update of the session, or (F-138) of one of its subagents, named by `subagent`. */
  readonly onUpdate: (agentSessionId: string, update: AcpUpdate, subagent?: SubagentRef) => void;
  /** F-138: a subagent of the session changed state. */
  readonly onSubagentStatus?: (agentSessionId: string, notice: SubagentNotice) => void;
  /**
   * An update `session/load` replayed: the session's history, which ostra already stored. The
   * driver marks it so; it's counted, never stored as a new event (ADR 0035).
   */
  readonly onReplay?: (agentSessionId: string, update: AcpUpdate) => void;
  readonly onPermission: (agentSessionId: string, request: PermissionRequest, signal: AbortSignal) => Promise<PermissionAnswer>;
  readonly onQuestion: (agentSessionId: string, request: QuestionRequest, signal: AbortSignal) => Promise<QuestionAnswer>;
};

export type McpServer = { readonly name: string; readonly url: string; readonly headers: Readonly<Record<string, string>> };

/**
 * Milestone 4 (F-137): a session config option as the agent advertised it on `session/new` or
 * `session/load` (ACP's `configOptions`, the `/unstable` field). Vendor data, read loosely: the
 * agent owns its IDs and values.
 */
export type SessionConfigOption = {
  readonly id: string;
  /** ACP's semantic category, such as `thought_level`; `null` when the agent gave none. */
  readonly category: string | null;
  /** The current value, as text; `null` when it isn't one ostra can read. */
  readonly currentValue: string | null;
  /** A select's values, its groups flattened, in the agent's order. Empty for a boolean. */
  readonly values: readonly string[];
};

/** ACP's reserved category for a reasoning level selector (ACP, "Session Config Options"). */
export const THOUGHT_LEVEL_CATEGORY = "thought_level";

/**
 * What a turn's prompt came to. With `subagents: "background"`, the driver answers it only once no
 * subagent of the session runs and the agent has finished the turns their reports woke it for.
 */
export type PromptOutcome = {
  readonly stopReason: StopReason;
  /**
   * The subagents still running when the turn's wait for them ran out (`AcpDriverOptions.subagentWaitMs`).
   * The driver stopped them; each is named by the main agent's call that started it, `null` when
   * the driver never saw that call. Absent: no subagent outlived the wait.
   */
  readonly subagentsStopped?: { readonly waitedMs: number; readonly startedBy: readonly (ToolCallId | null)[] };
};

/** What the base class tells the driver about its agent when it connects. */
export type ConnectOptions = {
  /** The adapter's `subagents` capability: with `background`, a turn waits for the subagents it started. Absent: `none`. */
  readonly subagents?: AgentCapabilities["subagents"];
};

/** One initialized ACP connection to one agent process. */
export type DriverConnection = {
  readonly agentName: string | null;
  readonly agentVersion: string | null;
  /** The agent advertised mid-turn steering on `initialize` (ADR 0032). */
  readonly steeringAdvertised: boolean;
  /** Milestone 4 (F-137): with the session's config options, as the agent advertised them. */
  readonly newSession: (input: {
    readonly cwd: string;
    readonly mcpServers: readonly McpServer[];
  }) => Promise<AdapterResult<{ readonly agentSessionId: string; readonly configOptions: readonly SessionConfigOption[] }>>;
  readonly loadSession: (input: {
    readonly agentSessionId: string;
    readonly cwd: string;
    readonly mcpServers: readonly McpServer[];
  }) => Promise<AdapterResult<{ readonly configOptions: readonly SessionConfigOption[] }>>;
  readonly prompt: (agentSessionId: string, text: string) => Promise<AdapterResult<PromptOutcome>>;
  readonly cancel: (agentSessionId: string) => Promise<void>;
  readonly steer: (agentSessionId: string, text: string) => Promise<AdapterResult<void>>;
  /**
   * Sets a session config option (the model, for one) and returns the `session.config_changed`
   * event for the caller to number and spool: the driver emits it itself, because an agent sends no
   * update for a change ostra made.
   */
  readonly setConfigOption?: (agentSessionId: string, configId: string, value: string) => Promise<AdapterResult<readonly TaskEvent[]>>;
  /** Sets the session's mode, with the same event. */
  readonly setMode?: (agentSessionId: string, modeId: string) => Promise<AdapterResult<readonly TaskEvent[]>>;
  /** Ends the connection, and the agent's process tree when the driver knows its PID. */
  readonly close: () => Promise<void>;
};

/** Where in a session an update arrived, for the mapping. */
export type MapContext = {
  readonly taskId: TaskId;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  /** The session's working folder: paths inside it are shown relative to it. */
  readonly cwd?: string;
  /** F-138: the subagent the update is from. Absent: the main agent's own. */
  readonly subagent?: SubagentRef;
  /** F-138: the adapter reports subagents (`subagents` isn't `none`), so a call that starts one says so. */
  readonly reportsSubagents?: boolean;
};

/** ostra's ACP driver, as the base class uses it (ticket 09 provides the real one). */
export type DriverPort = {
  readonly connect: (io: AgentIo, handlers: DriverHandlers, options?: ConnectOptions) => Promise<AdapterResult<DriverConnection>>;
  /** The ACP-to-ostra mapping every agent shares (ADR 0018). */
  readonly mapUpdate: (update: AcpUpdate, context: MapContext) => readonly TaskEvent[];
  /** F-138: a subagent's state, as `subagent.status`. A driver that knows no subagents omits it. */
  readonly mapSubagentStatus?: (notice: SubagentNotice, context: MapContext) => readonly TaskEvent[];
  /**
   * The turn ended: the events the mapping held back until now (the open text segment, the turn's
   * context usage). A driver whose mapping holds nothing back omits it.
   */
  readonly finishTurn?: (context: MapContext) => readonly TaskEvent[];
  /** The session is over: drops what the mapping kept for it. */
  readonly closeSession?: (sessionId: SessionId) => void;
};

/** A wait, in the words a member reads: whole minutes, or seconds below one. */
const waitedText = (ms: number): string => {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 1) {
    return minutes === 1 ? "1 minute" : `${String(minutes)} minutes`;
  }
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds === 1 ? "1 second" : `${String(seconds)} seconds`;
};

// ---------- sessions ----------

export type StartSessionInput = {
  readonly taskId: TaskId;
  readonly sessionId: SessionId;
  readonly io: AgentIo;
  readonly cwd: string;
  readonly mcpServers: readonly McpServer[];
  /** Mapped events, in order. The caller numbers and spools them. */
  readonly onEvents: (events: readonly TaskEvent[]) => void;
  readonly onPermission: DriverHandlers["onPermission"];
  readonly onQuestion: DriverHandlers["onQuestion"];
  /** Resume this agent session in place, when the adapter has `sessionLoad`. */
  readonly resumeAgentSessionId?: string;
  /**
   * Milestone 3 (F-063): for a `relaunch` adapter's `setMode`, stops the agent's process and starts
   * it again with the launch `prepareLaunch` gives for `mode`, and hands back its stdio. The runner
   * provides it; without it, a `relaunch` adapter can't change mode.
   */
  readonly relaunch?: (mode: TurnMode) => Promise<AdapterResult<AgentIo>>;
  /**
   * Milestone 4 (F-137, ADR 0066): for a `reasoningEffort: "relaunch"` adapter's `setEffort`, the
   * same as `relaunch`, with the launch written for the reasoning level given. The runner provides it.
   */
  readonly relaunchAtEffort?: (level: EffortLevel) => Promise<AdapterResult<AgentIo>>;
};

/** A running session, as the base class hands it back. */
export type AgentSession = {
  readonly taskId: TaskId;
  readonly sessionId: SessionId;
  readonly agentSessionId: string;
  readonly connection: DriverConnection;
  /** How many updates `session/load` replayed when the session was resumed: `session.restored`'s count. */
  readonly replayedUpdates: number;
  /** Milestone 4 (F-137): the session's config options as the agent advertised them when it started or loaded. */
  readonly configOptions: readonly SessionConfigOption[];
};

/** Milestone 4 (F-137): what `setEffort` did. */
export type EffortSet = {
  /** The session to use from then on: a `relaunch` adapter's is a new one. */
  readonly session: AgentSession;
  /** The level the session runs at now, after the clamp to what the agent advertised (ADR 0066). */
  readonly level: EffortLevel;
  /** The level asked for, when the clamp changed it. */
  readonly adjustedFrom?: EffortLevel;
  /**
   * The `session.config_changed` event, for the caller to number and spool: an agent sends no
   * update for a change ostra made. Empty when nothing changed.
   */
  readonly events: readonly TaskEvent[];
};

// ---------- milestone 2: moving a session to another box (ADR 0039) ----------

/** A command run beside the live agent, in its box, with its environment: an argument array, never a shell line. */
export type AgentCommand = {
  readonly command: string;
  readonly args: readonly string[];
  /** An allowlist, as the agent's own launch has (ADR 0030). */
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  /**
   * A file that receives the command's standard output, for an agent whose export prints the archive
   * (OpenCode's `session export` has no output flag). The executor opens it and wires the child's
   * stdout to it: no shell, no `>`. Absent: the command writes its own output files.
   */
  readonly stdoutTo?: string;
};

export type ExportSessionInput = {
  readonly agentSessionId: string;
  /** The box's agent folder and workspace, as the agent was launched with. */
  readonly agentDir: string;
  readonly workspaceDir: string;
  /** Where the archive ends up, written by the command itself or through its `stdoutTo`. The runner gzips and uploads it (ticket 22). */
  readonly archivePath: string;
};

export type ImportSessionInput = {
  /** The session the archive holds. */
  readonly agentSessionId: string;
  /** The fresh box's agent folder. */
  readonly agentDir: string;
  /**
   * The fresh box's workspace: the import binds the session to it, because the agent refuses to
   * load a session in another directory (OpenCode's `--directory`, spike 2).
   */
  readonly workspaceDir: string;
  /** The archive, downloaded and gunzipped. */
  readonly archivePath: string;
};

/** What an adapter's own mapping decides for one update. */
export type MappedUpdate =
  /** The adapter mapped it itself. */
  | { readonly handled: true; readonly events: readonly TaskEvent[] }
  /**
   * Use the shared mapping. `update` replaces the agent's update for it, so an agent that says a
   * thing its own way (OpenCode's todo list, as a tool call) can have it said as ACP says it, and
   * keep the shared mapping's ordering (the open text segment closes first).
   */
  | { readonly handled: false; readonly update?: AcpUpdate };

/**
 * The agent kind's base class. **Native memory is off** (ADR 0044, Q91): an adapter turns its agent's
 * own memory feature off at launch, so nothing an agent keeps for itself outlives the task, skips a
 * member's approval or differs from runner to runner (on `host`, an agent's memory folder would
 * carry from task to task on one machine). Project memory reaches the agent only as the launch's
 * `memory` block and, with `memory: "mcp"`, ostra's memory tools. Each adapter's class says what it
 * turns off, or that its agent has none: the Claude Code adapter sets
 * `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, and the contract case for the rule comes with it.
 */
export abstract class AgentAdapter {
  readonly kind = "agent" as const;
  abstract readonly name: string;
  abstract readonly capabilities: AgentCapabilities;

  readonly #context: AdapterContext;
  readonly #driver: DriverPort;
  #plumbing: Plumbing | undefined;
  readonly #turns = new Map<string, TurnId>();
  readonly #emitters = new Map<string, (events: readonly TaskEvent[]) => void>();
  readonly #starts = new Map<string, StartSessionInput>();
  /** Milestone 4 (F-137): each session's config options, as last advertised or set. */
  readonly #configs = new Map<string, readonly SessionConfigOption[]>();

  /**
   * Milestone 3 (ADR 0049, Q171): the repo files that hold this agent's own config, relative to a
   * repo's checkout, such as `opencode.json`. Without `projectConfigOverride`, the runner hides them
   * from the agent for the task and puts them back before the commit.
   */
  readonly repoConfigPaths: readonly string[] = [];

  constructor(driver: DriverPort, context: AdapterContext = defaultAdapterContext) {
    this.#driver = driver;
    this.#context = context;
  }

  /** Retries, rate budgets, idempotency and the logger, shared by every adapter (ADR 0025). */
  protected get plumbing(): Plumbing {
    this.#plumbing ??= createPlumbing(this.#context, { kind: this.kind, name: this.name });
    return this.#plumbing;
  }

  /** Whether the agent's binary is there, at the pinned version. */
  abstract health(): Promise<HealthReport>;

  /** The agent's command, arguments, allowlisted environment and config files for one task. */
  abstract prepareLaunch(input: PrepareLaunchInput): Promise<AdapterResult<AgentLaunch>>;

  /** The agent's own ACP quirks. Return `{ handled: false }` for the shared mapping. */
  protected abstract mapUpdate(update: AcpUpdate, context: MapContext): MappedUpdate;

  /**
   * Milestone 2: the command that exports a session to `archivePath`, with the capability
   * `sessionArchive`. Additive: an adapter answers `unsupported` until it has it (ticket 10). It
   * answers asynchronously because naming the command can mean finding and checking the agent's
   * binary, which the runner's code does with async calls only.
   */
  exportSession(input: ExportSessionInput): Promise<AdapterResult<AgentCommand>> {
    this.plumbing.logger.debug("exportSession is not supported", { agentSession: input.agentSessionId.length });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't export a session`));
  }

  /** Milestone 2: the command that imports an archive into a fresh box, bound to its workspace. */
  importSession(input: ImportSessionInput): Promise<AdapterResult<AgentCommand>> {
    this.plumbing.logger.debug("importSession is not supported", { agentSession: input.agentSessionId.length });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't import a session`));
  }

  /**
   * Milestone 3 (ADR 0049): what a permission request touches, for the rules. The default reads
   * ACP's standard kinds: a path for `edit`, `delete` and `move`, a command for `execute`, a URL for
   * `fetch`. An adapter whose agent says it another way, or names its MCP tools, overrides it.
   */
  protected describePermission(request: PermissionRequest, cwd: string): ApprovalRequestSubject | null {
    return describeStandardPermission(request, cwd);
  }

  /**
   * Milestone 4 (F-137, ADR 0066): the reasoning levels this agent can send for a model, low to
   * high, with `default` first. They're the model's controls as far as the agent can send them,
   * for its API format. An adapter with `reasoningEffort: "none"` answers `["default"]`.
   */
  abstract effortLevels(model: EffortModel): readonly EffortLevel[];

  /**
   * Milestone 4 (F-137): the agent's own value for a level, as its `thought_level` option names it,
   * or as its relaunch writes it. The default is ostra's name, and `default` for a model that
   * doesn't reason, which has no other level.
   */
  effortValue(level: EffortLevel, model: EffortModel): string {
    return model.reasoning.supported ? level : "default";
  }

  /** Milestone 3 (F-063): the agent's own ID of a mode, for `session/set_mode`. The default is ostra's name. */
  protected modeIdFor(mode: TurnMode): string {
    return mode;
  }

  /** Connects to the agent's process and starts (or resumes) its session. */
  async startSession(input: StartSessionInput): Promise<AdapterResult<AgentSession>> {
    if (input.resumeAgentSessionId !== undefined && !this.capabilities.sessionLoad) {
      return adapterError("unsupported", `${this.name} can't resume its own sessions`);
    }
    const sessionKey = String(input.sessionId);
    this.#starts.set(sessionKey, input);
    this.#emitters.set(sessionKey, input.onEvents);
    let replayed = 0;
    // F-138: an adapter that declares no subagents shows their calls flat, whatever the agent sends.
    const reportsSubagents = this.capabilities.subagents !== "none";
    const connected = await this.#driver.connect(
      input.io,
      {
        onReplay: () => {
          replayed += 1;
        },
        onUpdate: (_agentSessionId, update, subagent) => {
          const turnId = this.#turns.get(sessionKey);
          if (turnId === undefined) {
            // Before the first turn there's nothing to attach an update to: a load's replay that the
            // driver didn't mark is counted as one too, and never stored.
            replayed += 1;
            return;
          }
          const context: MapContext = {
            taskId: input.taskId,
            sessionId: input.sessionId,
            turnId,
            cwd: input.cwd,
            reportsSubagents,
            ...(subagent === undefined || !reportsSubagents ? {} : { subagent }),
          };
          const own = this.mapUpdate(update, context);
          const events = own.handled ? own.events : this.#driver.mapUpdate(own.update ?? update, context);
          if (events.length > 0) {
            input.onEvents(events);
          }
        },
        onSubagentStatus: (_agentSessionId, notice) => {
          const turnId = this.#turns.get(sessionKey);
          if (turnId === undefined || !reportsSubagents) {
            return;
          }
          const context: MapContext = { taskId: input.taskId, sessionId: input.sessionId, turnId, cwd: input.cwd, reportsSubagents, subagent: notice.subagent };
          const events = this.#driver.mapSubagentStatus?.(notice, context) ?? [];
          if (events.length > 0) {
            input.onEvents(events);
          }
        },
        // The request goes on with its subject, read once here, for the runner's rules, and (F-138)
        // without its subagent for an adapter that declares none.
        onPermission: (agentSessionId, request, signal) => {
          const { subagentId, ...rest } = request;
          const asked: PermissionRequest = reportsSubagents && subagentId !== undefined ? { ...rest, subagentId } : rest;
          return input.onPermission(agentSessionId, { ...asked, subject: this.describePermission(asked, input.cwd) }, signal);
        },
        onQuestion: input.onQuestion,
      },
      { subagents: this.capabilities.subagents },
    );
    if (!connected.ok) {
      this.#emitters.delete(sessionKey);
      this.#starts.delete(sessionKey);
      return connected;
    }
    const connection = connected.value;
    if (input.resumeAgentSessionId !== undefined) {
      const loaded = await connection.loadSession({
        agentSessionId: input.resumeAgentSessionId,
        cwd: input.cwd,
        mcpServers: input.mcpServers,
      });
      if (!loaded.ok) {
        return loaded;
      }
      this.#configs.set(sessionKey, loaded.value.configOptions);
      return ok({
        taskId: input.taskId,
        sessionId: input.sessionId,
        agentSessionId: input.resumeAgentSessionId,
        connection,
        replayedUpdates: replayed,
        configOptions: loaded.value.configOptions,
      });
    }
    const created = await connection.newSession({ cwd: input.cwd, mcpServers: input.mcpServers });
    if (!created.ok) {
      return created;
    }
    this.#configs.set(sessionKey, created.value.configOptions);
    return ok({
      taskId: input.taskId,
      sessionId: input.sessionId,
      agentSessionId: created.value.agentSessionId,
      connection,
      replayedUpdates: 0,
      configOptions: created.value.configOptions,
    });
  }

  /**
   * Runs one turn: the member's prompt, until the agent's stop reason. The turn's own events go out
   * through `onEvents` with the agent's: `turn.started` first, then what the mapping held back
   * (the open text segment, the context usage), then `turn.ended` with the stop reason, or
   * `turn.failed` when the agent couldn't finish. The caller writes `user.message` and numbers
   * the events; it doesn't write these (F-023).
   */
  async prompt(
    session: AgentSession,
    turnId: TurnId,
    text: string,
    options: {
      readonly mode?: TurnMode;
      /** Milestone 4 (F-137): the level the turn runs at, and the level asked for when the agent's clamp changed it. */
      readonly effort?: EffortLevel;
      readonly adjustedFrom?: EffortLevel;
    } = {},
  ): Promise<AdapterResult<PromptOutcome>> {
    const key = String(session.sessionId);
    const emit = this.#emitters.get(key);
    this.#turns.set(key, turnId);
    // Milestone 3: a turn whose mode the runner names says so, for the thread's plan marker (F-063).
    // Milestone 4: and its reasoning level (F-137), which a peer below minor 3 never sees.
    emit?.([
      {
        kind: "turn.started",
        turnId,
        ...(options.mode === undefined ? {} : { mode: options.mode }),
        ...(options.effort === undefined ? {} : { effort: options.effort }),
        ...(options.adjustedFrom === undefined ? {} : { adjustedFrom: options.adjustedFrom }),
      },
    ]);
    const result = await session.connection.prompt(session.agentSessionId, text);
    const held = this.#driver.finishTurn?.({ taskId: session.taskId, sessionId: session.sessionId, turnId }) ?? [];
    // A subagent the wait gave up on fails on the call that started it: what the member sees end.
    const stopped = result.ok ? result.value.subagentsStopped : undefined;
    const stoppedEvents: TaskEvent[] =
      stopped === undefined
        ? []
        : stopped.startedBy.flatMap((toolCallId): TaskEvent[] =>
            toolCallId === null
              ? []
              : [{ kind: "tool.failed", toolCallId, error: `the subagent still ran ${waitedText(stopped.waitedMs)} after its agent's turn was answered, so ostra stopped it` }],
          );
    emit?.([
      ...held,
      ...stoppedEvents,
      result.ok
        ? { kind: "turn.ended", turnId, stopReason: result.value.stopReason }
        : { kind: "turn.failed", turnId, error: result.error.message.slice(0, 4000) },
    ]);
    return result;
  }

  /** Cancels the running turn; the prompt then resolves with `cancelled`. */
  async cancel(session: AgentSession): Promise<void> {
    await session.connection.cancel(session.agentSessionId);
  }

  /** A member's message mid-turn. Only when the adapter declares `steerMidTurn` and the agent advertised it. */
  async steer(session: AgentSession, text: string): Promise<AdapterResult<void>> {
    if (!this.capabilities.steerMidTurn || !session.connection.steeringAdvertised) {
      return adapterError("unsupported", `${this.name} can't take a message mid-turn`);
    }
    return session.connection.steer(session.agentSessionId, text);
  }

  /**
   * Milestone 3 (F-063, ADR 0049): switches a live session between plan and build mode, between
   * turns. With `planMode: "session-mode"` it's ACP's `session/set_mode`; with `relaunch` the agent
   * is stopped and started again with the other mode's launch (`StartSessionInput.relaunch`), and
   * its session loaded, the replay counted as milestone 2 does; with `none` it's refused. The
   * session that comes back is the one to use from then on.
   */
  async setMode(session: AgentSession, mode: TurnMode): Promise<AdapterResult<AgentSession>> {
    const key = String(session.sessionId);
    const planMode = this.capabilities.planMode;
    switch (planMode) {
      case "none":
        return adapterError("unsupported", `${this.name} has no plan mode`);
      case "session-mode": {
        const setMode = session.connection.setMode;
        if (setMode === undefined) {
          return adapterError("unsupported", `${this.name}'s driver can't set a session's mode`);
        }
        const set = await setMode(session.agentSessionId, this.modeIdFor(mode));
        if (!set.ok) {
          return set;
        }
        this.#emitters.get(key)?.(set.value);
        return ok(session);
      }
      case "relaunch": {
        const start = this.#starts.get(key);
        if (!this.capabilities.sessionLoad || start?.relaunch === undefined) {
          return adapterError("unsupported", `${this.name} can't be relaunched in another mode here`);
        }
        await session.connection.close();
        // Between turns: the load's replay must never be mapped as the last turn's new events.
        this.#turns.delete(key);
        const io = await start.relaunch(mode);
        if (!io.ok) {
          return io;
        }
        const resumed = await this.startSession({ ...start, io: io.value, resumeAgentSessionId: session.agentSessionId });
        if (resumed.ok) {
          this.#emitters.get(key)?.([{ kind: "session.config_changed", key: "mode", value: this.modeIdFor(mode).slice(0, 2000) }]);
        }
        return resumed;
      }
      default:
        return planMode satisfies never;
    }
  }

  /**
   * Milestone 4 (F-137, ADR 0066): sets the session's reasoning level, between turns, and answers
   * the level it runs at. A level the agent doesn't advertise is never sent: it's clamped first
   * (`clampEffort`), so a turn never fails on it.
   * - `session-option`: `session/set_config_option` on the option of category `thought_level`
   *   (found by category, not by the agent's ID), with the value `effortValue` names, among the
   *   values the option advertises. `default` is sent only to undo a level the session has.
   * - `relaunch`: the agent is started again with the level's launch (`relaunchAtEffort`) and its
   *   session loaded, as `setMode` does.
   * - `none`: nothing; the session runs at the agent's default.
   */
  async setEffort(session: AgentSession, level: EffortLevel, model: EffortModel): Promise<AdapterResult<EffortSet>> {
    const key = String(session.sessionId);
    const reasoningEffort = this.capabilities.reasoningEffort;
    const outcome = (now: AgentSession, used: EffortLevel, events: readonly TaskEvent[]): EffortSet =>
      used === level ? { session: now, level: used, events } : { session: now, level: used, adjustedFrom: level, events };
    switch (reasoningEffort) {
      case "none":
        return ok(outcome(session, "default", []));
      case "session-option": {
        const options = this.#configs.get(key) ?? session.configOptions;
        const option = options.find((candidate) => candidate.category === THOUGHT_LEVEL_CATEGORY);
        if (option === undefined) {
          // The agent offers no level for this model: it runs at its default.
          return ok(outcome(session, "default", []));
        }
        const offered = allEffortLevels.filter((candidate) => option.values.includes(this.effortValue(candidate, model)));
        const clamped = clampEffort(level, offered).level;
        const value = this.effortValue(clamped, model);
        if (option.currentValue === value || !option.values.includes(value)) {
          // Already there, or `default` on an agent that can't be set back: nothing to send.
          return ok(outcome(session, clamped, []));
        }
        const setConfigOption = session.connection.setConfigOption;
        if (setConfigOption === undefined) {
          return adapterError("unsupported", `${this.name}'s driver can't set a session config option`);
        }
        const set = await setConfigOption(session.agentSessionId, option.id, value);
        if (!set.ok) {
          return set;
        }
        this.#configs.set(
          key,
          options.map((candidate) => (candidate.id === option.id ? { ...candidate, currentValue: value } : candidate)),
        );
        return ok(outcome(session, clamped, set.value));
      }
      case "relaunch": {
        const start = this.#starts.get(key);
        if (!this.capabilities.sessionLoad || start?.relaunchAtEffort === undefined) {
          return adapterError("unsupported", `${this.name} can't be relaunched at another level here`);
        }
        const clamped = clampEffort(level, this.effortLevels(model)).level;
        await session.connection.close();
        // Between turns: the load's replay must never be mapped as the last turn's new events.
        this.#turns.delete(key);
        const io = await start.relaunchAtEffort(clamped);
        if (!io.ok) {
          return io;
        }
        const resumed = await this.startSession({ ...start, io: io.value, resumeAgentSessionId: session.agentSessionId });
        if (!resumed.ok) {
          return resumed;
        }
        return ok(outcome(resumed.value, clamped, [{ kind: "session.config_changed", key: "effort", value: this.effortValue(clamped, model).slice(0, 2000) }]));
      }
      default:
        return reasoningEffort satisfies never;
    }
  }

  /** Ends the session's connection. */
  async close(session: AgentSession): Promise<void> {
    const key = String(session.sessionId);
    this.#turns.delete(key);
    this.#emitters.delete(key);
    this.#starts.delete(key);
    this.#configs.delete(key);
    this.#driver.closeSession?.(session.sessionId);
    await session.connection.close();
  }
}
