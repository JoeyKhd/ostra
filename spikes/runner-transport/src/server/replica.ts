// One core replica: serves the runner protocol on both carriers and routes
// commands through Postgres (ADR 0034). Any replica serves any request.
//
//   node src/server/replica.ts --replica=a --port=0 --cert=... --key=...
// Env: SPIKE_DATABASE_URL, SPIKE_AUTH_SECRET, SPIKE_METRICS_TOKEN.
// Test hook (harness only, needs OSTRA_SPIKE_TEST_HOOKS=1): --lose-acks=N commits
// a runner's batch and then drops the connection instead of acking it, N times per runner.

import { readFile } from "node:fs/promises";
import { randomUUID, timingSafeEqual } from "node:crypto";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import pg from "pg";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { z } from "zod";
import { ReplicaId, RunnerId } from "../protocol/ids.ts";
import {
  CloseCode,
  Command,
  CommandBody,
  CommandKind,
  Hello,
  InfoBody,
  PROTOCOL_MAJOR,
  SERVER_MINOR,
  encodeDown,
  frameText,
  httpUpBody,
  negotiate,
  parseJson,
  upFrame,
  type Ack,
  type CommandAck,
  type DownMessage,
  type ErrorMsg,
  type Events,
  type Status,
  type UpMessage,
  type Welcome,
} from "../protocol/messages.ts";
import { TimeScale, scaledTimers } from "../protocol/timers.ts";
import { boolArg, exitWithParent, parseArgs } from "../shared/args.ts";
import { verifyToken } from "../shared/auth.ts";
import { pgConfig } from "../shared/db.ts";
import { errorFields, makeLogger } from "../shared/log.ts";
import { summarize } from "../shared/stats.ts";

const args = parseArgs(
  z.object({
    replica: ReplicaId,
    port: z.coerce.number().int().min(0).max(65_535),
    cert: z.string(),
    key: z.string(),
    "time-scale": TimeScale.default(1),
    "server-minor": z.coerce.number().int().nonnegative().default(SERVER_MINOR),
    pool: z.coerce.number().int().positive().default(10),
    listen: boolArg.default(true),
    "lose-acks": z.coerce.number().int().nonnegative().default(0),
    "parent-pid": z.coerce.number().int().positive().optional(),
  }),
);
const env = z
  .object({
    SPIKE_DATABASE_URL: z.string().min(1),
    SPIKE_AUTH_SECRET: z.string().min(16),
    SPIKE_METRICS_TOKEN: z.string().min(16),
    OSTRA_SPIKE_TEST_HOOKS: z.literal("1").optional(),
  })
  .parse(process.env);
if (args["lose-acks"] > 0 && env.OSTRA_SPIKE_TEST_HOOKS !== "1") {
  process.stderr.write("--lose-acks is a test hook: it needs OSTRA_SPIKE_TEST_HOOKS=1\n");
  process.exit(2);
}

exitWithParent(args["parent-pid"]);
const replicaId = args.replica;
const timers = scaledTimers(args["time-scale"]);
const serverMinor = args["server-minor"];
const log = makeLogger({ replica: replicaId });
const FRAME_CAP = 1024 * 1024;
const BUFFER_LIMIT = 4 * 1024 * 1024;
const CREDIT_FRAMES = 256;
const CREDIT_BYTES = 4 * 1024 * 1024;

const pool = new pg.Pool({ ...pgConfig(env.SPIKE_DATABASE_URL), max: args.pool });
pool.on("error", (err) => {
  log("pg-pool-error", { code: err.name });
});

// ---------- metrics ----------

const counters = {
  wsConnections: 0,
  httpHellos: 0,
  batches: 0,
  eventsInserted: 0,
  eventsDuplicate: 0,
  resendRequests: 0,
  staleRefused: 0,
  notifications: 0,
  commandsSent: 0,
  evictions: 0,
  graceStops: 0,
  sweepDeliveries: 0,
  acksLost: 0,
};
const ingestMs: number[] = [];
const recordIngest = (ms: number): void => {
  ingestMs.push(ms);
  if (ingestMs.length > 20_000) ingestMs.splice(0, 10_000);
};

// ---------- peers ----------

type WsPeer = {
  readonly runnerId: RunnerId;
  readonly connEpoch: number;
  readonly minor: number;
  readonly ws: WebSocket;
  readonly openedAt: number;
  lastSent: number;
  lastFrameAt: number;
  delivering: boolean;
  deliverAgain: boolean;
  closed: boolean;
};

const wsPeers = new Map<RunnerId, WsPeer>();
/** HTTP peers this replica served recently: their presence goes into this replica's next write. */
const httpSeen = new Map<RunnerId, { connEpoch: number; at: number }>();
/** Long polls waiting on this replica, per runner. */
const httpWaiters = new Map<RunnerId, Set<{ after: number; wake: () => void }>>();

