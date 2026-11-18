import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { fixtureIds } from "@ostra/protocol/testing";
import { afterAll } from "vitest";

import { defineAgentContractSuite } from "../agent-suite.ts";
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
  return {
    launchInput: {
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
    },
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
  };
};

for (const profile of ["rich", "plain"] as const satisfies readonly FakeAgentProfile[]) {
  defineAgentContractSuite({
    name: `the scripted fake ACP agent, ${profile} profile`,
    create: async () => ({ adapter: new FakeAgentAdapter(profile), fixture: await fixtureFor() }),
  });
}
