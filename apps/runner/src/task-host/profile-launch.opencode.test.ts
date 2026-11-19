import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createScenarioBrain, stubMarker } from "@ostra/adapter-sdk/testing";
import type { Scenario } from "@ostra/adapter-sdk/testing";
import { blobIdSchema, repoIdSchema, taskCredentialsSchema } from "@ostra/protocol";
import type { TaskSpec, TaskSpecMcpServer } from "@ostra/protocol";
import { taskSpecFixture } from "@ostra/protocol/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startHarness, startShared } from "../testing/task-host-harness.ts";
import type { Harness, Shared } from "../testing/task-host-harness.ts";
import { startTokenMcpServer } from "../testing/token-mcp-server.ts";
import type { TokenMcpServer } from "../testing/token-mcp-server.ts";
import { defaultAgents } from "./agents.ts";

// Ticket 29 (F-021, ADR 0030, ADR 0049) on the agent the runner ships: the real, pinned OpenCode
// on the host executor, with a scripted stub model behind the real key proxy. The profile's HTTP
// MCP server needs its token: OpenCode reaches it only through the sidecar's MCP proxy, which adds
// the token from the credentials, so the token is never in OpenCode's environment, its files or the
// event log. A stdio server is OpenCode's own child: it starts with the agent and stops with it.

const TOKEN = "docs-mcp-token-5e6f7a8b9c";

