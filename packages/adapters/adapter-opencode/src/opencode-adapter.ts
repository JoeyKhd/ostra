import { adapterError, AgentAdapter, createAcpDriver, ok } from "@ostra/adapter-sdk";
import type {
  AcpUpdate,
  AdapterContext,
  AdapterResult,
  AgentCapabilities,
  AgentLaunch,
  DriverPort,
  HealthReport,
  MapContext,
  MappedUpdate,
  PrepareLaunchInput,
} from "@ostra/adapter-sdk";

import { resolveOpenCodeBinary } from "./binary.ts";
import type { OpenCodeBinary } from "./binary.ts";
import { buildAgentEnv, launchFiles, taskDirs } from "./config.ts";
import { createTodoTracker } from "./todo-plan.ts";
import type { TodoTracker } from "./todo-plan.ts";

// The OpenCode agent adapter (ADR 0032, F-019): OpenCode over ostra's ACP driver, with a per-task
// config, a pinned and checksummed binary, and an allowlisted environment. It writes only what is
// particular to OpenCode: how to launch it, and its todo list as a plan.

export type OpenCodeAdapterOptions = {
  /** The ACP driver. Default: ostra's own. */
  readonly driver?: DriverPort;
  /** Finds the binary. Default: the pinned `@opencode/cli`, checked against its SHA-256. */
  readonly resolveBinary?: () => Promise<AdapterResult<OpenCodeBinary>>;
};

export class OpenCodeAdapter extends AgentAdapter {
  readonly name = "opencode";
  readonly capabilities: AgentCapabilities = {
    // The extension is declared; a session uses it only when `initialize` says `_meta.steering.supported`
    // (the base class checks both, ADR 0032). The steer probe runs on every OpenCode bump.
    steerMidTurn: true,
    sessionLoad: true,
    // OpenCode sends no `plan` update: its todo list is mapped to `plan.updated` from `todowrite`.
    nativePlan: false,
    // A reject ends the turn `cancelled`, and the runner re-prompts (ADR 0032).
    rejectAndContinue: false,
    elicitationForm: true,
    modelBaseUrlAndPlaceholderKey: true,
  };

  readonly #resolveBinary: () => Promise<AdapterResult<OpenCodeBinary>>;
  readonly #todos = new Map<string, TodoTracker>();

  constructor(options: OpenCodeAdapterOptions = {}, context?: AdapterContext) {
    super(options.driver ?? createAcpDriver(), context);
    this.#resolveBinary = options.resolveBinary ?? (() => resolveOpenCodeBinary());
  }

  async health(): Promise<HealthReport> {
    const binary = await this.#resolveBinary();
    return binary.ok ? { status: "ok" } : { status: "down", reason: binary.error.message };
  }

  async prepareLaunch(input: PrepareLaunchInput): Promise<AdapterResult<AgentLaunch>> {
    const binary = await this.#resolveBinary();
    if (!binary.ok) {
      this.plumbing.logger.error("opencode.binary.refused", { code: binary.error.code });
      return binary;
    }
    const dirs = taskDirs(input.agentDir);
    if (input.model.baseUrl === "" || input.model.placeholderKey === "") {
      return adapterError("invalid-input", "OpenCode needs the model base URL and the task's key");
    }
    return ok({
      command: binary.value.path,
      // `opencode acp` speaks ACP on its stdio (ADR 0018).
      args: ["acp"],
      env: buildAgentEnv(input, dirs),
      cwd: input.workspaceDir,
      files: launchFiles(input, dirs),
    });
  }

  protected mapUpdate(update: AcpUpdate, context: MapContext): MappedUpdate {
    const key = String(context.sessionId);
    let tracker = this.#todos.get(key);
    if (tracker === undefined) {
      tracker = createTodoTracker();
      this.#todos.set(key, tracker);
    }
    const outcome = tracker.read(update);
    switch (outcome.kind) {
      case "other":
        return { handled: false };
      case "swallow":
        return { handled: true, events: [] };
      case "plan":
        return { handled: false, update: outcome.update };
      default:
        return outcome satisfies never;
    }
  }
}