const sendWs = (peer: WsPeer, msg: DownMessage): void => {
  if (peer.closed) return;
  peer.ws.send(JSON.stringify(encodeDown(msg, peer.minor)));
};

/** Read through a function: `closed` changes while a delivery awaits. */
const isClosed = (peer: WsPeer): boolean => peer.closed;

const closePeer = (peer: WsPeer, code: number, reason: string): void => {
  if (peer.closed) return;
  peer.closed = true;
  peer.ws.close(code, reason);
  setTimeout(() => {
    peer.ws.terminate();
  }, 2_000).unref();
};

// ---------- row schemas (storage is external data: validate it) ----------

const big = z.coerce.number().int();
const SessionRow = z.object({
  ingest_cursor: big,
  lease_epoch: big,
  state: z.enum(["offered", "running", "stopped"]),
  runner_id: z.string(),
});
const CommandRow = z.object({
  seq: big,
  id: z.string(),
  kind: z.string(),
  body: z.unknown(),
  not_after_ms: z.number().nullable(),
});
const EpochRow = z.object({ conn_epoch: big });

const commandFromRow = (row: unknown): Command | undefined => {
  const r = CommandRow.safeParse(row);
  if (!r.success) return undefined;
  const parsed = Command.safeParse({
    type: "command",
    seq: r.data.seq,
    id: r.data.id,
    kind: r.data.kind,
    body: r.data.body,
    ...(r.data.not_after_ms === null ? {} : { notAfter: r.data.not_after_ms }),
  });
  if (!parsed.success) {
    log("command-row-invalid", { seq: r.data.seq });
    return undefined;
  }
  return parsed.data;
};

const selectCommands = `
  SELECT seq, id::text AS id, kind, body, (extract(epoch FROM not_after) * 1000)::float8 AS not_after_ms
  FROM runner_command WHERE runner_id = $1 AND seq > $2 ORDER BY seq LIMIT 200`;

const withTx = async <T,>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
};

// ---------- hello ----------

type HelloResult =
  | { ok: true; welcome: Welcome; acks: Ack[]; minor: number; connEpoch: number }
  | { ok: false; error: ErrorMsg; close: number; http: number };

const acceptHello = async (runnerId: RunnerId, hello: Hello): Promise<HelloResult> => {
  if (hello.runnerId !== runnerId) {
    return {
      ok: false,
      error: { type: "error", code: "unauthorized", message: "token and hello name different runners" },
      close: CloseCode.revoked,
      http: 401,
    };
  }
  const n = negotiate(serverMinor, hello.protocolMajor, hello.protocolMinor);
  if (!n.ok) {
    return {
      ok: false,
      error: {
        type: "error",
        code: "version-unsupported",
        message:
          `This runner speaks protocol ${String(hello.protocolMajor)}.${String(hello.protocolMinor)}; ` +
          `this server speaks ${String(PROTOCOL_MAJOR)}.${String(serverMinor)} and accepts ` +
          `${String(PROTOCOL_MAJOR)}.${String(n.min)} to ${String(PROTOCOL_MAJOR)}.${String(n.max)}. ` +
          `Fix: install the runner version this server pins (GET /runner/v1/info), then restart the runner.`,
        supported: { min: n.min, max: n.max },
        serverMinor,
      },
      close: CloseCode.upgradeRequired,
      http: 426,
    };
  }
  const sessionIds = hello.sessions.map((s) => s.sessionId);
  const out = await withTx(async (c) => {
    await c.query("INSERT INTO runner (id) VALUES ($1) ON CONFLICT DO NOTHING", [runnerId]);
    const r = await c.query(
      `INSERT INTO runner_presence (runner_id, replica_id, conn_epoch, carrier, minor)
       VALUES ($1, $2, 1, $3, $4)
       ON CONFLICT (runner_id) DO UPDATE SET replica_id = $2, conn_epoch = runner_presence.conn_epoch + 1,
         carrier = $3, minor = $4, connected_at = now(), last_seen_at = now(), disconnected_at = NULL
       RETURNING conn_epoch`,
      [runnerId, replicaId, hello.carrier, n.minor],
    );
    const connEpoch = EpochRow.parse(r.rows[0]).conn_epoch;
    // Every replica closes an older connection of this runner (4409).
    await c.query("SELECT pg_notify('ostra_runner', $1)", [JSON.stringify({ k: "evict", r: runnerId, e: connEpoch })]);
    await c.query(
      "UPDATE runner_command SET acked_at = clock_timestamp() WHERE runner_id = $1 AND seq <= $2 AND acked_at IS NULL",
      [runnerId, hello.lastCommandSeq],
    );
    const cursors = await c.query(
      `SELECT s.id, s.ingest_cursor FROM session s JOIN task t ON t.id = s.task_id
       WHERE s.id = ANY($1::text[]) AND t.runner_id = $2`,
      [sessionIds, runnerId],
    );
    const acks: Ack[] = [];
    for (const row of cursors.rows) {
      const p = z.object({ id: z.string(), ingest_cursor: big }).safeParse(row);
      const match = p.success ? hello.sessions.find((s) => s.sessionId === p.data.id) : undefined;
      if (p.success && match !== undefined) acks.push({ type: "ack", sessionId: match.sessionId, upTo: p.data.ingest_cursor });
    }
    return { connEpoch, acks };
  });
  const welcome: Welcome = {
    type: "welcome",
    minor: n.minor,
    serverTime: Date.now(),
    connectionId: randomUUID(),
    connEpoch: out.connEpoch,
    replicaId,
    heartbeatMs: timers.pingMs,
    creditFrames: CREDIT_FRAMES,
    creditBytes: CREDIT_BYTES,
    maxConnectionAgeMs: timers.maxConnectionAgeMs,
    serverFeatures: [],
  };
  return { ok: true, welcome, acks: out.acks, minor: n.minor, connEpoch: out.connEpoch };
};

