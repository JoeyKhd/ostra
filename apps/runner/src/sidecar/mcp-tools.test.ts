import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { repoFullNameSchema, repoIdSchema, taskIdSchema } from "@ostra/protocol";
import type { TaskEventOf } from "@ostra/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { PR_BODY_MAX, SET_PR_TEXT_TOOL, startMcpTools } from "./mcp-tools.ts";
import type { McpTools } from "./mcp-tools.ts";

// Ticket 20's "done when": a real MCP client lists the tool, calls it, and the event comes out.

const repoId = repoIdSchema.parse("repo-1");
const otherRepoId = repoIdSchema.parse("repo-2");
const template = "## What\n\n## Why\n\n## How it was tested\n";

let tools: McpTools | undefined;
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
  await tools?.close();
  tools = undefined;
});

const start = async (): Promise<{ readonly tools: McpTools; readonly events: TaskEventOf<"pr.text_set">[]; readonly logs: LogRecord[] }> => {
  const events: TaskEventOf<"pr.text_set">[] = [];
  const logs: LogRecord[] = [];
  tools = await startMcpTools({
    taskId: taskIdSchema.parse("task-mcp"),
    repos: [
      { repoId, fullName: repoFullNameSchema.parse("ostra-test/test1"), prTemplate: template },
      { repoId: otherRepoId, fullName: repoFullNameSchema.parse("ostra-test/test2"), prTemplate: null },
    ],
    taskTitle: "Add a short CONTRIBUTING.md",
    listenHost: "127.0.0.1",
    logger: createLogger((record) => logs.push(record)),
    onPrText: (event) => events.push(event),
  });
  return { tools, events, logs };
};

const connect = async (server: McpTools, bearer: string = server.bearer): Promise<Client> => {
  const client = new Client({ name: "ostra-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } }));
  clients.push(client);
  return client;
};

const textOf = (result: unknown): string => {
  const content: unknown = Reflect.get(Object(result), "content");
  const first: unknown = Array.isArray(content) ? content[0] : undefined;
  const text: unknown = Reflect.get(Object(first), "text");
  return typeof text === "string" ? text : "";
};

describe("ostra's MCP tools", () => {
  it("F-030, F-078: lists the tool, whose description carries the repo's PR template and the title rule", async () => {
    const { tools: server } = await start();
    const client = await connect(server);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([SET_PR_TEXT_TOOL]);
    const [tool] = listed.tools;
    expect(tool?.description).toContain("ostra-test/test1: has a pull request template. Follow it");
    expect(tool?.description).toContain("## How it was tested");
    expect(tool?.description).toContain("ostra-test/test2: no pull request template");
    expect(tool?.description).toContain("close to the task's own title");
    expect(tool?.inputSchema.required).toEqual(["repo", "title", "body"]);
  });

  it("F-030: emits pr.text_set for a call naming one of the task's repos", async () => {
    const { tools: server, events } = await start();
    const client = await connect(server);
    const result = await client.callTool({
      name: SET_PR_TEXT_TOOL,
      arguments: { repo: "ostra-test/test1", title: "Add a short\nCONTRIBUTING.md", body: "## What\nA guide.\n" },
    });
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain("Saved");
    expect(events).toEqual([{ kind: "pr.text_set", repoId, title: "Add a short CONTRIBUTING.md", body: "## What\nA guide.\n" }]);
  });

  it("refuses an unknown repo, an oversized body and an unknown field, and emits nothing", async () => {
    const { tools: server, events } = await start();
    const client = await connect(server);
    const unknown = await client.callTool({ name: SET_PR_TEXT_TOOL, arguments: { repo: "someone/else", title: "x", body: "y" } });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain("isn't one of this task's repos");
    const oversized = await client.callTool({
      name: SET_PR_TEXT_TOOL,
      arguments: { repo: "ostra-test/test1", title: "x", body: "y".repeat(PR_BODY_MAX + 1) },
    });
    expect(oversized.isError).toBe(true);
    const extra = await client.callTool({ name: SET_PR_TEXT_TOOL, arguments: { repo: "ostra-test/test1", title: "x", body: "y", base: "main" } });
    expect(extra.isError).toBe(true);
    expect(events).toEqual([]);
  });

  it("answers a wrong bearer, and none, with 401", async () => {
    const { tools: server, logs } = await start();
    const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } };
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const wrong = await fetch(server.url, { method: "POST", headers: { ...headers, authorization: "Bearer not-the-task-bearer" }, body: JSON.stringify(initialize) });
    expect(wrong.status).toBe(401);
    const none = await fetch(server.url, { method: "POST", headers, body: JSON.stringify(initialize) });
    expect(none.status).toBe(401);
    await expect(connect(server, "wrong")).rejects.toThrow();
    expect(JSON.stringify(logs)).not.toContain(server.bearer);
  });
});
