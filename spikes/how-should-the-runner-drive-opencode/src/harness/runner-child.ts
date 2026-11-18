// A runner in its own process, driving agents with the same driver. The
// harness uses it when the runner itself must die (T11), stall (T6), or be
// measured alone (T16). Job in: a JSON file (argv[2]). Results out: one JSON
// object per line on stdout. Content never goes out: IDs, counts and timings.

import { readFile } from "node:fs/promises";
import { z } from "zod";
import { agentText, startAcpDriver, textPrompt, type AcpDriver } from "../lib/acp-driver.ts";
import { allowOnce, declineQuestions } from "../lib/deciders.ts";
import { taskId, type SessionId } from "../lib/ids.ts";
import { sampleProcesses } from "../lib/process-tree.ts";

const launchSchema = z.strictObject({
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  env: z.record(z.string(), z.string()),
});

const taskSchema = z.strictObject({ taskId: z.string(), launch: launchSchema, prompt: z.string() });

export const jobSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("turn-then-wait"), task: taskSchema }),
  z.strictObject({
    kind: z.literal("concurrent"),
    mode: z.enum(["per-process", "shared"]),
    tasks: z.array(taskSchema).min(1),
    stallAfterMs: z.number().int().nonnegative(),
    stallMs: z.number().int().nonnegative(),
    crashIndex: z.number().int().nullable(),
    crashAfterMs: z.number().int().nonnegative(),
  }),
  z.strictObject({ kind: z.literal("measure"), task: taskSchema, activePrompt: z.string() }),
]);

export type Job = z.infer<typeof jobSchema>;

const out = (value: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const start = async (task: z.infer<typeof taskSchema>): Promise<AcpDriver> =>
  startAcpDriver({
    taskId: taskId(task.taskId),
    launch: task.launch,
    decidePermission: allowOnce,
    answerElicitation: declineQuestions,
    // The harness tracks each agent this child starts, for its final sweep.
    onSpawn: (pid) => {
      out({ event: "spawned", pid, at: Date.now() });
    },
  });

/** Blocks this process's event loop, as a long synchronous step in a runner would. */
const stall = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const contiguous = (driver: AcpDriver): boolean => driver.events.every((e, i) => e.seq === i + 1);

const updatesLogged = (driver: AcpDriver): number => driver.events.filter((e) => e.kind === "session_update").length;

const runConcurrent = async (job: Extract<Job, { kind: "concurrent" }>): Promise<void> => {
  const rssStart = process.memoryUsage().rss;
  const drivers: AcpDriver[] = [];
  if (job.mode === "per-process") {
    for (const task of job.tasks) drivers.push(await start(task));
  } else {
    const first = job.tasks[0];
    if (first === undefined) throw new Error("no tasks");
    drivers.push(await start(first));
  }
  const sessions: { driver: AcpDriver; sessionId: SessionId; index: number }[] = [];
  for (const [index, task] of job.tasks.entries()) {
    const driver = job.mode === "per-process" ? drivers[index] : drivers[0];
    if (driver === undefined) throw new Error("driver missing");
    const session = await driver.newSession({ cwd: task.launch.cwd, mcpServers: [] });
    sessions.push({ driver, sessionId: session.sessionId, index });
  }
  const startedAt = Date.now();
  const outcomes = sessions.map(async ({ driver, sessionId, index }) => {
    const task = job.tasks[index];
    try {
      const response = await driver.prompt(sessionId, textPrompt(task?.prompt ?? ""));
      return { index, stopReason: response.stopReason, error: null, text: agentText(driver.events, sessionId).length };
    } catch (error) {
      return { index, stopReason: null, error: error instanceof Error ? error.name : "error", text: 0 };
    }
  });
  if (job.crashIndex !== null) {
    const victim = job.mode === "per-process" ? drivers[job.crashIndex] : drivers[0];
    setTimeout(() => {
      victim?.crash();
    }, job.crashAfterMs);
  }
  let stalledAt = 0;
  if (job.stallMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, job.stallAfterMs));
    stalledAt = Date.now() - startedAt;
    stall(job.stallMs);
  }
  const results = await Promise.all(outcomes);
  // A dead PID makes the Windows sampler drop the whole answer: sample the living.
  const agentPids = drivers.filter((d) => d.isRunning()).map((d) => d.pid);
  const agentRss = (await sampleProcesses(agentPids)).reduce((sum, s) => sum + s.rssBytes, 0);
  out({
    event: "concurrent-done",
    mode: job.mode,
    seconds: (Date.now() - startedAt) / 1000,
    stalledAt,
    results,
    drivers: drivers.map((d) => ({
      contiguous: contiguous(d),
      events: d.events.length,
      wireSessionUpdates: d.wire().inboundSessionUpdates,
      loggedSessionUpdates: updatesLogged(d),
    })),
    rssStart,
    rssEnd: process.memoryUsage().rss,
    agentRss,
  });
  for (const d of drivers) await d.stop();
};