// ---------- up: events, command acks, status ----------

const ingest = async (runnerId: RunnerId, msg: Events): Promise<DownMessage[]> => {
  const started = performance.now();
  counters.batches += 1;
  const result = await withTx(async (c): Promise<DownMessage[]> => {
    const r = await c.query(
      `SELECT s.ingest_cursor, t.lease_epoch, t.state, t.runner_id
       FROM session s JOIN task t ON t.id = s.task_id WHERE s.id = $1 FOR UPDATE OF s`,
      [msg.sessionId],
    );
    const row = SessionRow.safeParse(r.rows[0]);
    if (!row.success || row.data.runner_id !== runnerId) {
      return [{ type: "error", code: "unknown-session", message: "no such session for this runner", sessionId: msg.sessionId }];
    }
    const s = row.data;
    // Only the epoch fences: a task stopped on request keeps its epoch, so its spool can still drain.
    if (msg.leaseEpoch !== s.lease_epoch) {
      // The fence: a stale epoch's write is refused and never stored.
      await c.query("INSERT INTO stale_refusal (session_id, lease_epoch, from_seq, count) VALUES ($1, $2, $3, $4)", [
        msg.sessionId,
        msg.leaseEpoch,
        msg.fromSeq,
        msg.items.length,
      ]);
      counters.staleRefused += msg.items.length;
      return [
        {
          type: "error",
          code: "stale-lease",
          message: "this session's lease has moved on; its writes are refused",
          sessionId: msg.sessionId,
          currentEpoch: s.lease_epoch,
        },
      ];
    }
    if (msg.fromSeq > s.ingest_cursor + 1) {
      // A gap can never be committed.
      counters.resendRequests += 1;
      return [{ type: "ack", sessionId: msg.sessionId, upTo: s.ingest_cursor, resendFrom: s.ingest_cursor + 1 }];
    }
    const seqs: number[] = [];
    const kinds: string[] = [];
    const bodies: string[] = [];
    msg.items.forEach((item, i) => {
      const seq = msg.fromSeq + i;
      if (seq <= s.ingest_cursor) return;
      seqs.push(seq);
      kinds.push(item.kind);
      bodies.push(JSON.stringify(item.body));
    });
    let inserted = 0;
    if (seqs.length > 0) {
      const ins = await c.query(
        `INSERT INTO agent_event (session_id, seq, lease_epoch, kind, body)
         SELECT $1, u.s, $2, u.k, u.b FROM unnest($3::bigint[], $4::text[], $5::jsonb[]) AS u(s, k, b)
         ON CONFLICT DO NOTHING`,
        [msg.sessionId, msg.leaseEpoch, seqs, kinds, bodies],
      );
      inserted = ins.rowCount ?? 0;
    }
    counters.eventsInserted += inserted;
    counters.eventsDuplicate += msg.items.length - inserted;
    const upTo = Math.max(s.ingest_cursor, msg.fromSeq + msg.items.length - 1);
    if (upTo !== s.ingest_cursor) {
      await c.query("UPDATE session SET ingest_cursor = $2 WHERE id = $1", [msg.sessionId, upTo]);
    }
    // ADR 0037's reactions would be enqueued here, in the same transaction.
    return [{ type: "ack", sessionId: msg.sessionId, upTo }];
  });
  recordIngest(performance.now() - started);
  return result; // sent only after COMMIT
};

const AckedCommandRow = z.object({ kind: CommandKind, body: z.unknown() });

