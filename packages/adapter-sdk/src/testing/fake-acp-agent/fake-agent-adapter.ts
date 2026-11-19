import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAcpDriver } from "../../agent/acp/driver.ts";
import { AgentAdapter } from "../../agent/base.ts";
import type {
  AgentCommand,
  AgentLaunch,
  DriverPort,
  ExportSessionInput,
  ImportSessionInput,
  MappedUpdate,
  PrepareLaunchInput,
} from "../../agent/base.ts";
import type { AgentCapabilities } from "../../agent/capabilities.ts";
import type { AdapterContext } from "../../common/context.ts";
import { ok } from "../../common/result.ts";
import type { AdapterResult, HealthReport } from "../../common/result.ts";
import { fakeAgentCapabilities } from "./agent.ts";
import type { FakeAgentProfile } from "./agent.ts";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));

/** The variables an agent needs to run at all, and no more (ADR 0030): none is a secret. */
const PASSTHROUGH = process.platform === "win32" ? ["PATH", "Path", "SystemRoot"] : ["PATH", "LANG"];

/**
 * The scripted fake ACP agent, run through ostra's driver like any agent (ADR 0032). It declares
 * what OpenCode lacks, native plan updates and reject-and-continue, with steering (`rich`), or none
 * of them (`plain`), so both composer paths stay tested.
 */
export class FakeAgentAdapter extends AgentAdapter {
  readonly name: string;
  readonly capabilities: AgentCapabilities;
  readonly #profile: FakeAgentProfile;

  constructor(profile: FakeAgentProfile, driver: DriverPort = createAcpDriver(), context?: AdapterContext) {
    super(driver, context);
    this.#profile = profile;
    this.name = `fake-acp-agent-${profile}`;
    const declared = fakeAgentCapabilities[profile];
    this.capabilities = {
      ...declared,
      elicitationForm: true,
      modelBaseUrlAndPlaceholderKey: true,
      sessionArchive: true,
    };
  }

  /** The agent's own folder for its sessions, in the box's agent folder. */
  static dataDirOf(agentDir: string): string {
    return path.join(agentDir, "fake-agent-data");
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

  prepareLaunch(input: PrepareLaunchInput): Promise<AdapterResult<AgentLaunch>> {
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
      ...input.extraEnv,
    });
    return Promise.resolve(
      ok({
        command: process.execPath,
        args: [MAIN, `--profile=${this.#profile}`],
        env,
        cwd: input.workspaceDir,
        files: [],
      }),
    );
  }

  protected mapUpdate(): MappedUpdate {
    return { handled: false };
  }
}
