import type { IncomingMessage, ServerResponse } from "node:http";

import { mapCommandToFrame } from "@ostra/db";
import {
  connectionEpochFromHeader,
  downFrameCodec,
  httpCarrierStatus,
  httpDownQuerySchema,
  httpEpochRefusal,
  minorFromHeader,
  parseHttpUpBody,
  runnerHeaders,
  runnerLimits,
  runnerPaths,
  upFrameCodec,
} from "@ostra/protocol";
import type { DownFrame, ErrorFrame, Hello, RunnerId, UpFrame, WelcomePool } from "@ostra/protocol";

import { readJsonBody, sendError, sendJson } from "../http.ts";
import { bearerToken, runnerIsLive } from "./access-token.ts";
import type { GatewayContext, RunnerRef } from "./context.ts";
import { isTaskToken } from "./task-token.ts";

// The HTTP carrier (ADR 0034, milestone 5's ticket 11): the runner's session over plain HTTP, for a
// network whose proxy blocks the WebSocket upgrade. Ported from spikes/runner-transport/src/server/
// replica.ts (`onHttp`) onto the gateway's own session code, so a WebSocket and an HTTP connection
// are two carriers of one session:
//
// - `POST /hello` is the WebSocket's `hello`: the same acceptance, the same presence row and epoch
//   (`carrier: "http"`), and its answer is `welcome` with the acks. A newer connection on either
//   carrier supersedes the older one.
// - `POST /up` takes a batch of up frames, each handled as the WebSocket handles it: an events frame
//   goes through the same ingest transaction, idempotent on (session, seq), and its acks are in the
//   answer only after that transaction committed.
// - `GET /down?after=` acks the commands up to `after`, then answers the ones after it from the
//   outbox, or holds up to 25 s, woken by this replica's LISTEN (a command, an eviction, a revoke)
//   or its 2 s sweep, and answers `204`.
// - Every request after `hello` carries `x-ostra-epoch` and `x-ostra-minor`; an epoch that isn't the
//   presence row's open connection gets `409 { code: "superseded" }`. Any replica serves any
//   request: the epoch is the row's, not this replica's.
// - Liveness: a runner on HTTP is connected while a `down` poll is open or ended under 45 s ago.
//   The replica that served it keeps its presence row fresh until then, and then closes it as a
//   WebSocket's close does, unless another replica refreshed it since.
// - The access token is checked on every request, and a revoked runner's is refused (`runnerIsLive`).

/** What a hello came to: the WebSocket's outcome (`connections.ts`). */
export type HttpHelloOutcome =
  | { readonly ok: true; readonly connectionEpoch: number; readonly minor: number; readonly acks: readonly DownFrame[]; readonly pool: WelcomePool | null }
  | { readonly ok: false; readonly error: ErrorFrame };

/** The session code the carrier shares with the WebSocket's (`connections.ts`). */
export type CarrierSession = {
  readonly acceptHello: (runner: RunnerRef, hello: Hello) => Promise<HttpHelloOutcome>;
  /** A newer connection of the runner was accepted here: close an older WebSocket this replica holds. */
  readonly connectedHere: (runnerId: RunnerId, connectionEpoch: number) => void;
  /** One up frame past `hello`, as the WebSocket handles it; the frames it earned. */
  readonly handleUp: (runner: RunnerRef, minor: number, frame: Exclude<UpFrame, Hello>) => Promise<readonly DownFrame[]>;
  /** Acks the runner's commands up to `upTo` (never past what was sent). */
  readonly ackCommands: (runner: RunnerRef, upTo: number) => Promise<void>;
  /** Marks the connection gone and starts its grace, unless another replica refreshed it since `staleBefore`. */
  readonly closePresence: (runner: RunnerRef, connectionEpoch: number, at: Date, staleBefore: Date | null) => Promise<void>;
};

export type HttpCarrier = {
  /** Handles `hello`, `up` and `down`; `false` for any other path. */
  readonly handle: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean>;
  /** A command for the runner: its held polls answer. */
  readonly wake: (runnerId: RunnerId, upTo?: number) => void;
  /** A connection of the runner at `connectionEpoch` was accepted: older HTTP connections here end. */
  readonly connected: (runnerId: RunnerId, connectionEpoch: number) => void;
  /** The runner was revoked: its held polls answer, and are refused. */
  readonly revoked: (runnerId: RunnerId) => void;
  /** The runners with a poll held here, and what each asked after. */
  readonly holding: () => ReadonlyMap<RunnerId, number>;
  /** Whether this replica serves the runner's HTTP connection. */
  readonly holds: (runnerId: RunnerId) => boolean;
  /** Keeps the presence of the live HTTP connections fresh, and closes the ones that went quiet. */
  readonly writePresence: () => Promise<void>;
  /** Answers every held poll, so the runners poll another replica. */
  readonly stop: () => void;
};

