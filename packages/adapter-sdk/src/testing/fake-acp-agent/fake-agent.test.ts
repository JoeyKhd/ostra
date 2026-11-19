import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { turnIdSchema } from "@ostra/protocol";
import type { TaskEvent } from "@ostra/protocol";
import { fixtureIds } from "@ostra/protocol/testing";
import { afterAll, describe, expect, it } from "vitest";

import type { AgentSession } from "../../agent/base.ts";

import { defineAgentContractSuite } from "../agent-suite.ts";
import type { PrepareLaunchInput } from "../../agent/base.ts";
import type { AgentFixture } from "../agent-suite.ts";
import { spawnAgentProcess } from "../spawn-agent.ts";
import { fakeMarker } from "./agent.ts";
import type { FakeAgentProfile } from "./agent.ts";
import { FakeAgentAdapter } from "./fake-agent-adapter.ts";

// The agent contract suite, against the scripted fake ACP agent in both profiles, as a real child
// process through ostra's ACP driver (ticket 10).

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const fixtureFor = async (): Promise<AgentFixture> => {
  const root = await mkdtemp(path.join(tmpdir(), "ostra-fake-agent-"));
  roots.push(root);
  const workspaceDir = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(path.join(agentDir, "tmp"), { recursive: true });
  const base: PrepareLaunchInput = {
    taskId: fixtureIds.task,
    sessionId: fixtureIds.session,
    workspaceDir,
    agentDir,
    model: {
      endpointModelId: "stub-model",
      apiFormat: "openai-compatible",
      baseUrl: "http://127.0.0.1:9/key-proxy/v1",
      placeholderKey: "ostra-fake-key-for-this-task",
    },
    mcp: { url: "http://127.0.0.1:9/mcp" },
    instructions: null,
    extraEnv: { NODE_ENV: "test" },
  };
  return {
    launchInput: base,
    secrets: ["the-real-model-token", "the-real-git-token", "ghs_realtokenvalue0123456789"],
    start: spawnAgentProcess,
    simplePrompt: fakeMarker("say"),
    longPrompt: fakeMarker("silent"),
    probes: {
      tools: fakeMarker("tools"),
      permission: fakeMarker("permission"),
      question: fakeMarker("elicit"),
      unknownUpdate: fakeMarker("unknown"),
      environment: {
        prompt: fakeMarker("env"),
        // PATH and SystemRoot to run at all; the task's own folders; the fake key and base URL.
        allowedNames: [
          "PATH",
          "Path",
          "SystemRoot",
          "LANG",
          "HOME",
          "USERPROFILE",
          "TEMP",
          "TMP",
          "FAKE_AGENT_DATA",
          "FAKE_AGENT_BASE_URL",
          "FAKE_AGENT_API_KEY",
          "NODE_ENV",
          // Windows adds these to every process it starts, from the ones above.
          "HOMEDRIVE",
          "HOMEPATH",
          "LOGONSERVER",
          "SYSTEMDRIVE",
          "USERDOMAIN",
          "USERNAME",
          "WINDIR",
        ],
      },
      endpoint: fakeMarker("endpoint"),
      plan: fakeMarker("plan"),
      leftoverProcess: fakeMarker("spawn"),
      steerable: fakeMarker("steerable"),
    },
    archive: {
      run: async (command) => {
        const child = spawn(command.command, [...command.args], { cwd: command.cwd, env: { ...command.env }, stdio: "ignore", windowsHide: true });
        const code = await new Promise<number | null>((resolve) => {
          child.on("error", () => {
            resolve(null);
          });
          child.on("close", (exit) => {
            resolve(exit);
          });
        });
        return { code };
      },
      freshBox: async () => {
        const fresh = path.join(root, `fresh-${String(Date.now())}`);
        const freshWorkspace = path.join(fresh, "workspace");
        const freshAgent = path.join(fresh, "agent");
        await mkdir(freshWorkspace, { recursive: true });
        await mkdir(path.join(freshAgent, "tmp"), { recursive: true });
        return { ...base, workspaceDir: freshWorkspace, agentDir: freshAgent };
      },
      archivePath: path.join(root, "session-archive.json"),
      remember: { prompt: fakeMarker("remember", "BLUE-HERON"), recall: fakeMarker("recall"), fact: "BLUE-HERON" },
    },
  };
};

