// Exploration probe: one turn of OpenCode against a stub, through the key
// proxy, dumping what OpenCode sends (tool names and schemas, usage options)
// into .runs/probe-*/. Usage: node src/harness/probe-opencode.ts [openai|anthropic] [v2|v1]

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { agentText, startAcpDriver, textPrompt } from "../lib/acp-driver.ts";
import { allowOnce, declineQuestions } from "../lib/deciders.ts";
import { taskId } from "../lib/ids.ts";
import { startKeyProxy } from "../lib/key-proxy.ts";
import { buildAgentEnv, buildOpenCodeConfig, buildOpenCodeV1Config, createTaskDirs, openCodeAcpLaunch, resolveOpenCodeBinary, writeOpenCodeConfig } from "../lib/opencode.ts";
import { createScenarioBrain, stubMarker } from "../lib/stub-models/scenario.ts";
import { startStubModelServer } from "../lib/stub-models/server.ts";

const run = promisify(execFile);
const format = process.argv[2] === "anthropic" ? "anthropic" : "openai";
const line = process.argv[3] === "v1" ? "v1" : "v2";
const root = path.resolve(import.meta.dirname, "..", "..", ".runs", `probe-${format}-${line}-${String(Date.now())}`);

const main = async (): Promise<void> => {
  const realKey = randomBytes(16).toString("hex");
  const stub = await startStubModelServer({
    format,
    realKey,
    models: ["stub-coder"],
    brain: createScenarioBrain({
      hello: ({ step }) => (step === 0 ? { text: "hello from the stub" } : undefined),
    }),
  });
  const proxy = await startKeyProxy({
    upstreamBaseUrl: stub.baseUrl,
    realKey,
    upstreamAuth: format === "openai" ? "bearer" : "x-api-key",
    taskId: taskId("probe"),
    log: (entry) => {
      console.log(JSON.stringify(entry));
    },
  });
  const dirs = await createTaskDirs(root);
  await run("git", ["init", "-q", "-b", "main", dirs.workspace]);
  const providerId = `ostra-${format}`;
  const input = {
    providers: [{ kind: "custom", id: providerId, format, baseUrl: proxy.agentBaseUrl, keyEnv: "OSTRA_MODEL_API_KEY", models: [{ id: "stub-coder" }] }] as const,
    model: `${providerId}/stub-coder`,
  };
  // 1.x needs its own format, or it falls back to OpenCode's hosted free models.
  await writeOpenCodeConfig(dirs, line === "v2" ? buildOpenCodeConfig(input) : buildOpenCodeV1Config(input));
  const binary = await resolveOpenCodeBinary(line);
  console.log(JSON.stringify({ binary: binary.packageName, version: binary.packageVersion, sha256: binary.sha256 }));
  const env = buildAgentEnv({ dirs, fakeKeys: { OSTRA_MODEL_API_KEY: proxy.fakeKey } });
  const driver = await startAcpDriver({
    taskId: taskId("probe"),
    launch: openCodeAcpLaunch(binary, dirs, env),
    decidePermission: allowOnce,
    answerElicitation: declineQuestions,
  });
  try {
    console.log("initialize", JSON.stringify(driver.initialize));
    const session = await driver.newSession({ cwd: dirs.workspace, mcpServers: [] });
    console.log("session", JSON.stringify(session));
    const response = await driver.prompt(session.sessionId, textPrompt(`${stubMarker("hello")} say hi`));
    console.log("prompt", JSON.stringify(response));
    console.log("text", agentText(driver.events, session.sessionId));
    console.log("events", driver.events.map((e) => (e.kind === "session_update" ? e.update.sessionUpdate : e.kind)).join(","));
    console.log("wire", JSON.stringify(driver.wire()));
    await writeFile(path.join(root, "events.json"), JSON.stringify(driver.events, null, 2));
    await writeFile(
      path.join(root, "stub-calls.json"),
      JSON.stringify(
        stub.calls.map((c) => ({ ...c, messages: c.messages.map((m) => ({ ...m, text: m.text.slice(0, 400) })) })),
        null,
        2,
      ),
    );
    console.log(
      "stub",
      JSON.stringify(stub.calls.map((c) => ({ model: c.model, authOk: c.authOk, stream: c.stream, includeUsage: c.includeUsage, tools: c.toolNames, billed: c.billed }))),
    );
    console.log("proxy", JSON.stringify(proxy.calls.map((c) => ({ path: c.path, model: c.requestedModel, status: c.status, usage: c.usage }))));
  } finally {
    await driver.stop();
    await writeFile(path.join(root, "stderr.txt"), driver.stderrTail());
    await proxy.close();
    await stub.close();
  }
};

await main();