const runMeasure = async (job: Extract<Job, { kind: "measure" }>): Promise<void> => {
  const spawnAt = Date.now();
  const driver = await start(job.task);
  const initializedMs = Date.now() - spawnAt;
  const session = await driver.newSession({ cwd: job.task.launch.cwd, mcpServers: [] });
  const firstPrompt = driver.prompt(session.sessionId, textPrompt(job.task.prompt));
  const firstTokenAt = await new Promise<number>((resolve) => {
    const poll = setInterval(() => {
      if (driver.events.some((e) => e.kind === "session_update" && e.update.sessionUpdate === "agent_message_chunk")) {
        clearInterval(poll);
        resolve(Date.now());
      }
    }, 10);
  });
  await firstPrompt;
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const idle = await sampleProcesses([process.pid, driver.pid]);
  const cpuBefore = await sampleProcesses([process.pid, driver.pid]);
  const activeAt = Date.now();
  const active = driver.prompt(session.sessionId, textPrompt(job.activePrompt));
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const during = await sampleProcesses([process.pid, driver.pid]);
  await active;
  const activeMs = Date.now() - activeAt;
  const cpuAfter = await sampleProcesses([process.pid, driver.pid]);
  const cpu = (pid: number, samples: typeof cpuBefore): number => samples.find((s) => s.pid === pid)?.cpuMs ?? 0;
  out({
    event: "measure-done",
    initializedMs,
    spawnToFirstTokenMs: firstTokenAt - spawnAt,
    driverPid: process.pid,
    agentPid: driver.pid,
    idle,
    during,
    activeMs,
    driverCpuMsActive: cpu(process.pid, cpuAfter) - cpu(process.pid, cpuBefore),
    agentCpuMsActive: cpu(driver.pid, cpuAfter) - cpu(driver.pid, cpuBefore),
    driverHeapUsed: process.memoryUsage().heapUsed,
  });
  await driver.stop();
};

const main = async (): Promise<void> => {
  const file = process.argv[2];
  if (file === undefined) throw new Error("usage: runner-child.ts <job.json>");
  const job = jobSchema.parse(JSON.parse(await readFile(file, "utf8")));
  switch (job.kind) {
    case "turn-then-wait": {
      const driver = await start(job.task);
      const session = await driver.newSession({ cwd: job.task.launch.cwd, mcpServers: [] });
      const response = await driver.prompt(session.sessionId, textPrompt(job.task.prompt));
      out({ event: "ready", sessionId: session.sessionId, agentPid: driver.pid, stopReason: response.stopReason });
      // Wait to be killed.
      setInterval(() => undefined, 60_000);
      return;
    }
    case "concurrent":
      await runConcurrent(job);
      return;
    case "measure":
      await runMeasure(job);
      return;
    default:
      job satisfies never;
  }
};

main().catch((error: unknown) => {
  out({ event: "error", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
