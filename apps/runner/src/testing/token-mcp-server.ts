import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { z } from "zod";

// A fake MCP server that needs its token (ticket 29, F-021): streamable HTTP at `/mcp/<name>`,
// one tool per server, which answers only a request with `authorization: Bearer <token>`. A GET
// opens the reply stream (SSE) and sends two events a little apart, so a test sees them arrive one
// by one. It records each request's path, method and whether its token was right: never a body.

const rpcSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.looseObject({ name: z.string().optional(), protocolVersion: z.string().optional() }).optional(),
});

export type TokenMcpRequest = { readonly path: string; readonly method: string; readonly authorized: boolean; readonly rpcMethod: string | null };

export type TokenMcpServer = {
  /** The server's real address: `/mcp/<name>`. Only the credentials hold it. */
  readonly urlFor: (name: string) => string;
  readonly requests: readonly TokenMcpRequest[];
  /** Each tool call that was answered, as `<server>/<tool>`. */
  readonly calls: readonly string[];
  readonly close: () => Promise<void>;
};

const readBody = async (request: IncomingMessage): Promise<string> => {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
  }
  return body;
};

const answer = (server: string, tool: string, message: z.infer<typeof rpcSchema>): unknown => {
  if (message.method === "initialize") {
    return { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: server, version: "1.0.0" } };
  }
  if (message.method === "tools/list") {
    return { tools: [{ name: tool, description: `The ${tool} tool of ${server}.`, inputSchema: { type: "object", properties: {} } }] };
  }
  if (message.method === "tools/call") {
    return { content: [{ type: "text", text: `${server} ran ${message.params?.name ?? "nothing"} with its token` }] };
  }
  return {};
};

export const startTokenMcpServer = async (input: { readonly token: string; readonly tool: string }): Promise<TokenMcpServer> => {
  const requests: TokenMcpRequest[] = [];
  const calls: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const url = request.url ?? "";
      const name = /^\/mcp\/([A-Za-z0-9_-]+)$/.exec(url)?.[1];
      const authorized = request.headers.authorization === `Bearer ${input.token}`;
      const method = request.method ?? "";
      if (name === undefined) {
        requests.push({ path: url, method, authorized, rpcMethod: null });
        response.writeHead(404).end();
        return;
      }
      if (!authorized) {
        requests.push({ path: url, method, authorized, rpcMethod: null });
        response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "a token is needed" }));
        return;
      }
      if (method === "GET") {
        requests.push({ path: url, method, authorized, rpcMethod: null });
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        response.write("event: message\ndata: {\"first\":true}\n\n");
        setTimeout(() => {
          response.write("event: message\ndata: {\"second\":true}\n\n");
          response.end();
        }, 300);
        return;
      }
      if (method !== "POST") {
        requests.push({ path: url, method, authorized, rpcMethod: null });
        response.writeHead(method === "DELETE" ? 200 : 405).end();
        return;
      }
      const parsed = rpcSchema.safeParse(JSON.parse(await readBody(request)));
      requests.push({ path: url, method, authorized, rpcMethod: parsed.success ? (parsed.data.method ?? null) : null });
      if (!parsed.success || parsed.data.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      if (parsed.data.method === "tools/call") {
        calls.push(`${name}/${parsed.data.params?.name ?? ""}`);
      }
      response.writeHead(200, { "content-type": "application/json", "mcp-session-id": `session-${name}` });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.data.id, result: answer(name, input.tool, parsed.data) }));
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
    requests,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
};
