import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttp2Server } from "node:http2";
import type { ServerHttp2Stream } from "node:http2";
import { connect as netConnect } from "node:net";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { spliceStreams, webSocketDuplex } from "@ostra/adapter-sdk";
import {
  CLI_PATH_PREFIX,
  CLI_TUNNEL_SUBPROTOCOL,
  CORE_CLI_TUNNEL_PATH,
  cliPreviewTunnelRequestSchema,
  cliPreviewTunnelResponseSchema,
  cliSessionMessages,
  cliStartAppResponseSchema,
  cliTunnelErrorWords,
} from "@ostra/protocol";
import type { CliPreviewTunnelRefusal, CliStartAppResponse, CliTunnelError, CliTunnelErrorCode } from "@ostra/protocol";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

// `ostra preview`'s two servers in one, for the CLI's own tests (milestone 8, ticket 24): the web
// app's two CLI routes (the ticket and "Start the app", answered with the protocol's schemas) and
// core's `/cli/v1/tunnel` (the ticket used once, an `Origin` refused, refusals in
// `cliTunnelErrorSchema`'s body with core's statuses, then HTTP/2 as the server on the WebSocket's
// `webSocketDuplex`, each plain CONNECT to the ticket's port bridged to a port of this machine with
// `spliceStreams`, as core and the box do between them). The real ones together are
// `apps/core/src/previews/cli-preview.test.ts`.

/** One task the fake knows. */
export type FakePreviewTask = {
  /** Its previews by port; the first is the primary. */
  readonly previews: readonly { readonly port: number; readonly label: string }[];
  /** Whether a box runs it: none until "Start the app", then up after `bootPolls` more tickets are asked. */
  box: "running" | "none" | { readonly booting: number };
  /** A refusal every ticket gets, whatever the box: the runner on the HTTP carrier is `runner-cannot-tunnel`. */
  refusal: CliPreviewTunnelRefusal["code"] | null;
  /** What "Start the app" answers. */
  start: CliStartAppResponse;
  /** How many tickets are refused `no-box` after a start before the box is up. */
  bootPolls: number;
};

export const fakePreviewTask = (previews: FakePreviewTask["previews"], overrides: Partial<FakePreviewTask> = {}): FakePreviewTask => ({
  previews,
  box: "running",
  refusal: null,
  start: { state: "starting" },
  bootPolls: 1,
  ...overrides,
});

export type FakeUpgrade = { readonly origin: string | undefined; readonly protocol: string | undefined; readonly status: number };

export type FakePreviewServer = {
  /** The web app's address, and core's unless `coreUrl` moves it. */
  readonly url: string;
  /** Core's address in the grants. */
  coreUrl: string;
  readonly tasks: Map<string, FakePreviewTask>;
  /** Where a CONNECT to a task's port goes on this machine: `127.0.0.1:<dial>`. */
  readonly dial: Map<number, number>;
  /** A live CLI session's token, for the CLI's session file. */
  readonly addSession: () => string;
  readonly sessions: Map<string, "live" | "revoked">;
  /** The next upgrades' refusals, in order: each upgrade takes the first. */
  readonly upgradeRefusals: CliTunnelErrorCode[];
  /** Every ticket issued, and whether core took it. */
  readonly tickets: { readonly ticket: string; readonly port: number; used: boolean }[];
  readonly upgrades: FakeUpgrade[];
  /** Each request's method and path, in order. */
  readonly requests: string[];
  /** CONNECT streams bridged, and refused. */
  readonly counts: { connects: number; refused: number };
  /** Ports the box answers 403 for, as when the task's list of previews changed. */
  readonly boxRefuses: Set<number>;
  /** The close code of every tunnel that ended, as the fake saw it. */
  readonly closes: number[];
  readonly openTunnels: () => number;
  /** Ends every open tunnel with `code` (4401, 4404, 4410, 1001), or drops its connection with no close frame (1006). */
  readonly endTunnels: (code: number) => void;
  readonly close: () => Promise<void>;
};

/** Core's status for each refusal of the CLI's tunnel (ticket 23's `cli-tunnel.ts`). */
const tunnelStatus: Readonly<Record<CliTunnelErrorCode, number>> = {
  "bad-request": 400,
  "ticket-refused": 403,
  "not-found": 404,
  "port-not-allowed": 403,
  "runner-cannot-tunnel": 409,
  "no-box": 409,
  "not-connected": 409,
  "forwarding-failed": 502,
};

