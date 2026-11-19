import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { commandKindFromDb, commandResultToDb, mapCommandToFrame, notifyChannels } from "@ostra/db";
import type { Tx } from "@ostra/db";
import { awaitsApproval, enqueueRunnerAdmissionInTx, notifyRunnerInTx, recordRunnerReport, runnerFromColumns, runnerNotificationSchema, transitionRunner } from "@ostra/domain";
import type { RunnerInput, RunnerLifecycle, RunnerReportWithContainment } from "@ostra/domain";
import {
  closeCodes,
  commandIdSchema,
  commandSeqSchema,
  encodeDownFrame,
  minorWindow,
  negotiate,
  parseJson,
  parseUpFrame,
  isReservedLabel,
  PROTOCOL_MAJOR,
  refuseHelloExecutor,
  runnerLimits,
  organizationIdSchema,
  runnerIdSchema,
  runnerPaths,
  sessionIdSchema,
  taskIdSchema,
} from "@ostra/protocol";
import type { Ack, CommandAck, DownFrame, ErrorFrame, Hello, RunnerId, Status, UpFrame } from "@ostra/protocol";
import pg from "pg";
import { WebSocketServer } from "ws";
import type { RawData, WebSocket } from "ws";
import { z } from "zod";

import { salvageEventsFrame } from "../ingest/ingest.ts";
import { bearerToken, runnerIsLive } from "./access-token.ts";
import type { AckedCommand, GatewayContext, RunnerRef } from "./context.ts";
import { databaseErrorCodes } from "./database-error.ts";
import { createHttpCarrier } from "./http-carrier.ts";
import type { CarrierSession } from "./http-carrier.ts";
import { createSidecars } from "./sidecars.ts";
import { isTaskToken } from "./task-token.ts";

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
  /** The HTTP carrier's `hello`, `up` and `down` (milestone 5); `false` for any other path. */
  readonly handleHttp: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean>;
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
  const sidecars = createSidecars(context);
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

  /**
   * What a runner reports (F-067, F-069, ticket 13): its slots, resources, capabilities, labels,
   * install, minor and containment, kept on its row by `recordRunnerReport`, which writes only
   * what changed and sends its pool's admission when it has more room.
   */
  const reportOf = (runner: RunnerRef, minor: number, status: Status): RunnerReportWithContainment => ({
    runnerId: runner.runnerId,
    organizationId: runner.organizationId,
    minor,
    version: status.version,
    slots: status.capacity,
    resources: status.resources ?? null,
    capabilities: status.capabilities ?? null,
    install: status.install ?? null,
    labels: status.labels,
    os: null,
    arch: null,
    executor: status.executor,
    capacity: status.capacity,
    ...(status.processContainment === undefined ? {} : { processContainment: status.processContainment }),
  });

  const reportDeps = (tx: Tx) => ({
    tx,
    clock: context.ports.clock,
    notices: context.ports.notices,
    logger,
    server: { minor: context.serverMinor, version: context.serverVersion },
    jobs: context.ports.jobs,
  });

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
    // Minor 4: the `kubernetes` executor is new in it, so a runner below it is refused (ADR 0034).
    const registered = await db.runner.findFirst({
      where: { id: runner.runnerId, organizationId: runner.organizationId },
      select: { executor: true },
    });
    const executorRefusal = refuseHelloExecutor(hello, negotiation.minor, registered?.executor);
    if (executorRefusal !== null) {
      return {
        ok: false,
        error: {
          type: "error",
          code: "version-unsupported",
          message:
            `The ${executorRefusal.executor} executor needs protocol ${String(PROTOCOL_MAJOR)}.${String(executorRefusal.minMinor)} ` +
            `or later; this runner speaks ${String(hello.protocolMajor)}.${String(hello.protocolMinor)} with a server at ` +
            `${String(PROTOCOL_MAJOR)}.${String(context.serverMinor)}. Fix: install the runner version this server names ` +
            `(GET ${runnerPaths.info}, serverVersion ${context.serverVersion}), then start the runner again.`,
          supported: { min: Math.max(executorRefusal.minMinor, minorWindow(context.serverMinor).min), max: minorWindow(context.serverMinor).max },
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
      // Milestone 5 (F-067, ticket 13): what the hello reports, kept on the row; a runner below
      // minor 4 reports none of it, and counts slots only. Online, its pool's queue is admitted.
      const own = await tx.runner.findUniqueOrThrow({ where: { id: runner.runnerId }, select: { labels: true, capacity: true } });
      await recordRunnerReport(reportDeps(tx), {
        runnerId: runner.runnerId,
        organizationId: runner.organizationId,
        minor: negotiation.minor,
        version: hello.runnerVersion,
        slots: hello.resources?.slots ?? own.capacity,
        resources: hello.resources ?? null,
        capabilities: hello.capabilities ?? null,
        install: hello.install ?? null,
        labels: own.labels.filter((label) => !isReservedLabel(label)),
        os: null,
        arch: null,
        ...(hello.executor === undefined ? {} : { executor: hello.executor }),
      });
      if (state?.state === "online") {
        await enqueueRunnerAdmissionInTx({ jobs: context.ports.jobs }, tx, runner.organizationId, runner.runnerId);
      }
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

  const applyCommandAck = async (runner: RunnerRef, ack: CommandAck): Promise<void> => {
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

  const applyStatus = async (runner: RunnerRef, minor: number, status: Status): Promise<void> => {
    statuses.set(runner.runnerId, status);
    await db.$transaction((tx) => recordRunnerReport(reportDeps(tx), reportOf(runner, minor, status)));
  };

  // ---------- a connection ----------

  const markDisconnected = (peer: Peer): Promise<void> => closePresence(peer.runner, peer.connectionEpoch, new Date(peer.lastFrameAt), null);

  /**
   * Marks a connection of the runner gone, and starts what a disconnect starts (its tasks' grace).
   * Only the runner's newest connection marks it gone: a replaced one leaves presence alone.
   * `staleBefore`: only if no replica refreshed it since then (a dead replica's row, ticket 21).
   */
  const closePresence = async (runner: RunnerRef, connectionEpoch: number, at: Date, staleBefore: Date | null): Promise<void> => {
    await db.$transaction(async (tx) => {
      const closed =
        staleBefore === null
          ? await tx.$executeRaw`
              UPDATE "runner_presence" SET "disconnectedAt" = ${at}, "lastSeenAt" = ${at}
              WHERE "runnerId" = ${runner.runnerId} AND "connectionEpoch" = ${connectionEpoch} AND "disconnectedAt" IS NULL`
          : await tx.$executeRaw`
              UPDATE "runner_presence" SET "disconnectedAt" = ${at}
              WHERE "runnerId" = ${runner.runnerId} AND "connectionEpoch" = ${connectionEpoch} AND "disconnectedAt" IS NULL
                AND "lastSeenAt" < ${staleBefore}`;
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

  // ---------- the HTTP carrier: the same session on another carrier (milestone 5, ticket 11) ----------

  /** Acks the runner's commands up to `upTo`, never past what was ever sent. */
  const ackCommands = async (runner: RunnerRef, upTo: number): Promise<void> => {
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE "command" SET "ackedAt" = ${new Date(now())}
        WHERE "runnerId" = ${runner.runnerId} AND "organizationId" = ${runner.organizationId} AND "ackedAt" IS NULL
          AND "seq" <= LEAST(${upTo}, (SELECT "commandSeq" FROM "runner" WHERE "id" = ${runner.runnerId}))`;
      await tx.$executeRaw`
        UPDATE "runner" SET "ackedCommandSeq" = GREATEST("ackedCommandSeq", LEAST(${upTo}, "commandSeq"))
        WHERE "id" = ${runner.runnerId} AND "organizationId" = ${runner.organizationId}`;
    });
  };

  /** One up frame past `hello`, handled as the WebSocket handles it; the frames it earned. */
  const handleUp = async (runner: RunnerRef, minor: number, frame: Exclude<UpFrame, Hello>): Promise<readonly DownFrame[]> => {
    switch (frame.type) {
      case "events":
        // Answered only once the batch committed.
        return hooks.ingest(runner, frame);
      case "command-ack":
        await applyCommandAck(runner, frame);
        return [];
      case "status":
        await applyStatus(runner, minor, frame);
        return [];
      case "live-text":
        await hooks.liveText(runner, frame);
        return [];
      case "runner-event":
        logger.info("gateway.runner-event", { runnerId: runner.runnerId, kind: frame.event.kind, carrier: "http" });
        await hooks.runnerEvent?.(runner, frame);
        return [];
      default:
        return frame satisfies never;
    }
  };

  const carrierSession: CarrierSession = {
    acceptHello: async (runner, hello) => {
      const outcome = await acceptHello(runner, hello);
      return outcome.ok ? { ok: true, connectionEpoch: outcome.connectionEpoch, minor: outcome.minor, acks: outcome.acks } : { ok: false, error: outcome.error };
    },
    connectedHere: (runnerId, connectionEpoch) => {
      const peer = peers.get(runnerId);
      if (peer !== undefined && peer.connectionEpoch < connectionEpoch) {
        evict(peer, "replaced");
      }
    },
    handleUp,
    ackCommands,
    closePresence,
  };
  const http = createHttpCarrier(context, carrierSession);

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
        http.connected(runner.runnerId, outcome.connectionEpoch);
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
        // An events frame whose envelopes read but some body doesn't is refused once, per event,
        // and acked past (ticket 17, F-043): resent as it is, it would fail forever.
        const salvaged = salvageEventsFrame(text, peer.minor);
        if (salvaged === null) {
          violation(parsed.error.detail);
          return;
        }
        for (const reply of await hooks.ingest(runner, salvaged.frame, salvaged.refused)) {
          send(peer, reply);
        }
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
          await applyCommandAck(runner, frame);
          return;
        case "status":
          await applyStatus(runner, peer.minor, frame);
          return;
        case "live-text":
          await hooks.liveText(runner, frame);
          return;
        case "runner-event":
          // Protocol minor 2: a snapshot's result outside a task (ticket 26), applied by its ID, so
          // the runner's report again after a lost connection changes nothing.
          logger.info("gateway.runner-event", { runnerId: runner.runnerId, kind: frame.event.kind });
          await hooks.runnerEvent?.(runner, frame);
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
    if (token !== null && isTaskToken(token)) {
      // A box's sidecar, with its task token (ADR 0034, Q129).
      sidecars.handleUpgrade(request, socket, head, token);
      return;
    }
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
    if (notification.data.kind === "sidecar-command" || notification.data.kind === "sidecar-connected") {
      sidecars.onNotification(notification.data);
      return;
    }
    // The HTTP carrier's held polls, on whichever replica holds them.
    switch (notification.data.kind) {
      case "command":
        http.wake(notification.data.runnerId);
        break;
      case "connected":
        http.connected(notification.data.runnerId, notification.data.connectionEpoch);
        break;
      case "revoked":
        http.revoked(notification.data.runnerId);
        break;
      default:
        notification.data satisfies never;
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
    await sidecars.sweep();
    const holding = http.holding();
    const ids = [...new Set([...peers.keys(), ...holding.keys()])];
    if (ids.length === 0) {
      return;
    }
    // A missed NOTIFY: commands past what each peer was sent.
    const unacked = await db.$queryRaw<readonly unknown[]>`
      SELECT "runnerId", max("seq") AS "max" FROM "command"
      WHERE "runnerId" = ANY(${ids}::text[]) AND "ackedAt" IS NULL GROUP BY "runnerId"`;
    for (const raw of unacked) {
      const row = unackedRowSchema.safeParse(raw);
      if (row.success && (row.data.max ?? 0) > (holding.get(row.data.runnerId) ?? Number.MAX_SAFE_INTEGER)) {
        http.wake(row.data.runnerId, row.data.max ?? 0);
      }
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
      http.revoked(runnerIdSchema.parse(row.id));
      const peer = peers.get(runnerIdSchema.parse(row.id));
      if (peer !== undefined) {
        evict(peer, "revoked");
      }
    }
  };

  /**
   * A replica killed with `kill -9` never closes its runners' presence, so no grace would start for
   * a runner that doesn't come back (ticket 21, F-043). Any replica's presence pass closes a row no
   * replica refreshed within the dead time, as that replica's disconnect would have.
   */
  const closeOrphanedPresences = async (): Promise<void> => {
    const staleBefore = new Date(now() - timers.deadMs);
    const stale = await db.runnerPresence.findMany({
      where: { disconnectedAt: null, lastSeenAt: { lt: staleBefore } },
      select: { runnerId: true, organizationId: true, connectionEpoch: true, lastSeenAt: true },
      take: 200,
    });
    for (const row of stale) {
      const runnerId = runnerIdSchema.parse(row.runnerId);
      if (peers.has(runnerId) || http.holds(runnerId)) {
        continue;
      }
      logger.info("gateway.presence-orphaned", { runnerId, connectionEpoch: row.connectionEpoch });
      await closePresence({ runnerId, organizationId: organizationIdSchema.parse(row.organizationId) }, row.connectionEpoch, row.lastSeenAt, staleBefore);
    }
  };

  const writePresence = async (): Promise<void> => {
    await sidecars.writePresence();
    await http.writePresence();
    await closeOrphanedPresences();
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
    sidecars.ping();
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
    handleHttp: http.handle,
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
      http.stop();
      await sidecars.stop();
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
