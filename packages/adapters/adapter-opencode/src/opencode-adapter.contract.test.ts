import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createScenarioBrain, defineAgentContractSuite, spawnAgentProcess, startStubModelServer, stubMarker } from "@ostra/adapter-sdk/testing";
import type { AgentFixture, StubServer } from "@ostra/adapter-sdk/testing";
import type { ApiFormat } from "@ostra/protocol";
import { fixtureIds } from "@ostra/protocol/testing";
import { afterAll, describe } from "vitest";

import { OpenCodeAdapter } from "./opencode-adapter.ts";
import { scenarios } from "./stub-scenarios.ts";

// The agent contract suite against the real OpenCode binary, once per API format, with a stub
// model standing where the key proxy would. The stub takes the task's own key.

const TASK_KEY = "ostra-fake-key-for-this-task";
const MODEL = "stub-model";

const roots: string[] = [];
const servers: StubServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const fixtureFor = async (format: ApiFormat): Promise<AgentFixture> => {
  const stub = await startStubModelServer({
    format,
    realKey: TASK_KEY,
    models: [MODEL],
    brain: createScenarioBrain(scenarios),
  });
  servers.push(stub);
  const root = await mkdtemp(path.join(tmpdir(), "ostra-opencode-"));
  roots.push(root);
  const workspaceDir = path.join(root, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(path.join(workspaceDir, "README.md"), "hello\n", "utf8");
  return {
    launchInput: {
      taskId: fixtureIds.task,
      sessionId: fixtureIds.session,
      workspaceDir,
      agentDir: path.join(root, "agent"),
      model: { endpointModelId: MODEL, apiFormat: format, baseUrl: stub.baseUrl, placeholderKey: TASK_KEY },
      mcp: { url: "http://127.0.0.1:9/mcp" },
      instructions: null,
      extraEnv: {},
    },
    secrets: ["the-real-model-token", "the-real-git-token", "ghs_realtokenvalue0123456789"],
    start: spawnAgentProcess,
    simplePrompt: `${stubMarker("hello")} say hello`,
    longPrompt: `${stubMarker("long")} wait`,
    probes: {
      tools: { prompt: `${stubMarker("tools")} work`, kinds: ["read", "edit", "execute"], expectFailure: true },
      // OpenCode plans through its todo tool, without declaring a native plan.
      plan: { prompt: `${stubMarker("todo")} plan`, expectPlan: true },
      steerable: {
        prompt: `${stubMarker("steer")} wait`,
        waitFor: "never appears",
        steerText: "STEER-TOKEN: also mention the colour blue",
        expectMessage: "steer seen mid-turn",
      },
    },
  };
};

describe.each(["openai-compatible", "anthropic-messages"] as const)("OpenCode, %s stub", (format) => {
  defineAgentContractSuite({
    name: `opencode against a ${format} stub`,
    create: async () => ({ adapter: new OpenCodeAdapter(), fixture: await fixtureFor(format) }),
  });
});
