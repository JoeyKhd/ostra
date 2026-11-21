import { createScenarioBrain, stubMarker } from "@ostra/adapter-sdk/testing";
import type { Scenario } from "@ostra/adapter-sdk/testing";
import { ONE_ORIGIN_RULE } from "@ostra/protocol";
import type { OstraToolSet, TaskSpecAppProcess } from "@ostra/protocol";
import { appProcessesFixture, taskSpecFixture } from "@ostra/protocol/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Harness, Shared } from "../testing/task-host-harness.ts";
import { defaultAgents } from "./agents.ts";

// The app's block (F-140, ADR 0068, milestone 8's ticket 14) on the agent the runner ships: the real,
// pinned OpenCode on the host executor, with a scripted stub model behind the real key proxy. A
// task whose environment declares app processes reaches the model with each process's label and
// in-box address, the one-origin rule and where the logs are; one without gets no block. A host
// runner runs no services (ADR 0029), so its block names none.

const LF = String.fromCharCode(10);

/** The model's view: its system prompt, as OpenCode gave it, said back. */
const sayInstructions: Scenario = ({ step, request }) =>
  step === 0 ? { text: `instructions: ${request.messages.flatMap((message) => (message.role === "system" ? [message.text] : [])).join(LF)}` } : undefined;

let shared: Shared;
let harness: Harness | undefined;

beforeAll(async () => {
  shared = await startShared("app-block-opencode", { brain: createScenarioBrain({ "say-instructions": sayInstructions }) });
}, 60_000);

afterAll(async () => {
  await shared.close();
}, 60_000);

afterEach(async () => {
  await harness?.close();
  harness = undefined;
}, 60_000);

const appSets: readonly OstraToolSet[] = ["pr-text", "memory", "app"];

/** A task on OpenCode with the environment's app processes given, run to its first saved session: what the model was told. */
const run = async (appProcesses: readonly TaskSpecAppProcess[]): Promise<string> => {
  harness = await startHarness(shared, { agents: defaultAgents() });
  const h = harness;
  const made = h.taskFor(`${stubMarker("say-instructions")} Say them.`, {
    agent: { ...taskSpecFixture.agent, adapter: "opencode", apiFormat: "anthropic-messages", endpointModelId: "stub-model", instructions: "PROFILE-MARKER: keep commits small." },
    environment: { ...taskSpecFixture.environment, setupScript: null, appProcesses: [...appProcesses] },
    tools: [...appSets],
  });
  h.dispatch(made.spec);
  await h.waitForKind(made.spec, "session.saved", 1, 150_000);
  return h.ofKind(made.spec, "agent.message").map((event) => event.text).join(" ");
};

describe("the app's block on OpenCode, with the stub model (F-140)", () => {
  it("F-140/c10: a task whose environment declares app processes reaches OpenCode with each one's label and in-box address, the one-origin rule and the logs, after the profile's instructions", async () => {
    const said = await run(appProcessesFixture);
    expect(said).toContain("PROFILE-MARKER: keep commits small.");
    expect(said).toContain("## The app");
    expect(said).toContain(`- "Web" (web, the primary preview): http://localhost:5173, also in OSTRA_APP_WEB_URL`);
    expect(said).toContain(`- "API" (api): http://localhost:3001, also in OSTRA_APP_API_URL`);
    expect(said).toContain(`- "Docs" (docs): http://localhost:4000, also in OSTRA_APP_DOCS_URL`);
    expect(said).toContain(ONE_ORIGIN_RULE);
    expect(said).toContain(".ostra/app/<name>.log");
    expect(said).toContain("start_app");
    expect(said.indexOf("PROFILE-MARKER")).toBeLessThan(said.indexOf("## The app"));
    // A host runner runs no services: none is named.
    expect(said).not.toContain("Services:");
    // A process's command is the project's own line: it never reaches the instructions.
    for (const process of appProcessesFixture) {
      expect(said).not.toContain(process.command);
    }
  }, 300_000);

  it("F-140/c10: a task whose environment declares no app process gets no block", async () => {
    const said = await run([]);
    expect(said).toContain("PROFILE-MARKER: keep commits small.");
    expect(said).not.toContain("## The app");
    expect(said).not.toContain(ONE_ORIGIN_RULE);
  }, 300_000);
});
