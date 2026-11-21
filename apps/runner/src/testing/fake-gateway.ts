import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  closeCodes,
  commandSchema,
  encodeDownFrame,
  negotiate,
  parseUpFrame,
  previewPaths,
  PROTOCOL_MINOR,
  replicaIdSchema,
  runnerLimits,
  runnerPaths,
} from "@ostra/protocol";
import type {
  Command,
  CommandAck,
  DownFrame,
  LiveTextFrame,
  RunnerEvent,
  RunnerEventFrame,
  SessionId,
  Status,
  UpFrame,
} from "@ostra/protocol";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { FakeServer } from "./fake-server.ts";

// A fake runner gateway (spec section 8: the runner's connection tests run against a fake gateway
// built from the protocol's schemas). It takes the WebSocket upgrade on the fake server, checks the
// access token, answers `hello` with `welcome`, stores events once per `(sessionId, sessionSeq)`
// and acks after storing, answers a gap with `resendFrom`, and records everything else the peer
// sends. Every frame is parsed with the protocol's parser, so a frame the real gateway would
// refuse fails the test.

export type FakeGatewayOptions = {
  readonly creditFrames?: number;
  readonly creditBytes?: number;
  /** The server's clock, for `welcome.serverTime` and `notAfter`. */
  readonly now?: () => number;
  /** Pings every open connection this often, as core does, except one gone silent. */
  readonly pingMs?: number;
  /** The server's minor (default this build's): an older server reads and writes its own minor's frames (ADR 0034). */
  readonly serverMinor?: number;
};

export type FakeGateway = {
  /** Events stored, by session, by session number. */
  readonly stored: Map<SessionId, Map<number, RunnerEvent>>;
  /** How many times each event arrived, stored or not. */
  readonly received: Map<string, number>;
  readonly acks: CommandAck[];
  readonly statuses: Status[];
  readonly liveText: LiveTextFrame[];
  /** Protocol minor 2: a runner's own events, outside any task (a snapshot's result). */
  readonly runnerEvents: RunnerEventFrame[];
  readonly hellos: Extract<UpFrame, { type: "hello" }>[];
  /** Frames the gateway refused: each is a bug in the peer. A test checks this stays empty. */
  readonly protocolErrors: string[];
  /** Frames seen per connection: the highest number of events frames in flight unacked. */
  readonly maxUnackedFrames: () => number;
  readonly connections: () => number;
  /**
   * The current connection is open and the peer has acted on its welcome: its first status arrived.
   * An open socket alone is not enough: a command sent before the welcome lands would be judged
   * without the server's clock.
   */
  readonly connected: () => boolean;
  /** Store but don't ack (a server that commits and then loses the connection). */
  holdAcks: boolean;
  /** Silently drop the next events frame, so the one after leaves a gap. */
  loseNextFrame: boolean;
  /** Sessions whose lease is stale: their events get `error { code: "stale-lease" }`. */
  readonly staleSessions: Set<SessionId>;
  readonly sendCommand: (command: Command) => void;
  readonly send: (frame: DownFrame) => void;
  /** Acks every stored event of a session (after `holdAcks`). */
  readonly ackStored: (sessionId: SessionId) => void;
  /** Kills the current connection without a close frame. */
  readonly drop: () => void;
  /** Closes the current connection with a code, as the real gateway does. */
  readonly closeWith: (code: number) => void;
  /** Refuse every upgrade from now on (the server is down). */
  refuseUpgrades: boolean;
  /** Take a hello, and answer nothing: a server still settling it when the peer gives up on it. */
  holdWelcomes: boolean;
  /**
   * The current connection goes half open: no more pings, and the gateway stops reading it, so it
   * never sees the peer close it, and holds it as open, as a server does when the network drops.
   */
  readonly goSilent: () => void;
  /**
   * What core does when it accepts a newer connection of the runner: `evict` with `replaced`, then
   * close with 4409, on every connection it still holds but the current one.
   */
  readonly evictOlder: () => void;
  readonly waitFor: (check: () => boolean, timeoutMs?: number) => Promise<void>;
  readonly close: () => Promise<void>;
};

