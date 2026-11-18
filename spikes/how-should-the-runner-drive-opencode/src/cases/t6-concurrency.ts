// T6 Concurrency and integrity: 10 concurrent tasks on one runner, both one
// process per task and one shared process. A 5 s event-loop stall injected
// into the runner loses no events (seq gaps = 0), memory stays bounded, and
// one task's crash doesn't affect the others.

import { z } from "zod";
import { stubMarker } from "../lib/stub-models/scenario.ts";
import { errorMessage, startChildRunner, startTask, type CaseContext, type Task } from "../harness/fixture.ts";
import { check, fail, type Check, type Criterion } from "../harness/report.ts";

const MB = 1024 * 1024;
const TASKS = 10;

const done = z.looseObject({
  mode: z.string(),
  seconds: z.number(),
  stalledAt: z.number(),
  results: z.array(z.object({ index: z.number(), stopReason: z.string().nullable(), error: z.string().nullable(), text: z.number() })),
  drivers: z.array(z.object({ contiguous: z.boolean(), events: z.number(), wireSessionUpdates: z.number(), loggedSessionUpdates: z.number() })),
  rssStart: z.number(),
  rssEnd: z.number(),
  agentRss: z.number(),
});

const launchOf = (task: Task): { command: string; args: string[]; cwd: string; env: Record<string, string> } => ({
  ...task.launch,
  args: [...task.launch.args],
  env: { ...task.launch.env },
});

export const t6Concurrency = async (ctx: CaseContext): Promise<Criterion[]> => {
  const checks: Check[] = [];
  const recorded: Record<string, string | number> = {};
  const tasks: Task[] = [];
  try {
    for (let i = 0; i < TASKS; i += 1) {
      const task = await startTask(ctx, { name: `t6-${String(i)}`, upstream: { kind: "stub", format: "openai" } });
      await task.driver.stop();
      tasks.push(task);
    }
    const prompt = `${stubMarker("busy")} do the busy work`;

    for (const mode of ["per-process", "shared"] as const) {
      const crashIndex = mode === "per-process" ? TASKS - 1 : null;
      const child = await startChildRunner(ctx, `t6-${mode}`, {
        kind: "concurrent",
        mode,
        tasks: tasks.map((task) => ({ taskId: task.id, launch: launchOf(task), prompt })),
        stallAfterMs: 2500,
        stallMs: 5000,
        crashIndex,
        crashAfterMs: 1500,
      });
      const result = done.parse(await child.waitFor("concurrent-done", 300_000));
      await child.exited;
      const survivors = result.results.filter((r) => r.index !== crashIndex);
      const crashed = result.results.find((r) => r.index === crashIndex);
      const gaps = result.drivers.filter((d) => !d.contiguous || d.wireSessionUpdates !== d.loggedSessionUpdates).length;
      const growth = result.rssEnd - result.rssStart;
      recorded[`${mode}: seconds, events`] = `${result.seconds.toFixed(1)} s, ${String(result.drivers.reduce((s, d) => s + d.events, 0))} events`;
      recorded[`${mode}: runner RSS start / end (MB)`] = `${String(Math.round(result.rssStart / MB))} / ${String(Math.round(result.rssEnd / MB))}`;
      recorded[`${mode}: OpenCode RSS total (MB)`] = Math.round(result.agentRss / MB);
      checks.push(
        check(
          `${mode}: a 5 s event-loop stall in the runner loses no events (seq gaps = 0)`,
          result.stalledAt > 0 && gaps === 0 && survivors.every((r) => r.stopReason === "end_turn"),
          `stall at ${String(result.stalledAt)} ms; ${String(gaps)} of ${String(result.drivers.length)} drivers with a gap or a wire/log mismatch; ${String(survivors.filter((r) => r.stopReason === "end_turn").length)}/${String(survivors.length)} turns ended end_turn`,
        ),
      );
      checks.push(check(`${mode}: memory stays bounded`, growth < 150 * MB, `runner RSS grew ${String(Math.round(growth / MB))} MB over ${String(TASKS)} tasks`));
      if (crashIndex !== null) {
        checks.push(
          check(
            `${mode}: one task's crash doesn't affect the others`,
            crashed?.error === "AgentExitedError" && survivors.every((r) => r.stopReason === "end_turn"),
            `the crashed task ended with ${crashed?.error ?? crashed?.stopReason ?? "?"}; the other ${String(survivors.length)} ended ${[...new Set(survivors.map((r) => r.stopReason ?? r.error))].join(",")}`,
          ),
        );
      } else {
        recorded[`${mode}: crash isolation`] = "not possible by design: one process holds every session, so a crash ends them all";
      }
    }
  } catch (error) {
    checks.push(fail("the concurrency case", errorMessage(error)));
  } finally {
    for (const task of tasks) await task.close();
  }
  return [{ id: "T6", title: "Concurrency and integrity: 10 tasks, per-process and shared; 5 s stall loses nothing; bounded memory; crash isolation.", checks, recorded }];
};
