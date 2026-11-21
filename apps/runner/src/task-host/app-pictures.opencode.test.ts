import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { baseEnv, localShellProbe, machineBrowserSource, resolveMachineBrowser, resolveSetupShell } from "@ostra/adapter-executor-host";
import { createScenarioBrain, fakeBrowserProgram, stubMarker } from "@ostra/adapter-sdk/testing";
import type { Scenario } from "@ostra/adapter-sdk/testing";
import { APP_SCREENSHOT_CONTENT_TYPE, TAKE_SCREENSHOT_TOOL } from "@ostra/protocol";
import type { TaskSpecAppProcess } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pngSize } from "../browser/pictures.ts";
import { liveBrowser } from "../testing/app-pictures-cases.ts";
import { startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Harness, Shared } from "../testing/task-host-harness.ts";
import { defaultAgents } from "./agents.ts";

// Milestone 8's ticket 13 (F-121) on the agent the runner ships: the real, pinned OpenCode on the
// host executor, with a scripted stub model behind the real key proxy, calls `take_screenshot` on
// ostra's own MCP server in the task host; the runner starts the docs page from the `test-web`
// fixture, takes it in this machine's browser (the fake box browser on a Linux CI machine), uploads
// it as a blob of the task and sends `attachment.added`; and the tool's answer, the attachment's
// ID, reaches the model and so the agent's message. The model is offered `ostra_take_screenshot`
// by its name, as OpenCode's config asks (`codemode: false`), never only behind Code Mode's
// `execute`, which it was while the ACP session named ostra's server a second time.

const FIXTURE = path.resolve(fileURLToPath(new URL("../../../../e2e/m8-previews-and-library/fixtures/test-web/", import.meta.url)));
const CAPTION = "The docs page, as the agent saw it.";

/**
 * Calls ostra's `take_screenshot` on the docs page by its name, then quotes its answer. Offered by
 * name only, never behind Code Mode's `execute`: a model that isn't offered it says which tools it was.
 */
const takeIt: Scenario = ({ step, lastToolResults, request }) => {
  if (step === 0 && !request.toolNames.includes(`ostra_${TAKE_SCREENSHOT_TOOL}`)) {
    return { text: `not offered; the tools were ${request.toolNames.join(", ")}` };
  }
  if (step === 0) {
    return { toolCalls: [{ name: `ostra_${TAKE_SCREENSHOT_TOOL}`, arguments: { target: { process: "docs" }, caption: CAPTION } }] };
  }
  return step === 1 ? { text: `answered: ${lastToolResults.map((result) => result.text).join(" | ")}` } : undefined;
};

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "localhost", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });

let shared: Shared;
let harness: Harness | undefined;

beforeAll(async () => {
  shared = await startShared("app-pictures-opencode", { brain: createScenarioBrain({ "take-it": takeIt }) });
}, 60_000);

afterAll(async () => {
  await shared.close();
}, 60_000);

afterEach(async () => {
  await harness?.close();
  harness = undefined;
}, 60_000);

describe(`take_screenshot from OpenCode, with the stub model (${liveBrowser ? "the machine's browser" : "the fake browser"})`, () => {
  it("F-121/c1,c4,c8: OpenCode is offered take_screenshot by its name, and its call reaches ostra's MCP server, which starts the app's process, takes it in the box's browser as a blob of the task, and answers the attachment's ID to the agent", async () => {
    const dataDir = path.join(shared.root, "runner-opencode");
    const resolved = await resolveSetupShell("bash", localShellProbe(baseEnv(), shared.root));
    const browser = liveBrowser ? machineBrowserSource(() => resolveMachineBrowser({ named: process.env["OSTRA_RUNNER_BROWSER"], download: false, dataDir })) : fakeBrowserProgram();
    harness = await startHarness(shared, {
      dataDir,
      agents: defaultAgents(),
      executor: { browser },
      host: { appShell: resolved.kind === "found" ? resolved.command : "bash", pictureTiming: { quietMs: 200, settleMaxMs: 5_000 } },
    });
    const h = harness;
    const [repo] = taskSpecFixture.repos;
    const [environment] = taskSpecFixture.environment.repos;
    if (repo === undefined || environment === undefined) {
      throw new Error("the fixture has a repo");
    }
    const port = await freePort();
    const docs: TaskSpecAppProcess = {
      name: "docs",
      repoId: repo.repoId,
      folder: ".",
      command: `node "${path.join(FIXTURE, "docs", "server.js").replaceAll("\\", "/")}"`,
      port,
      ready: { kind: "port" },
      label: "Docs",
      primary: true,
      hostRewrite: true,
    };
    const made = h.taskFor(`${stubMarker("take-it")} Take a screenshot of the docs.`, {
      agent: { ...taskSpecFixture.agent, adapter: "opencode", apiFormat: "anthropic-messages", endpointModelId: "stub-model" },
      environment: {
        ...taskSpecFixture.environment,
        setupScript: null,
        repos: [{ ...environment, variables: [{ name: "TEST_WEB_DOCS_PORT", value: String(port), availableDuringSetup: true }] }],
        appProcesses: [docs],
      },
      tools: ["pr-text", "app"],
    });
    h.dispatch(made.spec);
    await h.waitForKind(made.spec, "session.saved", 1, 180_000);
    const said = h.ofKind(made.spec, "agent.message").map((event) => event.text).join(" ");
    const [shot] = h.ofKind(made.spec, "attachment.added");
    if (shot === undefined) {
      throw new Error(`no screenshot: ${said} ${JSON.stringify(h.ofKind(made.spec, "tool.failed"))}`);
    }
    expect(shot).toMatchObject({ attachmentKind: "screenshot", source: "agent", target: { process: "docs" }, path: "/", width: 1440, height: 900, caption: CAPTION });
    const blob = h.server.blobs.get(shot.blobId);
    expect(blob?.taskId).toBe(made.spec.taskId);
    expect(blob?.purpose).toBe("app-screenshot");
    expect(blob?.contentType).toBe(APP_SCREENSHOT_CONTENT_TYPE);
    expect(pngSize(blob?.bytes ?? Buffer.alloc(0))).toEqual({ width: 1440, height: 900 });
    const report = h.ofKind(made.spec, "app.browser")[0]?.browser;
    expect(report?.available).toBe(true);
    if (report?.available === true) {
      expect(shot.browser).toEqual({ name: report.name, version: report.version });
    }
    // The answer reached the model, which said it back.
    expect(said).toContain(`answered: Screenshot ${shot.attachmentId} (1440×900) is in the task's thread for the members of the project.`);
  }, 240_000);
});
