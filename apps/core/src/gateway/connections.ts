import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { commandKindFromDb, commandResultToDb, mapCommandToFrame, notifyChannels, processContainmentToDb } from "@ostra/db";
import { awaitsApproval, notifyRunnerInTx, runnerFromColumns, runnerNotificationSchema, transitionRunner } from "@ostra/domain";
import type { RunnerInput, RunnerLifecycle } from "@ostra/domain";
import {
  closeCodes,
  commandIdSchema,
  commandSeqSchema,
  encodeDownFrame,
  negotiate,
  parseJson,
  parseUpFrame,
  PROTOCOL_MAJOR,
  runnerLimits,
  runnerIdSchema,
  runnerPaths,
  sessionIdSchema,
  taskIdSchema,
} from "@ostra/protocol";
import type { Ack, CommandAck, DownFrame, ErrorFrame, Hello, RunnerId, Status } from "@ostra/protocol";
import pg from "pg";
import { WebSocketServer } from "ws";
import type { RawData, WebSocket } from "ws";
import { z } from "zod";

import { bearerToken, runnerIsLive } from "./access-token.ts";
import type { AckedCommand, GatewayContext, RunnerRef } from "./context.ts";
import { databaseErrorCodes } from "./database-error.ts";

// The runner's WebSocket session (ADR 0034) on one replica of core. Ported from
// spikes/runner-transport/src/server/replica.ts:
// - the access token at the upgrade, then `hello`/`welcome` with the minor negotiated
// - the presence table with a connection epoch: a new connection evicts the old one with 4409,
//   on this replica directly and on the others through a NOTIFY
// - commands down from the outbox: after the peer's last applied seq on connect, then on each
//   NOTIFY for a runner this replica holds, and on a sweep every 2 s; acks advance the cursor
// - events, live text and command results handed to the hooks, one frame at a time per connection
// - ping every 20 s, dead after 45 s without a frame; revoke sends `evict` and closes with 4403

type Peer = {
  readonly runner: RunnerRef;
  readonly connectionEpoch: number;
  readonly minor: number;
  readonly ws: WebSocket;
  readonly openedAt: number;
  /** The highest command seq sent on this connection. */
  lastSent: number;
  lastFrameAt: number;
  delivering: boolean;
  deliverAgain: boolean;
  closed: boolean;
  goawaySent: boolean;
};

export type Connections = {
  readonly handleUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  /** Starts the LISTEN connection and the timers. */
  readonly start: () => Promise<void>;
  /** Asks every peer to reconnect elsewhere, and stops. */
  readonly stop: () => Promise<void>;
  /** The runners this replica holds a connection of. */
  readonly held: () => readonly RunnerId[];
  /** The last `status` a held runner sent. */
  readonly status: (runnerId: RunnerId) => Status | null;
};

const big = z.coerce.number().int();
const epochRowSchema = z.looseObject({ connectionEpoch: big });
const unackedRowSchema = z.looseObject({ runnerId: runnerIdSchema, max: big.nullable() });

const isClosed = (peer: Peer): boolean => peer.closed;

const rawText = (data: RawData): string => {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(new Uint8Array(data)).toString("utf8");
};

const rejectUpgrade = (socket: Duplex, status: 401 | 403 | 404 | 500, code: string, message: string): void => {
  const body = JSON.stringify({ error: { code, message } });
  const reason = { 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 500: "Internal Server Error" }[status];
  socket.end(
    `HTTP/1.1 ${String(status)} ${reason}\r\ncontent-type: application/json\r\ncontent-length: ${String(Buffer.byteLength(body))}\r\nconnection: close\r\n\r\n${body}`,
  );
};

/** Thrown to roll back a hello whose runner was rejected or revoked while it waited for the runner's row. */
const revokedWhileConnecting = new Error("the runner was revoked while it connected");

type HelloOutcome =
  | { readonly ok: true; readonly connectionEpoch: number; readonly minor: number; readonly acks: readonly Ack[] }
  | { readonly ok: false; readonly error: ErrorFrame; readonly close: number };

export type ConnectionsOptions = {
  readonly databaseUrl: string;
  /** `false`: no LISTEN connection, so commands go out on the sweep only (a test of the sweep). */
  readonly listen?: boolean;
};