const applyCommandAck = async (runnerId: RunnerId, msg: CommandAck): Promise<void> => {
  await withTx(async (c) => {
    await c.query(
      "UPDATE runner_command SET acked_at = clock_timestamp() WHERE runner_id = $1 AND seq <= $2 AND acked_at IS NULL",
      [runnerId, msg.upTo],
    );
    for (const r of msg.results) {
      // Scoped to the calling runner. The row it returns is the only source for the
      // task updates below, so a runner can't move another runner's task.
      const acked = await c.query(
        `UPDATE runner_command SET result = $3, reason = $4, acked_at = coalesce(acked_at, clock_timestamp())
         WHERE runner_id = $1 AND id = $2::uuid RETURNING kind, body`,
        [runnerId, r.id, r.result, r.reason ?? null],
      );
      const row = AckedCommandRow.safeParse(acked.rows[0]);
      if (!row.success) {
        log("command-ack-unknown", { runner: runnerId, command: r.id });
        continue;
      }
      if (r.result === "accepted" && row.data.kind === "dispatch") {
        const b = CommandBody.dispatch.safeParse(row.data.body);
        if (b.success) {
          await c.query("UPDATE task SET state = 'running' WHERE id = $1 AND runner_id = $2 AND state = 'offered'", [b.data.taskId, runnerId]);
        }
      }
      if (r.result === "done" && row.data.kind === "stop") {
        const b = CommandBody.stop.safeParse(row.data.body);
        if (b.success && b.data.reason === "requested") {
          await c.query(
            `UPDATE task SET state = 'stopped', stopped_reason = 'requested', stopped_at = clock_timestamp()
             FROM session s
             WHERE s.id = $1 AND task.id = s.task_id AND task.runner_id = $2 AND task.state <> 'stopped'`,
            [b.data.sessionId, runnerId],
          );
        }
      }
    }
  });
};

const applyStatus = async (runnerId: RunnerId, msg: Status): Promise<void> => {
  await pool.query("UPDATE runner SET status = $2 WHERE id = $1", [runnerId, JSON.stringify(msg)]);
};

const handleUp = async (runnerId: RunnerId, msg: UpMessage): Promise<DownMessage[]> => {
  switch (msg.type) {
    case "events":
      return ingest(runnerId, msg);
    case "command.ack":
      await applyCommandAck(runnerId, msg);
      return [];
    case "status":
      await applyStatus(runnerId, msg);
      return [];
    default:
      return msg satisfies never;
  }
};

/**
 * Test hook: a committed batch loses its ack, up to --lose-acks times per runner.
 * The losses are spaced past the quick-death window, so the runner reconnects on
 * its own carrier instead of falling back to HTTP.
 */
const lostAcks = new Map<RunnerId, { batches: number; lost: number; lastAt: number }>();
const loseAck = (runnerId: RunnerId, replies: readonly DownMessage[]): boolean => {
  if (args["lose-acks"] === 0) return false;
  if (!replies.some((m) => m.type === "ack" && m.resendFrom === undefined)) return false;
  const now = Date.now();
  const st = lostAcks.get(runnerId) ?? { batches: 0, lost: 0, lastAt: now };
  lostAcks.set(runnerId, st);
  st.batches += 1;
  if (st.lost >= args["lose-acks"] || st.batches < 10 || now - st.lastAt < 1.5 * timers.quickDeathMs) return false;
  st.lost += 1;
  st.lastAt = now;
  counters.acksLost += 1;
  return true;
};

// ---------- down: commands ----------

const deliver = async (peer: WsPeer): Promise<void> => {
  if (peer.delivering) {
    peer.deliverAgain = true;
    return;
  }
  peer.delivering = true;
  try {
    do {
      peer.deliverAgain = false;
      if (peer.closed) return;
      if (peer.ws.bufferedAmount > BUFFER_LIMIT) {
        // Commands that wait stay in the table: nothing is lost.
        setTimeout(() => void deliver(peer), 100);
        return;
      }
      const r = await pool.query(selectCommands, [peer.runnerId, peer.lastSent]);
      for (const row of r.rows) {
        const cmd = commandFromRow(row);
        if (cmd === undefined || isClosed(peer)) break;
        sendWs(peer, cmd);
        peer.lastSent = cmd.seq;
        counters.commandsSent += 1;
      }
      if (r.rows.length === 200) peer.deliverAgain = true;
    } while (peer.deliverAgain);
  } catch (err) {
    log("deliver-failed", { runner: peer.runnerId, err: err instanceof Error ? err.name : "unknown" });
  } finally {
    peer.delivering = false;
  }
};

const wakeHttp = (runnerId: RunnerId): void => {
  const waiters = httpWaiters.get(runnerId);
  if (waiters === undefined) return;
  for (const w of waiters) w.wake();
};

// ---------- LISTEN ----------

const Notification = z.union([
  z.object({ k: z.literal("cmd"), r: RunnerId }),
  z.object({ k: z.literal("evict"), r: RunnerId, e: z.number().int() }),
]);

const onNotify = (payload: string | undefined): void => {
  counters.notifications += 1;
  const parsed = parseJson(payload ?? "");
  const n = parsed.ok ? Notification.safeParse(parsed.value) : undefined;
  if (n?.success !== true) return;
  // Every replica listens and ignores peers it doesn't hold.
  const peer = wsPeers.get(n.data.r);
  if (n.data.k === "cmd") {
    if (peer !== undefined) void deliver(peer);
    wakeHttp(n.data.r);
    return;
  }
  if (peer !== undefined && peer.connEpoch < n.data.e) {
    counters.evictions += 1;
    log("evict", { runner: n.data.r, oldEpoch: peer.connEpoch, newEpoch: n.data.e });
    closePeer(peer, CloseCode.replaced, "replaced by a newer connection");
    wsPeers.delete(n.data.r);
  }
};

