import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { commandKindFromDb, commandResultToDb } from "@ostra/db";
import { notifyRunnerInTx } from "@ostra/domain";
import {
  closeCodes,
  commandIdSchema,
  commandSchema,
  commandSeqSchema,
  encodeDownFrame,
  negotiate,
  parseUpFrame,
  runnerLimits,
  sessionIdSchema,
  taskIdSchema,
} from "@ostra/protocol";
import type { Ack, BoxId, CommandAck, DownFrame, ErrorFrame, Hello, SessionId } from "@ostra/protocol";
import { WebSocketServer } from "ws";
import type { RawData, WebSocket } from "ws";
import { z } from "zod";

import type { AckedCommand, GatewayContext, RunnerRef, SidecarLease } from "./context.ts";
import { databaseErrorCodes } from "./database-error.ts";
import { checkTaskLease } from "./task-token.ts";
import type { TaskTokenClaims } from "./task-token.ts";

// A `docker` or `kubernetes` box's sidecar as its own peer (ADR 0034, Q129, milestone 1's ticket
// 41). It connects with its task token, not the runner's: the token names one lease, and every use
// reads it. Its presence and connection epoch are the box's own (a second connection of the box
// evicts the first with 4409), and so is its command numbering: the task's `steer`, `interrupt`,
// `stop` and approval answers go to it, not to the runner. From it, core takes events, live text
// and command results for its own task's sessions only. The task's grace (F-045) starts when its
// sidecar's connection goes, not its runner's: a pool runner that stops or upgrades doesn't touch
// its boxes' tasks. Never logged: the token. Logged: IDs.

type SidecarPeer = {
  readonly lease: SidecarLease;
  /** The lease's runner, as ingest and the reactions take it. */
  readonly runner: RunnerRef;
  readonly connectionEpoch: number;
  readonly minor: number;
  readonly ws: WebSocket;
  lastSent: number;
  lastFrameAt: number;
  delivering: boolean;
  deliverAgain: boolean;
  closed: boolean;
};

export type Sidecars = {
  /** Upgrades a connection whose bearer is a task token. */
  readonly handleUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer, token: string) => void;
  /** A `sidecar-command` or `sidecar-connected` notification, from any replica. */
  readonly onNotification: (notification: { readonly kind: "sidecar-command"; readonly boxId: BoxId } | { readonly kind: "sidecar-connected"; readonly boxId: BoxId; readonly connectionEpoch: number }) => void;
  /** Catches a missed notification, and closes a sidecar whose lease ended. */
  readonly sweep: () => Promise<void>;
  readonly writePresence: () => Promise<void>;
  readonly ping: () => void;
  readonly stop: () => Promise<void>;
  /** The boxes whose sidecar this replica holds. */
  readonly held: () => readonly BoxId[];
};

const epochRowSchema = z.looseObject({ sidecarConnectionEpoch: z.coerce.number().int() });

const rawText = (data: RawData): string => {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(new Uint8Array(data)).toString("utf8");
};

const rejectUpgrade = (socket: Duplex, status: 401 | 403 | 404 | 409 | 500, body: Record<string, unknown>): void => {
  const text = JSON.stringify({ error: body });
  const reason = { 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 409: "Conflict", 500: "Internal Server Error" }[status];
  socket.end(
    `HTTP/1.1 ${String(status)} ${reason}\r\ncontent-type: application/json\r\ncontent-length: ${String(Buffer.byteLength(text))}\r\nconnection: close\r\n\r\n${text}`,
  );
};

const leaseOf = (claims: TaskTokenClaims): SidecarLease => ({
  organizationId: claims.organizationId,
  taskId: claims.taskId,
  leaseEpoch: claims.leaseEpoch,
  boxId: claims.boxId,
  runnerId: claims.runnerId,
});

const isClosed = (peer: SidecarPeer): boolean => peer.closed;