export const createConnections = (context: GatewayContext, options: ConnectionsOptions): Connections => {
  const { db, logger, timers, hooks } = context;
  const now = (): number => context.ports.clock.now();
  const peers = new Map<RunnerId, Peer>();
  const statuses = new Map<RunnerId, Status>();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: runnerLimits.frameMaxBytes });
  let running = false;
  const pending = new Set<ReturnType<typeof setTimeout>>();
  let listener: pg.Client | null = null;

  const send = (peer: Peer, frame: DownFrame): void => {
    if (!peer.closed) {
      peer.ws.send(encodeDownFrame(frame, peer.minor));
    }
  };

  const closePeer = (peer: Peer, code: number, reason: string): void => {
    if (peer.closed) {
      return;
    }
    peer.closed = true;
    if (peers.get(peer.runner.runnerId) === peer) {
      peers.delete(peer.runner.runnerId);
    }
    peer.ws.close(code, reason);
    const timer = setTimeout(() => {
      peer.ws.terminate();
    }, 2_000);
    timer.unref();
  };

  // ---------- the runner's lifecycle ----------

  /** Moves a runner by `input` when its lifecycle allows it; a refusal changes nothing. */
  const moveRunner = (state: RunnerLifecycle, input: RunnerInput): RunnerLifecycle => {
    const moved = transitionRunner(state, input);
    return moved.ok ? moved.state : state;
  };

  // ---------- hello ----------

  const acceptHello = async (runner: RunnerRef, hello: Hello): Promise<HelloOutcome> => {
    if (hello.peer.kind !== "runner" || hello.peer.runnerId !== runner.runnerId) {
      return {
        ok: false,
        error: { type: "error", code: "unauthorized", message: "the access token and hello name different peers" },
        close: closeCodes.revoked,
      };
    }
    const negotiation = negotiate(context.serverMinor, hello.protocolMajor, hello.protocolMinor);
    if (!negotiation.ok) {
      const { window } = negotiation;
      return {
        ok: false,
        error: {
          type: "error",
          code: "version-unsupported",
          message:
            `This runner speaks protocol ${String(hello.protocolMajor)}.${String(hello.protocolMinor)}; this server speaks ` +
            `${String(PROTOCOL_MAJOR)}.${String(context.serverMinor)} and accepts ${String(PROTOCOL_MAJOR)}.${String(window.min)} ` +
            `to ${String(PROTOCOL_MAJOR)}.${String(window.max)}. Fix: install the runner version this server names ` +
            `(GET ${runnerPaths.info}, serverVersion ${context.serverVersion}), then start the runner again.`,
          supported: window,
          serverMinor: context.serverMinor,
        },
        close: closeCodes.upgradeRequired,
      };
    }
    const outcome = await db.$transaction(async (tx) => {
      const row = await tx.runner.findFirst({
        where: { id: runner.runnerId, organizationId: runner.organizationId },
        select: { state: true, revokedAt: true, commandSeq: true },
      });
      if (row?.revokedAt !== null || row.state === "revoked") {
        return null;
      }
      const epochs = await tx.$queryRaw<readonly unknown[]>`
        INSERT INTO "runner_presence" ("runnerId", "organizationId", "replicaId", "connectionEpoch", "carrier", "minor", "connectedAt", "lastSeenAt", "disconnectedAt")
        VALUES (${runner.runnerId}, ${runner.organizationId}, ${context.replicaId}, 1, ${hello.carrier}, ${negotiation.minor}, now(), now(), NULL)
        ON CONFLICT ("runnerId") DO UPDATE SET
          "replicaId" = EXCLUDED."replicaId",
          "connectionEpoch" = "runner_presence"."connectionEpoch" + 1,
          "carrier" = EXCLUDED."carrier",
          "minor" = EXCLUDED."minor",
          "connectedAt" = now(),
          "lastSeenAt" = now(),
          "disconnectedAt" = NULL
        RETURNING "connectionEpoch"`;
      const connectionEpoch = epochRowSchema.parse(epochs[0]).connectionEpoch;
      // Every other replica closes an older connection of this runner (4409).
      await notifyRunnerInTx(tx, { kind: "connected", runnerId: runner.runnerId, connectionEpoch });

      // The runner's row, locked after its presence (the order a close and an admin's approve keep),
      // read again: an approve that committed while this hello waited is seen here.
      await tx.$queryRaw`SELECT 1 FROM "runner" WHERE "id" = ${runner.runnerId} FOR UPDATE`;
      const current = await tx.runner.findFirst({
        where: { id: runner.runnerId, organizationId: runner.organizationId },
        select: { state: true, revokedAt: true, kind: true, approvedAt: true, pool: { select: { requiresApproval: true } } },
      });
      if (current?.revokedAt !== null || current.state === "revoked") {
        // Rejected or revoked while this hello waited: nothing of this connection is kept.
        throw revokedWhileConnecting;
      }
      const before = runnerFromColumns({ state: current.state });
      // A pool that requires approval keeps a joined runner `joining` until an admin approves it (Q130).
      const accept = !awaitsApproval({
        kind: current.kind,
        approvedAt: current.approvedAt,
        poolRequiresApproval: current.pool?.requiresApproval ?? false,
      });
      const state = before.ok ? moveRunner(accept ? moveRunner(before.value, { type: "accept" }) : before.value, { type: "reconnected" }) : null;
      await tx.runner.update({
        where: { id: runner.runnerId },
        data: { lastSeenAt: new Date(now()), version: hello.runnerVersion, ...(state === null ? {} : { state: state.state }) },
      });
      // What the peer says it applied is acked, up to what was ever sent.
      const appliedUpTo = Math.min(hello.lastCommandSeq, row.commandSeq);
      await tx.command.updateMany({
        where: { runnerId: runner.runnerId, organizationId: runner.organizationId, seq: { lte: appliedUpTo }, ackedAt: null },
        data: { ackedAt: new Date(now()) },
      });
      await tx.$executeRaw`
        UPDATE "runner" SET "ackedCommandSeq" = GREATEST("ackedCommandSeq", ${appliedUpTo})
        WHERE "id" = ${runner.runnerId} AND "organizationId" = ${runner.organizationId}`;

      const sessionIds = hello.sessions.map((session) => session.sessionId);
      const cursors =
        sessionIds.length === 0
          ? []
          : await tx.session.findMany({
              where: {
                id: { in: sessionIds },
                organizationId: runner.organizationId,
                task: { leases: { some: { runnerId: runner.runnerId, state: "active" } } },
              },
              select: { id: true, ingestedSeq: true },
            });
      const acks = cursors.map((cursor): Ack => ({ type: "ack", sessionId: sessionIdSchema.parse(cursor.id), upTo: cursor.ingestedSeq }));
      await hooks.onConnectedInTx(tx, runner);
      if (state !== null && state.state !== current.state) {
        await context.ports.notices.emitInTx(tx, {
          organizationId: runner.organizationId,
          projectId: null,
          entity: "runner",
          entityId: runner.runnerId,
        });
      }
      return { connectionEpoch, acks };
    }).catch((error: unknown) => {
      if (error === revokedWhileConnecting) {
        return null;
      }
      throw error;
    });
    if (outcome === null) {
      return {
        ok: false,
        error: { type: "error", code: "unauthorized", message: "this runner is revoked; register it again" },
        close: closeCodes.revoked,
      };
    }
    return { ok: true, connectionEpoch: outcome.connectionEpoch, minor: negotiation.minor, acks: outcome.acks };
  };

  // ---------- commands down ----------

  const deliver = async (peer: Peer): Promise<void> => {
    if (peer.delivering) {
      peer.deliverAgain = true;
      return;
    }
    peer.delivering = true;
    try {
      do {
        peer.deliverAgain = false;
        if (peer.closed) {
          return;
        }
        if (peer.ws.bufferedAmount > runnerLimits.creditBytes) {
          // Commands that wait stay in the table: nothing is lost.
          const timer = setTimeout(() => void deliver(peer), 100);
          timer.unref();
          return;
        }
        const rows = await db.command.findMany({
          where: { runnerId: peer.runner.runnerId, organizationId: peer.runner.organizationId, seq: { gt: peer.lastSent } },
          orderBy: { seq: "asc" },
          take: 200,
        });
        for (const row of rows) {
          // Read through a function: `closed` changes while the query awaits.
          if (isClosed(peer)) {
            break;
          }
          send(peer, mapCommandToFrame(row));
          peer.lastSent = row.seq;
        }
        if (rows.length === 200) {
          peer.deliverAgain = true;
        }
      } while (peer.deliverAgain);
    } catch (error) {
      logger.warn("gateway.deliver-failed", { runnerId: peer.runner.runnerId, error: error instanceof Error ? error.name : "unknown" });
    } finally {
      peer.delivering = false;
    }
  };

  const applyCommandAck = async (peer: Peer, ack: CommandAck): Promise<void> => {
    const { runner } = peer;
    const at = new Date(now());
    await db.$transaction(async (tx) => {
      await tx.command.updateMany({
        where: { runnerId: runner.runnerId, organizationId: runner.organizationId, seq: { lte: ack.upTo }, ackedAt: null },
        data: { ackedAt: at },
      });
      await tx.$executeRaw`
        UPDATE "runner" SET "ackedCommandSeq" = GREATEST("ackedCommandSeq", LEAST(${ack.upTo}, "commandSeq"))
        WHERE "id" = ${runner.runnerId} AND "organizationId" = ${runner.organizationId}`;
      const acked: AckedCommand[] = [];
      for (const result of ack.results) {
        // Scoped to the calling runner: a runner can't answer another runner's command.
        const row = await tx.command.findFirst({
          where: { id: result.id, runnerId: runner.runnerId, organizationId: runner.organizationId },
        });
        if (row?.seq !== result.seq) {
          logger.warn("gateway.command-ack-unknown", { runnerId: runner.runnerId, commandId: result.id });
          continue;
        }
        await tx.command.update({
          where: { id: row.id },
          data: { result: commandResultToDb[result.result], reason: result.reason ?? null, ackedAt: row.ackedAt ?? at },
        });
        acked.push({
          commandId: commandIdSchema.parse(row.id),
          seq: commandSeqSchema.parse(row.seq),
          kind: commandKindFromDb[row.kind],
          body: row.body,
          taskId: row.taskId === null ? null : taskIdSchema.parse(row.taskId),
          result: result.result,
          reason: result.reason ?? null,
        });
      }
      if (acked.length > 0) {
        await hooks.onCommandResultsInTx(tx, runner, acked);
      }
    });
  };

  const applyStatus = async (runner: RunnerRef, status: Status): Promise<void> => {
    statuses.set(runner.runnerId, status);
    const row = await db.runner.findFirst({
      where: { id: runner.runnerId, organizationId: runner.organizationId },
      select: { executor: true, capacity: true, labels: true, version: true, processContainment: true },
    });
    if (row === null) {
      return;
    }
    // A status without it (a sidecar, an older runner) keeps what the row says (ticket 42).
    const containment = status.processContainment === undefined ? row.processContainment : processContainmentToDb[status.processContainment];
    const changed =
      row.executor !== status.executor ||
      row.processContainment !== containment ||
      row.capacity !== status.capacity ||
      row.version !== status.version ||
      row.labels.length !== status.labels.length ||
      row.labels.some((label, index) => label !== status.labels[index]);
    // A change notice only when something changed, never per heartbeat.
    if (!changed) {
      return;
    }
    await db.$transaction(async (tx) => {
      await tx.runner.update({
        where: { id: runner.runnerId },
        data: { executor: status.executor, capacity: status.capacity, labels: [...status.labels], version: status.version, processContainment: containment },
      });
      await context.ports.notices.emitInTx(tx, {
        organizationId: runner.organizationId,
        projectId: null,
        entity: "runner",
        entityId: runner.runnerId,
      });
    });
  };

  // ---------- a connection ----------

  const markDisconnected = async (peer: Peer): Promise<void> => {
    const { runner } = peer;
    await db.$transaction(async (tx) => {
      // Only the runner's newest connection marks it gone: a replaced one leaves presence alone.
      const closed = await tx.$executeRaw`
        UPDATE "runner_presence" SET "disconnectedAt" = ${new Date(peer.lastFrameAt)}, "lastSeenAt" = ${new Date(peer.lastFrameAt)}
        WHERE "runnerId" = ${runner.runnerId} AND "connectionEpoch" = ${peer.connectionEpoch} AND "disconnectedAt" IS NULL`;
      if (closed === 0) {
        return;
      }
      // Locked after presence, as hello does: an admin's approve that holds it waits for this close.
      await tx.$queryRaw`SELECT 1 FROM "runner" WHERE "id" = ${runner.runnerId} FOR UPDATE`;
      const row = await tx.runner.findFirst({
        where: { id: runner.runnerId, organizationId: runner.organizationId },
        select: { state: true },
      });
      const before = row === null ? null : runnerFromColumns({ state: row.state });
      if (before?.ok === true) {
        const after = moveRunner(before.value, { type: "disconnected" });
        if (after.state !== before.value.state) {
          await tx.runner.update({ where: { id: runner.runnerId }, data: { state: after.state } });
          await context.ports.notices.emitInTx(tx, {
            organizationId: runner.organizationId,
            projectId: null,
            entity: "runner",
            entityId: runner.runnerId,
          });
        }
      }
      await hooks.onDisconnectedInTx(tx, runner);
    });
  };

  const onConnection = (ws: WebSocket, runner: RunnerRef): void => {
    let peer: Peer | undefined;
    let helloSeen = false;
    let chain: Promise<void> = Promise.resolve();
    const handshake = setTimeout(() => {
      if (!helloSeen) {
        ws.close(closeCodes.handshakeTimeout, "no hello in time");
      }
    }, timers.handshakeTimeoutMs);

    const violation = (detail: string): void => {
      logger.warn("gateway.protocol-violation", { runnerId: runner.runnerId, detail });
      const frame: ErrorFrame = { type: "error", code: "protocol-violation", message: detail };
      if (peer === undefined) {
        ws.send(encodeDownFrame(frame, context.serverMinor));
        ws.close(closeCodes.protocolViolation, "protocol violation");
      } else {
        send(peer, frame);
        closePeer(peer, closeCodes.protocolViolation, "protocol violation");
      }
    };

    const handleFrame = async (data: RawData, isBinary: boolean): Promise<void> => {
      if (peer?.closed === true || (peer === undefined && helloSeen)) {
        return;
      }
      if (isBinary) {
        violation("frames are JSON text");
        return;
      }
      const text = rawText(data);
      if (peer === undefined) {
        const parsed = parseUpFrame(text, context.serverMinor);
        if (!parsed.ok || parsed.frame.type !== "hello") {
          violation(parsed.ok ? "the first frame must be hello" : parsed.error.detail);
          return;
        }
        helloSeen = true;
        clearTimeout(handshake);
        const outcome = await acceptHello(runner, parsed.frame);
        if (!outcome.ok) {
          logger.info("gateway.hello-refused", {
            runnerId: runner.runnerId,
            code: outcome.error.code,
            minor: parsed.frame.protocolMinor,
          });
          ws.send(encodeDownFrame(outcome.error, context.serverMinor));
          ws.close(outcome.close, outcome.error.code);
          return;
        }
        const openedAt = now();
        const opened: Peer = {
          runner,
          connectionEpoch: outcome.connectionEpoch,
          minor: outcome.minor,
          ws,
          openedAt,
          lastSent: parsed.frame.lastCommandSeq,
          lastFrameAt: openedAt,
          delivering: false,
          deliverAgain: false,
          closed: false,
          goawaySent: false,
        };
        const old = peers.get(runner.runnerId);
        if (old !== undefined) {
          send(old, { type: "evict", reason: "replaced" });
          closePeer(old, closeCodes.replaced, "replaced by a newer connection");
        }
        peers.set(runner.runnerId, opened);
        peer = opened;
        send(opened, {
          type: "welcome",
          minor: outcome.minor,
          serverTime: now(),
          connectionEpoch: outcome.connectionEpoch,
          replicaId: context.replicaId,
          pingMs: timers.pingMs,
          creditFrames: runnerLimits.creditFrames,
          creditBytes: runnerLimits.creditBytes,
          maxConnectionAgeMs: timers.maxConnectionAgeMs,
        });
        for (const ack of outcome.acks) {
          send(opened, ack);
        }
        logger.info("gateway.peer-open", {
          runnerId: runner.runnerId,
          organizationId: runner.organizationId,
          connectionEpoch: outcome.connectionEpoch,
          minor: outcome.minor,
        });
        await deliver(opened);
        return;
      }
      const parsed = parseUpFrame(text, peer.minor);
      if (!parsed.ok) {
        violation(parsed.error.detail);
        return;
      }
      const frame = parsed.frame;
      switch (frame.type) {
        case "hello":
          violation("hello was already sent");
          return;
        case "events": {
          const replies = await hooks.ingest(runner, frame);
          // Sent only after the batch committed.
          for (const reply of replies) {
            send(peer, reply);
          }
          return;
        }
        case "command-ack":
          await applyCommandAck(peer, frame);
          return;
        case "status":
          await applyStatus(runner, frame);
          return;
        case "live-text":
          await hooks.liveText(runner, frame);
          return;
        case "runner-event":
          // Protocol minor 2: a snapshot's result outside a task. Ticket 26 records it; until then
          // it's logged by kind only, and the runner reports it again with the command's resend.
          logger.info("gateway.runner-event", { runnerId: runner.runnerId, kind: frame.event.kind });
          return;
        default:
          frame satisfies never;
      }
    };

    ws.on("message", (data, isBinary) => {
      if (peer !== undefined) {
        peer.lastFrameAt = now();
      }
      // One frame at a time per connection: one batch in flight per runner.
      chain = chain
        .then(() => handleFrame(data, isBinary))
        .catch((error: unknown) => {
          // A database error's code (Prisma's P-codes, Postgres' SQLSTATE) says what failed without content.
          const { code, sqlState } = databaseErrorCodes(error);
          logger.error("gateway.frame-failed", {
            runnerId: runner.runnerId,
            error: error instanceof Error ? error.name : "unknown",
            ...(code === undefined ? {} : { code }),
            ...(sqlState === undefined ? {} : { sqlState }),
          });
          ws.close(1011, "internal error");
        });
    });
    ws.on("pong", () => {
      if (peer !== undefined) {
        peer.lastFrameAt = now();
      }
    });
    ws.on("error", () => undefined);
    ws.on("close", (code) => {
      clearTimeout(handshake);
      const closing = peer;
      if (closing === undefined) {
        return;
      }
      closing.closed = true;
      if (peers.get(runner.runnerId) === closing) {
        peers.delete(runner.runnerId);
      }
      statuses.delete(runner.runnerId);
      logger.info("gateway.peer-close", { runnerId: runner.runnerId, connectionEpoch: closing.connectionEpoch, code });
      // After the frames already in flight, so a batch that arrived before the close is saved first.
      chain = chain
        .then(() => markDisconnected(closing))
        .catch((error: unknown) => {
          logger.warn("gateway.disconnect-failed", { runnerId: runner.runnerId, error: error instanceof Error ? error.name : "unknown" });
        });
    });
  };

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(request.url ?? "/", "http://ostra.invalid");
    if (url.pathname !== runnerPaths.connect) {
      rejectUpgrade(socket, 404, "not-found", "no such route");
      return;
    }
    const token = bearerToken(request.headers.authorization);
    const claims = token === null ? null : context.tokens.verify(token, now());
    if (claims === null) {
      rejectUpgrade(socket, 401, "unauthorized", "a valid access token is required (POST /runner/v1/token)");
      return;
    }
    const runner: RunnerRef = { runnerId: claims.runnerId, organizationId: claims.organizationId };
    runnerIsLive(db, runner)
      .then((live) => {
        if (!live) {
          rejectUpgrade(socket, 403, "unauthorized", "this runner is revoked; register it again");
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
          onConnection(ws, runner);
        });
      })
      .catch(() => {
        rejectUpgrade(socket, 500, "internal", "internal error");
      });
  };

  // ---------- LISTEN, sweep, presence, ping ----------

  const evict = (peer: Peer, reason: "revoked" | "replaced"): void => {
    send(peer, { type: "evict", reason });
    closePeer(peer, reason === "revoked" ? closeCodes.revoked : closeCodes.replaced, reason);
    logger.info("gateway.evicted", { runnerId: peer.runner.runnerId, reason });
  };

  const onNotification = (payload: string | undefined): void => {
    const json = parseJson(payload ?? "");
    const notification = json.ok ? runnerNotificationSchema.safeParse(json.value) : undefined;
    if (notification?.success !== true) {
      return;
    }
    // Every replica listens and ignores the runners it doesn't hold.
    const peer = peers.get(notification.data.runnerId);
    if (peer === undefined) {
      return;
    }
    switch (notification.data.kind) {
      case "command":
        void deliver(peer);
        return;
      case "connected":
        if (peer.connectionEpoch < notification.data.connectionEpoch) {
          evict(peer, "replaced");
        }
        return;
      case "revoked":
        evict(peer, "revoked");
        return;
      default:
        notification.data satisfies never;
    }
  };

  const listen = async (): Promise<void> => {
    const client = new pg.Client({ connectionString: options.databaseUrl });
    client.on("notification", (message) => {
      if (message.channel === notifyChannels.runner) {
        onNotification(message.payload);
      }
    });
    client.on("error", () => {
      if (listener === client) {
        listener = null;
      }
      logger.warn("gateway.listen-lost", {});
      client.end().catch(() => undefined);
      if (running) {
        later(1_000, async () => {
          await listen();
          await sweep();
        });
      }
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${notifyChannels.runner}`);
      listener = client;
    } catch {
      client.end().catch(() => undefined);
      if (running) {
        later(1_000, listen);
      }
    }
  };

  const sweep = async (): Promise<void> => {
    const ids = [...peers.keys()];
    if (ids.length === 0) {
      return;
    }
    // A missed NOTIFY: commands past what each peer was sent.
    const unacked = await db.$queryRaw<readonly unknown[]>`
      SELECT "runnerId", max("seq") AS "max" FROM "command"
      WHERE "runnerId" = ANY(${ids}::text[]) AND "ackedAt" IS NULL GROUP BY "runnerId"`;
    for (const raw of unacked) {
      const row = unackedRowSchema.safeParse(raw);
      const peer = row.success ? peers.get(row.data.runnerId) : undefined;
      if (row.success && peer !== undefined && (row.data.max ?? 0) > peer.lastSent) {
        void deliver(peer);
      }
    }
    // A missed revoke.
    const revoked = await db.runner.findMany({
      where: { id: { in: ids }, OR: [{ state: "revoked" }, { revokedAt: { not: null } }] },
      select: { id: true },
    });
    for (const row of revoked) {
      const peer = peers.get(runnerIdSchema.parse(row.id));
      if (peer !== undefined) {
        evict(peer, "revoked");
      }
    }
  };

  const writePresence = async (): Promise<void> => {
    const held = [...peers.values()].filter((peer) => !peer.closed);
    for (const peer of held) {
      await db.$executeRaw`
        UPDATE "runner_presence" SET "lastSeenAt" = now()
        WHERE "runnerId" = ${peer.runner.runnerId} AND "connectionEpoch" = ${peer.connectionEpoch} AND "disconnectedAt" IS NULL`;
    }
    if (held.length > 0) {
      await db.runner.updateMany({ where: { id: { in: held.map((peer) => peer.runner.runnerId) } }, data: { lastSeenAt: new Date(now()) } });
    }
  };

  const ping = (): Promise<void> => {
    const at = now();
    for (const peer of peers.values()) {
      if (peer.closed) {
        continue;
      }
      if (at - peer.lastFrameAt > timers.deadMs) {
        logger.info("gateway.peer-dead", { runnerId: peer.runner.runnerId, connectionEpoch: peer.connectionEpoch });
        peer.ws.terminate();
        continue;
      }
      if (!peer.goawaySent && at - peer.openedAt > timers.maxConnectionAgeMs) {
        peer.goawaySent = true;
        send(peer, { type: "goaway", reconnectAfterMs: Math.floor(Math.random() * 5_000), reason: "max-age" });
      }
      peer.ws.ping();
    }
    return Promise.resolve();
  };

  const later = (ms: number, work: () => Promise<void>): void => {
    const timer = setTimeout(() => {
      pending.delete(timer);
      work().catch((error: unknown) => {
        logger.warn("gateway.timer-failed", { error: error instanceof Error ? error.name : "unknown" });
      });
    }, ms);
    pending.add(timer);
  };

  const every = (ms: number, work: () => Promise<void>): void => {
    const tick = (): void => {
      if (!running) {
        return;
      }
      later(ms, async () => {
        try {
          await work();
        } finally {
          tick();
        }
      });
    };
    tick();
  };

  return {
    handleUpgrade,
    start: async () => {
      running = true;
      if (options.listen !== false) {
        await listen();
      }
      every(timers.sweepMs, sweep);
      every(timers.presenceMs, writePresence);
      every(timers.pingMs, ping);
    },
    stop: async () => {
      running = false;
      for (const timer of pending) {
        clearTimeout(timer);
      }
      pending.clear();
      for (const peer of [...peers.values()]) {
        send(peer, { type: "goaway", reconnectAfterMs: Math.floor(Math.random() * 5_000), reason: "draining" });
        closePeer(peer, closeCodes.draining, "the server is stopping");
      }
      const client = listener;
      listener = null;
      await client?.end().catch(() => undefined);
      await new Promise<void>((resolve) => {
        wss.close(() => {
          resolve();
        });
      });
    },
    held: () => [...peers.keys()],
    status: (runnerId) => statuses.get(runnerId) ?? null,
  };
};
