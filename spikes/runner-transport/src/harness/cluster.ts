import { randomUUID } from "node:crypto";
import https from "node:https";
import path from "node:path";
import type pg from "pg";
import { z } from "zod";
import { RunnerId, SessionId, TaskId } from "../protocol/ids.ts";
import { mintToken } from "../shared/auth.ts";
import { eventHash } from "../shared/fake-event.ts";
import { nowPrecise, sleep } from "../shared/stats.ts";
import type { Certs } from "./certs.ts";
import { spawnNode, num, str, type Child, type JsonLine } from "./procs.ts";

// What the harness does as "the panel" and "the queue": it registers runners,
// dispatches, steers and stops through the outbox, and checks what got stored.

export type Ctx = {
  readonly root: string;
  readonly dataDir: string;
  readonly db: pg.Pool;
  readonly dbUrl: string;
  readonly certs: Certs;
  /** The server CA's PEM, read once when the context is built. */
  readonly serverCaPem: string;
  readonly secret: string;
  /** The operator token `/metrics` asks for. */
  readonly metricsToken: string;
  readonly timeScale: number;
};

const SRC = path.resolve(import.meta.dirname, "..");
const big = z.coerce.number().int();

/** The environment a child gets: the parent's, minus any proxy or CA settings unless asked. */
export const cleanEnv = (extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(https?_proxy|no_proxy|all_proxy|node_extra_ca_certs|node_use_env_proxy|database_url|spike_database_url|ostra_spike_test_hooks)$/i.test(k)) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
};

// ---------- replicas ----------

export type Replica = { readonly name: string; port: number; child: Child };

export const startReplica = async (
  ctx: Ctx,
  name: string,
  opts: { readonly pool?: number; readonly timeScale?: number; readonly loseAcks?: number } = {},
): Promise<Replica> => {
  const hooks = opts.loseAcks !== undefined && opts.loseAcks > 0;
  const child = spawnNode(
    `replica-${name}`,
    path.join(SRC, "server", "replica.ts"),
    [
      `--replica=${name}`,
      "--port=0",
      `--cert=${ctx.certs.serverCert}`,
      `--key=${ctx.certs.serverKey}`,
      `--time-scale=${String(opts.timeScale ?? ctx.timeScale)}`,
      `--pool=${String(opts.pool ?? 10)}`,
      ...(hooks ? [`--lose-acks=${String(opts.loseAcks)}`] : []),
    ],
    cleanEnv({
      SPIKE_DATABASE_URL: ctx.dbUrl,
      SPIKE_AUTH_SECRET: ctx.secret,
      SPIKE_METRICS_TOKEN: ctx.metricsToken,
      ...(hooks ? { OSTRA_SPIKE_TEST_HOOKS: "1" } : {}),
    }),
  );
  const ready = await child.waitFor((l) => l["t"] === "ready", 30_000);
  const port = num(ready, "port");
  if (port === undefined) throw new Error(`replica ${name} did not start`);
  return { name, port, child };
};

export const restartReplica = async (ctx: Ctx, r: Replica, opts: { readonly pool?: number } = {}): Promise<void> => {
  const fresh = await startReplica(ctx, r.name, opts);
  r.port = fresh.port;
  r.child = fresh.child;
};

export const ReplicaMetrics = z.looseObject({
  replicaId: z.string(),
  rss: z.number(),
  heapUsed: z.number(),
  wsPeers: z.number(),
  httpPeers: z.number(),
  counters: z.looseObject({
    notifications: z.number(),
    eventsInserted: z.number(),
    eventsDuplicate: z.number(),
    acksLost: z.number(),
    batches: z.number(),
    commandsSent: z.number(),
    staleRefused: z.number(),
    evictions: z.number(),
  }),
  ingestMs: z.looseObject({ p50: z.number(), p99: z.number() }),
});
export type ReplicaMetrics = z.infer<typeof ReplicaMetrics>;