let listener: pg.Client | undefined;
const startListener = async (): Promise<void> => {
  if (!args.listen) return;
  const c = new pg.Client(pgConfig(env.SPIKE_DATABASE_URL));
  c.on("notification", (m) => {
    onNotify(m.payload);
  });
  c.on("error", () => {
    log("listen-lost");
    listener = undefined;
    c.end().catch(() => undefined);
    setTimeout(() => void startListener().then(sweep), 1_000);
  });
  try {
    await c.connect();
    await c.query("LISTEN ostra_runner");
    listener = c;
    log("listening");
  } catch {
    setTimeout(() => void startListener(), 1_000);
  }
};

// ---------- timers: sweep, presence, ping, grace ----------

const UnackedRow = z.object({ runner_id: RunnerId, max: big });

const sweep = async (): Promise<void> => {
  const ids = new Set<string>([...wsPeers.keys(), ...httpWaiters.keys()]);
  if (ids.size === 0) return;
  const r = await pool.query(
    "SELECT runner_id, max(seq) AS max FROM runner_command WHERE runner_id = ANY($1::text[]) AND acked_at IS NULL GROUP BY runner_id",
    [[...ids]],
  );
  for (const row of r.rows) {
    const u = UnackedRow.safeParse(row);
    if (!u.success) continue;
    const peer = wsPeers.get(u.data.runner_id);
    if (peer !== undefined && u.data.max > peer.lastSent) {
      counters.sweepDeliveries += 1;
      void deliver(peer);
    }
    for (const w of httpWaiters.get(u.data.runner_id) ?? []) if (u.data.max > w.after) w.wake();
  }
};

const writePresence = async (): Promise<void> => {
  const now = Date.now();
  const wsIds = [...wsPeers.values()].filter((p) => !p.closed).map((p) => p.runnerId);
  const httpIds: string[] = [];
  const httpEpochs: number[] = [];
  for (const [id, seen] of httpSeen) {
    if (now - seen.at > timers.presenceMs * 2) {
      httpSeen.delete(id);
      continue;
    }
    httpIds.push(id);
    httpEpochs.push(seen.connEpoch);
  }
  await pool.query(
    `INSERT INTO core_replica (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET last_seen_at = now()`,
    [replicaId],
  );
  if (wsIds.length > 0) {
    await pool.query(
      `UPDATE runner_presence SET last_seen_at = now()
       WHERE runner_id = ANY($1::text[]) AND replica_id = $2 AND disconnected_at IS NULL`,
      [wsIds, replicaId],
    );
  }
  if (httpIds.length > 0) {
    await pool.query(
      `UPDATE runner_presence p SET last_seen_at = now(), replica_id = $3, disconnected_at = NULL
       FROM unnest($1::text[], $2::bigint[]) AS u(r, e) WHERE p.runner_id = u.r AND p.conn_epoch = u.e`,
      [httpIds, httpEpochs, replicaId],
    );
  }
};

const ping = (): void => {
  const now = Date.now();
  for (const peer of wsPeers.values()) {
    if (peer.closed) continue;
    if (now - peer.lastFrameAt > timers.deadMs) {
      log("peer-dead", { runner: peer.runnerId, epoch: peer.connEpoch });
      peer.closed = true;
      peer.ws.terminate();
      continue;
    }
    peer.ws.ping();
  }
};

const LostRow = z.object({ id: z.string(), runner_id: z.string(), session_id: z.string() });

/** Task grace (F-045): a task whose peer has been gone too long is stopped, and its epoch moves on. */
const graceSweep = async (): Promise<void> => {
  await withTx(async (c) => {
    const r = await c.query(
      `SELECT t.id, t.runner_id, s.id AS session_id
       FROM task t JOIN session s ON s.task_id = t.id
       LEFT JOIN runner_presence p ON p.runner_id = t.runner_id
       WHERE t.state <> 'stopped'
         AND coalesce(p.disconnected_at, p.last_seen_at, t.created_at) < now() - ($1::double precision * interval '1 millisecond')
       FOR UPDATE OF t SKIP LOCKED`,
      [timers.graceMs],
    );
    for (const row of r.rows) {
      const lost = LostRow.safeParse(row);
      if (!lost.success) continue;
      const up = await c.query(
        `UPDATE task SET state = 'stopped', stopped_reason = 'runner-lost', stopped_at = clock_timestamp(),
           lease_epoch = lease_epoch + 1 WHERE id = $1 AND state <> 'stopped' RETURNING lease_epoch`,
        [lost.data.id],
      );
      const epoch = z.object({ lease_epoch: big }).safeParse(up.rows[0]);
      if (!epoch.success) continue;
      await c.query("SELECT * FROM enqueue_command($1, 'stop', $2::jsonb, NULL, true)", [
        lost.data.runner_id,
        JSON.stringify({ sessionId: lost.data.session_id, leaseEpoch: epoch.data.lease_epoch, reason: "runner-lost" }),
      ]);
      counters.graceStops += 1;
      log("task-stopped-grace", { task: lost.data.id, runner: lost.data.runner_id, epoch: epoch.data.lease_epoch });
    }
  });
};

