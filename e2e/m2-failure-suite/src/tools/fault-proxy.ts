import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

// A fault-injecting HTTP proxy for core's calls to a real service (ticket 38, spec section 8), so
// "retry after a write committed" runs against real Linear and GitHub. Core is pointed at it
// (CORE_TEST_LINEAR_API_URL for Linear's GraphQL, OSTRA_GITHUB_API_URL for GitHub's REST API) and
// it forwards every call unchanged, except one an armed fault matches: that call is forwarded, the
// service applies the write and answers, and the proxy throws the answer away and says 500 instead,
// as a write that committed and lost its reply.
//
// It keeps the method, the path and a GraphQL operation's root field of what it forwarded, never a
// body, a header or a token.

export type FaultRequest = {
  readonly method: string;
  readonly path: string;
  /** For GraphQL: the first root field of a mutation (`commentCreate`), or `null`. */
  readonly mutation: string | null;
};

export type Fault = {
  readonly name: string;
  readonly match: (request: FaultRequest) => boolean;
  /** How many matching calls it answers with a 500 after the write; default 1. */
  times?: number;
};

export type Fired = { readonly name: string; readonly method: string; readonly path: string; readonly mutation: string | null; readonly upstreamStatus: number };

export type FaultProxy = {
  readonly url: string;
  readonly arm: (fault: Fault) => void;
  /** Faults still armed. */
  readonly armed: () => readonly string[];
  readonly fired: () => readonly Fired[];
  /** Every call forwarded, in order. */
  readonly forwarded: () => readonly FaultRequest[];
  readonly close: () => Promise<void>;
};

/** A GraphQL mutation's first root field, read from the query text only. */
export const mutationOf = (body: string): string | null => {
  let query: unknown;
  try {
    query = Reflect.get(Object(JSON.parse(body)), "query");
  } catch {
    return null;
  }
  if (typeof query !== "string") return null;
  const match = /^\s*mutation\b[^{]*\{\s*(?:\w+\s*:\s*)?(\w+)/.exec(query);
  return match?.[1] ?? null;
};

const HOP_BY_HOP: ReadonlySet<string> = new Set(["host", "connection", "keep-alive", "transfer-encoding", "content-length", "accept-encoding", "upgrade", "proxy-connection", "te", "trailer"]);

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks);
};

/** Forwards to `targetOrigin` (`https://api.linear.app`, `https://api.github.com`). */
export const startFaultProxy = async (targetOrigin: string): Promise<FaultProxy> => {
  const faults: Fault[] = [];
  const fired: Fired[] = [];
  const forwarded: FaultRequest[] = [];

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = request.method ?? "GET";
    const url = request.url ?? "/";
    const body = await readBody(request);
    const seen: FaultRequest = { method, path: url.split("?")[0] ?? url, mutation: method === "POST" ? mutationOf(body.toString("utf8")) : null };
    forwarded.push(seen);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name)) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const fault = faults.find((one) => (one.times ?? 1) > 0 && one.match(seen));
    const upstream = await fetch(`${targetOrigin}${url}`, {
      method,
      headers,
      ...(method === "GET" || method === "HEAD" ? {} : { body }),
      redirect: "manual",
    });
    const answer = Buffer.from(await upstream.arrayBuffer());
    if (fault !== undefined) {
      fault.times = (fault.times ?? 1) - 1;
      fired.push({ name: fault.name, method, path: seen.path, mutation: seen.mutation, upstreamStatus: upstream.status });
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "the failure suite's proxy: the write was applied, this answer is not its own" }));
      return;
    }
    const out: Record<string, string> = {};
    upstream.headers.forEach((value, name) => {
      // fetch already decoded the body: its encoding and length are no longer the body's.
      if (name === "content-encoding" || name === "content-length" || name === "transfer-encoding" || name === "connection") return;
      out[name] = value;
    });
    response.writeHead(upstream.status, out);
    response.end(answer);
  };

  const server = http.createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "the failure suite's proxy could not reach the service" }));
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  return {
    url: `http://127.0.0.1:${String(port)}`,
    arm: (fault) => {
      faults.push(fault);
    },
    armed: () => faults.filter((fault) => (fault.times ?? 1) > 0).map((fault) => fault.name),
    fired: () => fired,
    forwarded: () => forwarded,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
};