type Session = { readonly runner: RunnerRef; connectionEpoch: number; lastSeenAt: number; openPolls: number };
type Waiter = { readonly after: number; readonly wake: () => void };

/** An up batch: up to 512 frames, each at most the frame cap, with room for the wrapper. */
const UP_BODY_MAX_BYTES = 2 * runnerLimits.frameMaxBytes;

export const createHttpCarrier = (context: GatewayContext, session: CarrierSession): HttpCarrier => {
  const { db, logger, timers } = context;
  const now = (): number => context.ports.clock.now();
  const sessions = new Map<RunnerId, Session>();
  const waiters = new Map<RunnerId, Set<Waiter>>();

  const encode = (frames: readonly DownFrame[], minor: number): readonly unknown[] => frames.map((frame) => downFrameCodec.encodeValue(frame, minor));

  const wakeAll = (runnerId: RunnerId, upTo?: number): void => {
    for (const waiter of [...(waiters.get(runnerId) ?? [])]) {
      if (upTo === undefined || upTo > waiter.after) {
        waiter.wake();
      }
    }
  };

  /** The runner the access token names, live; `null` after the refusal was sent. */
  const authenticate = async (request: IncomingMessage, response: ServerResponse): Promise<RunnerRef | null> => {
    const token = bearerToken(request.headers.authorization);
    if (token !== null && isTaskToken(token)) {
      // A box's sidecar keeps its WebSocket; its HTTP carrier comes with the runner's (ticket 18).
      sendError(response, 400, "bad-request", "the HTTP carrier is the runner's; a box's sidecar connects over the WebSocket");
      return null;
    }
    const claims = token === null ? null : context.tokens.verify(token, now());
    if (claims === null) {
      sendError(response, 401, "unauthorized", "a valid access token is required (POST /runner/v1/token)");
      return null;
    }
    const runner: RunnerRef = { runnerId: claims.runnerId, organizationId: claims.organizationId };
    if (!(await runnerIsLive(db, runner))) {
      sendError(response, 403, "unauthorized", "this runner is revoked; register it again");
      return null;
    }
    return runner;
  };

  /**
   * A newer connection of the runner was accepted, on either carrier: an older HTTP connection this
   * replica serves ends, replaced, as `evict` ends a WebSocket. Its next request is answered `409`.
   */
  const endOlder = (runnerId: RunnerId, connectionEpoch: number): void => {
    const held = sessions.get(runnerId);
    if (held !== undefined && held.connectionEpoch < connectionEpoch) {
      sessions.delete(runnerId);
      logger.info("gateway.evicted", { runnerId, reason: "replaced", carrier: "http", connectionEpoch: held.connectionEpoch });
    }
  };

  /**
   * A request of a connection that isn't the runner's open one: `409`, at the request's minor. From
   * minor 8, `replaced` when a newer connection took over (ADR 0034, amended 2026-11-21), so the
   * runner stops as on the WebSocket's `evict`; `superseded` when core closed it (quiet past the dead
   * time, or presence gone), and the runner says hello again.
   */
  const refuseEpoch = (response: ServerResponse, presence: { readonly connectionEpoch: number } | null, epoch: number, minor: number): void => {
    const why = presence !== null && presence.connectionEpoch > epoch ? "replaced" : "closed";
    sendJson(response, httpCarrierStatus.superseded, httpEpochRefusal(why, minor));
  };

  /**
   * The request's connection, when its `x-ostra-epoch` is the runner's open connection and its
   * `x-ostra-minor` that connection's; `null` after the refusal was sent.
   */
  const connectionOf = async (request: IncomingMessage, response: ServerResponse, runner: RunnerRef): Promise<{ readonly connectionEpoch: number; readonly minor: number } | null> => {
    const epochHeader = request.headers[runnerHeaders.connectionEpoch];
    const minorHeader = request.headers[runnerHeaders.minor];
    const epoch = connectionEpochFromHeader(typeof epochHeader === "string" ? epochHeader : undefined);
    if (epoch === null || typeof minorHeader !== "string") {
      sendError(response, 400, "bad-request", `send ${runnerHeaders.connectionEpoch} and ${runnerHeaders.minor} from welcome`);
      return null;
    }
    const presence = await db.runnerPresence.findFirst({
      where: { runnerId: runner.runnerId, organizationId: runner.organizationId },
      select: { connectionEpoch: true, disconnectedAt: true, minor: true },
    });
    if (presence?.connectionEpoch !== epoch || presence.disconnectedAt !== null) {
      refuseEpoch(response, presence, epoch, minorFromHeader(minorHeader));
      return null;
    }
    if (minorFromHeader(minorHeader) !== presence.minor) {
      sendError(response, 400, "bad-request", `${runnerHeaders.minor} is not the minor welcome named`);
      return null;
    }
    const seen = sessions.get(runner.runnerId);
    if (seen?.connectionEpoch === epoch) {
      seen.lastSeenAt = now();
    } else {
      sessions.set(runner.runnerId, { runner, connectionEpoch: epoch, lastSeenAt: now(), openPolls: 0 });
    }
    return { connectionEpoch: epoch, minor: presence.minor };
  };

  // ---------- POST /hello ----------

  const hello = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const runner = await authenticate(request, response);
    if (runner === null) {
      return;
    }
    const body = await readJsonBody(request);
    const parsed = body.ok ? upFrameCodec.parseValue(body.value, context.serverMinor) : null;
    if (parsed?.ok !== true || parsed.frame.type !== "hello" || parsed.frame.carrier !== "http") {
      sendError(response, 400, "protocol-violation", "the body is a hello frame with carrier http");
      return;
    }
    const outcome = await session.acceptHello(runner, parsed.frame);
    if (!outcome.ok) {
      logger.info("gateway.hello-refused", { runnerId: runner.runnerId, code: outcome.error.code, minor: parsed.frame.protocolMinor, carrier: "http" });
      const status = outcome.error.code === "version-unsupported" ? 426 : 403;
      sendJson(response, status, { frames: encode([outcome.error], context.serverMinor) });
      return;
    }
    endOlder(runner.runnerId, outcome.connectionEpoch);
    sessions.set(runner.runnerId, { runner, connectionEpoch: outcome.connectionEpoch, lastSeenAt: now(), openPolls: 0 });
    session.connectedHere(runner.runnerId, outcome.connectionEpoch);
    // Polls of the older connection, held here, answer now (and are refused).
    wakeAll(runner.runnerId);
    logger.info("gateway.peer-open", {
      runnerId: runner.runnerId,
      organizationId: runner.organizationId,
      connectionEpoch: outcome.connectionEpoch,
      minor: outcome.minor,
      carrier: "http",
    });
    const welcome: DownFrame = {
      type: "welcome",
      minor: outcome.minor,
      serverTime: now(),
      connectionEpoch: outcome.connectionEpoch,
      replicaId: context.replicaId,
      pingMs: timers.pingMs,
      creditFrames: runnerLimits.creditFrames,
      creditBytes: runnerLimits.creditBytes,
      maxConnectionAgeMs: timers.maxConnectionAgeMs,
      ...(outcome.pool === null || outcome.minor < 4 ? {} : { pool: outcome.pool }),
    };
    sendJson(response, httpCarrierStatus.ok, { frames: encode([welcome, ...outcome.acks], outcome.minor) });
  };

  // ---------- POST /up ----------

  const up = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const runner = await authenticate(request, response);
    if (runner === null) {
      return;
    }
    const connection = await connectionOf(request, response, runner);
    if (connection === null) {
      return;
    }
    const body = await readJsonBody(request, UP_BODY_MAX_BYTES);
    const parsed = body.ok ? parseHttpUpBody(body.value, connection.minor) : null;
    if (parsed?.ok !== true) {
      logger.warn("gateway.protocol-violation", { runnerId: runner.runnerId, carrier: "http", detail: parsed === null ? "not JSON" : parsed.detail });
      sendError(response, 400, "protocol-violation", parsed === null ? "the body is not JSON within the batch's size" : parsed.detail);
      return;
    }
    const replies: DownFrame[] = [];
    for (const frame of parsed.frames) {
      if (frame.type === "hello") {
        sendError(response, 400, "protocol-violation", "hello goes to POST /runner/v1/hello");
        return;
      }
      // One frame after another, as on the WebSocket: an events frame's acks are in the answer only
      // once its transaction committed, so a batch whose answer is lost is sent again and stored once.
      replies.push(...(await session.handleUp(runner, connection.minor, frame)));
    }
    sendJson(response, httpCarrierStatus.ok, { frames: encode(replies, connection.minor) });
  };

  // ---------- GET /down?after= ----------

  const commandsAfter = async (runner: RunnerRef, after: number): Promise<readonly DownFrame[]> => {
    const rows = await db.command.findMany({
      where: { runnerId: runner.runnerId, organizationId: runner.organizationId, seq: { gt: after } },
      orderBy: { seq: "asc" },
      take: 200,
    });
    return rows.map((row) => mapCommandToFrame(row));
  };

  const hold = (runnerId: RunnerId, after: number, request: IncomingMessage): Promise<void> =>
    new Promise((resolve) => {
      let set = waiters.get(runnerId);
      if (set === undefined) {
        set = new Set();
        waiters.set(runnerId, set);
      }
      const held = set;
      let timer: ReturnType<typeof setTimeout> | undefined = undefined;
      const waiter: Waiter = {
        after,
        wake: () => {
          clearTimeout(timer);
          held.delete(waiter);
          if (held.size === 0 && waiters.get(runnerId) === held) {
            waiters.delete(runnerId);
          }
          request.off("close", waiter.wake);
          resolve();
        },
      };
      timer = setTimeout(waiter.wake, timers.longPollMs);
      held.add(waiter);
      request.on("close", waiter.wake);
    });

  const down = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    const runner = await authenticate(request, response);
    if (runner === null) {
      return;
    }
    const query = httpDownQuerySchema.safeParse({ after: url.searchParams.get("after") ?? undefined });
    if (!query.success) {
      sendError(response, 400, "bad-request", "after is the highest command seq applied, a whole number");
      return;
    }
    const connection = await connectionOf(request, response, runner);
    if (connection === null) {
      return;
    }
    const { after } = query.data;
    // By seq alone, and never final: a command's result comes in an up batch, maybe after this
    // poll, or on the runner's next connection when its batch was lost (ADR 0034, amended
    // 2026-11-22), and `command-ack` records it and acts on it on an acked command too.
    await session.ackCommands(runner, after);
    let frames = await commandsAfter(runner, after);
    if (frames.length === 0) {
      const current = sessions.get(runner.runnerId);
      if (current !== undefined) {
        current.openPolls += 1;
      }
      try {
        await hold(runner.runnerId, after, request);
      } finally {
        if (current !== undefined) {
          current.openPolls -= 1;
          current.lastSeenAt = now();
        }
      }
      if (response.destroyed || response.writableEnded) {
        return;
      }
      // Woken: revoked or superseded meanwhile is refused; otherwise what came.
      if (!(await runnerIsLive(db, runner))) {
        sendError(response, 403, "unauthorized", "this runner is revoked; register it again");
        return;
      }
      const presence = await db.runnerPresence.findFirst({ where: { runnerId: runner.runnerId }, select: { connectionEpoch: true, disconnectedAt: true } });
      if (presence?.connectionEpoch !== connection.connectionEpoch || presence.disconnectedAt !== null) {
        refuseEpoch(response, presence, connection.connectionEpoch, connection.minor);
        return;
      }
      frames = await commandsAfter(runner, after);
    }
    if (frames.length === 0) {
      response.writeHead(httpCarrierStatus.idle);
      response.end();
      return;
    }
    sendJson(response, httpCarrierStatus.ok, { frames: encode(frames, connection.minor) });
  };

  // ---------- presence ----------

  const writePresence = async (): Promise<void> => {
    const at = now();
    for (const [runnerId, held] of [...sessions]) {
      if (held.openPolls > 0 || at - held.lastSeenAt <= timers.deadMs) {
        await db.$executeRaw`
          UPDATE "runner_presence" SET "lastSeenAt" = now(), "replicaId" = ${context.replicaId}
          WHERE "runnerId" = ${runnerId} AND "connectionEpoch" = ${held.connectionEpoch} AND "disconnectedAt" IS NULL`;
        await db.runner.updateMany({ where: { id: runnerId, organizationId: held.runner.organizationId }, data: { lastSeenAt: new Date(at) } });
        continue;
      }
      // Quiet for longer than the dead time: gone, as a WebSocket that stopped answering is, unless
      // another replica serves its polls now and refreshed its row since.
      sessions.delete(runnerId);
      logger.info("gateway.peer-close", { runnerId, connectionEpoch: held.connectionEpoch, carrier: "http" });
      await session.closePresence(held.runner, held.connectionEpoch, new Date(held.lastSeenAt), new Date(at - timers.deadMs));
    }
  };

  return {
    handle: async (request, response, url) => {
      const route = `${request.method ?? "GET"} ${url.pathname}`;
      switch (route) {
        case `POST ${runnerPaths.httpHello}`:
          await hello(request, response);
          return true;
        case `POST ${runnerPaths.httpUp}`:
          await up(request, response);
          return true;
        case `GET ${runnerPaths.httpDown}`:
          await down(request, response, url);
          return true;
        default:
          return false;
      }
    },
    wake: wakeAll,
    connected: (runnerId, connectionEpoch) => {
      endOlder(runnerId, connectionEpoch);
      wakeAll(runnerId);
    },
    revoked: (runnerId) => {
      sessions.delete(runnerId);
      wakeAll(runnerId);
    },
    holding: () => new Map([...waiters].map(([runnerId, set]) => [runnerId, Math.min(...[...set].map((waiter) => waiter.after))])),
    holds: (runnerId) => sessions.has(runnerId),
    writePresence,
    stop: () => {
      for (const runnerId of [...waiters.keys()]) {
        wakeAll(runnerId);
      }
      sessions.clear();
    },
  };
};
