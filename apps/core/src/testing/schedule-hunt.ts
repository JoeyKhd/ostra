import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Db } from "@ostra/db";
import type { IsolationFixture } from "@ostra/db/testing";
import { postgresAuditLog, postgresChangeNotices, saveAutomation, systemClock } from "@ostra/domain";
import type { AutomationSettings } from "@ostra/domain";
import type { Jobs } from "@ostra/jobs";
import { replicaSet } from "@ostra/jobs/testing";
import type { ReplicaSet } from "@ostra/jobs/testing";
import type { AutomationId } from "@ostra/protocol";
import { z } from "zod";

import type { KillPointName } from "../kill-points.ts";
import { scopeOf } from "./automations.ts";
import { freePort, waitFor } from "./restart.ts";

// The schedule hunt (milestone 6's ticket 37, F-106, F-048): spike 8's C4 hunt
// (`spikes/durable-queue-choice/src/scenarios/c4-schedules.ts`), ported against ostra's scheduler
// tick. 200 automations are created at runtime, each every minute, on one database with three core
// processes (`restart-child.ts`, the real `startCore`). For each tick, every replica but one is armed
// at one of three kill points, and the first armed replica to reach it ends itself there with SIGKILL:
//
//   - `scheduler.tick-written`: inside a schedule's tick transaction, its occurrence row, its job and
//     its next time written, before the commit (the occurrences being inserted);
//   - `automation.occurrence-started`: inside the occurrence's transaction, its task started and
//     recorded, before the commit (the occurrences being forwarded to their starts);
//   - `automation.occurrence-committed`: after that commit, before the job completes (its replay).
//
// The kill is triggered from inside the work by the replica that holds it (its Nth pass, so it lands
// mid-tick), never by the clock; the harness reads the line it prints as it dies and kills the other
// armed replica at once, so every replica but one is gone, then starts both again. The survivor
// rotates. After the last tick every (automation, occurrence) pair must have started exactly once:
// one `automation_run` row, `started`, with one task, and one `automation.started` event in that
// task (no runner is needed: a started task waits queued).
//
// Then the late start: every process stopped, and started again with the scheduler's clock 7 hours
// ahead. Each automation fires once, for the latest occurrence, and the rest are recorded `missed`
// (at most 50 rows named), with one audit entry each holding the count.

const here = path.dirname(fileURLToPath(import.meta.url));
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const HUNT_REPLICAS = ["core-1", "core-2", "core-3"] as const;
const POINTS = ["scheduler.tick-written", "automation.occurrence-started", "automation.occurrence-committed"] as const satisfies readonly KillPointName[];
type HuntPoint = (typeof POINTS)[number];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const randomInt = (low: number, high: number): number => low + Math.floor(Math.random() * (high - low + 1));

export type HuntInput = {
  readonly db: Db;
  /** An enqueue-only queue on the same database, for the saves, not started yet: the replicas install its schema. */
  readonly jobs: Jobs;
  readonly fixture: IsolationFixture;
  /** What a core process of the harness starts with (`seedRestartWorld`). Holds secrets: never logged. */
  readonly env: NodeJS.ProcessEnv;
  readonly logDir: string;
  readonly note: (line: string) => void;
  readonly scheduleCount: number;
  /** Strikes to land at each kill point before the hunt stops. */
  readonly strikesPerPoint: number;
  /** The most ticks the hunt waits through for its strikes. */
  readonly maxTicks: number;
  /** How long the install is "down" for the late start, in hours of the scheduler's clock. */
  readonly lateHours: number;
  readonly missedHours: number;
};

export type HuntStrike = {
  readonly tick: number;
  readonly point: HuntPoint;
  /** The replica that held the work and ended itself at the point. */
  readonly holder: string | null;
  readonly hit: number | null;
  readonly killed: readonly string[];
  readonly survivor: string;
  /** Seconds from the tick's minute to the kill. */
  readonly atSeconds: number | null;
};

export type HuntResult = {
  readonly ok: boolean;
  readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly detail: string }[];
  readonly strikes: readonly HuntStrike[];
  readonly pairs: number;
};

