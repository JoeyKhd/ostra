import type { Readable, Writable } from "node:stream";

import type {
  ApiFormat,
  QuestionField,
  SessionId,
  StopReason,
  TaskEvent,
  TaskId,
  TurnId,
} from "@ostra/protocol";

import { createPlumbing, defaultAdapterContext } from "../common/context.ts";
import type { AdapterContext, Plumbing } from "../common/context.ts";
import { adapterError, ok } from "../common/result.ts";
import type { AdapterResult, HealthReport } from "../common/result.ts";
import type { AgentCapabilities } from "./capabilities.ts";

// The agent kind (ADR 0025, ADR 0032): OpenCode first, Claude Code before launch. ACP is the only
// way ostra talks to an agent (ADR 0018). The base class composes ostra's ACP driver through a
// `DriverPort` (ticket 09 provides it), so an adapter writes only what's particular to its agent:
// how to launch it, and the quirks of its ACP updates.

// ---------- launching ----------

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
};

/** An ACP `session/update`'s update, as the agent sent it: vendor-owned, so loose. */
export type AcpUpdate = { readonly sessionUpdate: string; readonly [field: string]: unknown };

/** An ACP permission request, reduced to what ostra uses. */
export type PermissionRequest = {
  readonly toolCallId: string;
  readonly title: string;
  readonly options: readonly { readonly optionId: string; readonly name: string; readonly kind: string }[];
};

export type PermissionAnswer =
  | { readonly outcome: "selected"; readonly optionId: string }
  | { readonly outcome: "cancelled" };

/** An ACP `elicitation.form` request, mapped to ostra's question fields. */
export type QuestionRequest = { readonly message: string; readonly fields: readonly QuestionField[] };

export type QuestionAnswer =
  | { readonly outcome: "answered"; readonly answers: Readonly<Record<string, string>> }
  | { readonly outcome: "declined" }
  | { readonly outcome: "cancelled" };

/** What the driver calls back with. Each callback names the agent's own session ID. */
export type DriverHandlers = {
  readonly onUpdate: (agentSessionId: string, update: AcpUpdate) => void;
  readonly onPermission: (agentSessionId: string, request: PermissionRequest, signal: AbortSignal) => Promise<PermissionAnswer>;
  readonly onQuestion: (agentSessionId: string, request: QuestionRequest, signal: AbortSignal) => Promise<QuestionAnswer>;
};

export type McpServer = { readonly name: string; readonly url: string; readonly headers: Readonly<Record<string, string>> };

/** One initialized ACP connection to one agent process. */
export type DriverConnection = {
  readonly agentName: string | null;
  readonly agentVersion: string | null;
  /** The agent advertised mid-turn steering on `initialize` (ADR 0032). */
  readonly steeringAdvertised: boolean;
  readonly newSession: (input: { readonly cwd: string; readonly mcpServers: readonly McpServer[] }) => Promise<AdapterResult<{ readonly agentSessionId: string }>>;
  readonly loadSession: (input: {
    readonly agentSessionId: string;
    readonly cwd: string;
    readonly mcpServers: readonly McpServer[];
  }) => Promise<AdapterResult<void>>;
  readonly prompt: (agentSessionId: string, text: string) => Promise<AdapterResult<{ readonly stopReason: StopReason }>>;
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
};

/** ostra's ACP driver, as the base class uses it (ticket 09 provides the real one). */
export type DriverPort = {
  readonly connect: (io: AgentIo, handlers: DriverHandlers) => Promise<AdapterResult<DriverConnection>>;
  /** The ACP-to-ostra mapping every agent shares (ADR 0018). */
  readonly mapUpdate: (update: AcpUpdate, context: MapContext) => readonly TaskEvent[];
  /**
   * The turn ended: the events the mapping held back until now (the open text segment, the turn's
   * context usage). A driver whose mapping holds nothing back omits it.
   */
  readonly finishTurn?: (context: MapContext) => readonly TaskEvent[];
  /** The session is over: drops what the mapping kept for it. */
  readonly closeSession?: (sessionId: SessionId) => void;
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
};

