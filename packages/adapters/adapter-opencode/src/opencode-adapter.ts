import path from "node:path";

import { adapterError, AgentAdapter, createAcpDriver, describeStandardPermission, ok } from "@ostra/adapter-sdk";
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
  PermissionRequest,
  PrepareLaunchInput,
} from "@ostra/adapter-sdk";
import { checkoutDirSchema, mcpSubjectValue } from "@ostra/protocol";
import type { ApprovalRequestSubject } from "@ostra/protocol";

import { ARCHIVE_VERIFIED_VERSIONS, OPENCODE_VERSION, resolveOpenCodeBinary } from "./binary.ts";
import type { OpenCodeBinary } from "./binary.ts";
import { buildAgentEnv, buildCliEnv, launchFiles, taskDirs } from "./config.ts";
import { OSTRA_MCP_SERVER } from "./permissions.ts";
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

/** A profile MCP server's name as OpenCode prefixes its tools with it (`<name>_<tool>`). */
const MCP_SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/** Whether `child` is inside `parent`, by their resolved paths. */
const isInside = (parent: string, child: string): boolean => {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

/** The launch's milestone 3 inputs, checked before any file is written (ADR 0049). */
const checkProfileInputs = (input: PrepareLaunchInput): string | null => {
  for (const skill of input.skills ?? []) {
    // A skill is read from the task's own agent folder, never from the repo or the runner's machine.
    if (!isAbsolutePath(skill.dir) || !isInside(input.agentDir, skill.dir)) {
      return "a skill's folder is outside the task's agent folder";
    }
  }
  const names = new Set<string>();
  for (const server of input.mcpServers ?? []) {
    if (!MCP_SERVER_NAME.test(server.name) || server.name === OSTRA_MCP_SERVER || names.has(server.name)) {
      return "an MCP server's name is not a plain name, is ostra's own, or is given twice";
    }
    names.add(server.name);
  }
  // A repo's skills are named by its checkout folder: one folder name inside the workspace.
  if ((input.repoDirs ?? []).some((dir) => !checkoutDirSchema.safeParse(dir).success)) {
    return "a repo's folder is not one folder name inside the workspace";
  }
  return null;
};

/**
 * The OpenCode adapter. **Native memory** (ADR 0044, Q91): OpenCode documents no memory feature of
 * its own (`context/research/project-memory.md`, section 8), so this adapter turns nothing off.
 * Project memory reaches it only as the launch's memory block, written into the task's instructions
 * file after the profile's instructions and before the repos' own `AGENTS.md`, and as ostra's
 * memory tools on the ostra MCP server its config already names.
 */
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
    // Milestone 3 (ADR 0049, ticket 08), each checked against OpenCode 2.3.2 (the README) and in the
    // agent contract suite: the rules are written into OpenCode's own permissions as "ask"; plan
    // first is OpenCode's plan agent, switched with `session/set_mode` and made read-only by the
    // config; skills are read from the folders the runner wrote; both MCP transports; and the
    // repo's own OpenCode config is never read (`OPENCODE_DISABLE_PROJECT_CONFIG`).
    permissionRules: "native",
    planMode: "session-mode",
    skills: true,
    mcp: { http: true, stdio: true },
    projectConfigOverride: true,
    // Milestone 4 (ADR 0044, ticket 07): OpenCode reaches ostra's MCP server, so it takes the memory
    // tools; the block goes into its instructions file (`instructionsText`). Native memory: OpenCode
    // has none of its own, so there is nothing to turn off.
    memory: "mcp",
  };

  /** The repo files OpenCode reads its project config from, hidden without `projectConfigOverride` (Q171). */
  override readonly repoConfigPaths: readonly string[] = ["opencode.json", "opencode.jsonc", ".opencode"];

  readonly #resolveBinary: () => Promise<AdapterResult<OpenCodeBinary>>;
  readonly #todos = new Map<string, TodoTracker>();
  /** The profile's MCP server names per workspace, so a tool's permission names its server (`describePermission`). */
  readonly #mcpServersByWorkspace = new Map<string, readonly string[]>();

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
    const refused = checkProfileInputs(input);
    if (refused !== null) {
      return adapterError("invalid-input", refused);
    }
    this.#mcpServersByWorkspace.set(path.resolve(input.workspaceDir), (input.mcpServers ?? []).map((server) => server.name));
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

  /**
   * What an OpenCode permission request touches (ADR 0049). Its edits, commands and fetches come in
   * ACP's standard kinds (the base's reading); an MCP tool comes as kind `other`, titled
   * `<server>_<tool>`, which names the profile's server. ostra's own tools, and every other request
   * (a skill, a question), touch nothing a rule watches.
   */
  protected override describePermission(request: PermissionRequest, cwd: string): ApprovalRequestSubject | null {
    const standard = describeStandardPermission(request, cwd);
    if (standard !== null || request.toolKind !== "other") {
      return standard;
    }
    const servers = this.#mcpServersByWorkspace.get(path.resolve(cwd)) ?? [];
    // The longest name first: a server `docs` and a server `docs-v2` are told apart.
    const server = [...servers].sort((a, b) => b.length - a.length).find((name) => request.title.startsWith(`${name}_`) && request.title.length > name.length + 1);
    return server === undefined ? null : { tool: "mcp", subject: { kind: "tool", value: mcpSubjectValue(server, request.title.slice(server.length + 1)) } };
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