const every = (ms: number, fn: () => Promise<void> | void, name: string): void => {
  const tick = (): void => {
    Promise.resolve()
      .then(fn)
      .catch((err: unknown) => {
        log("timer-failed", { timer: name, err: err instanceof Error ? err.name : "unknown" });
      })
      .finally(() => {
        setTimeout(tick, ms);
      });
  };
  setTimeout(tick, ms);
};

// ---------- WebSocket carrier ----------

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: FRAME_CAP });

const onWs = (ws: WebSocket, runnerId: RunnerId): void => {
  counters.wsConnections += 1;
  let peer: WsPeer | undefined;
  let chain: Promise<void> = Promise.resolve();
  let gotHello = false;
  const handshake = setTimeout(() => {
    if (!gotHello) ws.terminate();
  }, timers.handshakeTimeoutMs);

  const handleFrame = async (data: RawData): Promise<void> => {
    const text = frameText(data);
    const json = parseJson(text);
    if (!json.ok) {
      ws.close(CloseCode.protocolViolation, "not json");
      return;
    }
    if (peer === undefined) {
      const hello = Hello.safeParse(json.value);
      if (!hello.success) {
        ws.close(CloseCode.protocolViolation, "expected hello");
        return;
      }
      gotHello = true;
      clearTimeout(handshake);
      const res = await acceptHello(runnerId, hello.data);
      if (!res.ok) {
        ws.send(JSON.stringify(res.error));
        ws.close(res.close, res.error.code);
        log("hello-refused", { runner: runnerId, code: res.error.code, minor: hello.data.protocolMinor });
        return;
      }
      const now = Date.now();
      peer = {
        runnerId,
        connEpoch: res.connEpoch,
        minor: res.minor,
        ws,
        openedAt: now,
        lastSent: hello.data.lastCommandSeq,
        lastFrameAt: now,
        delivering: false,
        deliverAgain: false,
        closed: false,
      };
      const old = wsPeers.get(runnerId);
      if (old !== undefined && old !== peer) {
        counters.evictions += 1;
        closePeer(old, CloseCode.replaced, "replaced by a newer connection");
      }
      wsPeers.set(runnerId, peer);
      sendWs(peer, res.welcome);
      for (const a of res.acks) sendWs(peer, a);
      log("peer-open", { runner: runnerId, epoch: res.connEpoch, minor: res.minor, carrier: "websocket" });
      await deliver(peer);
      return;
    }
    const msg = upFrame(peer.minor).safeParse(json.value);
    if (!msg.success) {
      log("frame-invalid", { runner: runnerId });
      closePeer(peer, CloseCode.protocolViolation, "invalid frame");
      return;
    }
    const replies = await handleUp(runnerId, msg.data);
    if (msg.data.type === "events" && loseAck(runnerId, replies)) {
      // Committed, but the connection dies before the ack leaves.
      log("test-ack-lost", { runner: runnerId, carrier: "websocket" });
      peer.closed = true;
      ws.terminate();
      return;
    }
    for (const reply of replies) sendWs(peer, reply);
  };

  ws.on("message", (data) => {
    if (peer !== undefined) peer.lastFrameAt = Date.now();
    // One frame at a time per connection: one batch in flight per runner.
    chain = chain
      .then(() => handleFrame(data))
      .catch((err: unknown) => {
        log("frame-failed", { runner: runnerId, err: err instanceof Error ? err.name : "unknown" });
        ws.close(1011, "internal");
      });
  });
  ws.on("pong", () => {
    if (peer !== undefined) peer.lastFrameAt = Date.now();
  });
  ws.on("error", () => undefined);
  ws.on("close", (code) => {
    clearTimeout(handshake);
    if (peer === undefined) return;
    const p = peer;
    p.closed = true;
    if (wsPeers.get(runnerId) === p) wsPeers.delete(runnerId);
    log("peer-close", { runner: runnerId, epoch: p.connEpoch, code });
    pool
      .query(
        // The peer was last heard at its last frame, not when we noticed it was gone.
        `UPDATE runner_presence SET disconnected_at = to_timestamp($3 / 1000.0), last_seen_at = to_timestamp($3 / 1000.0)
         WHERE runner_id = $1 AND conn_epoch = $2`,
        [runnerId, p.connEpoch, p.lastFrameAt],
      )
      .catch(() => undefined);
  });
};

// ---------- HTTP carrier ----------

const BODY_TIMEOUT_MS = 10_000;

