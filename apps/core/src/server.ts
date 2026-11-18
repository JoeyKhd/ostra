import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import type { Logger } from "@ostra/adapter-sdk";

import { sendJson } from "./http.ts";

// Core's HTTP server (ADR 0016): the runner gateway, and later the webhook inbox and the task spec
// and credentials endpoints. Each piece is a route handler that says whether it took the request.

export type RouteHandler = (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean>;
export type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

export type CoreServer = {
  readonly server: Server;
  /** Listens; resolves with the port (0 picks a free one). */
  readonly listen: (port: number, host?: string) => Promise<number>;
  readonly close: () => Promise<void>;
};

export const createCoreServer = (options: {
  readonly routes: readonly RouteHandler[];
  readonly upgrade: UpgradeHandler;
  readonly logger: Logger;
}): CoreServer => {
  const server = createServer({ keepAliveTimeout: 65_000 }, (request, response) => {
    const url = new URL(request.url ?? "/", "http://ostra.invalid");
    const handle = async (): Promise<void> => {
      if (request.method === "GET" && url.pathname === "/healthz") {
        sendJson(response, 200, { ok: true });
        return;
      }
      for (const route of options.routes) {
        if (await route(request, response, url)) {
          return;
        }
      }
      sendJson(response, 404, { error: { code: "not-found", message: "no such route" } });
    };
    handle().catch((error: unknown) => {
      options.logger.error("http.failed", { path: url.pathname, error: error instanceof Error ? error.name : "unknown" });
      if (response.headersSent) {
        response.destroy();
      } else {
        sendJson(response, 500, { error: { code: "internal", message: "internal error" } });
      }
    });
  });
  // A whole request must arrive in 30 s.
  server.headersTimeout = 30_000;
  server.requestTimeout = 30_000;
  server.on("upgrade", options.upgrade);
  server.on("clientError", (_error, socket) => {
    socket.destroy();
  });
  return {
    server,
    listen: (port, host = "0.0.0.0") =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          const address = server.address();
          resolve(typeof address === "object" && address !== null ? (address satisfies AddressInfo).port : port);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
};
