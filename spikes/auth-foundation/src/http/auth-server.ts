import http from "node:http";
import net from "node:net";
import { toNodeHandler } from "better-auth/node";
import type { OstraAuth } from "../auth/create-auth.ts";

export type AuthServer = {
  readonly url: string;
  readonly close: () => Promise<void>;
};

export const findFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address !== null && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("no free port"));
        }
      });
    });
  });

/**
 * Serves better-auth over real HTTP on the loopback interface. A personal
 * runner is a separate program that talks to the server this way, so the
 * device-code scenarios call it with `fetch`, not in-process.
 */
export const startAuthServer = async (auth: OstraAuth, port: number): Promise<AuthServer> => {
  const handler = toNodeHandler(auth);
  const server = http.createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve();
    });
  });
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
};