/** Read a request body, up to `cap` bytes and for at most 10 s: a partial body can't hold a connection open. */
const readBody = (req: IncomingMessage, cap: number): Promise<string | undefined> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (v: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      settle(undefined);
      req.destroy();
    }, BODY_TIMEOUT_MS);
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > cap) {
        settle(undefined);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      settle(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", () => {
      settle(undefined);
    });
  });

const metricsToken = Buffer.from(`Bearer ${env.SPIKE_METRICS_TOKEN}`);
/** `/metrics` takes the operator's token, never a runner's. */
const metricsAllowed = (header: string | undefined): boolean => {
  const given = Buffer.from(header ?? "");
  return given.length === metricsToken.length && timingSafeEqual(given, metricsToken);
};

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
};

const errorBody = (code: ErrorMsg["code"], message: string): { messages: ErrorMsg[] } => ({
  messages: [{ type: "error", code, message }],
});

const MinorHeader = z.coerce.number().int().nonnegative();

/** Check an HTTP request's connection epoch against presence: a newer connection wins. */
const httpEpochOk = async (runnerId: RunnerId, conn: number): Promise<boolean> => {
  const r = await pool.query("SELECT conn_epoch FROM runner_presence WHERE runner_id = $1", [runnerId]);
  const row = EpochRow.safeParse(r.rows[0]);
  return row.success && row.data.conn_epoch === conn;
};