export const createSidecars = (context: GatewayContext): Sidecars => {
  const { db, logger, timers, hooks } = context;
  const now = (): number => context.ports.clock.now();
  const peers = new Map<BoxId, SidecarPeer>();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: runnerLimits.frameMaxBytes });

  const send = (peer: SidecarPeer, frame: DownFrame): void => {
    if (!peer.closed) {
      peer.ws.send(encodeDownFrame(frame, peer.minor));
    }
  };

  const closePeer = (peer: SidecarPeer, code: number, reason: string): void => {
    if (peer.closed) {
      return;
    }
    peer.closed = true;
    if (peers.get(peer.lease.boxId) === peer) {
      peers.delete(peer.lease.boxId);
    }
    peer.ws.close(code, reason);
    const timer = setTimeout(() => {
      peer.ws.terminate();
    }, 2_000);
    timer.unref();
  };

  /** The stale-lease answer on the socket, and the close: the sidecar doesn't come back. */
  const endStale = (peer: SidecarPeer, currentEpoch: number | undefined): void => {
    const frame: ErrorFrame = {
      type: "error",
      code: "stale-lease",
      message: "this task token's lease has ended",
      ...(currentEpoch === undefined || currentEpoch < 1 ? {} : { currentEpoch }),
    };
    send(peer, frame);
    closePeer(peer, closeCodes.revoked, "stale-lease");
    logger.info("gateway.sidecar-stale", { taskId: peer.lease.taskId, boxId: peer.lease.boxId, leaseEpoch: peer.lease.leaseEpoch });
  };

  /** Whether every session named is its own task's: a sidecar speaks for nothing else. */
  const ownSessions = async (peer: SidecarPeer, sessionIds: readonly SessionId[]): Promise<boolean> => {
    const unique = [...new Set(sessionIds)];
    if (unique.length === 0) {
      return true;
    }
    const count = await db.session.count({
      where: { id: { in: unique }, taskId: peer.lease.taskId, organizationId: peer.lease.organizationId },
    });
    return count === unique.length;
  };

  // ---------- hello ----------

  type HelloOutcome =
    | { readonly ok: true; readonly connectionEpoch: number; readonly minor: number; readonly acks: readonly Ack[] }
    | { readonly ok: false; readonly error: ErrorFrame; readonly close: number };

  const acceptHello = async (lease: SidecarLease, hello: Hello): Promise<HelloOutcome> => {
    const peer = hello.peer;
    if (peer.kind !== "sidecar" || peer.taskId !== lease.taskId || peer.boxId !== lease.boxId || peer.leaseEpoch !== lease.leaseEpoch) {
      return {
        ok: false,
        error: { type: "error", code: "unauthorized", message: "the task token and hello name different peers" },
        close: closeCodes.revoked,
      };
    }
    const negotiation = negotiate(context.serverMinor, hello.protocolMajor, hello.protocolMinor);
    if (!negotiation.ok) {
      return {
        ok: false,
        error: {
          type: "error",
          code: "version-unsupported",
          message: "this sidecar's protocol is outside the server's window",
          supported: negotiation.window,
          serverMinor: context.serverMinor,
        },
        close: closeCodes.upgradeRequired,
      };
    }
    const outcome = await db.$transaction(async (tx) => {
      const check = await checkTaskLease(tx, lease);
      if (!check.ok) {
        return { stale: true as const, currentEpoch: check.error === "stale-lease" ? check.currentEpoch : undefined };
      }
      const epochs = await tx.$queryRaw<readonly unknown[]>`
        UPDATE "box" SET "sidecarConnectionEpoch" = "sidecarConnectionEpoch" + 1, "sidecarReplicaId" = ${context.replicaId},
          "sidecarConnectedAt" = now(), "sidecarLastSeenAt" = now(), "sidecarDisconnectedAt" = NULL
        WHERE "id" = ${lease.boxId} AND "organizationId" = ${lease.organizationId}
        RETURNING "sidecarConnectionEpoch"`;
      const connectionEpoch = epochRowSchema.parse(epochs[0]).sidecarConnectionEpoch;
      // Every other replica closes an older connection of this box (4409).
      await notifyRunnerInTx(tx, { kind: "sidecar-connected", boxId: lease.boxId, connectionEpoch });
      // What the sidecar says it applied is acked.
      await tx.sidecarCommand.updateMany({
        where: { boxId: lease.boxId, organizationId: lease.organizationId, seq: { lte: hello.lastCommandSeq }, ackedAt: null },
        data: { ackedAt: new Date(now()) },
      });
      const sessionIds = hello.sessions.map((session) => session.sessionId);
      const cursors =
        sessionIds.length === 0
          ? []
          : await tx.session.findMany({
              where: { id: { in: sessionIds }, organizationId: lease.organizationId, taskId: lease.taskId },
              select: { id: true, ingestedSeq: true },
            });
      const acks = cursors.map((cursor): Ack => ({ type: "ack", sessionId: sessionIdSchema.parse(cursor.id), upTo: cursor.ingestedSeq }));
      await hooks.onSidecarConnectedInTx(tx, lease);
      return { stale: false as const, connectionEpoch, acks };
    });
    if (outcome.stale) {
      return {
        ok: false,
        error: {
          type: "error",
          code: "stale-lease",
          message: "this task token's lease has ended",
          ...(outcome.currentEpoch === undefined || outcome.currentEpoch < 1 ? {} : { currentEpoch: outcome.currentEpoch }),
        },
        close: closeCodes.revoked,
      };
    }
    return { ok: true, connectionEpoch: outcome.connectionEpoch, minor: negotiation.minor, acks: outcome.acks };
  };

  // ---------- commands down ----------

  const deliver = async (peer: SidecarPeer): Promise<void> => {
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
        const rows = await db.sidecarCommand.findMany({
          where: { boxId: peer.lease.boxId, organizationId: peer.lease.organizationId, seq: { gt: peer.lastSent } },
          orderBy: { seq: "asc" },
          take: 200,
        });
        for (const row of rows) {
          if (isClosed(peer)) {
            break;
          }
          send(
            peer,
            commandSchema.parse({
              type: "command",
              seq: row.seq,
              id: commandIdSchema.parse(row.id),
              notAfter: row.notAfter.getTime(),
              kind: commandKindFromDb[row.kind],
              body: row.body,
            }),
          );
          peer.lastSent = row.seq;
        }
        if (rows.length === 200) {
          peer.deliverAgain = true;
        }
      } while (peer.deliverAgain);
    } catch (error) {
      logger.warn("gateway.sidecar-deliver-failed", { boxId: peer.lease.boxId, error: error instanceof Error ? error.name : "unknown" });
    } finally {
      peer.delivering = false;
    }
  };

  const applyCommandAck = async (peer: SidecarPeer, ack: CommandAck): Promise<void> => {
    const { lease } = peer;
    const at = new Date(now());
    await db.$transaction(async (tx) => {
      await tx.sidecarCommand.updateMany({
        where: { boxId: lease.boxId, organizationId: lease.organizationId, seq: { lte: ack.upTo }, ackedAt: null },
        data: { ackedAt: at },
      });
      const acked: AckedCommand[] = [];
      for (const result of ack.results) {
        // Scoped to the calling box: a sidecar can't answer another box's command.
        const row = await tx.sidecarCommand.findFirst({ where: { id: result.id, boxId: lease.boxId, organizationId: lease.organizationId } });
        if (row?.seq !== result.seq) {
          logger.warn("gateway.sidecar-command-ack-unknown", { boxId: lease.boxId, commandId: result.id });
          continue;
        }
        await tx.sidecarCommand.update({
          where: { id: row.id },
          data: { result: commandResultToDb[result.result], reason: result.reason ?? null, ackedAt: row.ackedAt ?? at },
        });
        acked.push({
          commandId: commandIdSchema.parse(row.id),
          seq: commandSeqSchema.parse(row.seq),
          kind: commandKindFromDb[row.kind],
          body: row.body,
          taskId: taskIdSchema.parse(row.taskId),
          result: result.result,
          reason: result.reason ?? null,
        });
      }
      if (acked.length > 0) {
        await hooks.onCommandResultsInTx(tx, peer.runner, acked);
      }
    });
  };

  // ---------- a connection ----------

  const markDisconnected = async (peer: SidecarPeer): Promise<void> => {
    await db.$transaction(async (tx) => {
      // Only the box's newest connection marks it gone: a replaced one leaves presence alone.
      const closed = await tx.$executeRaw`
        UPDATE "box" SET "sidecarDisconnectedAt" = ${new Date(peer.lastFrameAt)}, "sidecarLastSeenAt" = ${new Date(peer.lastFrameAt)}
        WHERE "id" = ${peer.lease.boxId} AND "sidecarConnectionEpoch" = ${peer.connectionEpoch} AND "sidecarDisconnectedAt" IS NULL`;
      if (closed === 0) {
        return;
      }
      await hooks.onSidecarDisconnectedInTx(tx, peer.lease);
    });
  };

  const onConnection = (ws: WebSocket, lease: SidecarLease): void => {
    const runner: RunnerRef = { runnerId: lease.runnerId, organizationId: lease.organizationId };
    const ids = { taskId: lease.taskId, boxId: lease.boxId, leaseEpoch: lease.leaseEpoch };
    let peer: SidecarPeer | undefined;
    let helloSeen = false;
    let chain: Promise<void> = Promise.resolve();
    const handshake = setTimeout(() => {
      if (!helloSeen) {
        ws.close(closeCodes.handshakeTimeout, "no hello in time");
      }
    }, timers.handshakeTimeoutMs);

    const violation = (detail: string): void => {
      logger.warn("gateway.sidecar-protocol-violation", { ...ids, detail });
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
        const outcome = await acceptHello(lease, parsed.frame);
        if (!outcome.ok) {
          logger.info("gateway.sidecar-hello-refused", { ...ids, code: outcome.error.code });
          ws.send(encodeDownFrame(outcome.error, context.serverMinor));
          ws.close(outcome.close, outcome.error.code);
          return;
        }
        const openedAt = now();
        const opened: SidecarPeer = {
          lease,
          runner,
          connectionEpoch: outcome.connectionEpoch,
          minor: outcome.minor,
          ws,
          lastSent: parsed.frame.lastCommandSeq,
          lastFrameAt: openedAt,
          delivering: false,
          deliverAgain: false,
          closed: false,
        };
        const old = peers.get(lease.boxId);
        if (old !== undefined) {
          send(old, { type: "evict", reason: "replaced" });
          closePeer(old, closeCodes.replaced, "replaced by a newer connection");
        }
        peers.set(lease.boxId, opened);
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
        logger.info("gateway.sidecar-open", { ...ids, organizationId: lease.organizationId, connectionEpoch: outcome.connectionEpoch });
        await deliver(opened);
        return;
      }
      const parsed = parseUpFrame(text, peer.minor);
      if (!parsed.ok) {
        violation(parsed.error.detail);
        return;
      }
      const frame = parsed.frame;
      if (frame.type === "hello") {
        violation("hello was already sent");
        return;
      }
      // Every use reads the lease: a sidecar whose lease ended gets the stale-lease error and goes.
      const check = await checkTaskLease(db, lease);
      if (!check.ok) {
        endStale(peer, check.error === "stale-lease" ? check.currentEpoch : undefined);
        return;
      }
      switch (frame.type) {
        case "events": {
          if (!(await ownSessions(peer, frame.events.map((item) => item.sessionId)))) {
            violation("a sidecar sends its own task's events only");
            return;
          }
          const replies = await hooks.ingest(runner, frame);
          for (const reply of replies) {
            send(peer, reply);
          }
          return;
        }
        case "command-ack":
          await applyCommandAck(peer, frame);
          return;
        case "status":
          // One task's sidecar: its status says nothing the runner's doesn't.
          return;
        case "live-text":
          if (!(await ownSessions(peer, frame.frames.map((item) => item.sessionId)))) {
            violation("a sidecar sends its own task's live text only");
            return;
          }
          await hooks.liveText(runner, frame);
          return;
        case "runner-event":
          // Protocol minor 2: an event outside a task (a snapshot's result) is a runner's, never a sidecar's.
          violation("a sidecar sends its own task's events only");
          return;
        default:
          frame satisfies never;
      }
    };

    ws.on("message", (data, isBinary) => {
      if (peer !== undefined) {
        peer.lastFrameAt = now();
      }
      chain = chain
        .then(() => handleFrame(data, isBinary))
        .catch((error: unknown) => {
          const { code, sqlState } = databaseErrorCodes(error);
          logger.error("gateway.sidecar-frame-failed", {
            ...ids,
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
      if (peers.get(lease.boxId) === closing) {
        peers.delete(lease.boxId);
      }
      logger.info("gateway.sidecar-closed", { ...ids, connectionEpoch: closing.connectionEpoch, code });
      chain
        .then(() => markDisconnected(closing))
        .catch((error: unknown) => {
          logger.warn("gateway.sidecar-disconnect-failed", { ...ids, error: error instanceof Error ? error.name : "unknown" });
        });
    });
  };

  return {
    handleUpgrade: (request, socket, head, token) => {
      const claims = context.taskTokens.verify(token);
      if (claims === null) {
        rejectUpgrade(socket, 401, { code: "unauthorized", message: "the task token is not valid" });
        return;
      }
      checkTaskLease(db, claims)
        .then((check) => {
          if (!check.ok) {
            if (check.error === "not-found") {
              rejectUpgrade(socket, 404, { code: "not-found", message: "no such task" });
            } else {
              rejectUpgrade(socket, 409, { code: "stale-lease", message: "this task token's lease has ended", currentEpoch: check.currentEpoch });
            }
            return;
          }
          wss.handleUpgrade(request, socket, head, (ws) => {
            onConnection(ws, leaseOf(claims));
          });
        })
        .catch(() => {
          rejectUpgrade(socket, 500, { code: "internal", message: "internal error" });
        });
    },
    onNotification: (notification) => {
      const peer = peers.get(notification.boxId);
      if (peer === undefined) {
        return;
      }
      switch (notification.kind) {
        case "sidecar-command":
          void deliver(peer);
          return;
        case "sidecar-connected":
          if (peer.connectionEpoch < notification.connectionEpoch) {
            send(peer, { type: "evict", reason: "replaced" });
            closePeer(peer, closeCodes.replaced, "replaced");
          }
          return;
        default:
          notification satisfies never;
      }
    },
    sweep: async () => {
      for (const peer of [...peers.values()]) {
        if (peer.closed) {
          continue;
        }
        const check = await checkTaskLease(db, peer.lease);
        if (!check.ok) {
          endStale(peer, check.error === "stale-lease" ? check.currentEpoch : undefined);
          continue;
        }
        const pending = await db.sidecarCommand.count({ where: { boxId: peer.lease.boxId, seq: { gt: peer.lastSent } } });
        if (pending > 0) {
          void deliver(peer);
        }
      }
    },
    writePresence: async () => {
      const held = [...peers.values()].filter((peer) => !peer.closed);
      for (const peer of held) {
        await db.$executeRaw`
          UPDATE "box" SET "sidecarLastSeenAt" = now()
          WHERE "id" = ${peer.lease.boxId} AND "sidecarConnectionEpoch" = ${peer.connectionEpoch} AND "sidecarDisconnectedAt" IS NULL`;
      }
    },
    ping: () => {
      const at = now();
      for (const peer of peers.values()) {
        if (peer.closed) {
          continue;
        }
        if (at - peer.lastFrameAt > timers.deadMs) {
          logger.info("gateway.sidecar-dead", { boxId: peer.lease.boxId, connectionEpoch: peer.connectionEpoch });
          peer.ws.terminate();
          continue;
        }
        peer.ws.ping();
      }
    },
    stop: async () => {
      for (const peer of [...peers.values()]) {
        send(peer, { type: "goaway", reconnectAfterMs: Math.floor(Math.random() * 5_000), reason: "draining" });
        closePeer(peer, closeCodes.draining, "the server is stopping");
      }
      await new Promise<void>((resolve) => {
        wss.close(() => {
          resolve();
        });
      });
    },
    held: () => [...peers.keys()],
  };
};
