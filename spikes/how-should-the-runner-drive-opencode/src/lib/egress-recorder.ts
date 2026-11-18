// A deny-all forward proxy that records where an agent tries to go. Handed to
// the agent as HTTP_PROXY / HTTPS_PROXY (with the key proxy on loopback in
// NO_PROXY), it refuses every CONNECT and absolute-URL request and records the
// host. It only sees clients that honour the proxy variables: it's a cheap
// stand-in for an egress firewall plus packet capture, not a replacement.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type EgressAttempt = { readonly at: number; readonly host: string; readonly kind: "connect" | "http" };

export type EgressRecorder = {
  readonly url: string;
  readonly attempts: readonly EgressAttempt[];
  /** Variables that send the agent's outbound HTTP(S) here, except loopback. */
  readonly env: Readonly<Record<string, string>>;
  readonly close: () => Promise<void>;
};

export const startEgressRecorder = async (): Promise<EgressRecorder> => {
  const attempts: EgressAttempt[] = [];
  const server = createServer((req, res) => {
    let host = req.headers.host ?? "unknown";
    try {
      host = new URL(req.url ?? "").host;
    } catch {
      // Not an absolute URL: keep the Host header.
    }
    attempts.push({ at: Date.now(), host, kind: "http" });
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("egress denied by ostra spike");
  });
  server.on("clientError", (_error, socket) => {
    socket.destroy();
  });
  server.on("connect", (req, socket) => {
    socket.on("error", () => {
      // The client gave up after the refusal: nothing to do.
    });
    attempts.push({ at: Date.now(), host: req.url ?? "unknown", kind: "connect" });
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? (address satisfies AddressInfo).port : 0;
  const url = `http://127.0.0.1:${String(port)}`;
  const noProxy = "127.0.0.1,localhost,::1";
  return {
    url,
    attempts,
    env: { HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, ALL_PROXY: url, NO_PROXY: noProxy, no_proxy: noProxy },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
};