const onHttp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const url = new URL(req.url ?? "/", "https://ostra.invalid");
  if (req.method === "GET" && url.pathname === "/metrics") {
    if (!metricsAllowed(req.headers.authorization)) {
      json(res, 401, errorBody("unauthorized", "metrics need the operator token"));
      return;
    }
    const mem = process.memoryUsage();
    json(res, 200, {
      replicaId,
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      wsPeers: wsPeers.size,
      httpPeers: httpSeen.size,
      listening: listener !== undefined,
      counters,
      ingestMs: summarize(ingestMs),
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/runner/v1/info") {
    json(
      res,
      200,
      InfoBody.parse({
        protocolMajor: PROTOCOL_MAJOR,
        serverMinor,
        supported: { min: Math.max(0, serverMinor - 1), max: serverMinor + 1 },
        serverVersion: `0.${String(serverMinor)}.0-spike`,
      }),
    );
    return;
  }
  if (url.pathname === "/runner/v1/connect") {
    // Reached without an upgrade: something on the path stripped it (nginx's defaults do).
    json(res, 426, errorBody("protocol-violation", "WebSocket upgrade required on this path"));
    return;
  }
  const runnerId = verifyToken(env.SPIKE_AUTH_SECRET, req.headers.authorization);
  if (runnerId === undefined) {
    json(res, 401, errorBody("unauthorized", "bad or missing token"));
    return;
  }

  if (req.method === "POST" && url.pathname === "/runner/v1/hello") {
    const body = await readBody(req, 64 * 1024);
    const parsed = body === undefined ? undefined : parseJson(body);
    const hello = parsed?.ok === true ? Hello.safeParse(parsed.value) : undefined;
    if (hello?.success !== true) {
      json(res, 400, errorBody("protocol-violation", "expected hello"));
      return;
    }
    counters.httpHellos += 1;
    const r = await acceptHello(runnerId, hello.data);
    if (!r.ok) {
      log("hello-refused", { runner: runnerId, code: r.error.code, minor: hello.data.protocolMinor, carrier: "http" });
      json(res, r.http, { messages: [r.error] });
      return;
    }
    httpSeen.set(runnerId, { connEpoch: r.connEpoch, at: Date.now() });
    log("peer-open", { runner: runnerId, epoch: r.connEpoch, minor: r.minor, carrier: "http" });
    json(res, 200, { messages: [encodeDown(r.welcome, r.minor), ...r.acks] });
    return;
  }

  const minorHeader = MinorHeader.safeParse(req.headers["x-ostra-minor"]);
  const neg = minorHeader.success ? negotiate(serverMinor, PROTOCOL_MAJOR, minorHeader.data) : undefined;
  if (neg?.ok !== true) {
    json(res, 400, errorBody("protocol-violation", "missing or unsupported x-ostra-minor"));
    return;
  }
  const minor = neg.minor;

  if (req.method === "POST" && url.pathname === "/runner/v1/up") {
    const body = await readBody(req, 2 * FRAME_CAP);
    const parsedJson = body === undefined ? undefined : parseJson(body);
    const up = parsedJson?.ok === true ? httpUpBody(minor).safeParse(parsedJson.value) : undefined;
    if (up?.success !== true) {
      json(res, 400, errorBody("protocol-violation", "invalid up body"));
      return;
    }
    if (!(await httpEpochOk(runnerId, up.data.conn))) {
      json(res, 409, errorBody("replaced", "a newer connection holds this runner; send hello again"));
      return;
    }
    httpSeen.set(runnerId, { connEpoch: up.data.conn, at: Date.now() });
    const out: DownMessage[] = [];
    for (const m of up.data.messages) out.push(...(await handleUp(runnerId, m)));
    if (up.data.messages.some((m) => m.type === "events") && loseAck(runnerId, out)) {
      // Committed, but the response never leaves.
      log("test-ack-lost", { runner: runnerId, carrier: "http" });
      res.destroy();
      return;
    }
    json(res, 200, { messages: out.map((m) => encodeDown(m, minor)) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/runner/v1/down") {
    const after = z.coerce.number().int().nonnegative().safeParse(url.searchParams.get("after"));
    const conn = z.coerce.number().int().positive().safeParse(url.searchParams.get("conn"));
    if (!after.success || !conn.success) {
      json(res, 400, errorBody("protocol-violation", "after and conn are required"));
      return;
    }
    if (!(await httpEpochOk(runnerId, conn.data))) {
      json(res, 409, errorBody("replaced", "a newer connection holds this runner; send hello again"));
      return;
    }
    httpSeen.set(runnerId, { connEpoch: conn.data, at: Date.now() });
    await pool.query(
      "UPDATE runner_command SET acked_at = clock_timestamp() WHERE runner_id = $1 AND seq <= $2 AND acked_at IS NULL",
      [runnerId, after.data],
    );
    const fetchCommands = async (): Promise<Command[]> => {
      const r = await pool.query(selectCommands, [runnerId, after.data]);
      const cmds: Command[] = [];
      for (const row of r.rows) {
        const c = commandFromRow(row);
        if (c !== undefined) cmds.push(c);
      }
      return cmds;
    };
    let cmds = await fetchCommands();
    if (cmds.length === 0) {
      // Hold: woken by this replica's LISTEN connection or its sweep.
      await new Promise<void>((resolve) => {
        let set = httpWaiters.get(runnerId);
        if (set === undefined) {
          set = new Set();
          httpWaiters.set(runnerId, set);
        }
        const waiter = {
          after: after.data,
          wake: () => {
            clearTimeout(timer);
            set.delete(waiter);
            if (set.size === 0) httpWaiters.delete(runnerId);
            resolve();
          },
        };
        const timer = setTimeout(waiter.wake, timers.longPollMs);
        set.add(waiter);
        req.on("close", waiter.wake);
      });
      if (res.destroyed) return;
      cmds = await fetchCommands();
    }
    httpSeen.set(runnerId, { connEpoch: conn.data, at: Date.now() });
    if (cmds.length === 0) {
      res.writeHead(204);
      res.end();
      return;
    }
    counters.commandsSent += cmds.length;
    json(res, 200, { messages: cmds.map((c) => encodeDown(c, minor)) });
    return;
  }

  json(res, 404, errorBody("protocol-violation", "no such route"));
};

const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
  const url = new URL(req.url ?? "/", "https://ostra.invalid");
  const reject = (status: number, text: string): void => {
    const body = JSON.stringify(errorBody(status === 401 ? "unauthorized" : "protocol-violation", text));
    socket.end(
      `HTTP/1.1 ${String(status)} ${status === 401 ? "Unauthorized" : "Not Found"}\r\ncontent-type: application/json\r\ncontent-length: ${String(Buffer.byteLength(body))}\r\nconnection: close\r\n\r\n${body}`,
    );
  };
  if (url.pathname !== "/runner/v1/connect") {
    reject(404, "no such route");
    return;
  }
  const runnerId = verifyToken(env.SPIKE_AUTH_SECRET, req.headers.authorization);
  if (runnerId === undefined) {
    reject(401, "bad or missing token");
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    onWs(ws, runnerId);
  });
};

// ---------- start ----------

const main = async (): Promise<void> => {
  const [cert, key] = await Promise.all([readFile(args.cert), readFile(args.key)]);
  const server = https.createServer({ cert, key, keepAliveTimeout: 65_000 }, (req, res) => {
    onHttp(req, res).catch((err: unknown) => {
      log("http-failed", { err: err instanceof Error ? err.name : "unknown" });
      if (!res.headersSent) json(res, 500, errorBody("internal", "internal error"));
      else res.destroy();
    });
  });
  server.headersTimeout = 30_000;
  // Receiving a whole request (headers and body) must finish in 30 s. A long poll
  // has no body: its 25 s hold is the response, which this doesn't bound.
  server.requestTimeout = 30_000;
  server.on("upgrade", onUpgrade);
  server.on("clientError", (_err, socket) => {
    socket.destroy();
  });
  await startListener();
  every(timers.sweepMs, sweep, "sweep");
  every(timers.presenceMs, writePresence, "presence");
  every(timers.pingMs, ping, "ping");
  every(timers.graceSweepMs, graceSweep, "grace");
  await writePresence();
  server.listen(args.port, "127.0.0.1", () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    log("ready", { port, minor: serverMinor, listen: args.listen });
  });
};

main().catch((err: unknown) => {
  log("fatal", errorFields(err));
  process.exit(1);
});
