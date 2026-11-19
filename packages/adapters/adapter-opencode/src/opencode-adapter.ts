import path from "node:path";

import { adapterError, AgentAdapter, createAcpDriver, ok } from "@ostra/adapter-sdk";
import type {
  AcpUpdate,
  AdapterContext,
  AdapterResult,
  AgentCapabilities,
  AgentCommand,
  AgentLaunch,
  DriverPort,
  ExportSessionInput,
  HealthReport,
  ImportSessionInput,
  MapContext,
  MappedUpdate,
  PrepareLaunchInput,
} from "@ostra/adapter-sdk";

import { ARCHIVE_VERIFIED_VERSIONS, OPENCODE_VERSION, resolveOpenCodeBinary } from "./binary.ts";
import type { OpenCodeBinary } from "./binary.ts";
import { buildAgentEnv, buildCliEnv, launchFiles, taskDirs } from "./config.ts";
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

/** An agent session ID is OpenCode's own (`ses_…`): never one that a flag could be mistaken for. */
const AGENT_SESSION_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

const isAbsolutePath = (value: string): boolean => path.posix.isAbsolute(value) || path.win32.isAbsolute(value);

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
    // `opencode session export` and `import --directory` (ticket 10). Only for a version whose archive
    // ostra has run (ADR 0039, spike 2): another pinned version reads false until the agent suite has
    // passed on it, and reopening then uses the rebuild template.
    sessionArchive: ARCHIVE_VERIFIED_VERSIONS.includes(OPENCODE_VERSION),
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

  // The archive commands run beside the live agent, in its box, with the task's own folders and no
  // credential: an argument array and an allowlisted environment, never a shell line. `--standalone`
  // gives the one command a private server, so OpenCode's background service never starts (spike 1).

  override async exportSession(input: ExportSessionInput): Promise<AdapterResult<AgentCommand>> {
    const checked = await this.#archiveCommand(input.agentSessionId, [input.workspaceDir, input.agentDir, input.archivePath]);
    if (!checked.ok) {
      return checked;
    }
    return ok({
      command: checked.value.path,
      // `session export` prints the archive; the executor wires its stdout to the file.
      args: ["session", "export", input.agentSessionId, "--standalone"],
      env: buildCliEnv(taskDirs(input.agentDir)),
      cwd: input.workspaceDir,
      stdoutTo: input.archivePath,
    });
  }

  override async importSession(input: ImportSessionInput): Promise<AdapterResult<AgentCommand>> {
    const checked = await this.#archiveCommand(input.agentSessionId, [input.workspaceDir, input.agentDir, input.archivePath]);
    if (!checked.ok) {
      return checked;
    }
    return ok({
      command: checked.value.path,
      // Always `--directory`: the archive names the old box's absolute path, and a session loads only in
      // the directory it is bound to (spike 2, surprise 5).
      args: ["session", "import", input.archivePath, "--standalone", "--directory", input.workspaceDir],
      env: buildCliEnv(taskDirs(input.agentDir)),
      cwd: input.workspaceDir,
    });
  }

  /** The binary and the inputs of an archive command, checked before any command is named. */
  async #archiveCommand(agentSessionId: string, paths: readonly string[]): Promise<AdapterResult<OpenCodeBinary>> {
    if (!AGENT_SESSION_ID.test(agentSessionId)) {
      return adapterError("invalid-input", "an OpenCode session ID is letters, digits, `_`, `-` and `.`, and does not start with a dash");
    }
    if (paths.some((value) => !isAbsolutePath(value) || value.includes("\u0000"))) {
      return adapterError("invalid-input", "the folders and the archive of a session move are absolute paths");
    }
    const binary = await this.#resolveBinary();
    if (!binary.ok) {
      this.plumbing.logger.error("opencode.binary.refused", { code: binary.error.code });
      return binary;
    }
    if (!ARCHIVE_VERIFIED_VERSIONS.includes(binary.value.packageVersion)) {
      return adapterError("unsupported", `OpenCode ${binary.value.packageVersion} has not passed ostra's session archive checks`);
    }
    return binary;
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