const startedPayloadSchema = z.looseObject({ automationId: z.string(), occurrenceAt: z.number().nullable() });
const missedAuditSchema = z.looseObject({ missed: z.number() });

/** The schedule every automation of the hunt has: a prompt task every minute, nothing skipped while open. */
const everyMinute = (index: number): AutomationSettings => ({
  name: `Hunt ${String(index).padStart(3, "0")}`,
  taskKind: "code",
  agentProfileId: null,
  poolLabels: [],
  requireApproval: false,
  kind: "schedule",
  schedule: "* * * * *",
  timeZone: "UTC",
  skipWhileOpen: false,
  does: { kind: "prompt", title: `Hunt ${String(index)}`, prompt: "A prompt the hunt never reads back; $(rm -rf ~) is data" },
});

const percentile = (sorted: readonly number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;

export const runScheduleHunt = async (input: HuntInput): Promise<HuntResult> => {
  const { db, note } = input;
  const organizationId = input.fixture.a.organization.id;
  const projectId = input.fixture.a.openProject.id;
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
    note(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
  };
  const ports = new Map<string, number>();
  for (const name of HUNT_REPLICAS) ports.set(name, await freePort());
  let clockOffsetMs = 0;
  const replicas: ReplicaSet = replicaSet((name) => ({
    command: process.execPath,
    args: [path.join(here, "restart-child.ts")],
    env: {
      ...input.env,
      OSTRA_CORE_PORT: String(ports.get(name) ?? 0),
      OSTRA_SCHEDULE_MISSED_HOURS: String(input.missedHours),
      // The hunt's schedules fire every minute: the tick holds a schedule to this setting too (ticket 41).
      OSTRA_SCHEDULE_MIN_INTERVAL_MINUTES: "1",
      CORE_TEST_CONTROL_STDIN: "1",
      ...(clockOffsetMs === 0 ? {} : { CORE_TEST_SCHEDULER_CLOCK_OFFSET_MS: String(clockOffsetMs) }),
    },
    ready: (line) => typeof Reflect.get(Object(line), "listening") === "number",
    logFile: path.join(input.logDir, `${name}.log`),
  }));
  const strikes: HuntStrike[] = [];
  try {
    // A cold database, three replicas booting at once.
    await Promise.all(HUNT_REPLICAS.map((name) => replicas.start(name)));
    note(`three core processes up on one database: ${HUNT_REPLICAS.join(", ")}`);
    // The first core installed the queue's schema; the saves enqueue through it.
    await input.jobs.start();
    note("the saves' queue started");

    // 200 automations created at runtime, as a project admin saves them.
    const admin = scopeOf(input.fixture.a.admin, "admin");
    const deps = { db, jobs: input.jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, scheduleMinIntervalMinutes: 1 };
    const createdAt = Date.now();
    const automationIds: AutomationId[] = [];
    for (let index = 0; index < input.scheduleCount; index += 1) {
      const saved = await saveAutomation(deps, admin, { projectId, automationId: null, settings: everyMinute(index) });
      if (!saved.ok) throw new Error(`the save was refused: ${saved.error}`);
      automationIds.push(saved.automationId);
    }
    note(`${String(input.scheduleCount)} automations created at runtime in ${((Date.now() - createdAt) / 1000).toFixed(1)} s, each "* * * * *"`);

    // ---------- the hunt ----------
    const landed = new Map<HuntPoint, number>(POINTS.map((point) => [point, 0]));
    const nextPoint = (tick: number): HuntPoint | null => {
      for (let step = 0; step < POINTS.length; step += 1) {
        const point = POINTS[(tick + step) % POINTS.length];
        if (point !== undefined && (landed.get(point) ?? 0) < input.strikesPerPoint) return point;
      }
      return null;
    };
    const firstTick = Math.ceil((Date.now() + 30_000) / MINUTE) * MINUTE;
    let lastTick = firstTick;
    for (let tick = 0; tick < input.maxTicks; tick += 1) {
      const point = nextPoint(tick);
      if (point === null) break;
      const tickAt = firstTick + tick * MINUTE;
      lastTick = tickAt;
      await sleep(Math.max(0, tickAt - 20_000 - Date.now()));
      const survivor = HUNT_REPLICAS[strikes.length % HUNT_REPLICAS.length] ?? "core-1";
      for (const name of HUNT_REPLICAS) {
        if (replicas.get(name)?.alive() !== true) await replicas.start(name);
      }
      const armed = HUNT_REPLICAS.filter((name) => name !== survivor);
      // The tick's pass takes the schedules one by one; an occurrence's job goes to any replica.
      // A pass within each armed replica's share: the tick's pass is one replica's, the occurrences are spread over three.
      const occurrenceShare = Math.max(1, Math.min(25, Math.floor(input.scheduleCount / 6)));
      const hit = point === "scheduler.tick-written" ? randomInt(Math.min(20, input.scheduleCount), Math.max(Math.min(20, input.scheduleCount), input.scheduleCount - 20)) : randomInt(Math.min(3, occurrenceShare), occurrenceShare);
      const died = new Promise<{ readonly holder: string; readonly hit: number }>((resolve) => {
        for (const name of armed) {
          replicas.get(name)?.onLine((line) => {
            const reached: unknown = Reflect.get(Object(line), "killPoint");
            if (reached === point) {
              const count: unknown = Reflect.get(Object(line), "hit");
              resolve({ holder: name, hit: typeof count === "number" ? count : 0 });
            }
          });
        }
      });
      for (const name of armed) replicas.get(name)?.send({ arm: point, hit });
      const outcome = await Promise.race([died, sleep(Math.max(0, tickAt + 45_000 - Date.now())).then(() => null)]);
      if (outcome === null) {
        for (const name of armed) replicas.get(name)?.send({ arm: null });
        strikes.push({ tick, point, holder: null, hit: null, killed: [], survivor, atSeconds: null });
        note(`tick ${String(tick)}: ${point} armed on ${armed.join(" and ")} (pass ${String(hit)}); not reached: the survivor ${survivor} held the work`);
        continue;
      }
      // The holder is gone; every other armed replica goes at once, so only the survivor is left.
      await replicas.kill(armed);
      const atSeconds = Math.round((Date.now() - tickAt) / 100) / 10;
      landed.set(point, (landed.get(point) ?? 0) + 1);
      strikes.push({ tick, point, holder: outcome.holder, hit: outcome.hit, killed: armed, survivor, atSeconds });
      note(`tick ${String(tick)}: ${outcome.holder} reached ${point} at its pass ${String(outcome.hit)}, ${String(atSeconds)} s after the minute, and ended itself there; killed ${armed.join(" and ")}, kept ${survivor}`);
      await sleep(2_000);
      await Promise.all(armed.map((name) => replicas.start(name)));
    }
    for (const name of HUNT_REPLICAS) {
      if (replicas.get(name)?.alive() !== true) await replicas.start(name);
    }

    // Every occurrence up to the last tick is in, and each started one has its task.
    const settle = async (minOccurrence: number): Promise<void> => {
      await waitFor(
        "every occurrence in, with its task",
        async () => {
          const behind = await db.automation.count({ where: { organizationId, id: { in: automationIds }, OR: [{ lastOccurrenceAt: null }, { lastOccurrenceAt: { lt: new Date(minOccurrence) } }] } });
          const open = await db.automationRun.count({ where: { organizationId, kind: "occurrence", state: "started", taskId: null } });
          return behind === 0 && open === 0;
        },
        4 * MINUTE,
      );
    };
    await settle(lastTick);
    // The replicas keep ticking; stopping them ends the hunt's window.
    await replicas.killAll();
    note(`the hunt is over: ${String(strikes.filter((one) => one.holder !== null).length)} strikes landed in ${String(strikes.length)} ticks; every process stopped`);

    // ---------- the check: each (automation, occurrence) pair started exactly once ----------
    const runs = await db.automationRun.findMany({ where: { organizationId, kind: "occurrence", automationId: { in: automationIds } }, select: { automationId: true, occurrenceAt: true, state: true, taskId: true, createdAt: true } });
    const started = await db.event.findMany({ where: { organizationId, kind: "automation.started" }, select: { taskId: true, payload: true } });
    const startsByPair = new Map<string, string[]>();
    for (const event of started) {
      const payload = startedPayloadSchema.safeParse(event.payload);
      if (!payload.success || payload.data.occurrenceAt === null) continue;
      const pair = `${payload.data.automationId}|${String(payload.data.occurrenceAt)}`;
      startsByPair.set(pair, [...(startsByPair.get(pair) ?? []), event.taskId]);
    }
    const tasks = await db.task.findMany({ where: { organizationId, automationId: { in: automationIds } }, select: { id: true, state: true, automationId: true, createdAt: true } });
    const runPairs = new Set<string>();
    let pairs = 0;
    let exact = 0;
    const notStarted: string[] = [];
    const doubled: string[] = [];
    const latencies: number[] = [];
    const lastReal = new Map<string, number>();
    for (const run of runs) {
      if (run.occurrenceAt === null) continue;
      const at = run.occurrenceAt.getTime();
      lastReal.set(run.automationId, Math.max(lastReal.get(run.automationId) ?? 0, at));
      const pair = `${run.automationId}|${String(at)}`;
      runPairs.add(pair);
      pairs += 1;
      const tasksOfPair = startsByPair.get(pair) ?? [];
      if (tasksOfPair.length > 1) doubled.push(`${run.automationId} at ${new Date(at).toISOString()}: ${String(tasksOfPair.length)} tasks`);
      if (run.state !== "started" || run.taskId === null || tasksOfPair.length === 0) {
        notStarted.push(`${run.automationId} at ${new Date(at).toISOString()}: ${run.state}${run.taskId === null ? ", no task" : ""}`);
      } else if (tasksOfPair.length === 1 && tasksOfPair[0] === run.taskId) {
        exact += 1;
        latencies.push(run.createdAt.getTime() - at);
      }
    }
    // Every minute from each automation's first occurrence to its last has its row: none skipped.
    let gaps = 0;
    for (const automationId of automationIds) {
      const times = runs.filter((run) => run.automationId === automationId && run.occurrenceAt !== null).map((run) => run.occurrenceAt?.getTime() ?? 0).sort((a, b) => a - b);
      for (let index = 1; index < times.length; index += 1) {
        gaps += Math.max(0, Math.round(((times[index] ?? 0) - (times[index - 1] ?? 0)) / MINUTE) - 1);
      }
    }
    const strays = [...startsByPair.keys()].filter((pair) => !runPairs.has(pair));
    latencies.sort((a, b) => a - b);
    note(`${String(input.scheduleCount)} automations, ${String(pairs)} (automation, occurrence) pairs from the first occurrence to the hunt's end; the tick inserted each occurrence ${(percentile(latencies, 50) / 1000).toFixed(1)} s after its minute at p50, ${(percentile(latencies, 95) / 1000).toFixed(1)} s at p95, ${(percentile(latencies, 100) / 1000).toFixed(1)} s at most`);
    const landedCount = strikes.filter((one) => one.holder !== null).length;
    check(
      "the hunt landed its strikes, each in the replica holding the work",
      POINTS.every((point) => (landed.get(point) ?? 0) >= input.strikesPerPoint),
      POINTS.map((point) => `${point} ${String(landed.get(point) ?? 0)} of ${String(input.strikesPerPoint)}`).join(", ") + `; ${String(landedCount)} landed in ${String(strikes.length)} ticks`,
    );
    check("each (automation, occurrence) pair started exactly once", exact === pairs && pairs >= input.scheduleCount * 3, `${String(exact)} of ${String(pairs)} pairs started once with one task; ${String(notStarted.length)} not started, ${String(doubled.length)} with more than one task${[...notStarted, ...doubled].slice(0, 4).map((one) => `; ${one}`).join("")}`);
    check("no occurrence was skipped between an automation's first and last", gaps === 0, `${String(gaps)} minutes with no occurrence row`);
    check("every task belongs to one occurrence, and waits queued", strays.length === 0 && tasks.length === exact && tasks.every((task) => task.state === "queued"), `${String(tasks.length)} tasks for ${String(exact)} started pairs, ${String(strays.length)} started outside any occurrence row, ${String(tasks.filter((task) => task.state !== "queued").length)} not queued`);

    // ---------- the late start ----------
    clockOffsetMs = input.lateHours * HOUR;
    const downAt = Date.now();
    await Promise.all(HUNT_REPLICAS.map((name) => replicas.start(name)));
    note(`late start: the three processes started again with the scheduler's clock ${String(input.lateHours)} hours ahead`);
    const fakeNow = (): number => Date.now() + clockOffsetMs;
    await waitFor(
      "each automation's catch-up",
      async () => {
        const behind = await db.automation.count({ where: { organizationId, id: { in: automationIds }, lastOccurrenceAt: { lt: new Date(downAt + clockOffsetMs - 2 * MINUTE) } } });
        const open = await db.automationRun.count({ where: { organizationId, kind: "occurrence", state: "started", taskId: null } });
        return behind === 0 && open === 0;
      },
      4 * MINUTE,
    );
    await replicas.killAll();
    const afterRuns = await db.automationRun.findMany({ where: { organizationId, kind: "occurrence", automationId: { in: automationIds }, createdAt: { gte: new Date(downAt) } }, select: { automationId: true, occurrenceAt: true, state: true, taskId: true } });
    const audits = await db.auditEntry.findMany({ where: { organizationId, action: "automation.occurrences-missed", createdAt: { gte: new Date(downAt) } }, select: { entityId: true, data: true } });
    let caughtUp = 0;
    const lateProblems: string[] = [];
    for (const automationId of automationIds) {
      const before = lastReal.get(automationId) ?? 0;
      const mine = afterRuns.filter((run) => run.automationId === automationId && run.occurrenceAt !== null);
      const fires = mine.filter((run) => run.state === "started").map((run) => run.occurrenceAt?.getTime() ?? 0).sort((a, b) => a - b);
      const catchUp = fires[0];
      if (catchUp === undefined) {
        lateProblems.push(`${automationId}: nothing fired`);
        continue;
      }
      const window = mine.filter((run) => (run.occurrenceAt?.getTime() ?? 0) > before && (run.occurrenceAt?.getTime() ?? 0) <= catchUp);
      const missedRows = window.filter((run) => run.state === "missed").length;
      const startedRows = window.filter((run) => run.state === "started" && run.taskId !== null).length;
      const owed = Math.round((catchUp - before) / MINUTE) - 1;
      const mineAudits = audits.filter((entry) => entry.entityId === automationId);
      const audited = mineAudits.map((entry) => missedAuditSchema.safeParse(entry.data)).map((parsed) => (parsed.success ? parsed.data.missed : -1));
      // The first tick after the start sees at least `downAt` plus the offset: its latest due minute is within one of it.
      const latest = catchUp >= downAt + clockOffsetMs - MINUTE && catchUp <= fakeNow();
      if (startedRows === 1 && missedRows === Math.min(50, owed) && mineAudits.length === 1 && audited[0] === owed && latest && owed >= (input.lateHours * HOUR) / MINUTE - 3) {
        caughtUp += 1;
      } else if (lateProblems.length < 4) {
        lateProblems.push(`${automationId}: ${String(startedRows)} fired, ${String(missedRows)} missed rows of ${String(owed)} owed, audit entries ${audited.join("/")}`);
      }
    }
    check(
      `after ${String(input.lateHours)} hours down, each automation fires once for the latest occurrence and the rest are missed, with one audit entry`,
      caughtUp === automationIds.length,
      `${String(caughtUp)} of ${String(automationIds.length)} automations caught up so; ${String(audits.length)} audit entries${lateProblems.map((one) => `; ${one}`).join("")}`,
    );
    return { ok: checks.every((one) => one.ok), checks, strikes, pairs };
  } finally {
    await replicas.killAll();
  }
};