export const metrics = (ctx: Ctx, port: number): Promise<ReplicaMetrics | undefined> =>
  new Promise((resolve) => {
    const req = https.get(
      {
        host: "127.0.0.1",
        port,
        path: "/metrics",
        ca: ctx.serverCaPem,
        servername: "localhost",
        agent: false,
        headers: { authorization: `Bearer ${ctx.metricsToken}` },
      },
      (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try {
          const parsed = ReplicaMetrics.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          resolve(parsed.success ? parsed.data : undefined);
        } catch {
          resolve(undefined);
        }
      });
      },
    );
    req.on("error", () => {
      resolve(undefined);
    });
    req.setTimeout(10_000, () => req.destroy());
  });

// ---------- runners ----------

export type RunnerProc = {
  readonly id: RunnerId;
  readonly dataDir: string;
  child: Child;
  readonly start: (extraArgs?: readonly string[]) => Child;
};

export type RunnerOpts = {
  readonly id: string;
  readonly serverUrl: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly args?: readonly string[];
  /**
   * Start the harness-only entry (runner-test.ts), which takes --self-fence,
   * --crash-on-steer and the freeze command. Otherwise the real CLI (runner.ts).
   */
  readonly testHooks?: boolean;
};

export const runner = (ctx: Ctx, o: RunnerOpts): RunnerProc => {
  const id = RunnerId.parse(o.id);
  const dataDir = path.join(ctx.dataDir, "runners", o.id);
  let restarts = 0;
  const start = (extraArgs: readonly string[] = []): Child =>
    spawnNode(
      `runner-${o.id}${restarts++ === 0 ? "" : `-${String(restarts)}`}`,
      path.join(SRC, "runner", o.testHooks === true ? "runner-test.ts" : "runner.ts"),
      [
        `--runner=${o.id}`,
        `--server=${o.serverUrl}`,
        `--data=${dataDir}`,
        `--time-scale=${String(ctx.timeScale)}`,
        ...(o.args ?? []),
        ...extraArgs,
      ],
      cleanEnv({
        OSTRA_RUNNER_TOKEN: mintToken(ctx.secret, id),
        NODE_EXTRA_CA_CERTS: ctx.certs.bundle,
        ...(o.testHooks === true ? { OSTRA_SPIKE_TEST_HOOKS: "1" } : {}),
        ...(o.env ?? {}),
      }),
    );
  const r: RunnerProc = { id, dataDir, child: start(), start };
  return r;
};

export const restartRunner = (r: RunnerProc, extraArgs: readonly string[] = []): Child => {
  r.child = r.start(extraArgs);
  return r.child;
};

const ReportLine = z.looseObject({
  t: z.literal("report"),
  carrier: z.string(),
  lastAppliedSeq: z.number(),
  sessions: z.record(z.string(), z.object({ lastSeq: z.number(), ackedUpTo: z.number(), state: z.string() })),
});
export type Report = z.infer<typeof ReportLine>;

export const report = async (child: Child): Promise<Report | undefined> => {
  const from = child.lines.length;
  child.send({ cmd: "report" });
  const line = await child.waitFor((l) => l["t"] === "report", 10_000, from);
  const r = ReportLine.safeParse(line);
  return r.success ? r.data : undefined;
};

export const waitWelcome = (child: Child, timeoutMs: number, fromIndex = 0): Promise<JsonLine | undefined> =>
  child.waitFor((l) => l["t"] === "welcome", timeoutMs, fromIndex);

/** Wait until the runner's spool for `session` is fully acked, and return its last seq. */
export const waitDrained = async (child: Child, session: SessionId, timeoutMs: number): Promise<number | undefined> => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await report(child);
    const s = r?.sessions[session];
    if (s !== undefined && s.state !== "running" && s.ackedUpTo === s.lastSeq) return s.lastSeq;
    await sleep(250);
  }
  return undefined;
};

// ---------- the panel and the queue, writing to the outbox ----------