const ticketStatus: Readonly<Record<CliPreviewTunnelRefusal["code"], number>> = { "not-found": 404, "port-not-allowed": 403, "runner-cannot-tunnel": 409, "no-box": 409 };

const readJson = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : JSON.parse(text);
};

const send = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const refuseUpgrade = (socket: Duplex, code: CliTunnelErrorCode): void => {
  const body = JSON.stringify({ error: { code, message: cliTunnelErrorWords(code) } } satisfies CliTunnelError);
  socket.end(`HTTP/1.1 ${String(tunnelStatus[code])} Refused\r\ncontent-type: application/json\r\ncontent-length: ${String(Buffer.byteLength(body))}\r\nconnection: close\r\n\r\n${body}`);
};

const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

export const startFakePreviewServer = async (): Promise<FakePreviewServer> => {
  const tasks = new Map<string, FakePreviewTask>();
  const dial = new Map<number, number>();
  const sessions = new Map<string, "live" | "revoked">();
  const upgradeRefusals: CliTunnelErrorCode[] = [];
  const tickets: { readonly ticket: string; readonly port: number; used: boolean }[] = [];
  const upgrades: FakeUpgrade[] = [];
  const requests: string[] = [];
  const counts = { connects: 0, refused: 0 };
  const boxRefuses = new Set<number>();
  const closes: number[] = [];
  const open = new Set<WebSocket>();
  let url = "";

  const signedIn = (request: IncomingMessage, response: ServerResponse): boolean => {
    const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1];
    const state = token === undefined ? undefined : sessions.get(token);
    if (state === "live") {
      return true;
    }
    const code = state === "revoked" ? "session-revoked" : "session-missing";
    send(response, 401, { error: { code, message: cliSessionMessages[code] } });
    return false;
  };

  const ticketRoute = async (task: FakePreviewTask | undefined, request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const body = cliPreviewTunnelRequestSchema.parse(await readJson(request));
    const refuse = (code: CliPreviewTunnelRefusal["code"]): void => {
      send(response, ticketStatus[code], cliPreviewTunnelResponseSchema.parse({ code }));
    };
    if (task === undefined) {
      refuse("not-found");
      return;
    }
    if (task.refusal !== null) {
      refuse(task.refusal);
      return;
    }
    if (typeof task.box === "object") {
      task.box = task.box.booting > 0 ? { booting: task.box.booting - 1 } : "running";
    }
    if (task.box !== "running") {
      refuse("no-box");
      return;
    }
    const preview = body.port === null ? task.previews[0] : task.previews.find((candidate) => candidate.port === body.port);
    if (preview === undefined) {
      refuse("port-not-allowed");
      return;
    }
    const ticket = `ostra_pt_${randomBytes(32).toString("base64url")}`;
    tickets.push({ ticket, port: preview.port, used: false });
    send(response, 200, cliPreviewTunnelResponseSchema.parse({ coreUrl: server.coreUrl, ticket, port: preview.port, label: preview.label }));
  };

  const startRoute = (task: FakePreviewTask | undefined, response: ServerResponse): void => {
    if (task === undefined) {
      send(response, 404, { code: "not-found" });
      return;
    }
    const answer = cliStartAppResponseSchema.parse(task.start);
    if ("code" in answer) {
      send(response, answer.code === "not-found" ? 404 : answer.code === "core-unreachable" ? 503 : 409, answer);
      return;
    }
    if (task.box === "none") {
      task.box = { booting: task.bootPolls };
    }
    send(response, 200, answer);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = new URL(request.url ?? "/", "http://fake").pathname;
    requests.push(`${request.method ?? "?"} ${path}`);
    const route = new RegExp(`^${CLI_PATH_PREFIX}/tasks/([^/]+)/(previews/tunnel|app/start)$`).exec(path);
    if (request.method !== "POST" || route === null) {
      send(response, 404, { error: { code: "not-found", message: "No such address" } });
      return;
    }
    if (!signedIn(request, response)) {
      return;
    }
    const task = tasks.get(decodeURIComponent(route[1] ?? ""));
    if (route[2] === "previews/tunnel") {
      await ticketRoute(task, request, response);
      return;
    }
    startRoute(task, response);
  };

  /** Core's HTTP/2 server for one CLI: each plain CONNECT to the ticket's port, bridged to this machine. */
  const serve = (ws: WebSocket, port: number): void => {
    const http2 = createHttp2Server();
    http2.on("session", (session) => {
      session.on("error", () => undefined);
    });
    http2.on("stream", (stream: ServerHttp2Stream, headers) => {
      stream.on("error", () => undefined);
      const refuse = (status: number): void => {
        counts.refused += 1;
        stream.respond({ ":status": status });
        stream.end();
      };
      if (first(headers[":method"]) !== "CONNECT" || headers[":protocol"] !== undefined) {
        refuse(405);
        return;
      }
      const asked = Number(/:(\d+)$/.exec(first(headers[":authority"]) ?? "")?.[1]);
      const target = dial.get(asked);
      if (asked !== port || boxRefuses.has(asked) || target === undefined) {
        refuse(403);
        return;
      }
      const socket = netConnect({ host: "127.0.0.1", port: target });
      socket.once("connect", () => {
        counts.connects += 1;
        stream.respond({ ":status": 200 });
        spliceStreams(socket, stream);
      });
      socket.once("error", () => {
        if (!stream.headersSent) {
          refuse(502);
        }
      });
    });
    const duplex = webSocketDuplex(ws);
    duplex.on("error", () => undefined);
    http2.emit("connection", duplex);
  };

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, handleProtocols: (protocols) => (protocols.has(CLI_TUNNEL_SUBPROTOCOL) ? CLI_TUNNEL_SUBPROTOCOL : false) });
  const http = createServer((request, response) => {
    handle(request, response).catch(() => {
      send(response, 400, { error: { code: "bad-request", message: "The request didn't parse." } });
    });
  });
  http.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => undefined);
    const target = new URL(request.url ?? "/", "http://fake");
    const record = (status: number): void => {
      upgrades.push({ origin: request.headers.origin, protocol: first(request.headers["sec-websocket-protocol"]), status });
    };
    if (target.pathname !== CORE_CLI_TUNNEL_PATH || request.headers.origin !== undefined || request.headers["sec-websocket-protocol"]?.includes(CLI_TUNNEL_SUBPROTOCOL) !== true) {
      record(400);
      refuseUpgrade(socket, "bad-request");
      return;
    }
    const refusal = upgradeRefusals.shift();
    const ticket = tickets.find((candidate) => candidate.ticket === target.searchParams.get("ticket"));
    const code = refusal ?? (ticket === undefined || ticket.used ? "ticket-refused" : null);
    if (ticket !== undefined) {
      ticket.used = true;
    }
    if (code !== null || ticket === undefined) {
      record(tunnelStatus[code ?? "ticket-refused"]);
      refuseUpgrade(socket, code ?? "ticket-refused");
      return;
    }
    record(101);
    wss.handleUpgrade(request, socket, head, (ws) => {
      open.add(ws);
      ws.on("error", () => undefined);
      ws.on("close", (closeCode) => {
        open.delete(ws);
        closes.push(closeCode);
      });
      serve(ws, ticket.port);
    });
  });
  await new Promise<void>((resolve) => {
    http.listen(0, "127.0.0.1", resolve);
  });
  const address: AddressInfo | string | null = http.address();
  if (address === null || typeof address === "string") {
    throw new Error("the fake preview server has no port");
  }
  url = `http://127.0.0.1:${String(address.port)}`;
  const server: FakePreviewServer = {
    url,
    coreUrl: url,
    tasks,
    dial,
    addSession: () => {
      const token = `ostra_cli_${randomBytes(32).toString("base64url")}`;
      sessions.set(token, "live");
      return token;
    },
    sessions,
    upgradeRefusals,
    tickets,
    upgrades,
    requests,
    counts,
    boxRefuses,
    closes,
    openTunnels: () => open.size,
    endTunnels: (code) => {
      for (const ws of open) {
        if (code === 1006) {
          ws.terminate();
        } else {
          ws.close(code, "ended by the test");
        }
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of open) {
          ws.terminate();
        }
        wss.close();
        http.closeAllConnections();
        http.close(() => {
          resolve();
        });
      }),
  };
  return server;
};
