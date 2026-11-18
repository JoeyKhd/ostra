// Shared pieces for the scenarios: results, settings, and a Scenario that owns one database, one
// fake GitHub and the replicas and panels started against them.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Cluster, Db } from "./cluster.ts";
import { startFakeGithub, type FakeGithub } from "./fake-github.ts";
import { panelOutSchema, replicaOutSchema } from "./messages.ts";
import type { PanelCommandWire, PanelOut, PanelReply, ReplicaConfigInput, ReplicaOut, WorkerName } from "./messages.ts";
import type { DbosReplicaConfigInput } from "./dbos/messages.ts";
import { sleep, spawnNode } from "./proc.ts";
import type { ExitInfo, ManagedChild } from "./proc.ts";

export type Verdict = "PASS" | "FAIL" | "SKIPPED";

export type CriterionResult = {
  readonly id: string;
  /** The pass bar's own bullet. */
  readonly criterion: string;
  readonly verdict: Verdict;
  readonly summary: string;
  readonly evidence: readonly string[];
  /** For SKIPPED: the exact input that is missing. */
  readonly missingInput?: string;
  /**
   * A caveat the summary line must carry, so a bare PASS never says more than the run showed (for
   * example "overshoot: peak 5 at limit 2"). Absent when there is nothing to add.
   */
  readonly qualifier?: string;
};

export const settingsSchema = z.object({
  SPIKE_ONLY: z.string().optional(),
  /**
   * A Postgres server to use instead of embedded-postgres: it needs rights to CREATE and DROP
   * DATABASE. The harness creates databases named `spike_<run>_template` and `<scenario>_<run>`
   * on it and drops every one it created when it stops. The name is SPIKE_-prefixed on purpose: a
   * generic DATABASE_URL in a developer's shell belongs to some other project.
   */
  SPIKE_DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, "must be a postgres:// or postgresql:// URL")
    .optional(),
  /** The suffix of every database this run creates (8 hex digits). Random when absent. */
  SPIKE_RUN_ID: z
    .string()
    .regex(/^[a-f0-9]{8}$/, "must be 8 hex digits")
    .optional(),
  SPIKE_SCHEDULE_TICKS: z.coerce.number().int().min(2).default(4),
  SPIKE_SCHEDULE_COUNT: z.coerce.number().int().min(1).default(200),
  /** C4: how many kills must strand a forwarding batch (kill the replica that holds it) before the window counts as hit. */
  SPIKE_SCHEDULE_HUNT_KILLS: z.coerce.number().int().min(1).default(3),
  /** C4: how long to wait, after the last tick, for a stranded forwarding batch to be freed (pg-boss expires it after 15 minutes). */
  SPIKE_STRAND_WAIT_MINUTES: z.coerce.number().int().min(0).default(17),
  /**
   * C4 experiment: shorten the expiry of pg-boss's internal forwarding queue (15 minutes by default) on every
   * replica, to see whether a stranded forwarding batch is then freed sooner. Unset: pg-boss's default.
   */
  SPIKE_SEND_IT_EXPIRE_SECONDS: z.coerce.number().int().min(1).optional(),
  /**
   * C4 fix, part 1: a heartbeat on pg-boss's forwarding queue (pg-boss creates it with none), set by every
   * replica with updateQueue. A killed holder's batch is then freed after the heartbeat goes stale, not
   * after the 15-minute expiry. pg-boss's minimum is 10. Unset: pg-boss's default (no heartbeat).
   */
  SPIKE_SEND_IT_HEARTBEAT_SECONDS: z.coerce.number().int().min(10).optional(),
  /**
   * C4 fix, part 2: which schedules carry a singleton key and a 60 s slot on the jobs they create.
   * `alternate` (the default): every second one, so plain and guarded run side by side. `all`: every one.
   */
  SPIKE_SCHEDULE_GUARD: z.enum(["alternate", "all"]).default("alternate"),
  /**
   * D4: the executor ID a restarted DBOS replica comes back with. `slot` (the default): the same one as
   * the process it replaces, which DBOS's self-hosting guide requires. `process`: a new one per process,
   * as a pod with a generated name would get.
   */
  SPIKE_DBOS_EXECUTOR_ID: z.enum(["slot", "process"]).default("slot"),
  SPIKE_GROUP_JOBS: z.coerce.number().int().min(1).default(1000),
  SPIKE_GROUP_KEYS: z.coerce.number().int().min(1).default(20),
  /** C3: the second pass, with jobs of 2 to 4 seconds. */
  SPIKE_GROUP_LONG_JOBS: z.coerce.number().int().min(1).default(200),
  /** C3: a peak above this many active jobs in one group fails, whatever the shares say (5 x the limit of 2). */
  SPIKE_GROUP_PEAK_CAP: z.coerce.number().int().min(3).default(10),
  SPIKE_KEEP_LOGS: z.string().optional(),
});
export type Settings = z.output<typeof settingsSchema>;

