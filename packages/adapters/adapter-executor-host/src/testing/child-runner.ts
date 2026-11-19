// A runner's executor as its own process (ticket 42): the containment test kills this process
// hard and checks that nothing of its task is left. It starts the host executor the way `ostra
// runner` does (`HostExecutor.start`), makes and prepares one box against the git upstream at
// OSTRA_TEST_GIT_ORIGIN, and starts an agent that detaches a helper and exits at once. It prints
// one JSON line, `{ "helper": <pid> }`, and then waits to be killed.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { silentLogger, systemClock } from "@ostra/adapter-sdk";
import { boxIdSchema, taskIdSchema } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";

import { HostExecutor } from "../host-executor.ts";
import { detachedHelperScript } from "./helpers.ts";

const dataDir = process.env["OSTRA_TEST_DATA_DIR"] ?? "";
const origin = process.env["OSTRA_TEST_GIT_ORIGIN"] ?? "";

const executor = await HostExecutor.start({ dataDir }, { logger: silentLogger, clock: systemClock });
const box = { taskId: taskIdSchema.parse("child-runner-task"), boxId: boxIdSchema.parse("child-runner-box") };
const spec = { ...taskSpecFixture, environment: { ...taskSpecFixture.environment, setupScript: null } };
const created = await executor.create({ ...box, spec, proxies: { gitBaseUrl: origin, modelBaseUrl: "http://127.0.0.1:9/v1", mcpUrl: "http://127.0.0.1:9/mcp" } });
if (!created.ok) {
  throw new Error(created.error.message);
}
const prepared = await executor.prepare({ box, spec, secrets: [], onSetupOutput: () => undefined });
if (!prepared.ok) {
  throw new Error(prepared.error.message);
}
const pidFile = path.join(created.value.agentDir, "helper.pid");
const agent = await executor.startAgent(box, {
  command: process.execPath,
  args: ["-e", detachedHelperScript(pidFile, { exitAtOnce: true })],
  env: process.platform === "win32" ? { SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows" } : {},
  cwd: created.value.workspaceDir,
  files: [],
});
if (!agent.ok) {
  throw new Error(agent.error.message);
}
let helper = 0;
for (let attempt = 0; attempt < 200 && helper === 0; attempt += 1) {
  helper = Number((await readFile(pidFile, "utf8").catch(() => "0")).trim());
  if (helper === 0) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
process.stdout.write(`${JSON.stringify({ helper, containment: executor.capabilities.processContainment })}\n`);
setInterval(() => undefined, 1_000);
