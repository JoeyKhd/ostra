import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import path from "node:path";

import { z } from "zod";

// Test MCP servers for the OpenCode cases (ADR 0049, F-021): a real agent connects to its servers
// and lists their tools before the model sees them, so the cases need servers that answer. Tests
// only, never part of the adapter's runtime surface.

/** A JSON-RPC message, as an MCP client sends it: loose, it's the agent's. */
const rpcSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.looseObject({ name: z.string().optional(), protocolVersion: z.string().optional() }).optional(),
});

/** One tool per server, `<tool>`, whose result says `<server> ran <tool>`. */
const answer = (server: string, tool: string, message: z.infer<typeof rpcSchema>): unknown => {
  if (message.method === "initialize") {
    return { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: server, version: "1.0.0" } };
  }
  if (message.method === "tools/list") {
    return { tools: [{ name: tool, description: `The ${tool} tool of ${server}.`, inputSchema: { type: "object", properties: {} } }] };
  }
  if (message.method === "tools/call") {
    return { content: [{ type: "text", text: `${server} ran ${message.params?.name ?? "nothing"}` }] };
  }
  return {};
};

const readBody = async (request: IncomingMessage): Promise<string> => {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
  }
  return body;
};

export type TestMcpHttp = {
  /** The address of the server of that name: `/mcp/<name>`. */
  readonly urlFor: (name: string) => string;
  /** Each tool call, as `<server>/<tool>`, in order. */
  readonly calls: readonly string[];
  readonly close: () => Promise<void>;
};

/** One streamable-HTTP endpoint that answers as a server per path, `/mcp/<name>`, each with one tool. */
export const startTestMcpHttp = async (tool: string): Promise<TestMcpHttp> => {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const name = /^\/mcp\/([A-Za-z0-9-]+)$/.exec(request.url ?? "")?.[1];
      if (name === undefined || request.method !== "POST") {
        // No server-sent stream: a client that asks for one goes on with plain answers.
        response.writeHead(name === undefined ? 404 : 405).end();
        return;
      }
      const parsed = rpcSchema.safeParse(JSON.parse(await readBody(request)));
      if (!parsed.success || parsed.data.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      if (parsed.data.method === "tools/call") {
        calls.push(`${name}/${parsed.data.params?.name ?? ""}`);
      }
      response.writeHead(200, { "content-type": "application/json", "mcp-session-id": `session-${name}` });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.data.id, result: answer(name, tool, parsed.data) }));
    })();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    urlFor: (name) => `http://127.0.0.1:${String(port)}/mcp/${name}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
};

/** A stdio MCP server, as a script Node runs: newline-delimited JSON-RPC, one tool. */
const STDIO_SCRIPT = `import { createInterface } from "node:readline";
const [server, tool] = process.argv.slice(2);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  let result = {};
  if (message.method === "initialize") result = { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: server, version: "1.0.0" } };
  if (message.method === "tools/list") result = { tools: [{ name: tool, description: "The " + tool + " tool of " + server + ".", inputSchema: { type: "object", properties: {} } }] };
  if (message.method === "tools/call") result = { content: [{ type: "text", text: server + " ran " + message.params?.name }] };
  send({ jsonrpc: "2.0", id: message.id, result });
});
`;

/** Writes the stdio server's script into `dir`, and names the command that runs it as server `name`. */
export const writeTestMcpStdio = async (dir: string, name: string, tool: string): Promise<{ readonly command: string; readonly args: readonly string[] }> => {
  const script = path.join(dir, "test-mcp-stdio.mjs");
  await writeFile(script, STDIO_SCRIPT, "utf8");
  return { command: process.execPath, args: [script, name, tool] };
};