/** What every scenario gets. */
export type StaticContext = {
  readonly projectRoot: string;
  readonly runDir: string;
  readonly settings: Settings;
  readonly note: (message: string) => void;
};

/** What a scenario that needs Postgres gets. */
export type RunContext = StaticContext & { readonly cluster: Cluster };

export type Replica = {
  readonly id: string;
  readonly child: ManagedChild<ReplicaOut>;
  kill9: () => Promise<ExitInfo>;
  stop: () => Promise<ExitInfo>;
  isAlive: () => boolean;
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** What the harness gives `panel.call`: the wire form (plain strings for IDs; the panel parses them). */
export type PanelCommandInput = DistributiveOmit<Exclude<PanelCommandWire, { type: "stop" }>, "requestId">;

export type Panel = {
  readonly id: string;
  readonly child: ManagedChild<PanelOut>;
  call: (command: PanelCommandInput, options?: { readonly requestId?: string; readonly timeoutMs?: number }) => Promise<PanelReply>;
  stop: () => Promise<ExitInfo>;
  kill9: () => Promise<ExitInfo>;
};

export type Scenario = {
  readonly name: string;
  readonly db: Db;
  readonly github: FakeGithub;
  startReplica: (id: string, workers: readonly WorkerName[], overrides?: Partial<ReplicaConfigInput>) => Promise<Replica>;
  startPanel: (id: string) => Promise<Panel>;
  /** Starts a replica without waiting for it, for concurrent boots. */
  spawnReplica: (id: string, workers: readonly WorkerName[], overrides?: Partial<ReplicaConfigInput>) => Replica;
  /** Starts a DBOS replica (src/dbos/replica.ts) without waiting for it: same IPC messages, same kill. */
  spawnDbosReplica: (id: string, config: Omit<DbosReplicaConfigInput, "replicaId" | "databaseUrl">) => Replica;
  dispose: () => Promise<void>;
};

export const REPLICA_DEFAULTS = {
  localConcurrency: 3,
  groupConcurrency: 2,
  pollingIntervalSeconds: 0.5,
  // pg-boss's monitor and supervise passes default to 60 s. A killed replica's jobs are freed by the
  // first monitor pass after their heartbeat goes stale, so the spike runs them every 5 s.
  monitorIntervalSeconds: 5,
  superviseIntervalSeconds: 5,
} as const;

export const openScenario = async (ctx: RunContext, name: string): Promise<Scenario> => {
  const db = await ctx.cluster.createScenarioDatabase(name);
  const github = await startFakeGithub();
  const logDir = join(ctx.runDir, name);
  await mkdir(logDir, { recursive: true });

  const children: { readonly kill9: () => Promise<ExitInfo> }[] = [];

  const spawnReplicaProcess = (id: string, entry: string, env: Readonly<Record<string, string>>): Replica => {
    const child = spawnNode({
      name: id,
      entry,
      env,
      logPath: join(logDir, `${id}.log`),
      messageSchema: replicaOutSchema,
    });
    children.push(child);
    return {
      id,
      child,
      kill9: () => child.kill9(),
      stop: async () => {
        child.send({ type: "stop" });
        const timeout = new Promise<ExitInfo>((resolve) => {
          setTimeout(() => {
            resolve({ code: null, signal: null });
          }, 30_000).unref();
        });
        const info = await Promise.race([child.exited, timeout]);
        if (child.isAlive()) {
          return child.kill9();
        }
        return info;
      },
      isAlive: child.isAlive,
    };
  };

  const spawnReplica = (id: string, workers: readonly WorkerName[], overrides: Partial<ReplicaConfigInput> = {}): Replica => {
    const config: ReplicaConfigInput = {
      replicaId: id,
      databaseUrl: db.url,
      fakeGithubUrl: github.url,
      workers: [...workers],
      ...REPLICA_DEFAULTS,
      ...overrides,
    };
    return spawnReplicaProcess(id, join(ctx.projectRoot, "src", "replica.ts"), { REPLICA_CONFIG: JSON.stringify(config) });
  };

  const spawnDbosReplica = (id: string, config: Omit<DbosReplicaConfigInput, "replicaId" | "databaseUrl">): Replica => {
    const full: DbosReplicaConfigInput = { replicaId: id, databaseUrl: db.url, ...config };
    return spawnReplicaProcess(id, join(ctx.projectRoot, "src", "dbos", "replica.ts"), { DBOS_REPLICA_CONFIG: JSON.stringify(full) });
  };

  const startReplica =async (id: string, workers: readonly WorkerName[], overrides: Partial<ReplicaConfigInput> = {}): Promise<Replica> => {
    const replica = spawnReplica(id, workers, overrides);
    const message = await replica.child.waitForMessage(
      (candidate) => candidate.type === "ready" || candidate.type === "fatal",
      60_000,
      "ready",
    );
    if (message.type === "fatal") {
      throw new Error(`${id} failed to start: ${message.error}`);
    }
    return replica;
  };

  const startPanel = async (id: string): Promise<Panel> => {
    const child = spawnNode({
      name: id,
      entry: join(ctx.projectRoot, "src", "panel.ts"),
      env: { PANEL_CONFIG: JSON.stringify({ panelId: id, databaseUrl: db.url }) },
      logPath: join(logDir, `${id}.log`),
      messageSchema: panelOutSchema,
    });
    children.push(child);
    const ready = await child.waitForMessage(
      (candidate) => candidate.type === "ready" || candidate.type === "fatal",
      60_000,
      "ready",
    );
    if (ready.type === "fatal") {
      throw new Error(`${id} failed to start: ${ready.error}`);
    }
    let counter = 0;
    return {
      id,
      child,
      call: async (command, options = {}) => {
        counter += 1;
        const requestId = options.requestId ?? `${id}-req-${String(counter)}`;
        child.send({ ...command, requestId });
        const reply = await child.waitForMessage(
          (candidate) => candidate.type === "reply" && candidate.requestId === requestId,
          options.timeoutMs ?? 120_000,
          `reply to ${command.type}`,
        );
        if (reply.type !== "reply") {
          throw new Error("unexpected message");
        }
        if (!reply.ok) {
          throw new Error(`${id} ${command.type} failed: ${reply.error ?? "unknown"}`);
        }
        return reply;
      },
      stop: async () => {
        child.send({ type: "stop" });
        return child.exited;
      },
      kill9: () => child.kill9(),
    };
  };

  return {
    name,
    db,
    github,
    spawnReplica,
    spawnDbosReplica,
    startReplica,
    startPanel,
    dispose: async () => {
      await Promise.all(children.map((child) => child.kill9()));
      await github.close();
      // Give Postgres a moment to notice the closed sockets of killed children.
      await sleep(200);
    },
  };
};

// Small helpers over the scenario database.

export const countRows = async (db: Db, sql: string, params: readonly unknown[]): Promise<number> => {
  const rows = await db.query(sql, params, z.object({ n: z.coerce.number() }));
  return rows[0]?.n ?? 0;
};

export const dbNowMs = async (db: Db): Promise<number> => {
  const rows = await db.query("SELECT (extract(epoch from clock_timestamp()) * 1000)::float8 AS ms", [], z.object({ ms: z.number() }));
  return rows[0]?.ms ?? 0;
};

export const fmtMs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

export const unreachable = (value: never): never => {
  throw new Error(`unreachable: ${String(value)}`);
};
