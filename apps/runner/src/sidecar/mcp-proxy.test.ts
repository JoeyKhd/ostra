import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { taskIdSchema } from "@ostra/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { startTokenMcpServer } from "../testing/token-mcp-server.ts";
import type { TokenMcpServer } from "../testing/token-mcp-server.ts";
import { startMcpProxy } from "./mcp-proxy.ts";
import type { McpProxy } from "./mcp-proxy.ts";

// Ticket 29 (F-021, ADR 0030): the sidecar's MCP proxy adds a server's headers from the
// credentials, so the agent never holds them, answers only its own random paths, and streams the
// server's reply stream as it comes.

const TOKEN = "mcp-server-token-0b1c2d3e4f";

let upstream: TokenMcpServer | undefined;
let proxy: McpProxy | undefined;

afterEach(async () => {
  await proxy?.close();
  await upstream?.close();
  proxy = undefined;
  upstream = undefined;
});

const start = async (): Promise<{ readonly upstream: TokenMcpServer; readonly proxy: McpProxy; readonly logs: LogRecord[] }> => {
  upstream = await startTokenMcpServer({ token: TOKEN, tool: "lookup" });
  const logs: LogRecord[] = [];
  proxy = await startMcpProxy({
    taskId: taskIdSchema.parse("0196f1a0-m3-mcp-proxy"),
    routes: [{ name: "docs", proxyPath: "/mcp/docs", url: upstream.urlFor("docs"), headers: { Authorization: `Bearer ${TOKEN}` } }],
    listenHost: "127.0.0.1",
    logger: createLogger((record) => logs.push(record)),
  });
  return { upstream, proxy, logs };
};

const rpc = (id: number, method: string, params: Record<string, unknown> = {}): string => JSON.stringify({ jsonrpc: "2.0", id, method, params });

const post = (url: string, body: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body });

describe("the sidecar's MCP proxy (F-021)", () => {
  it("F-021: the server refuses a call without its token, and takes the same call through the proxy, which adds it", async () => {
    const { upstream: server, proxy: mcp, logs } = await start();
    const call = rpc(1, "tools/call", { name: "lookup", arguments: {} });
    const direct = await post(server.urlFor("docs"), call);
    expect(direct.status).toBe(401);
    // The agent's own authorization header is never what reaches the server: the credentials' is.
    const through = await post(mcp.urlFor("/mcp/docs"), call, { authorization: "Bearer the-agents-own-guess" });
    expect(through.status).toBe(200);
    expect(through.headers.get("mcp-session-id")).toBe("session-docs");
    expect(await through.json()).toMatchObject({ result: { content: [{ text: "docs ran lookup with its token" }] } });
    expect(server.calls).toEqual(["docs/lookup"]);
    expect(server.requests.map((request) => request.authorized)).toEqual([false, true]);
    // The proxy's address holds no credential, and its log line names the server, the status and the bytes only.
    expect(mcp.urlFor("/mcp/docs")).not.toContain(TOKEN);
    expect(mcp.urlFor("/mcp/docs")).not.toContain(server.urlFor("docs"));
    const line = logs.find((record) => record.message === "mcp call");
    expect(line?.fields).toMatchObject({ server: "docs", status: 200 });
    expect(line?.fields["requestBytes"]).toBe(Buffer.byteLength(call));
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
    expect(JSON.stringify(logs)).not.toContain("tools/call");
  });

  it("F-021: the reply stream (SSE) comes through as it's sent, not when it ends", async () => {
    const { proxy: mcp } = await start();
    const answer = await fetch(mcp.urlFor("/mcp/docs"), { headers: { accept: "text/event-stream" } });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("text/event-stream");
    const reader = answer.body?.getReader();
    const startedAt = Date.now();
    const first = await reader?.read();
    const firstAt = Date.now() - startedAt;
    expect(Buffer.from(first?.value ?? new Uint8Array()).toString("utf8")).toContain('{"first":true}');
    // The second event comes 300 ms after the first: the first was never held back for it.
    expect(firstAt).toBeLessThan(250);
    let rest = "";
    for (let chunk = await reader?.read(); chunk !== undefined && !chunk.done; chunk = await reader?.read()) {
      rest += Buffer.from(chunk.value).toString("utf8");
    }
    expect(rest).toContain('{"second":true}');
  });

  it("F-021: any other path or method is refused, and nothing reaches a server", async () => {
    const { upstream: server, proxy: mcp } = await start();
    const base = mcp.urlFor("/mcp/docs");
    const prefix = base.slice(0, base.length - "/mcp/docs".length);
    const origin = new URL(base).origin;
    const body = rpc(1, "tools/list");
    expect((await post(`${prefix}/mcp/other`, body)).status).toBe(404);
    expect((await post(`${origin}/mcp/docs`, body)).status).toBe(404);
    expect((await post(`${origin}/0000000000000000/mcp/docs`, body)).status).toBe(404);
    expect((await post(`${base}/extra`, body)).status).toBe(404);
    expect((await fetch(base, { method: "PUT", body })).status).toBe(405);
    expect(server.requests).toEqual([]);
  });

  it("F-021: a server that can't be reached answers 502, and the proxy goes on", async () => {
    const { upstream: server, proxy: mcp } = await start();
    await server.close();
    upstream = undefined;
    expect((await post(mcp.urlFor("/mcp/docs"), rpc(1, "tools/list"))).status).toBe(502);
  });
});
