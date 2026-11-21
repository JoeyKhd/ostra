import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { mcpSubjectValue } from "@ostra/protocol";
import type { ApprovalRequestSubject } from "@ostra/protocol";

import { createAcpDriver } from "../../agent/acp/driver.ts";
import { AgentAdapter, composeLaunchInstructions, effortModelOf, launchHasAppTools, orderedEffortLevels } from "../../agent/base.ts";
import type {
  AgentCommand,
  AgentLaunch,
  DriverPort,
  EffortModel,
  ExportSessionInput,
  ImportSessionInput,
  MappedUpdate,
  PermissionRequest,
  PrepareLaunchInput,
} from "../../agent/base.ts";
import type { AgentCapabilities } from "../../agent/capabilities.ts";
import type { AdapterContext } from "../../common/context.ts";
import { adapterError, ok } from "../../common/result.ts";
import type { AdapterResult, HealthReport } from "../../common/result.ts";
import { FAKE_AGENT_REPO_CONFIG, FAKE_AGENT_UNKNOWN_NOTIFICATION_ENV, fakeAgentCapabilities } from "./agent.ts";
import type { FakeAgentConfig, FakeAgentProfile } from "./agent.ts";
import type { EffortLevel } from "@ostra/protocol";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));

/** The variables an agent needs to run at all, and no more (ADR 0030): none is a secret. */
const PASSTHROUGH = process.platform === "win32" ? ["PATH", "Path", "SystemRoot"] : ["PATH", "LANG"];

/** Milestone 4 (ticket 02): how a fake takes memory. `index-only` is the third fake: no ostra MCP server. */
export type FakeAgentMemory = "mcp" | "index-only";

/**
 * Milestone 4 (F-137, ADR 0066): how a fake takes a reasoning level. The existing fakes declare
 * `none`; `session-option` advertises a `thought_level` option (its ID is `reasoning`, not
 * OpenCode's `effort`) with the model's levels, and records each value set on it.
 */
export type FakeAgentEffort = "session-option" | "none";

/**
 * Milestone 7 (ticket 03): what a fake adds for the parity cases. `unknownNotification` sends a
 * notification no client knows after `initialize`. `pinnedSha256` is the checksum its program
 * must have, as OpenCode's binary has one: a mismatch refuses the launch.
 */
export type FakeAgentParity = {
  readonly unknownNotification?: boolean;
  readonly pinnedSha256?: string;
  /**
   * Milestone 8 (ticket 03): a fake without MCP at all, no server of the profile's or ostra's: it
   * gets no app tools, and its task's pictures are the ones ostra takes after each turn.
   */
  readonly noMcp?: boolean;
};

/** The SHA-256 of the fake's program, as a pin would name it. */
export const fakeAgentProgramSha256 = async (): Promise<string> => createHash("sha256").update(await readFile(MAIN)).digest("hex");

/**
 * The scripted fake ACP agent, run through ostra's driver like any agent (ADR 0032). It declares
 * what OpenCode lacks, native plan updates and reject-and-continue, with steering (`rich`), or none
 * of them (`plain`), so both composer paths stay tested.
 *
 * Milestone 4: both take ostra's memory tools over MCP (`memory: "mcp"`); a third fake,
 * `new FakeAgentAdapter("plain", driver, context, "index-only")`, lists no ostra MCP server in its
 * config whatever the spec offers, and gets the memory block alone (the profile's own MCP servers still reach it). **Native memory:** the fake agent has none, so there's
 * nothing to turn off (ADR 0044): it keeps only its sessions, in the task's agent folder.
 */
export class FakeAgentAdapter extends AgentAdapter {
  readonly name: string;
  readonly capabilities: AgentCapabilities;
  override readonly repoConfigPaths: readonly string[] = [FAKE_AGENT_REPO_CONFIG];
  readonly #profile: FakeAgentProfile;
  readonly #parity: FakeAgentParity;