export const registerRunners = async (ctx: Ctx, ids: readonly string[]): Promise<void> => {
  await ctx.db.query("INSERT INTO runner (id) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING", [ids]);
};

export type Dispatched = { readonly task: TaskId; readonly session: SessionId };

export const dispatch = async (ctx: Ctx, runnerId: string, name: string): Promise<Dispatched> => {
  const task = TaskId.parse(`task-${name}`);
  const session = SessionId.parse(`sess-${name}`);
  const c = await ctx.db.connect();
  try {
    await c.query("BEGIN");
    await c.query("INSERT INTO runner (id) VALUES ($1) ON CONFLICT DO NOTHING", [runnerId]);
    await c.query("INSERT INTO task (id, runner_id, lease_epoch, state) VALUES ($1, $2, 1, 'offered')", [task, runnerId]);
    await c.query("INSERT INTO session (id, task_id) VALUES ($1, $2)", [session, task]);
    await c.query("SELECT * FROM enqueue_command($1, 'dispatch', $2::jsonb, NULL, true)", [
      runnerId,
      JSON.stringify({ taskId: task, sessionId: session, leaseEpoch: 1 }),
    ]);
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
  return { task, session };
};

/** Many dispatches in one transaction, for the load phase. */
export const dispatchMany = async (ctx: Ctx, pairs: readonly { runnerId: string; name: string }[]): Promise<Dispatched[]> => {
  const out: Dispatched[] = [];
  const c = await ctx.db.connect();
  try {
    await c.query("BEGIN");
    for (const p of pairs) {
      const task = TaskId.parse(`task-${p.name}`);
      const session = SessionId.parse(`sess-${p.name}`);
      await c.query("INSERT INTO task (id, runner_id, lease_epoch, state) VALUES ($1, $2, 1, 'offered')", [task, p.runnerId]);
      await c.query("INSERT INTO session (id, task_id) VALUES ($1, $2)", [session, task]);
      await c.query("SELECT * FROM enqueue_command($1, 'dispatch', $2::jsonb, NULL, true)", [
        p.runnerId,
        JSON.stringify({ taskId: task, sessionId: session, leaseEpoch: 1 }),
      ]);
      out.push({ task, session });
    }
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
  return out;
};

const EnqRow = z.object({ seq: big, id: z.string() });

export const steer = async (
  ctx: Ctx,
  runnerId: string,
  session: SessionId,
  o: { readonly notify: boolean; readonly notAfterMs?: number },
): Promise<{ id: string; t0: number }> => {
  const t0 = nowPrecise();
  const r = await ctx.db.query("SELECT * FROM enqueue_command($1, 'steer', $2::jsonb, $3, $4)", [
    runnerId,
    JSON.stringify({ sessionId: session, text: "please also update the changelog" }),
    o.notAfterMs === undefined ? null : new Date(o.notAfterMs),
    o.notify,
  ]);
  return { id: EnqRow.parse(r.rows[0]).id, t0 };
};

export const stopSession = async (ctx: Ctx, runnerId: string, session: SessionId): Promise<void> => {
  await ctx.db.query(
    `SELECT * FROM enqueue_command($1, 'stop', jsonb_build_object('sessionId', $2::text, 'leaseEpoch',
       (SELECT t.lease_epoch FROM session s JOIN task t ON t.id = s.task_id WHERE s.id = $2), 'reason', 'requested'), NULL, true)`,
    [runnerId, session],
  );
};

export const stopMany = async (ctx: Ctx, pairs: readonly { runnerId: string; session: SessionId }[]): Promise<void> => {
  await ctx.db.query(
    `SELECT enqueue_command(u.r, 'stop', jsonb_build_object('sessionId', u.s, 'leaseEpoch', 1, 'reason', 'requested'), NULL, true)
     FROM unnest($1::text[], $2::text[]) AS u(r, s)`,
    [pairs.map((p) => p.runnerId), pairs.map((p) => p.session)],
  );
};

export const commandResult = async (ctx: Ctx, id: string): Promise<{ result: string | null; reason: string | null } | undefined> => {
  const r = await ctx.db.query("SELECT result, reason FROM runner_command WHERE id = $1::uuid", [id]);
  const row = z.object({ result: z.string().nullable(), reason: z.string().nullable() }).safeParse(r.rows[0]);
  return row.success ? row.data : undefined;
};

// ---------- checks ----------

export type Verify = {
  readonly ok: boolean;
  readonly expected: number;
  readonly stored: number;
  readonly duplicates: number;
  readonly gaps: number;
  readonly badBodies: number;
};

/** Every event the agent produced (seq 1..expected) is stored exactly once, with the body it had. */
export const verifySession = async (ctx: Ctx, session: SessionId, expected: number): Promise<Verify> => {
  const r = await ctx.db.query("SELECT seq, body->>'h' AS h FROM agent_event WHERE session_id = $1 ORDER BY seq", [session]);
  const rows = z.array(z.object({ seq: big, h: z.string().nullable() })).parse(r.rows);
  let gaps = 0;
  let badBodies = 0;
  let dup = 0;
  let prev = 0;
  for (const row of rows) {
    if (row.seq === prev) dup += 1;
    else if (row.seq !== prev + 1) gaps += row.seq - prev - 1;
    if (row.h !== eventHash(session, row.seq)) badBodies += 1;
    prev = row.seq;
  }
  if (prev < expected) gaps += expected - prev;
  const stored = rows.length;
  return { ok: stored === expected && gaps === 0 && dup === 0 && badBodies === 0, expected, stored, duplicates: dup, gaps, badBodies };
};

export const verifyMany = async (ctx: Ctx, expected: ReadonlyMap<string, number>): Promise<{ ok: number; bad: number; stored: number; expected: number }> => {
  const r = await ctx.db.query(
    "SELECT session_id, seq, body->>'h' AS h FROM agent_event WHERE session_id = ANY($1::text[]) ORDER BY session_id, seq",
    [[...expected.keys()]],
  );
  const rows = z.array(z.object({ session_id: z.string(), seq: big, h: z.string().nullable() })).parse(r.rows);
  const per = new Map<string, number[]>();
  let badHash = new Set<string>();
  for (const row of rows) {
    let list = per.get(row.session_id);
    if (list === undefined) {
      list = [];
      per.set(row.session_id, list);
    }
    list.push(row.seq);
    if (row.h !== eventHash(row.session_id, row.seq)) badHash = badHash.add(row.session_id);
  }
  let ok = 0;
  let bad = 0;
  let expectedTotal = 0;
  for (const [sid, n] of expected) {
    expectedTotal += n;
    const seqs = per.get(sid) ?? [];
    const good = seqs.length === n && seqs.every((s, i) => s === i + 1) && !badHash.has(sid);
    if (good) ok += 1;
    else bad += 1;
  }
  return { ok, bad, stored: rows.length, expected: expectedTotal };
};

export const presenceOf = async (ctx: Ctx, runnerId: string): Promise<{ replica: string; epoch: number; carrier: string } | undefined> => {
  const r = await ctx.db.query("SELECT replica_id, conn_epoch, carrier FROM runner_presence WHERE runner_id = $1", [runnerId]);
  const row = z.object({ replica_id: z.string(), conn_epoch: big, carrier: z.string() }).safeParse(r.rows[0]);
  return row.success ? { replica: row.data.replica_id, epoch: row.data.conn_epoch, carrier: row.data.carrier } : undefined;
};

export const steerReceipts = (child: Child): Map<string, number> => {
  const m = new Map<string, number>();
  for (const l of child.lines) {
    if (l["t"] !== "steer-received") continue;
    const id = str(l, "command");
    const at = num(l, "at");
    if (id !== undefined && at !== undefined) m.set(id, at);
  }
  return m;
};

export const newId = (): string => randomUUID().slice(0, 8);