for (const profile of ["rich", "plain"] as const satisfies readonly FakeAgentProfile[]) {
  defineAgentContractSuite({
    name: `the scripted fake ACP agent, ${profile} profile`,
    create: async () => ({ adapter: new FakeAgentAdapter(profile), fixture: await fixtureFor() }),
  });
}

// F-019: the fakes stand for what OpenCode lacks. `rich` declares native plan updates and
// reject-and-continue, and both happen; `plain` declares neither, and can't be steered.

const turnOf = (n: number) => turnIdSchema.parse(`fake-f019-turn-${String(n)}`);

const runFake = async (
  profile: FakeAgentProfile,
  body: (adapter: FakeAgentAdapter, session: AgentSession, events: TaskEvent[]) => Promise<void>,
): Promise<void> => {
  const fixture = await fixtureFor();
  const adapter = new FakeAgentAdapter(profile);
  const launch = await adapter.prepareLaunch(fixture.launchInput);
  if (!launch.ok) throw new Error(launch.error.message);
  const started = await spawnAgentProcess(launch.value);
  const events: TaskEvent[] = [];
  const session = await adapter.startSession({
    taskId: fixture.launchInput.taskId,
    sessionId: fixture.launchInput.sessionId,
    io: started.io,
    cwd: fixture.launchInput.workspaceDir,
    mcpServers: [],
    onEvents: (batch) => {
      events.push(...batch);
    },
    onPermission: (_sessionId, request) => {
      const reject = request.options.find((option) => option.kind === "reject_once");
      return Promise.resolve(reject === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId: reject.optionId });
    },
    onQuestion: () => Promise.resolve({ outcome: "cancelled" }),
  });
  try {
    if (!session.ok) throw new Error(session.error.message);
    await body(adapter, session.value, events);
    await adapter.close(session.value);
  } finally {
    await started.stop();
  }
};

describe("the fake ACP agents, for the capabilities OpenCode lacks (F-019)", () => {
  it("F-019: the rich fake declares native plan updates and reject-and-continue, which OpenCode lacks, and both reach ostra", async () => {
    await runFake("rich", async (adapter, session, events) => {
      expect(adapter.capabilities).toMatchObject({ nativePlan: true, rejectAndContinue: true, steerMidTurn: true });
      expect(await adapter.prompt(session, turnOf(1), fakeMarker("plan"))).toEqual({ ok: true, value: { stopReason: "end_turn" } });
      expect(events.filter((event) => event.kind === "plan.updated")).toHaveLength(1);
      // A deny, and the agent carries on in the same turn.
      expect(await adapter.prompt(session, turnOf(2), fakeMarker("permission"))).toEqual({ ok: true, value: { stopReason: "end_turn" } });
      expect(events.some((event) => event.kind === "tool.failed")).toBe(true);
    });
  }, 60_000);

  it("F-019: the plain fake declares neither and can't steer: no plan update, a deny ends the turn, and a steer is refused", async () => {
    await runFake("plain", async (adapter, session, events) => {
      expect(adapter.capabilities).toMatchObject({ nativePlan: false, rejectAndContinue: false, steerMidTurn: false });
      expect(session.connection.steeringAdvertised).toBe(false);
      expect(await adapter.prompt(session, turnOf(1), fakeMarker("plan"))).toEqual({ ok: true, value: { stopReason: "end_turn" } });
      expect(events.some((event) => event.kind === "plan.updated")).toBe(false);
      expect(await adapter.prompt(session, turnOf(2), fakeMarker("permission"))).toEqual({ ok: true, value: { stopReason: "cancelled" } });
      // The deny ended the turn; the next prompt goes on (the re-prompt ADR 0032 describes).
      expect(await adapter.prompt(session, turnOf(3), fakeMarker("say"))).toEqual({ ok: true, value: { stopReason: "end_turn" } });
      expect(await adapter.steer(session, "use tabs")).toMatchObject({ ok: false, error: { code: "unsupported" } });
    });
  }, 60_000);
});