  constructor(
    profile: FakeAgentProfile,
    driver: DriverPort = createAcpDriver(),
    context?: AdapterContext,
    memory: FakeAgentMemory = "mcp",
    effort: FakeAgentEffort = "none",
    parity: FakeAgentParity = {},
  ) {
    super(driver, context);
    this.#profile = profile;
    this.#parity = parity;
    this.name = `fake-acp-agent-${profile}${memory === "mcp" ? "" : "-index-only"}${effort === "none" ? "" : "-effort"}${parity.unknownNotification === true ? "-unknown-notification" : ""}${parity.noMcp === true ? "-no-mcp" : ""}`;
    const declared = fakeAgentCapabilities[profile];
    this.capabilities = {
      ...declared,
      elicitationForm: true,
      modelBaseUrlAndPlaceholderKey: true,
      sessionArchive: true,
      memory,
      reasoningEffort: effort,
      ...(parity.noMcp === true ? { mcp: { http: false, stdio: false } } : {}),
    };
  }

  /**
   * The fake's levels (F-137): a `none` fake has `default` alone. A `session-option` one offers the
   * model's effort list, or `none` and `on` for a toggle; a budget alone it can't send.
   */
  effortLevels(model: EffortModel): readonly EffortLevel[] {
    const { reasoning } = model;
    if (this.capabilities.reasoningEffort === "none" || !reasoning.supported) {
      return ["default"];
    }
    return orderedEffortLevels([...(reasoning.effort ?? []), ...(reasoning.toggle === true ? (["none", "on"] as const) : [])]);
  }

  /** The agent's own folder for its sessions, in the box's agent folder. */
  static dataDirOf(agentDir: string): string {
    return path.join(agentDir, "fake-agent-data");
  }

  /** Milestone 3: the task config the agent reads, in the box's agent folder: never in the repo. */
  static configPathOf(agentDir: string): string {
    return path.join(agentDir, "fake-agent-config.json");
  }