export const makeCommand = (fields: {
  readonly seq: number;
  readonly id: string;
  readonly notAfter: number;
  readonly kind: Command["kind"];
  readonly body: unknown;
}): Command => commandSchema.parse({ type: "command", ...fields });

export const startFakeGateway = (server: FakeServer, options: FakeGatewayOptions = {}): FakeGateway => {
  const now = options.now ?? Date.now;
  const serverMinor = options.serverMinor ?? PROTOCOL_MINOR;
  // The minor each connection negotiated: its frames are read and written at it.
  const minors = new WeakMap<WebSocket, number>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: runnerLimits.frameMaxBytes });
  const stored = new Map<SessionId, Map<number, RunnerEvent>>();
  const received = new Map<string, number>();
  const acks: CommandAck[] = [];
  const statuses: Status[] = [];
  const liveText: LiveTextFrame[] = [];
  const runnerEvents: RunnerEventFrame[] = [];
  const hellos: Extract<UpFrame, { type: "hello" }>[] = [];
  const protocolErrors: string[] = [];
  let current: WebSocket | undefined;
  // The connection whose peer has sent its first status, which it does once it has the welcome.
  let welcomed: WebSocket | undefined;
  let connectionCount = 0;
  let unacked = 0;
  let maxUnacked = 0;
  // Each connection's TCP socket, and the connections gone half open.
  const rawSockets = new Map<WebSocket, Duplex>();
  const silent = new Set<WebSocket>();
  const pinger =
    options.pingMs === undefined
      ? undefined
      : setInterval(() => {
          for (const client of wss.clients) {
            if (client.readyState === 1 && !silent.has(client)) {
              client.ping();
            }
          }
        }, options.pingMs);

  const upTo = (sessionId: SessionId): number => {
    const events = stored.get(sessionId);
    let seq = 0;
    while (events?.has(seq + 1) === true) {
      seq += 1;
    }
    return seq;
  };

  const sendTo = (socket: WebSocket | undefined, frame: DownFrame): void => {
    if (socket?.readyState === 1) {
      socket.send(encodeDownFrame(frame, minors.get(socket) ?? serverMinor));
    }
  };

  const gateway: FakeGateway = {
    stored,
    received,
    acks,
    statuses,
    liveText,
    runnerEvents,
    hellos,
    protocolErrors,
    maxUnackedFrames: () => maxUnacked,
    connections: () => connectionCount,
    connected: () => current?.readyState === 1 && welcomed === current,
    holdAcks: false,
    loseNextFrame: false,
    staleSessions: new Set(),
    refuseUpgrades: false,
    holdWelcomes: false,
    goSilent: () => {
      if (current !== undefined) {
        silent.add(current);
        rawSockets.get(current)?.pause();
      }
    },
    evictOlder: () => {
      for (const client of wss.clients) {
        if (client !== current && client.readyState === 1) {
          sendTo(client, { type: "evict", reason: "replaced" });
          client.close(closeCodes.replaced, "replaced by a newer connection");
        }
      }
    },
    sendCommand: (command) => {
      sendTo(current, command);
    },
    send: (frame) => {
      sendTo(current, frame);
    },
    ackStored: (sessionId) => {
      unacked = 0;
      sendTo(current, { type: "ack", sessionId, upTo: upTo(sessionId) });
    },
    drop: () => {
      current?.terminate();
    },
    closeWith: (code) => {
      current?.close(code);
    },
    waitFor: async (check, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!check()) {
        if (Date.now() > deadline) {
          throw new Error("the fake gateway waited too long");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(pinger);
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close(() => {
          resolve();
        });
      }),
  };

  const onFrame = (socket: WebSocket, frame: UpFrame): void => {
    switch (frame.type) {
      case "hello": {
        hellos.push(frame);
        if (gateway.holdWelcomes) {
          return;
        }
        const negotiation = negotiate(serverMinor, frame.protocolMajor, frame.protocolMinor);
        if (!negotiation.ok) {
          sendTo(socket, { type: "error", code: "version-unsupported", message: "outside the window", supported: negotiation.window, serverMinor });
          socket.close(closeCodes.upgradeRequired);
          return;
        }
        minors.set(socket, negotiation.minor);
        sendTo(socket, {
          type: "welcome",
          minor: negotiation.minor,
          serverTime: now(),
          connectionEpoch: connectionCount,
          replicaId: replicaIdSchema.parse("replica-test"),
          pingMs: runnerLimits.pingMs,
          creditFrames: options.creditFrames ?? runnerLimits.creditFrames,
          creditBytes: options.creditBytes ?? runnerLimits.creditBytes,
          maxConnectionAgeMs: runnerLimits.maxConnectionAgeMs,
        });
        return;
      }
      case "events": {
        if (gateway.loseNextFrame) {
          gateway.loseNextFrame = false;
          return;
        }
        unacked += 1;
        maxUnacked = Math.max(maxUnacked, unacked);
        const touched = new Set<SessionId>();
        let gapAt: { readonly sessionId: SessionId; readonly from: number } | undefined;
        for (const item of frame.events) {
          const key = `${item.sessionId}#${String(item.sessionSeq)}`;
          received.set(key, (received.get(key) ?? 0) + 1);
          if (gateway.staleSessions.has(item.sessionId)) {
            sendTo(socket, { type: "error", code: "stale-lease", message: "the lease is stale", sessionId: item.sessionId, currentEpoch: item.leaseEpoch + 1 });
            return;
          }
          const events = stored.get(item.sessionId) ?? new Map<number, RunnerEvent>();
          stored.set(item.sessionId, events);
          const cursor = upTo(item.sessionId);
          if (item.sessionSeq > cursor + 1) {
            gapAt ??= { sessionId: item.sessionId, from: cursor + 1 };
            continue;
          }
          if (!events.has(item.sessionSeq)) {
            events.set(item.sessionSeq, item);
          }
          touched.add(item.sessionId);
        }
        if (gapAt !== undefined) {
          unacked = 0;
          sendTo(socket, { type: "ack", sessionId: gapAt.sessionId, upTo: upTo(gapAt.sessionId), resendFrom: gapAt.from });
          return;
        }
        if (!gateway.holdAcks) {
          unacked = 0;
          for (const sessionId of touched) {
            sendTo(socket, { type: "ack", sessionId, upTo: upTo(sessionId) });
          }
        }
        return;
      }
      case "command-ack":
        acks.push(frame);
        return;
      case "status":
        statuses.push(frame);
        welcomed = socket;
        return;
      case "live-text":
        liveText.push(...frame.frames);
        return;
      case "runner-event":
        runnerEvents.push(frame);
        return;
      default:
        frame satisfies never;
    }
  };

  server.httpServer.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Milestone 8: a view's preview connection is the fake core's (`fake-preview-core.ts`), when a test attaches it.
    if (request.url?.startsWith(previewPaths.connection) === true) {
      return;
    }
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") === true ? header.slice("Bearer ".length) : undefined;
    if (gateway.refuseUpgrades || request.url !== runnerPaths.connect) {
      socket.destroy();
      return;
    }
    if (token === undefined || !server.accessTokens.has(token)) {
      // As core refuses it: ostra's error body, so the runner reads it as ostra's answer, not a proxy's.
      const body = JSON.stringify({ error: { code: "unauthorized", message: "a valid access token is required" } });
      socket.end(`HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: ${String(Buffer.byteLength(body))}\r\n\r\n${body}`);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      connectionCount += 1;
      unacked = 0;
      current = ws;
      rawSockets.set(ws, socket);
      ws.once("close", () => {
        rawSockets.delete(ws);
        silent.delete(ws);
      });
      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          ws.close(closeCodes.protocolViolation);
          return;
        }
        const text = Buffer.isBuffer(data) ? data.toString("utf8") : Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(data).toString("utf8");
        const parsed = parseUpFrame(text, minors.get(ws) ?? serverMinor);
        if (!parsed.ok) {
          protocolErrors.push(parsed.error.detail);
          ws.close(closeCodes.protocolViolation, parsed.error.reason);
          return;
        }
        onFrame(ws, parsed.frame);
      });
    });
  });

  return gateway;
};
