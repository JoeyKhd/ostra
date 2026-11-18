// T16 Resource use: RSS and CPU of the driver and of OpenCode, idle and
// active, plus time from spawn to first token. Working budget: driver
// overhead <= 50 MB, spawn to first token <= 3 s. The driver runs alone in a
// child process so its memory is its own; its overhead is measured against a
// bare Node process.

import { spawn } from "node:child_process";
import { z } from "zod";
import { sampleProcesses } from "../lib/process-tree.ts";
import { stubMarker } from "../lib/stub-models/scenario.ts";
import { errorMessage, startChildRunner, withTask, type CaseContext } from "../harness/fixture.ts";
import { check, fail, type Check, type Criterion } from "../harness/report.ts";

const MB = 1024 * 1024;

const sample = z.object({ pid: z.number(), rssBytes: z.number(), cpuMs: z.number() });
const measured = z.looseObject({
  initializedMs: z.number(),
  spawnToFirstTokenMs: z.number(),
  driverPid: z.number(),
  agentPid: z.number(),
  idle: z.array(sample),
  during: z.array(sample),
  activeMs: z.number(),
  driverCpuMsActive: z.number(),
  agentCpuMsActive: z.number(),
});

const bareNodeRss = async (): Promise<number> => {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},4000)"], { stdio: "ignore", windowsHide: true });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const rss = (await sampleProcesses(child.pid === undefined ? [] : [child.pid]))[0]?.rssBytes ?? 0;
  child.kill();
  return rss;
};

export const t16Resources = async (ctx: CaseContext): Promise<Criterion[]> => {
  const checks: Check[] = [];
  const recorded: Record<string, string | number> = {};
  try {
    await withTask(ctx, { name: "t16", upstream: { kind: "stub", format: "openai" } }, async (task) => {
      await task.driver.stop();
      const child = await startChildRunner(ctx, "t16", {
        kind: "measure",
        task: { taskId: task.id, launch: { ...task.launch, args: [...task.launch.args], env: { ...task.launch.env } }, prompt: `${stubMarker("hello")} hi` },
        activePrompt: `${stubMarker("slow-text", "8")} stream for a while`,
      });
      const result = measured.parse(await child.waitFor("measure-done", 180_000));
      await child.exited;
      const base = await bareNodeRss();
      const rss = (samples: z.infer<typeof sample>[], pid: number): number => samples.find((s) => s.pid === pid)?.rssBytes ?? 0;
      const driverIdle = rss(result.idle, result.driverPid);
      const driverActive = rss(result.during, result.driverPid);
      const sampled = (samples: z.infer<typeof sample>[]): boolean => [result.driverPid, result.agentPid].every((pid) => samples.some((x) => x.pid === pid && x.rssBytes > 0));
      const complete = sampled(result.idle) && sampled(result.during) && base > 0;
      const overhead = Math.max(driverIdle, driverActive) - base;
      recorded["bare Node RSS (MB)"] = Math.round(base / MB);
      recorded["driver RSS idle / active (MB)"] = `${String(Math.round(driverIdle / MB))} / ${String(Math.round(driverActive / MB))}`;
      recorded["OpenCode RSS idle / active (MB)"] = `${String(Math.round(rss(result.idle, result.agentPid) / MB))} / ${String(Math.round(rss(result.during, result.agentPid) / MB))}`;
      recorded["CPU during an 8 s streamed turn, driver / OpenCode (ms)"] = `${String(result.driverCpuMsActive)} / ${String(result.agentCpuMsActive)}`;
      recorded["spawn to initialized (ms)"] = result.initializedMs;
      recorded["spawn to first token (ms, stub)"] = result.spawnToFirstTokenMs;
      checks.push(
        complete
          ? check("driver overhead <= 50 MB", overhead <= 50 * MB, `${String(Math.round(overhead / MB))} MB over a bare Node process (${process.platform === "win32" ? "Windows working set" : "RSS"})`)
          : fail("driver overhead <= 50 MB", `samples incomplete: driver and agent idle ${String(result.idle.length)}/2, active ${String(result.during.length)}/2, bare Node ${base > 0 ? "sampled" : "missing"}`),
      );
      checks.push(check("spawn to first token <= 3 s", result.spawnToFirstTokenMs <= 3000, `${String(result.spawnToFirstTokenMs)} ms against a local stub (a real model adds its own latency)`));
    });
  } catch (error) {
    checks.push(fail("resource measurement", errorMessage(error)));
  }
  return [{ id: "T16", title: "Resource use: driver and OpenCode RSS and CPU, idle and active; spawn to first token.", checks, recorded }];
};