/** A running session, as the base class hands it back. */
export type AgentSession = {
  readonly taskId: TaskId;
  readonly sessionId: SessionId;
  readonly agentSessionId: string;
  readonly connection: DriverConnection;
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

export abstract class AgentAdapter {
  readonly kind = "agent" as const;
  abstract readonly name: string;
  abstract readonly capabilities: AgentCapabilities;

  readonly #context: AdapterContext;
  readonly #driver: DriverPort;
  #plumbing: Plumbing | undefined;
  readonly #turns = new Map<string, TurnId>();
  readonly #emitters = new Map<string, (events: readonly TaskEvent[]) => void>();

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

  /** Connects to the agent's process and starts (or resumes) its session. */
  async startSession(input: StartSessionInput): Promise<AdapterResult<AgentSession>> {
    if (input.resumeAgentSessionId !== undefined && !this.capabilities.sessionLoad) {
      return adapterError("unsupported", `${this.name} can't resume its own sessions`);
    }
    const sessionKey = String(input.sessionId);
    this.#emitters.set(sessionKey, input.onEvents);
    const connected = await this.#driver.connect(input.io, {
      onUpdate: (_agentSessionId, update) => {
        const turnId = this.#turns.get(sessionKey);
        if (turnId === undefined) {
          return;
        }
        const context: MapContext = { taskId: input.taskId, sessionId: input.sessionId, turnId, cwd: input.cwd };
        const own = this.mapUpdate(update, context);
        const events = own.handled ? own.events : this.#driver.mapUpdate(own.update ?? update, context);
        if (events.length > 0) {
          input.onEvents(events);
        }
      },
      onPermission: input.onPermission,
      onQuestion: input.onQuestion,
    });
    if (!connected.ok) {
      this.#emitters.delete(sessionKey);
      return connected;
    }
    const connection = connected.value;
    if (input.resumeAgentSessionId !== undefined) {
      const loaded = await connection.loadSession({
        agentSessionId: input.resumeAgentSessionId,
        cwd: input.cwd,
        mcpServers: input.mcpServers,
      });
      return loaded.ok
        ? ok({ taskId: input.taskId, sessionId: input.sessionId, agentSessionId: input.resumeAgentSessionId, connection })
        : loaded;
    }
    const created = await connection.newSession({ cwd: input.cwd, mcpServers: input.mcpServers });
    return created.ok
      ? ok({ taskId: input.taskId, sessionId: input.sessionId, agentSessionId: created.value.agentSessionId, connection })
      : created;
  }

  /**
   * Runs one turn: the member's prompt, until the agent's stop reason. The turn's own events go out
   * through `onEvents` with the agent's: `turn.started` first, then what the mapping held back
   * (the open text segment, the context usage), then `turn.ended` with the stop reason, or
   * `turn.failed` when the agent couldn't finish. The caller writes `user.message` and numbers
   * the events; it doesn't write these (F-023).
   */
  async prompt(session: AgentSession, turnId: TurnId, text: string): Promise<AdapterResult<{ readonly stopReason: StopReason }>> {
    const key = String(session.sessionId);
    const emit = this.#emitters.get(key);
    this.#turns.set(key, turnId);
    emit?.([{ kind: "turn.started", turnId }]);
    const result = await session.connection.prompt(session.agentSessionId, text);
    const held = this.#driver.finishTurn?.({ taskId: session.taskId, sessionId: session.sessionId, turnId }) ?? [];
    emit?.([
      ...held,
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

  /** Ends the session's connection. */
  async close(session: AgentSession): Promise<void> {
    const key = String(session.sessionId);
    this.#turns.delete(key);
    this.#emitters.delete(key);
    this.#driver.closeSession?.(session.sessionId);
    await session.connection.close();
  }
}
