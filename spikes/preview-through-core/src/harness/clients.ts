import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { WebSocket } from "ws";

// Node clients for the checks that need exact headers (a Host or an Origin no browser would send).

export type Reply = { readonly status: number; readonly headers: IncomingHttpHeaders; readonly body: string };

export const get = (url: string, headers: Record<string, string> = {}, method = "GET"): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = httpRequest({ host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method, headers });
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    request.on("error", reject);
    request.setTimeout(30_000, () => request.destroy(new Error(`timed out: ${url}`)));
    request.end();
  });

export type WsOutcome = { readonly opened: boolean; readonly status: number | null; readonly detail: string };

// Open a WebSocket with the given headers and report whether the server accepted it.
export const tryWebSocket = (url: string, headers: Record<string, string>, protocols: string[] = []): Promise<WsOutcome> =>
  new Promise((resolve) => {
    const socket = new WebSocket(url, protocols, { headers, handshakeTimeout: 10_000 });
    const done = (outcome: WsOutcome) => {
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      socket.terminate();
      resolve(outcome);
    };
    socket.on("open", () => {
      done({ opened: true, status: 101, detail: "open" });
    });
    socket.on("unexpected-response", (_request, response) => {
      done({ opened: false, status: response.statusCode ?? null, detail: `HTTP ${String(response.statusCode)}` });
    });
    socket.on("error", (error) => {
      done({ opened: false, status: null, detail: error.message });
    });
  });

// A preview cookie for a Node client: a one-time code from core, then /.ostra/enter, whose Set-Cookie is kept.
export const previewCookie = async (core: string, host: string, port: number, previewId: string): Promise<string> => {
  const response = await fetch(`${core}/control/code`, { method: "POST", body: JSON.stringify({ port, previewId, layout: "cross-site" }) });
  const body: unknown = await response.json();
  const code = typeof body === "object" && body !== null && "code" in body && typeof body.code === "string" ? body.code : "";
  const entered = await get(`${core}/.ostra/enter?code=${encodeURIComponent(code)}`, { host });
  const setCookie = entered.headers["set-cookie"]?.[0] ?? "";
  return setCookie.split(";")[0] ?? "";
};
