import { randomBytes } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import type { Logger } from "@ostra/adapter-sdk";
import type { TaskId } from "@ostra/protocol";

// The sidecar's MCP proxy (ticket 29, ADR 0030, ADR 0049): the profile's HTTP MCP servers, as the
// agent reaches them. Beside the key proxy, on loopback on `host` and on the box network on
// `docker`, it answers at `/<random>/mcp/<name>` only, for each server the spec names, and forwards
// streamable HTTP (a POST, and the SSE stream of its replies, a GET, and a session's DELETE) to the
// server's real URL with the headers from the task's credentials. The agent sees only the proxy's
// address: never the server's URL, never its headers. Requests and replies are passed through and
// never logged; a line names the server, the status and the bytes.

export type McpProxyRoute = {
  /** The server's name in the profile. */
  readonly name: string;
  /** Its path on the proxy, from the spec (`/mcp/<name>`). */
  readonly proxyPath: string;
  /** The server's real URL and headers, from the credentials. Never logged. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
};

export type McpProxyOptions = {
  readonly taskId: TaskId;
  readonly routes: readonly McpProxyRoute[];
  readonly listenHost: string;
  readonly advertiseHost?: string;
  readonly port?: number;
  readonly logger: Logger;
};

export type McpProxy = {
  /** The address the agent reaches a server at, by its spec's proxy path. */
  readonly urlFor: (proxyPath: string) => string;
  readonly close: () => Promise<void>;
};

/** The methods of streamable HTTP: a message, the reply stream, the session's end. */
const METHODS: ReadonlySet<string> = new Set(["POST", "GET", "DELETE"]);

/** The agent's headers that go on: what streamable HTTP reads. Everything else stays, its own credentials first. */
const FORWARDED_REQUEST_HEADERS: readonly string[] = ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"];

/** The server's headers that come back. */
const FORWARDED_RESPONSE_HEADERS: readonly string[] = ["content-type", "mcp-session-id", "cache-control"];

const pick = (headers: IncomingHttpHeaders, names: readonly string[]): OutgoingHttpHeaders => {
  const out: OutgoingHttpHeaders = {};
  for (const name of names) {
    const value = headers[name];
    if (value !== undefined) {
      out[name] = value;
    }
  }
  return out;
};

export const startMcpProxy = async (options: McpProxyOptions): Promise<McpProxy> => {
  const log = options.logger.child({ taskId: options.taskId, component: "mcp-proxy" });
  // The random part: only the agent's config holds it, so another process on the machine can't
  // guess a server's address (as the key proxy's fake key).
  const prefix = `/${randomBytes(16).toString("hex")}`;
  const routes = new Map(options.routes.map((route) => [`${prefix}${route.proxyPath}`, route] as const));

  const refuse = (response: ServerResponse, status: number): void => {
    response.writeHead(status, { "content-type": "text/plain" }).end(status === 404 ? "not found" : "method not allowed");
  };

  const forward = (incoming: IncomingMessage, response: ServerResponse, route: McpProxyRoute): void => {
    const target = new URL(route.url);
    const secure = target.protocol === "https:";
    const headers: OutgoingHttpHeaders = { ...pick(incoming.headers, FORWARDED_REQUEST_HEADERS), host: target.host };
    for (const [name, value] of Object.entries(route.headers)) {
      headers[name.toLowerCase()] = value;
    }
    let sent = 0;
    let received = 0;
    let status = 0;
    const send = secure ? httpsRequest : httpRequest;
    const onAnswer = (answer: IncomingMessage): void => {
      status = answer.statusCode ?? 502;
      response.writeHead(status, pick(answer.headers, FORWARDED_RESPONSE_HEADERS));
      // An SSE reply goes out as it comes, never buffered.
      response.flushHeaders();
      answer.on("data", (chunk: Buffer) => {
        received += chunk.length;
      });
      answer.pipe(response);
      answer.on("end", () => {
        log.info("mcp call", { server: route.name, method: incoming.method ?? null, status, requestBytes: sent, replyBytes: received });
      });
      answer.on("error", () => {
        response.destroy();
      });
    };
    // Node refuses a header it can't send (a control character) by throwing here: the call fails with
    // a 502, and the runner, with every task on it, goes on.
    let outgoing: ClientRequest;
    try {
      outgoing = send(target, { method: incoming.method ?? "POST", headers }, onAnswer);
    } catch (error) {
      log.warn("an MCP server couldn't be reached", { server: route.name, error: error instanceof Error ? error.name : "unknown" });
      incoming.resume();
      response.writeHead(502, { "content-type": "text/plain" }).end("the MCP server couldn't be reached");
      return;
    }
    outgoing.on("error", (error) => {
      log.warn("an MCP server couldn't be reached", { server: route.name, error: error.name });
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "text/plain" }).end("the MCP server couldn't be reached");
      } else {
        response.destroy();
      }
    });
    // The agent hung up (a reply stream it closed): the server's stream goes too.
    response.on("close", () => {
      outgoing.destroy();
    });
    incoming.on("data", (chunk: Buffer) => {
      sent += chunk.length;
    });
    incoming.pipe(outgoing);
  };

  const server = createServer((incoming, response) => {
    const pathname = new URL(incoming.url ?? "/", "http://mcp-proxy.local").pathname;
    const route = routes.get(pathname);
    if (route === undefined) {
      // Any other path: nothing about which exist, and nothing logged of what was asked.
      log.warn("mcp proxy refused a path", { status: 404 });
      refuse(response, 404);
      return;
    }
    if (!METHODS.has(incoming.method ?? "")) {
      refuse(response, 405);
      return;
    }
    forward(incoming, response, route);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.listenHost, () => {
      resolve();
    });
  });
  const address: AddressInfo | string | null = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const origin = `http://${options.advertiseHost ?? options.listenHost}:${String(port)}`;
  log.info("mcp proxy listening", { servers: routes.size });

  return {
    urlFor: (proxyPath) => `${origin}${prefix}${proxyPath}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
};
