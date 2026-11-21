import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
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

/** The server's tools, `<tool>` each, whose result says `<server> ran <tool>`. */
const answer = (server: string, tools: readonly string[], message: z.infer<typeof rpcSchema>): unknown => {
  if (message.method === "initialize") {
    return { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: server, version: "1.0.0" } };
  }
  if (message.method === "tools/list") {
    return { tools: tools.map((tool) => ({ name: tool, description: `The ${tool} tool of ${server}.`, inputSchema: { type: "object", properties: {} } })) };
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

/** A server listening on loopback at a port of its own. */
const listenOnLoopback = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
};

const closeServer = (server: Server): Promise<void> =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => {
      resolve();
    });
  });

/**
 * One streamable-HTTP endpoint that answers as a server per path, `/mcp/<name>`, each with the
 * tool given, or (milestone 8) with every tool of a list, as a server that lists too much would.
 */
export const startTestMcpHttp = async (tool: string | readonly string[]): Promise<TestMcpHttp> => {
  const tools = typeof tool === "string" ? [tool] : tool;
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
      response.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.data.id, result: answer(name, tools, parsed.data) }));
    })();
  });
  const port = await listenOnLoopback(server);
  return {
    urlFor: (name) => `http://127.0.0.1:${String(port)}/mcp/${name}`,
    calls,
    close: () => closeServer(server),
  };
};

export type OAuthChallengeMcp = {
  /** The address of the server of that name: `/mcp/<name>`, which answers every call with an OAuth challenge. */
  readonly urlFor: (name: string) => string;
  /** Every request it got, as `<method> <path>`, in order. */
  readonly requests: readonly string[];
  readonly close: () => Promise<void>;
};

/**
 * Milestone 8 (F-145, ADR 0069): a remote MCP server that asks for OAuth sign-in, as MCP's
 * authorization spec has it: every call to `/mcp/<name>` is a 401 whose `WWW-Authenticate` names
 * its protected-resource metadata, which names an authorization server on the same port with
 * dynamic client registration, so a client that signs in finds everything it needs to start. It
 * notes every request, so a case sees whether the agent went looking for a sign-in.
 */
export const startOAuthChallengeMcp = async (): Promise<OAuthChallengeMcp> => {
  const requests: string[] = [];
  let origin = "";
  const json = (response: ServerResponse, status: number, body: unknown): void => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const server = createServer((request, response) => {
    void (async () => {
      const url = request.url ?? "/";
      const pathname = url.split("?")[0] ?? url;
      requests.push(`${request.method ?? "GET"} ${pathname}`);
      await readBody(request);
      if (/^\/mcp\/[A-Za-z0-9-]+$/.test(pathname)) {
        response.writeHead(401, {
          "content-type": "application/json",
          "www-authenticate": `Bearer realm="mcp", resource_metadata="${origin}/.well-known/oauth-protected-resource${pathname}"`,
        });
        response.end(JSON.stringify({ error: "invalid_token", error_description: "sign in first" }));
        return;
      }
      if (pathname.startsWith("/.well-known/oauth-protected-resource")) {
        json(response, 200, { resource: `${origin}${pathname.slice("/.well-known/oauth-protected-resource".length)}`, authorization_servers: [origin] });
        return;
      }
      if (pathname.startsWith("/.well-known/oauth-authorization-server") || pathname.startsWith("/.well-known/openid-configuration")) {
        json(response, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
        });
        return;
      }
      if (pathname === "/register") {
        json(response, 201, { client_id: "test-client", redirect_uris: ["http://127.0.0.1:19876/mcp/oauth/callback"] });
        return;
      }
      response.writeHead(404).end();
    })();
  });
  const port = await listenOnLoopback(server);
  origin = `http://127.0.0.1:${String(port)}`;
  return { urlFor: (name) => `${origin}/mcp/${name}`, requests, close: () => closeServer(server) };
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