  /**
   * The profile's side as the agent reads it (ADR 0049): the mode, the rules (which only a `native`
   * agent uses), the skills as a folder or, without `skills`, as instructions, and the MCP servers
   * the agent can speak. An HTTP server's URL is the sidecar's: no credential is in it.
   */
  #config(input: PrepareLaunchInput): FakeAgentConfig {
    const skills = input.skills ?? [];
    const skillLines = this.capabilities.skills ? [] : skills.map((skill) => `Skill ${skill.name}: read ${path.join(skill.dir, "SKILL.md")}`);
    // Milestone 4: the profile's instructions, the repos side by side and the memory block, in this config file.
    // Milestone 8: the app tools ride ostra's MCP server, which only a fake with memory over MCP lists.
    const appTools = this.capabilities.memory === "mcp" && (this.capabilities.mcp.http || this.capabilities.mcp.stdio) && launchHasAppTools(input);
    const instructions = [composeLaunchInstructions(input, { appTools }) ?? "", ...skillLines].filter((line) => line !== "").join("\n");
    const mcpServers = (input.mcpServers ?? []).filter((server) =>
      server.transport === "http" ? this.capabilities.mcp.http : this.capabilities.mcp.stdio,
    );
    const memoryTools = this.capabilities.memory === "mcp" && input.memory?.tools === true;
    return {
      mode: input.mode ?? "build",
      approvalRules: input.approvalRules ?? [],
      ...(this.capabilities.skills ? { skills: skills.map((skill) => ({ name: skill.name, dir: skill.dir })) } : {}),
      instructions: instructions === "" ? null : instructions,
      mcpServers: mcpServers.map((server) => ({ name: server.name, transport: server.transport, readOnly: server.readOnly })),
      ...(memoryTools || appTools ? { ostraMcp: { url: input.mcp.url, ...(input.mcp.bearer === undefined ? {} : { bearer: input.mcp.bearer }) } } : {}),
      // Milestone 4 (F-137): the values its `thought_level` option advertises, from the model's controls.
      effortValues: this.#effortValues(input),
    };
  }

  #effortValues(input: PrepareLaunchInput): string[] {
    const model = effortModelOf(input.model);
    return this.effortLevels(model)
      .filter((level) => level !== "default")
      .map((level) => this.effortValue(level, model));
  }

  /** An MCP call is a tool call of kind `other` naming its server and tool; the rest are ACP's standard kinds. */
  protected override describePermission(request: PermissionRequest, cwd: string): ApprovalRequestSubject | null {
    const input = request.rawInput;
    if (request.toolKind === "other" && typeof input === "object" && input !== null) {
      const server: unknown = Reflect.get(input, "mcpServer");
      const tool: unknown = Reflect.get(input, "tool");
      if (typeof server === "string" && typeof tool === "string") {
        return { tool: "mcp", subject: { kind: "tool", value: mcpSubjectValue(server, tool) } };
      }
    }
    return super.describePermission(request, cwd);
  }

  #baseEnv(agentDir: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of PASSTHROUGH) {
      const value = process.env[name];
      if (value !== undefined) {
        env[name] = value;
      }
    }
    return { ...env, HOME: agentDir, USERPROFILE: agentDir, FAKE_AGENT_DATA: FakeAgentAdapter.dataDirOf(agentDir) };
  }

  override exportSession(input: ExportSessionInput): Promise<AdapterResult<AgentCommand>> {
    return Promise.resolve(ok({
      command: process.execPath,
      args: [MAIN, "export", `--session=${input.agentSessionId}`, `--out=${input.archivePath}`],
      env: this.#baseEnv(input.agentDir),
      cwd: input.workspaceDir,
    }));
  }

  override importSession(input: ImportSessionInput): Promise<AdapterResult<AgentCommand>> {
    return Promise.resolve(ok({
      command: process.execPath,
      args: [MAIN, "import", `--in=${input.archivePath}`, `--directory=${input.workspaceDir}`],
      env: this.#baseEnv(input.agentDir),
      cwd: input.workspaceDir,
    }));
  }

  health(): Promise<HealthReport> {
    return Promise.resolve({ status: "ok" });
  }

  async prepareLaunch(input: PrepareLaunchInput): Promise<AdapterResult<AgentLaunch>> {
    if (this.#parity.pinnedSha256 !== undefined && (await fakeAgentProgramSha256()) !== this.#parity.pinnedSha256) {
      return adapterError("conflict", "the fake agent's program does not match its pinned SHA-256: it is not started");
    }
    const env: Record<string, string> = {};
    for (const name of PASSTHROUGH) {
      const value = process.env[name];
      if (value !== undefined) {
        env[name] = value;
      }
    }
    Object.assign(env, {
      HOME: input.agentDir,
      USERPROFILE: input.agentDir,
      TEMP: path.join(input.agentDir, "tmp"),
      TMP: path.join(input.agentDir, "tmp"),
      FAKE_AGENT_DATA: FakeAgentAdapter.dataDirOf(input.agentDir),
      FAKE_AGENT_BASE_URL: input.model.baseUrl,
      FAKE_AGENT_API_KEY: input.model.placeholderKey,
      FAKE_AGENT_CONFIG: FakeAgentAdapter.configPathOf(input.agentDir),
      ...(this.#parity.unknownNotification === true ? { [FAKE_AGENT_UNKNOWN_NOTIFICATION_ENV]: "1" } : {}),
      ...input.extraEnv,
    });
    return ok({
      command: process.execPath,
      args: [MAIN, `--profile=${this.#profile}`],
      env,
      cwd: input.workspaceDir,
      files: [{ path: FakeAgentAdapter.configPathOf(input.agentDir), content: JSON.stringify(this.#config(input)) }],
    });
  }

  protected mapUpdate(): MappedUpdate {
    return { handled: false };
  }
}