const scenarios: Readonly<Record<string, Scenario>> = {
  /** Loads every skill OpenCode lists or its instructions name, and names each with its first heading (the adapter suite's). */
  skills: ({ step, request, lastToolResults }) => {
    if (step === 0) {
      const listed = request.messages.map((message) => message.text).join("\n");
      const fromList = [...listed.matchAll(/<id>([^<]+)<\/id>/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1].trim()]));
      const fromInstructions = [...listed.matchAll(/`skill` tool, by its ID\): ([^\n]+)/g)].flatMap((match) =>
        [...(match[1] ?? "").matchAll(/`([^`]+)`/g)].flatMap((id) => (id[1] === undefined ? [] : [id[1]])),
      );
      const ids = [...new Set([...fromList, ...fromInstructions])];
      return ids.length === 0 ? { text: "no skills listed" } : { toolCalls: ids.map((id) => ({ name: "skill", arguments: { id } })) };
    }
    if (step === 1) {
      const loaded = lastToolResults.flatMap((result) => {
        const name = /<skill_content name="([^"]+)">/.exec(result.text)?.[1];
        const heading = result.text.split("\n").find((line) => line.startsWith("# ") && !line.startsWith("# Skill:"));
        return name === undefined ? [] : [`${name} (${heading?.trim() ?? "no heading"})`];
      });
      return { text: `skills: ${loaded.join(", ")}` };
    }
    return undefined;
  },

  /** Calls the tool the marker names (`<server>_<tool>`), then quotes what it answered. */
  "mcp-call": ({ step, args, lastToolResults }) => {
    if (step === 0) {
      return { toolCalls: [{ name: args, arguments: {} }] };
    }
    return step === 1 ? { text: `${args} answered: ${lastToolResults.map((result) => result.text).join(" | ")}` } : undefined;
  },
};

/** A stdio MCP server that writes its PID to a file when it starts, with one tool. */
const STDIO_SCRIPT = `import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [server, tool, pidFile] = process.argv.slice(2);
writeFileSync(pidFile, String(process.pid));
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  let result = {};
  if (message.method === "initialize") result = { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: server, version: "1.0.0" } };
  if (message.method === "tools/list") result = { tools: [{ name: tool, description: "The " + tool + " tool.", inputSchema: { type: "object", properties: {} } }] };
  if (message.method === "tools/call") result = { content: [{ type: "text", text: server + " ran " + message.params?.name + " in " + process.pid }] };
  send({ jsonrpc: "2.0", id: message.id, result });
});
`;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let shared: Shared;
let mcpServer: TokenMcpServer;
let harness: Harness | undefined;

beforeAll(async () => {
  shared = await startShared("profile-launch-opencode", { brain: createScenarioBrain(scenarios) });
  mcpServer = await startTokenMcpServer({ token: TOKEN, tool: "lookup" });
  // A repo with a skill of its own, where OpenCode reads a project's skills.
  await shared.upstream.createRepo("ostra-test/skills", {
    "README.md": "# skills",
    ".opencode/skills/repo-deploy/SKILL.md": ["---", "name: repo-deploy", "description: How this repo deploys", "---", "# Repo deploy", "", "Run the deploy script.", ""].join(String.fromCharCode(10)),
  });
}, 60_000);

afterAll(async () => {
  await mcpServer.close();
  await shared.close();
}, 60_000);

afterEach(async () => {
  await harness?.close();
  harness = undefined;
}, 60_000);

const start = async (): Promise<Harness> => {
  harness = await startHarness(shared, { agents: defaultAgents() });
  return harness;
};

const taskOn = (h: Harness, prompt: string, servers: readonly TaskSpecMcpServer[]) =>
  h.taskFor(prompt, {
    agent: { ...taskSpecFixture.agent, adapter: "opencode", apiFormat: "anthropic-messages", endpointModelId: "stub-model", mcpServers: [...servers] },
    environment: { ...taskSpecFixture.environment, setupScript: null },
  });

const messages = (h: Harness, spec: TaskSpec): string => h.ofKind(spec, "agent.message").map((event) => event.text).join(" ");

/** Every file under the folders the launches named, as text. */
const textUnder = async (dir: string): Promise<string> => {
  let out = "";
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        out += await readFile(full, "utf8").catch(() => "");
      }
    }
  };
  await walk(dir);
  return out;
};

describe("skills on OpenCode, with the stub models (F-021)", () => {
  it("F-021: the profile's skill, written into the agent folder by the runner, reaches OpenCode beside the repo's own", async () => {
    const h = await start();
    const [base] = taskSpecFixture.repos;
    if (base === undefined) {
      throw new Error("the fixture has a repo");
    }
    const made = h.taskFor(`${stubMarker("skills")} List them.`, {
      repos: [{ ...base, repoId: repoIdSchema.parse("0196f1a0-0000-7000-8000-0000000000ad"), fullName: "ostra-test/skills", cloneUrl: "https://github.com/ostra-test/skills.git", checkoutDir: "skills" }],
      agent: { ...taskSpecFixture.agent, adapter: "opencode", apiFormat: "anthropic-messages", endpointModelId: "stub-model" },
      environment: { ...taskSpecFixture.environment, setupScript: null },
    });
    const blob = h.server.putBlob(made.spec.taskId, Buffer.from(["---", "name: review", "description: How to review", "---", "# The review skill", "", "Read the diff twice.", ""].join(String.fromCharCode(10))), "text/markdown");
    const spec: TaskSpec = { ...made.spec, agent: { ...made.spec.agent, skills: [{ name: "review", blobId: blobIdSchema.parse(blob), files: [] }] } };
    h.server.tasks.set(spec.taskId, { spec, credentials: made.credentials });
    h.dispatch(spec);
    await h.waitForKind(spec, "session.saved", 1, 150_000);
    expect(messages(h, spec)).toContain("review (# The review skill)");
    expect(messages(h, spec)).toContain("repo-deploy (# Repo deploy)");
  }, 300_000);
});

describe("MCP servers on OpenCode, with the stub models (F-021)", () => {
  it("F-021: the server refuses a call without its token; OpenCode's call through the proxy is answered, and the token is in none of its environment, files or events", async () => {
    // Without the token, the server refuses.
    const direct = await fetch(mcpServer.urlFor("docs"), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lookup", arguments: {} } }),
    });
    expect(direct.status).toBe(401);
    const before = mcpServer.requests.length;

    const h = await start();
    const made = taskOn(h, `${stubMarker("mcp-call", "docs_lookup")} Look it up.`, [{ name: "docs", transport: "http", proxyPath: "/mcp/docs", readOnly: true }]);
    const credentials = taskCredentialsSchema.parse({
      ...made.credentials,
      mcpServers: [{ name: "docs", url: mcpServer.urlFor("docs"), headers: { authorization: `Bearer ${TOKEN}` } }],
    });
    h.server.tasks.set(made.spec.taskId, { spec: made.spec, credentials });
    h.dispatch(made.spec);
    await h.waitForKind(made.spec, "session.saved", 1, 150_000);
    expect(messages(h, made.spec)).toContain("docs_lookup answered: docs ran lookup with its token");
    expect(mcpServer.calls).toContain("docs/lookup");
    // Every request OpenCode made came through the proxy with the token; none without it.
    const throughProxy = mcpServer.requests.slice(before);
    expect(throughProxy.length).toBeGreaterThan(0);
    expect(throughProxy.every((request) => request.path === "/mcp/docs" && request.authorized)).toBe(true);
    // Absent from the agent's environment and the files its launch wrote, from its own folder on disk, and from the events and logs.
    const launch = h.launches.at(-1);
    expect(JSON.stringify(launch?.env)).not.toContain(TOKEN);
    expect(JSON.stringify(launch?.files)).not.toContain(TOKEN);
    expect(JSON.stringify(launch)).not.toContain(mcpServer.urlFor("docs"));
    const configDir = launch?.files[0]?.path;
    expect(configDir).toBeDefined();
    expect(await textUnder(path.dirname(path.dirname(configDir ?? "")))).not.toContain(TOKEN);
    expect(JSON.stringify([h.eventsOf(made.spec), h.logs])).not.toContain(TOKEN);
  }, 300_000);

  it("F-021: a stdio server starts as OpenCode's child, answers its call, and stops when the agent stops", async () => {
    const h = await start();
    const script = path.join(shared.root, "pid-mcp-stdio.mjs");
    const pidFile = path.join(shared.root, `stdio-${String(Date.now())}.pid`);
    await writeFile(script, STDIO_SCRIPT, "utf8");
    const { spec } = taskOn(h, `${stubMarker("mcp-call", "local_ping")} Ping.`, [
      { name: "local", transport: "stdio", command: process.execPath, args: [script, "local", "ping", pidFile], env: { LOCAL_MODE: "test" }, readOnly: false },
    ]);
    h.dispatch(spec);
    await h.waitForKind(spec, "session.saved", 1, 150_000);
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(messages(h, spec)).toContain(`local_ping answered: local ran ping in ${String(pid)}`);
    expect(alive(pid)).toBe(true);
    // The session ends: the agent stops, and its stdio server with it.
    expect(await h.waitForAck(h.stop(spec))).toMatchObject({ result: "done" });
    await h.gateway.waitFor(() => !alive(pid), 30_000);
    expect(alive(pid)).toBe(false);
  }, 300_000);
});
